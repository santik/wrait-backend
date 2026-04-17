-- CreateEnum
CREATE TYPE "CallCountType" AS ENUM ('TRANSCRIPTION');

-- AlterTable
ALTER TABLE "call_counts"
ADD COLUMN "type" "CallCountType" NOT NULL DEFAULT 'TRANSCRIPTION';

-- DropIndex
DROP INDEX "call_counts_device_id_date_key";

-- CreateIndex
CREATE UNIQUE INDEX "call_counts_device_id_date_type_key" ON "call_counts"("device_id", "date", "type");
