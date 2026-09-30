-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('PIX', 'CREDIT_CARD');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAIL');

-- CreateEnum
CREATE TYPE "FailureReason" AS ENUM ('CHECKOUT_FAILED', 'CHECKOUT_OUTCOME_UNKNOWN', 'PAYMENT_REJECTED', 'MANUAL');

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "cpf" CHAR(11) NOT NULL,
    "description" VARCHAR(140) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "payment_method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "failure_reason" "FailureReason",
    "provider_preference_id" TEXT,
    "checkout_url" TEXT,
    "provider_payment_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_preference_id_key" ON "payments"("provider_preference_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_payment_id_key" ON "payments"("provider_payment_id");

-- CreateIndex
CREATE INDEX "payments_created_at_id_idx" ON "payments"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "payments_cpf_created_at_id_idx" ON "payments"("cpf", "created_at" DESC, "id" DESC);


-- Defense in depth: the database enforces the invariants the domain enforces.
ALTER TABLE "payments"
    ADD CONSTRAINT "payments_cpf_digits_check" CHECK ("cpf" ~ '^[0-9]{11}$'),
    ADD CONSTRAINT "payments_amount_positive_check" CHECK ("amount_cents" > 0),
    ADD CONSTRAINT "payments_description_not_blank_check" CHECK (length(btrim("description")) > 0),
    ADD CONSTRAINT "payments_version_non_negative_check" CHECK ("version" >= 0),
    ADD CONSTRAINT "payments_failure_reason_iff_fail_check" CHECK (("status" = 'FAIL') = ("failure_reason" IS NOT NULL)),
    ADD CONSTRAINT "payments_provider_fields_card_only_check" CHECK (
        "payment_method" = 'CREDIT_CARD'
        OR ("provider_preference_id" IS NULL AND "checkout_url" IS NULL AND "provider_payment_id" IS NULL)
    ),
    ADD CONSTRAINT "payments_paid_card_has_provider_payment_check" CHECK (
        NOT ("payment_method" = 'CREDIT_CARD' AND "status" = 'PAID') OR "provider_payment_id" IS NOT NULL
    );
