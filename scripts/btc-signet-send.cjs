require("dotenv").config({ path: "apps/api/.env" });

const bitcoin = require("bitcoinjs-lib");
const ecc = require("tiny-secp256k1");
const { ECPairFactory } = require("ecpair");

bitcoin.initEccLib(ecc);

const ECPair = ECPairFactory(ecc);
const network = bitcoin.networks.testnet; // Signet uses testnet-style addresses/WIF.

function btcToSats(value) {
  return BigInt(Math.round(Number(value) * 100_000_000));
}

function satsToBtc(sats) {
  return Number(sats) / 100_000_000;
}

async function rpc(method, params = []) {
  const rpcUrlRaw = process.env.BITCOIN_SIGNET_RPC_PRIMARY_URL;
  if (!rpcUrlRaw) throw new Error("Missing BITCOIN_SIGNET_RPC_PRIMARY_URL");

  const url = new URL(rpcUrlRaw);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);

  url.username = "";
  url.password = "";

  const auth = Buffer.from(`${username}:${password}`).toString("base64");

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      jsonrpc: "1.0",
      id: "btc-signet-send",
      method,
      params,
    }),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`RPC HTTP ${res.status}: ${text}`);
  }

  const json = JSON.parse(text);

  if (json.error) {
    throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  }

  return json.result;
}

async function main() {
  const recipient = process.argv[2];
  const amountArg = process.argv[3];

  if (!recipient || !amountArg) {
    throw new Error(
      "Usage: node scripts/btc-signet-send.cjs <recipient tb1q address> <amount BTC | max>"
    );
  }

  const wif = process.env.BITCOIN_SIGNET_WITHDRAWAL_WIF;
  if (!wif) throw new Error("Missing BITCOIN_SIGNET_WITHDRAWAL_WIF");

  const feeSats = BigInt(process.env.BITCOIN_SIGNET_WITHDRAWAL_FEE_SATS || "1000");

  const keyPair = ECPair.fromWIF(wif, network);
  const pubkey = Buffer.from(keyPair.publicKey);

  const payment = bitcoin.payments.p2wpkh({
    pubkey,
    network,
  });

  const fromAddress = payment.address;
  if (!fromAddress || !payment.output) {
    throw new Error("Failed to derive p2wpkh address from WIF");
  }

  console.log("From:", fromAddress);
  console.log("To:", recipient);
  console.log("Fee:", feeSats.toString(), "sats");

  const chain = await rpc("getblockchaininfo", []);
  if (chain.chain !== "signet") {
    throw new Error(`Wrong Bitcoin network: ${chain.chain}. Expected signet.`);
  }

  const scan = await rpc("scantxoutset", ["start", [`addr(${fromAddress})`]]);

  if (!scan.success) {
    throw new Error("scantxoutset failed");
  }

  const unspents = scan.unspents || [];
  if (unspents.length === 0) {
    throw new Error(
      `No UTXOs found for ${fromAddress}. Did you fund this exact tb1q address?`
    );
  }

  const totalSats = unspents.reduce((sum, utxo) => {
    return sum + btcToSats(utxo.amount);
  }, 0n);

  console.log("UTXOs:", unspents.length);
  console.log("Available:", satsToBtc(totalSats), "sBTC");

  let sendSats;

  if (amountArg.toLowerCase() === "max") {
    sendSats = totalSats - feeSats;
  } else {
    sendSats = btcToSats(amountArg);
  }

  if (sendSats <= 0n) {
    throw new Error("Send amount must be positive after fee");
  }

  if (sendSats + feeSats > totalSats) {
    throw new Error(
      `Insufficient funds. Need ${satsToBtc(sendSats + feeSats)} sBTC, have ${satsToBtc(totalSats)} sBTC`
    );
  }

  const changeSats = totalSats - sendSats - feeSats;

  const psbt = new bitcoin.Psbt({ network });

  for (const utxo of unspents) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: payment.output,
        value: btcToSats(utxo.amount),
      },
    });
  }

  psbt.addOutput({
    address: recipient,
    value: sendSats,
  });

  if (changeSats > 546n) {
    psbt.addOutput({
      address: fromAddress,
      value: changeSats,
    });
  }

  const signer = {
    publicKey: pubkey,
    sign: (hash) => Buffer.from(keyPair.sign(hash)),
  };

  for (let i = 0; i < unspents.length; i++) {
    psbt.signInput(i, signer);
    psbt.validateSignaturesOfInput(i, () => true);
    psbt.finalizeInput(i);
  }

  const tx = psbt.extractTransaction();
  const rawTx = tx.toHex();

  console.log("Sending:", satsToBtc(sendSats), "sBTC");
  console.log("Change:", satsToBtc(changeSats), "sBTC");

  const txid = await rpc("sendrawtransaction", [rawTx]);

  console.log("TXID:", txid);
  console.log(`Explorer: https://mempool.space/signet/tx/${txid}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});