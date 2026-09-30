import { createHash } from 'node:crypto';
import { ApiKeyAuthenticator } from '../../../src/presentation/http/auth/api-key-authenticator';

const sha256 = (text: string) => createHash('sha256').update(text).digest();

describe('ApiKeyAuthenticator', () => {
  const authenticator = new ApiKeyAuthenticator([
    { id: 'client', sha256: sha256('client-key-0001'), canSettle: false },
    { id: 'operator', sha256: sha256('operator-key-0002'), canSettle: true },
  ]);

  it('identifies the caller by the hash of the presented key', () => {
    expect(authenticator.authenticate('operator-key-0002')).toEqual({ keyId: 'operator', canSettle: true });
  });

  it.each([
    ['an unknown key', 'guessed-key'],
    ['a missing header', undefined],
    ['an empty header', ''],
    ['a repeated header', ['client-key-0001', 'operator-key-0002']],
  ])('rejects %s', (_label, presented) => {
    expect(authenticator.authenticate(presented)).toBeNull();
  });
});
