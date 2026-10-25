-- CreateTable
CREATE TABLE "registration_attempts" (
    "ip" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1
);

-- CreateIndex
CREATE UNIQUE INDEX "registration_attempts_ip_date_key" ON "registration_attempts"("ip", "date");

-- CreateIndex
CREATE INDEX "registration_attempts_date_idx" ON "registration_attempts"("date");
