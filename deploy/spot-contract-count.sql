SELECT n."chainKey" AS network, count(*) AS verified_contracts
FROM token_contracts tc
JOIN networks n ON n.id = tc."networkId"
WHERE tc.metadata->>'purpose' = 'SPOT_CONVERT'
GROUP BY n."chainKey"
ORDER BY n."chainKey";
