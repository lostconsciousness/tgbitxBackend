require("dotenv").config({ path: "apps/api/.env" });

const tronwebPackage = require("tronweb");
const TronWeb = tronwebPackage.TronWeb || tronwebPackage;

async function main() {
  const recipient = process.argv[2];
  const amountUsdtRaw = process.argv[3];

  if (!recipient || !amountUsdtRaw) {
    throw new Error("Usage: node scripts/tron-nile-send-usdt.cjs <recipient T address> <amount USDT>");
  }

  const rpcUrl = process.env.TRON_NILE_RPC_PRIMARY_URL || "https://nile.trongrid.io";
  const privateKey = process.env.TRON_NILE_WITHDRAWAL_PRIVATE_KEY;
  const usdtAddress = process.env.TRON_NILE_USDT_TRC20_ADDRESS;
  const feeLimit = Number(process.env.TRON_NILE_TRC20_FEE_LIMIT_SUN || "150000000");

  if (!privateKey) throw new Error("Missing TRON_NILE_WITHDRAWAL_PRIVATE_KEY");
  if (!usdtAddress) throw new Error("Missing TRON_NILE_USDT_TRC20_ADDRESS");

  const amountUsdt = Number(amountUsdtRaw);
  if (!Number.isFinite(amountUsdt) || amountUsdt <= 0) {
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
  const contract = await tronWeb.contract().at(usdtAddress);

  const amountRaw = Math.floor(amountUsdt * 1_000_000);

  console.log("From:", fromAddress);
  console.log("To:", recipient);
  console.log("USDT contract:", usdtAddress);
  console.log("Amount:", amountUsdt, "USDT");
  console.log("Fee limit:", feeLimit, "SUN");

  const txid = await contract
    .transfer(recipient, amountRaw)
    .send({
      feeLimit,
      callValue: 0,
      shouldPollResponse: false,
    });

  console.log("TXID:", txid);
  console.log(`Explorer: https://nile.tronscan.org/#/transaction/${txid}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});