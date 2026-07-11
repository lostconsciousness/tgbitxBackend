const fs = require("fs");

const tronwebPackage = require("tronweb");
const TronWeb = tronwebPackage.TronWeb || tronwebPackage;

async function main() {
  const walletName = process.argv[2] || "tron-nile-wallet-new";
  const outputPath = `./${walletName}.json`;

  const tronWeb = new TronWeb({
    fullHost: "https://nile.trongrid.io",
  });

  const account = await tronWeb.createAccount();

  const wallet = {
    network: "TRON_NILE",
    address: account.address.base58,
    hexAddress: account.address.hex,
    privateKey: account.privateKey,
  };

  fs.writeFileSync(outputPath, JSON.stringify(wallet, null, 2));

  console.log("New TRON Nile wallet created");
  console.log("Address:", wallet.address);
  console.log("Hex address:", wallet.hexAddress);
  console.log("Saved to:", outputPath);
  console.log("");
  console.log("IMPORTANT: private key is inside the JSON file. Do not commit it.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});