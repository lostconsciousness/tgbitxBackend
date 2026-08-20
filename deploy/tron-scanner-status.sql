SELECT count(*) AS active_tron_addresses
FROM user_deposit_addresses
WHERE network = 'TRON' AND status = 'ACTIVE';

SELECT stream, count(*) AS cursors, max("updatedAt") AS last_updated,
       max("lastTimestampMs") AS latest_timestamp_ms
FROM tron_deposit_scan_cursors
GROUP BY stream
ORDER BY stream;

SELECT status, count(*) AS deposits, max("detectedAt") AS last_detected
FROM deposits
WHERE network = 'TRON'
GROUP BY status
ORDER BY status;
