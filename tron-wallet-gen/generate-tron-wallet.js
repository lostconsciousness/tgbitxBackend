const { TronWeb } = require("tronweb");

async function main() {
  const account = await TronWeb.createAccount();

  console.log("TRON_WITHDRAWAL_PRIVATE_KEY=" + account.privateKey);
  console.log("TRON_WITHDRAWAL_HOT_ADDRESS=" + account.address.base58);
  console.log("TRON_HEX_ADDRESS=" + account.address.hex);
}

main().catch(console.error);