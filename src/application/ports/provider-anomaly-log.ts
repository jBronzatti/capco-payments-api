export type ProviderAnomalyKind = 'UNKNOWN_REFERENCE' | 'MISMATCH' | 'DUPLICATE_APPROVAL' | 'REVERSAL';

export type BindingField = 'paymentMethod' | 'amount' | 'currency' | 'paymentType' | 'collector';

/** Provider evidence this service will not act on automatically, kept for a person to resolve. */
export interface ProviderAnomaly {
  kind: ProviderAnomalyKind;
  /** Null when the provider payment cannot be tied to one of ours. */
  paymentId: string | null;
  providerPaymentId: string;
  providerStatus: string;
  /** Which facts disagree with our payment; empty unless the kind is MISMATCH. */
  mismatches: BindingField[];
}

/** Durable, one record per kind, provider payment and provider status: redeliveries add nothing, changes do. */
export interface ProviderAnomalyLog {
  record(anomaly: ProviderAnomaly): Promise<void>;
}
