# Token allowlist and flexible deposits

The exchange does not auto-enable every token visible on-chain. Connected wallet balances and deposit options are driven by the configured `Asset` + `TokenContract` allowlist.

This is intentional:

- wallet balances can scan many configured token contracts across EVM networks;
- deposits are shown only for verified and enabled `asset + network` pairs;
- spam/scam tokens are not accepted just because they appear in a wallet.

## User deposit selection flow

The frontend should use this flow:

1. `GET /deposits/options` (requires auth; assets sorted by `balanceValueUsdc` desc)
2. User selects `asset.symbol`.
3. User selects one of `asset.networks[]`.
4. `POST /deposits/address` with:

```json
{
  "assetSymbol": "USDC",
  "network": "base-sepolia"
}
```

5. `GET /deposits/instructions/USDC?network=base-sepolia`

For EVM networks, the personal deposit address is shared by user + network. Different coins on the same network are matched by token contract + destination address.

## Admin add-token flow

Create the asset once:

```http
POST /admin/assets
```

```json
{
  "symbol": "LINK",
  "name": "Chainlink",
  "type": "CRYPTO",
  "decimals": 18
}
```

Add a token contract for each network:

```http
POST /admin/assets/LINK/contracts
```

```json
{
  "network": "ethereum-sepolia",
  "standard": "ERC20",
  "tokenAddress": "0x0000000000000000000000000000000000000000",
  "decimals": 18,
  "withdrawalFeeAmount": "0",
  "minWithdrawalAmount": "0"
}
```

Verify the deployed contract:

```http
POST /admin/assets/LINK/verify-contract?network=ethereum-sepolia
```

Enable deposits only after verification:

```http
PATCH /admin/assets/LINK/transfers?network=ethereum-sepolia
```

```json
{
  "depositEnabled": true,
  "withdrawalEnabled": false
}
```

## Bulk allowlist import

Set `TOKEN_ALLOWLIST_PATH` to a JSON file and run the seed. Imported pairs are disabled by default and must still be verified before deposits can be enabled.

The repository includes a generated EVM allowlist:

```text
apps/api/prisma/allowlists/top-100-uniswap-default.json
```

It contains 100 curated assets from the Uniswap Labs Default token list across the supported EVM mainnets: Ethereum, Arbitrum, Base, Optimism, Polygon, BNB, and Avalanche.

Asset icons are stored as `Asset.iconUrl`. Network icons are stored as `Network.iconUrl`. Both are returned by the deposit option and account overview APIs so the frontend can render coin/network selectors without a hardcoded icon map.

```json
{
  "assets": [
    {
      "symbol": "LINK",
      "name": "Chainlink",
      "iconUrl": "https://assets.coingecko.com/coins/images/877/large/chainlink-new-logo.png",
      "type": "CRYPTO",
      "decimals": 18,
      "networks": [
        {
          "network": "ethereum-sepolia",
          "standard": "ERC20",
          "address": "0x0000000000000000000000000000000000000000",
          "decimals": 18
        },
        {
          "network": "base-sepolia",
          "standard": "ERC20",
          "address": "0x0000000000000000000000000000000000000000",
          "decimals": 18
        }
      ]
    }
  ]
}
```

## Connected wallet balances

`GET /wallets/balances` scans configured EVM token contracts plus native gas balances. To see more coins there, add more `TokenContract` rows through the admin endpoint or `TOKEN_ALLOWLIST_PATH`.

Solana and Bitcoin remain separate adapter paths. They can appear in the allowlist, but deposits stay disabled until the SVM/UTXO adapters are implemented and tested.
