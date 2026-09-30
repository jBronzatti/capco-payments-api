import { createHash, timingSafeEqual } from 'node:crypto';

export interface ApiKeyCredential {
  id: string;
  sha256: Buffer;
  canSettle: boolean;
}

export interface Principal {
  keyId: string;
  canSettle: boolean;
}

const MAX_KEY_LENGTH = 256;

/** Keys are known only by their SHA-256 digests; digests are compared in constant time. */
export class ApiKeyAuthenticator {
  constructor(private readonly credentials: readonly ApiKeyCredential[]) {}

  authenticate(presented: string | string[] | undefined): Principal | null {
    if (typeof presented !== 'string' || presented.length === 0 || presented.length > MAX_KEY_LENGTH) {
      return null;
    }
    const digest = createHash('sha256').update(presented).digest();
    const match = this.credentials.find((credential) => timingSafeEqual(credential.sha256, digest));
    return match ? { keyId: match.id, canSettle: match.canSettle } : null;
  }
}
