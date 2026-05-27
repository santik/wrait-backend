# S-056 — Quota SQL operations

For now, per-device quota changes are managed directly in the database through the `devices.daily_record_limit` column.

Semantics:
- `NULL` = use backend default
- `0` = block the device
- positive integer = explicit base device limit

Effective API limits derived from that value:
- cleanup limit = `daily_record_limit`
- transcribe limit = `daily_record_limit * 2`

Table and column:
- table: `"devices"`
- device id column: `"device_id"`
- quota column: `"daily_record_limit"`

Example queries:

Set a device to the default behavior again:

```sql
UPDATE "devices"
SET "daily_record_limit" = NULL
WHERE "device_id" = '<device-id>';
```

Block a device completely:

```sql
UPDATE "devices"
SET "daily_record_limit" = 0
WHERE "device_id" = '<device-id>';
```

Set a device to `5` completed records per day:
- cleanup limit becomes `5`
- transcribe limit becomes `10`

```sql
UPDATE "devices"
SET "daily_record_limit" = 5
WHERE "device_id" = '<device-id>';
```

Inspect the current configured limit for one device:

```sql
SELECT
  "device_id",
  "daily_record_limit"
FROM "devices"
WHERE "device_id" = '<device-id>';
```

Inspect all devices with explicit overrides:

```sql
SELECT
  "device_id",
  "daily_record_limit"
FROM "devices"
WHERE "daily_record_limit" IS NOT NULL
ORDER BY "registered_at" DESC;
```

Inspect today's usage for one device:

```sql
SELECT
  "type",
  "count"
FROM "call_counts"
WHERE "device_id" = '<device-id>'
  AND "date" = CURRENT_DATE
ORDER BY "type";
```

Inspect today's usage with effective limits:

```sql
SELECT
  d."device_id",
  d."daily_record_limit",
  COALESCE(t."count", 0) AS transcription_count,
  COALESCE(c."count", 0) AS cleanup_count,
  COALESCE(d."daily_record_limit", 3) * 2 AS transcription_limit,
  COALESCE(d."daily_record_limit", 3) AS cleanup_limit
FROM "devices" d
LEFT JOIN "call_counts" t
  ON t."device_id" = d."device_id"
 AND t."date" = CURRENT_DATE
 AND t."type" = 'TRANSCRIPTION'
LEFT JOIN "call_counts" c
  ON c."device_id" = d."device_id"
 AND c."date" = CURRENT_DATE
 AND c."type" = 'CLEANUP'
WHERE d."device_id" = '<device-id>';
```
