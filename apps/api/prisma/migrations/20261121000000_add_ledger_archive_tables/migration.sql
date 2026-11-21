-- CreateTable
CREATE TABLE "ArchiveManifest" (
    "id" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "objectKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "minRecordAt" TIMESTAMP(3) NOT NULL,
    "maxRecordAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArchiveManifest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArchiveManifest_objectKey_key" ON "ArchiveManifest"("objectKey");

-- CreateIndex
CREATE INDEX "ArchiveManifest_dataset_year_month_idx" ON "ArchiveManifest"("dataset", "year", "month");

-- CreateTable
CREATE TABLE "ArchiveCursor" (
    "scope" TEXT NOT NULL,
    "lastCreatedAt" TIMESTAMP(3) NOT NULL,
    "lastId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArchiveCursor_pkey" PRIMARY KEY ("scope")
);
