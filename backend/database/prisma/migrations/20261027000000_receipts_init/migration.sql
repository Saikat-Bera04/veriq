CREATE TABLE IF NOT EXISTS "receipts" (
    "sequence" BIGSERIAL NOT NULL,
    "request_id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "block_number" BIGINT,
    "created_at" BIGINT NOT NULL,
    "receipt_json" JSONB NOT NULL,
    CONSTRAINT "receipts_pkey" PRIMARY KEY ("sequence")
);

CREATE UNIQUE INDEX IF NOT EXISTS "receipts_request_id_key"
    ON "receipts"("request_id");

CREATE INDEX IF NOT EXISTS "receipts_created_at"
    ON "receipts"("created_at" DESC, "sequence" DESC);
