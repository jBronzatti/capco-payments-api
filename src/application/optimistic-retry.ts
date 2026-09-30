import { ConcurrentUpdateError } from './errors';

const MAX_ATTEMPTS = 2;

/**
 * Runs a read-decide-write attempt again when another writer committed between its read and its conditional
 * write (the attempt answers null). Gives up with a conflict instead of retrying without bound.
 */
export async function retryOnConflict<T>(attempt: () => Promise<T | null>): Promise<T> {
  for (let count = 1; count <= MAX_ATTEMPTS; count += 1) {
    const outcome = await attempt();
    if (outcome !== null) return outcome;
  }
  throw new ConcurrentUpdateError();
}
