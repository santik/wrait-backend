ALTER TABLE "devices"
ADD COLUMN "daily_record_limit" INTEGER;

ALTER TABLE "devices"
ADD CONSTRAINT "devices_daily_record_limit_non_negative"
CHECK ("daily_record_limit" IS NULL OR "daily_record_limit" >= 0);
