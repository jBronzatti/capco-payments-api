export class DeadlineExceededError extends Error {
  override readonly name = 'DeadlineExceededError';
}

/**
 * Settles with the call, or rejects with `onTimeout()` once `timeoutMs` passes. The call is not cancelled, only
 * no longer awaited; a rejection it produces afterwards is still handled.
 */
export async function withDeadline<T>(
  call: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([call, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
