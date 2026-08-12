SELECT a.symbol, n."chainKey" AS network
FROM token_contracts tc
JOIN assets a ON a.id = tc."assetId"
JOIN networks n ON n.id = tc."networkId"
WHERE tc.metadata->>'purpose' = 'SPOT_CONVERT'
ORDER BY a.symbol, n."chainKey";
