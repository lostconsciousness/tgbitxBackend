require("dotenv").config({ path: "apps/api/.env" });

const tronwebPackage = require("tronweb");
const TronWeb = tronwebPackage.TronWeb || tronwebPackage;

async function main() {
  const rpcUrl = process.env.TRON_NILE_RPC_PRIMARY_URL;
  const privateKey = process.env.TRON_NILE_WITHDRAWAL_PRIVATE_KEY;
  const usdtAddress = process.env.TRON_NILE_USDT_TRC20_ADDRESS;

  if (!rpcUrl) throw new Error("Missing TRON_NILE_RPC_PRIMARY_URL");
  if (!privateKey) throw new Error("Missing TRON_NILE_WITHDRAWAL_PRIVATE_KEY");

  const tronWeb = new TronWeb({
    fullHost: rpcUrl,
    privateKey,
  });

  const hotAddress = tronWeb.address.fromPrivateKey(privateKey);

  console.log("Hot address:", hotAddress);

  const trxSun = await tronWeb.trx.getBalance(hotAddress);
  console.log("TRX:", trxSun / 1_000_000);

  if (usdtAddress) {
    const contract = await tronWeb.contract().at(usdtAddress);
    const rawBalance = await contract.balanceOf(hotAddress).call();

    console.log("USDT raw:", rawBalance.toString());
    console.log("USDT assuming 6 decimals:", Number(rawBalance.toString()) / 1_000_000);
  } else {
    console.log("TRON_NILE_USDT_TRC20_ADDRESS not set, skipping USDT check.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});