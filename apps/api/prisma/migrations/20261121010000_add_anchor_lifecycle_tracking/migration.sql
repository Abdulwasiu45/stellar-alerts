-- AlterTable
ALTER TABLE "AnchorTransactionWatch"
    ADD COLUMN "unifiedState" TEXT,
    ADD COLUMN "statusChangedAt" TIMESTAMP(3),
    ADD COLUMN "kind" TEXT,
    ADD COLUMN "anchorAccount" TEXT,
    ADD COLUMN "memo" TEXT,
    ADD COLUMN "memoType" TEXT,
    ADD COLUMN "stellarTxHash" TEXT;

-- CreateIndex
CREATE INDEX "AnchorTransactionWatch_anchorAccount_memo_idx" ON "AnchorTransactionWatch"("anchorAccount", "memo");

-- CreateTable
CREATE TABLE "AnchorTransactionEvent" (
    "id" TEXT NOT NULL,
    "watchId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "unifiedState" TEXT,
    "stellarTxHash" TEXT,
    "anomaly" BOOLEAN NOT NULL DEFAULT false,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnchorTransactionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnchorTransactionEvent_watchId_createdAt_idx" ON "AnchorTransactionEvent"("watchId", "createdAt");

-- AddForeignKey
ALTER TABLE "AnchorTransactionEvent" ADD CONSTRAINT "AnchorTransactionEvent_watchId_fkey" FOREIGN KEY ("watchId") REFERENCES "AnchorTransactionWatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
