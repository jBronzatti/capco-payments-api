import { SourceFailureLimiter } from '../../../src/presentation/http/webhooks/source-failure-limiter';

describe('SourceFailureLimiter', () => {
  let now: number;
  const limiter = (limit = 2, maxSources = 100) =>
    new SourceFailureLimiter({ limit, windowMs: 60_000, maxSources }, () => now);

  beforeEach(() => {
    now = 1_000_000;
  });

  it('blocks a source once it reaches the failure limit within the window', () => {
    const subject = limiter();
    subject.recordFailure('a');
    expect(subject.isBlocked('a')).toBe(false);

    subject.recordFailure('a');

    expect(subject.isBlocked('a')).toBe(true);
  });

  it('counts each source separately', () => {
    const subject = limiter();
    subject.recordFailure('a');
    subject.recordFailure('a');

    expect(subject.isBlocked('b')).toBe(false);
  });

  it('forgets failures when their window ends', () => {
    const subject = limiter();
    subject.recordFailure('a');
    subject.recordFailure('a');

    now += 60_000;

    expect(subject.isBlocked('a')).toBe(false);
    subject.recordFailure('a');
    expect(subject.isBlocked('a')).toBe(false);
  });

  it('tracks a bounded number of sources, dropping the oldest first', () => {
    const subject = limiter(1, 2);
    subject.recordFailure('a');
    subject.recordFailure('b');

    subject.recordFailure('c');

    expect(subject.isBlocked('a')).toBe(false);
    expect(subject.isBlocked('b')).toBe(true);
    expect(subject.isBlocked('c')).toBe(true);
  });
});
