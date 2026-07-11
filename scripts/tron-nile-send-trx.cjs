require("dotenv").config({ path: "apps/api/.env" });

const tronwebPackage = require("tronweb");
const TronWeb = tronwebPackage.TronWeb || tronwebPackage;

async function main() {
  const recipient = process.argv[2];
  const amountTrxRaw = process.argv[3];

  if (!recipient || !amountTrxRaw) {
    throw new Error("Usage: node scripts/tron-nile-send-trx.cjs <recipient T address> <amount TRX>");
  }

  const rpcUrl = process.env.TRON_NILE_RPC_PRIMARY_URL || "https://nile.trongrid.io";
  const privateKey = process.env.TRON_NILE_WITHDRAWAL_PRIVATE_KEY;

  if (!privateKey) {
    throw new Error("Missing TRON_NILE_WITHDRAWAL_PRIVATE_KEY in apps/api/.env");
  }

  const amountTrx = Number(amountTrxRaw);
  if (!Number.isFinite(amountTrx) || amountTrx <= 0) {
    throw new Error("Amount must be a positive number");
  }

  const tronWeb = new TronWeb({
    fullHost: rpcUrl,
    privateKey,
  });

  if (!tronWeb.isAddress(recipient)) {
    throw new Error(`Invalid TRON recipient address: ${recipient}`);
  }

  const fromAddress = tronWeb.address.fromPrivateKey(privateKey);
  const amountSun = Math.floor(amountTrx * 1_000_000);

  console.log("From:", fromAddress);
  console.log("To:", recipient);
  console.log("Amount:", amountTrx, "TRX");

  const result = await tronWeb.trx.sendTransaction(recipient, amountSun, privateKey);

  console.log("Result:", result);

  if (result.txid) {
    console.log(`Explorer: https://nile.tronscan.org/#/transaction/${result.txid}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});