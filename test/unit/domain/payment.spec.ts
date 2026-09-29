import { Payment, PaymentSnapshot } from '../../../src/domain/payment/payment';
import { InvalidTransitionError, StatusManagedByProviderError } from '../../../src/domain/payment/errors';
import { Cpf } from '../../../src/domain/shared/cpf';
import { Description } from '../../../src/domain/shared/description';
import { Money } from '../../../src/domain/shared/money';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const ID = '0b7c8f0e-6a0e-4a53-9a57-0d7d9e0c1a11';

function payment(overrides: Partial<PaymentSnapshot> = {}): Payment {
  return Payment.restore({
    id: ID,
    cpf: '12345678909',
    description: 'Pedido #123',
    amountCents: 15075,
    paymentMethod: 'PIX',
    status: 'PENDING',
    failureReason: null,
    providerPreferenceId: null,
    checkoutUrl: null,
    providerPaymentId: null,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

const card = (overrides: Partial<PaymentSnapshot> = {}) =>
  payment({ paymentMethod: 'CREDIT_CARD', ...overrides });
const paidCard = (providerPaymentId = '111') => card({ status: 'PAID', providerPaymentId });

describe('Payment', () => {
  describe('creation', () => {
    it('opens every new payment as PENDING at version 0 with normalised values', () => {
      const created = Payment.create(
        {
          id: ID,
          cpf: Cpf.parse('123.456.789-09'),
          description: Description.parse(' Pedido #123 '),
          amount: Money.fromDecimal(150.75),
          paymentMethod: 'PIX',
        },
        NOW,
      );

      expect(created.toSnapshot()).toEqual(payment().toSnapshot());
    });
  });

  describe('description changes', () => {
    it('allows a new description while PENDING', () => {
      expect(payment().changeDescription(Description.parse('Novo texto'))).toEqual({
        description: 'Novo texto',
      });
    });

    it('rejects a description change once the payment is settled', () => {
      const settled = payment({ status: 'PAID' });
      expect(() => settled.changeDescription(Description.parse('x'))).toThrow(InvalidTransitionError);
    });

    it('treats the current description as a no-op, even once settled, so a repeated PUT stays idempotent', () => {
      const settled = payment({ status: 'PAID' });
      expect(settled.changeDescription(Description.parse('Pedido #123'))).toBeNull();
    });
  });

  describe('manual settlement (PIX)', () => {
    it('moves PENDING to PAID', () => {
      expect(payment().settleManually('PAID')).toEqual({ status: 'PAID', failureReason: null });
    });

    it('moves PENDING to FAIL with a MANUAL reason', () => {
      expect(payment().settleManually('FAIL')).toEqual({ status: 'FAIL', failureReason: 'MANUAL' });
    });

    it.each([
      ['PAID', null],
      ['FAIL', 'MANUAL'],
    ] as const)('treats a repeated request for the current status %s as a no-op', (status, failureReason) => {
      expect(payment({ status, failureReason }).settleManually(status)).toBeNull();
    });

    it.each([
      ['PAID', 'FAIL', null],
      ['FAIL', 'PAID', 'MANUAL'],
    ] as const)('refuses %s -> %s because settled PIX payments are terminal', (from, to, failureReason) => {
      expect(() => payment({ status: from, failureReason }).settleManually(to)).toThrow(
        InvalidTransitionError,
      );
    });

    it.each([
      ['a pending card payment', card()],
      ['a paid card payment, even for its current status', paidCard()],
    ])('refuses any manual status change on %s', (_label, subject) => {
      expect(() => subject.settleManually('PAID')).toThrow(StatusManagedByProviderError);
    });
  });

  describe('checkout lifecycle (card)', () => {
    it('attaches the checkout to a pending card payment', () => {
      expect(card().attachCheckout('pref-1', 'https://checkout.example/pref-1')).toEqual({
        providerPreferenceId: 'pref-1',
        checkoutUrl: 'https://checkout.example/pref-1',
      });
    });

    it.each([
      ['a PIX payment', payment()],
      ['a card payment that already has one', card({ providerPreferenceId: 'pref-1' })],
    ])('refuses to attach a checkout to %s', (_label, subject) => {
      expect(() => subject.attachCheckout('pref-2', 'https://x')).toThrow(InvalidTransitionError);
    });

    it.each([
      ['failed', card({ status: 'FAIL', failureReason: 'CHECKOUT_FAILED' })],
      ['paid', paidCard()],
    ])('attaches nothing to a card payment that already %s meanwhile', (_label, subject) => {
      expect(subject.attachCheckout('pref-2', 'https://x')).toBeNull();
    });

    it('knows which checkout it has', () => {
      expect(card({ providerPreferenceId: 'pref-1' }).hasCheckout('pref-1')).toBe(true);
      expect(card().hasCheckout('pref-1')).toBe(false);
    });

    it('records a checkout failure on a pending card payment', () => {
      expect(card().failCheckout('CHECKOUT_OUTCOME_UNKNOWN')).toEqual({
        status: 'FAIL',
        failureReason: 'CHECKOUT_OUTCOME_UNKNOWN',
      });
    });

    it.each([
      ['a paid card payment', paidCard()],
      ['a failed card payment', card({ status: 'FAIL', failureReason: 'PAYMENT_REJECTED' })],
    ])('never lets a checkout failure overwrite %s', (_label, subject) => {
      expect(subject.failCheckout('CHECKOUT_FAILED')).toBeNull();
    });

    it('refuses to record a checkout failure on a PIX payment', () => {
      expect(() => payment().failCheckout('CHECKOUT_FAILED')).toThrow(InvalidTransitionError);
    });
  });

  describe('provider outcomes (card)', () => {
    it('settles a pending payment on approval, keeping the winning provider payment', () => {
      expect(card().applyProviderOutcome({ providerPaymentId: '111', outcome: 'APPROVED' })).toEqual({
        kind: 'APPLY',
        changes: { status: 'PAID', failureReason: null, providerPaymentId: '111' },
      });
    });

    it('lets a provider-confirmed approval supersede an earlier failure', () => {
      const failed = card({ status: 'FAIL', failureReason: 'PAYMENT_REJECTED' });
      expect(failed.applyProviderOutcome({ providerPaymentId: '222', outcome: 'APPROVED' })).toEqual({
        kind: 'APPLY',
        changes: { status: 'PAID', failureReason: null, providerPaymentId: '222' },
      });
    });

    it('treats a repeated approval of the winning payment as a no-op', () => {
      expect(paidCard('111').applyProviderOutcome({ providerPaymentId: '111', outcome: 'APPROVED' })).toEqual(
        {
          kind: 'NO_OP',
        },
      );
    });

    it('surfaces a different approved payment on a paid charge as a duplicate approval', () => {
      expect(paidCard('111').applyProviderOutcome({ providerPaymentId: '222', outcome: 'APPROVED' })).toEqual(
        {
          kind: 'DUPLICATE_APPROVAL',
        },
      );
    });

    it('fails a pending payment on a confirmed rejection', () => {
      expect(card().applyProviderOutcome({ providerPaymentId: '111', outcome: 'REJECTED' })).toEqual({
        kind: 'APPLY',
        changes: { status: 'FAIL', failureReason: 'PAYMENT_REJECTED' },
      });
    });

    it.each([
      ['a paid payment (stale rejection)', paidCard('111')],
      ['an already failed payment', card({ status: 'FAIL', failureReason: 'PAYMENT_REJECTED' })],
    ])('ignores a rejection for %s', (_label, subject) => {
      expect(subject.applyProviderOutcome({ providerPaymentId: '333', outcome: 'REJECTED' })).toEqual({
        kind: 'NO_OP',
      });
    });

    it.each(['IN_PROGRESS', 'UNRECOGNIZED'] as const)('does not transition on %s', (outcome) => {
      expect(card().applyProviderOutcome({ providerPaymentId: '111', outcome })).toEqual({ kind: 'NO_OP' });
    });

    it('reports a reversal of the winning payment without transitioning (refunds are outside this lifecycle)', () => {
      expect(paidCard('111').applyProviderOutcome({ providerPaymentId: '111', outcome: 'REVERSED' })).toEqual(
        {
          kind: 'REVERSAL',
        },
      );
    });

    it.each([
      ['a refunded losing duplicate on a paid charge', paidCard('111'), '222'],
      ['a reversal reported for a pending payment', card(), '111'],
    ])('ignores %s', (_label, subject, providerPaymentId) => {
      expect(subject.applyProviderOutcome({ providerPaymentId, outcome: 'REVERSED' })).toEqual({
        kind: 'NO_OP',
      });
    });

    it('refuses provider outcomes for PIX payments', () => {
      expect(() => payment().applyProviderOutcome({ providerPaymentId: '111', outcome: 'APPROVED' })).toThrow(
        InvalidTransitionError,
      );
    });
  });
});
