import { ConcurrencyGate } from '../../../src/presentation/http/webhooks/concurrency-gate';

describe('ConcurrencyGate', () => {
  it('refuses work beyond its capacity without running it', async () => {
    const gate = new ConcurrencyGate(1);
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = gate.run(() => blocker);
    const second = jest.fn(async () => 'second');

    expect(gate.run(second)).toBeNull();
    expect(second).not.toHaveBeenCalled();

    release();
    await first;
  });

  it('frees the slot when the work ends, however it ends', async () => {
    const gate = new ConcurrencyGate(1);

    await expect(gate.run(async () => 'done')).resolves.toBe('done');
    await expect(gate.run(async () => Promise.reject(new Error('failed')))).rejects.toThrow('failed');
    await expect(
      gate.run(() => {
        throw new Error('thrown before any promise');
      }),
    ).rejects.toThrow('thrown before any promise');

    await expect(gate.run(async () => 'still open')).resolves.toBe('still open');
  });
});
