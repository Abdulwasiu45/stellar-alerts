-- CreateTable
CREATE TABLE "ContractWasmAudit" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "wasmHash" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "exportedFunctions" JSONB NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "auditRegistry" TEXT,
    "sourceRepo" TEXT,
    "auditReportUrl" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractWasmAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContractWasmAudit_contractId_key" ON "ContractWasmAudit"("contractId");

-- CreateIndex
CREATE INDEX "ContractWasmAudit_wasmHash_idx" ON "ContractWasmAudit"("wasmHash");

-- CreateIndex
CREATE INDEX "ContractWasmAudit_isVerified_idx" ON "ContractWasmAudit"("isVerified");

-- CreateIndex
CREATE INDEX "ContractWasmAudit_lastCheckedAt_idx" ON "ContractWasmAudit"("lastCheckedAt");
