const tronwebPackage = require("tronweb");
const TronWeb = tronwebPackage.TronWeb || tronwebPackage;

async function main() {
  const tronWeb = new TronWeb({
    fullHost: "https://nile.trongrid.io",
  });

  const account = await tronWeb.createAccount();

  console.log("TRON_NILE_WITHDRAWAL_PRIVATE_KEY=" + account.privateKey);
  console.log("");
  console.log("TRON Nile hot address:");
  console.log(account.address.base58);
  console.log("");
  console.log("TRON hex address:");
  console.log(account.address.hex);
  console.log("");
  console.log("Fund this T... address with Nile TRX:");
  console.log(account.address.base58);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});