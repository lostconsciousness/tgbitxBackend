const bitcoin = require("bitcoinjs-lib");
const ecc = require("tiny-secp256k1");
const { ECPairFactory } = require("ecpair");

bitcoin.initEccLib(ecc);

const ECPair = ECPairFactory(ecc);

// Signet uses testnet-style WIF/address params.
// This is NOT Bitcoin mainnet.
const network = bitcoin.networks.testnet;

const keyPair = ECPair.makeRandom({ network });
const pubkey = Buffer.from(keyPair.publicKey);

const p2wpkh = bitcoin.payments.p2wpkh({
  pubkey,
  network,
});

const p2pkh = bitcoin.payments.p2pkh({
  pubkey,
  network,
});

const nestedSegwit = bitcoin.payments.p2sh({
  redeem: bitcoin.payments.p2wpkh({
    pubkey,
    network,
  }),
  network,
});

console.log("BITCOIN_SIGNET_WITHDRAWAL_WIF=" + keyPair.toWIF());
console.log("");
console.log("Recommended hot address, native segwit p2wpkh:");
console.log(p2wpkh.address);
console.log("");
console.log("Other possible address types from same WIF:");
console.log("legacy p2pkh:       " + p2pkh.address);
console.log("nested segwit p2sh: " + nestedSegwit.address);
console.log("");
console.log("IMPORTANT:");
console.log("Fund the exact address type your backend derives from this WIF.");
console.log("Most likely you need the tb1q... p2wpkh address.");