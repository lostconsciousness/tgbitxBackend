SELECT a.id AS asset_id, a.symbol, n.id AS network_id, n."chainKey", tc.standard,
       tc.address, tc."contractVerifiedAt", tc.metadata
FROM assets a
CROSS JOIN networks n
LEFT JOIN token_contracts tc ON tc."assetId" = a.id AND tc."networkId" = n.id
WHERE a.symbol = 'ETH' AND n."chainKey" = 'bnb';
