-- Add custom color-coded category tags to tracked wallets
-- issue: Wallet Tagging & Custom Label Classification System API
ALTER TABLE "Wallet" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Gin index for tag filtering on GET /wallets?tag=Payroll
CREATE INDEX IF NOT EXISTS "Wallet_tags_idx" ON "Wallet" USING GIN("tags");
