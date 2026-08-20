COPY (
  SELECT
    n."chainKey" AS network,
    lower(uda.address) AS address
  FROM user_deposit_addresses uda
  JOIN networks n ON n."legacyChain" = uda.network
  WHERE uda.status = 'ACTIVE'
    AND n.family = 'EVM'
    AND n.mainnet = true
    AND n."chainKey" IN ('ethereum', 'arbitrum', 'base', 'optimism', 'bnb')
  ORDER BY n."chainKey", lower(uda.address)
) TO STDOUT WITH CSV HEADER;
