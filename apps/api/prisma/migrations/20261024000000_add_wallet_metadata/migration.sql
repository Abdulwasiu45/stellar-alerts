ALTER TABLE "Wallet"
ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb;