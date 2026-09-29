-- CreateEnum
CREATE TYPE "ProviderAnomalyKind" AS ENUM ('UNKNOWN_REFERENCE', 'MISMATCH', 'DUPLICATE_APPROVAL', 'REVERSAL');

-- CreateTable
CREATE TABLE "provider_anomalies" (
    "id" UUID NOT NULL,
    "kind" "ProviderAnomalyKind" NOT NULL,
    "payment_id" UUID,
    "provider_payment_id" TEXT NOT NULL,
    "provider_status" TEXT NOT NULL,
    "mismatches" TEXT[],
    "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_anomalies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_anomalies_payment_id_idx" ON "provider_anomalies"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_anomalies_kind_provider_payment_id_provider_status_key" ON "provider_anomalies"("kind", "provider_payment_id", "provider_status");

-- AddForeignKey
ALTER TABLE "provider_anomalies" ADD CONSTRAINT "provider_anomalies_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Defense in depth: the evidence keeps the shape the application writes.
ALTER TABLE "provider_anomalies"
    ADD CONSTRAINT "provider_anomalies_provider_payment_id_digits_check" CHECK ("provider_payment_id" ~ '^[0-9]{1,20}$'),
    ADD CONSTRAINT "provider_anomalies_mismatches_known_check" CHECK (
        "mismatches" IS NOT NULL
        AND "mismatches" <@ ARRAY['paymentMethod', 'amount', 'currency', 'paymentType', 'collector']::TEXT[]
    ),
    ADD CONSTRAINT "provider_anomalies_mismatch_has_fields_check" CHECK (("kind" = 'MISMATCH') = (cardinality("mismatches") > 0)),
    ADD CONSTRAINT "provider_anomalies_unknown_reference_iff_no_payment_check" CHECK (("kind" = 'UNKNOWN_REFERENCE') = ("payment_id" IS NULL));
