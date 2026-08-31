import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for
const TAG_BYTES = 16;

/**
 * Thrown when a credential operation cannot proceed. Carries a `code` so
 * callers can map it to an HTTP status without string-matching a message.
 */
export class CredentialError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CredentialError';
    this.code = code;
  }
}

/**
 * Turns the configured `HAVEN_SECRET_KEY` into a 32-byte key.
 *
 * The key is expected to be base64 (`openssl rand -base64 32`, as documented
 * in docs/SECURITY.md). It is NOT hashed or stretched into shape: a key of the
 * wrong length is a misconfiguration, and quietly digesting it would let a
 * four-character key look like a 256-bit one.
 *
 * @throws {CredentialError} when the key is missing or the wrong size.
 */
export function resolveKey(rawKey) {
  if (rawKey === null || rawKey === undefined || rawKey === '') {
    throw new CredentialError(
      'HAVEN_SECRET_KEY is not set, so credentials cannot be stored. ' +
        'Generate one with `openssl rand -base64 32` and set it in .env. ' +
        'Credentials are never stored unencrypted.',
      'NO_SECRET_KEY'
    );
  }

  const key = Buffer.from(rawKey, 'base64');

  if (key.length !== KEY_BYTES) {
    throw new CredentialError(
      `HAVEN_SECRET_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
        'Generate one with `openssl rand -base64 32`.',
      'BAD_SECRET_KEY'
    );
  }

  return key;
}

/**
 * Encrypts a credential.
 *
 * A fresh random IV per record — never a counter, never reused. GCM's security
 * collapses entirely if an IV repeats under the same key, which is the single
 * easiest way to get this wrong.
 *
 * @returns {{ ciphertext: Buffer, iv: Buffer, authTag: Buffer }}
 */
export function encrypt(plaintext, rawKey) {
  const key = resolveKey(rawKey);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);

  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

/**
 * Decrypts a credential, or throws.
 *
 * This is the property the whole scheme rests on: GCM authenticates as well as
 * encrypts, so `final()` throws on a wrong key or tampered ciphertext instead
 * of returning plausible-looking rubbish. A wrong key must never silently
 * yield a wrong password that then gets sent to an upstream service.
 *
 * @throws {CredentialError} code `DECRYPT_FAILED`.
 */
export function decrypt({ ciphertext, iv, authTag }, rawKey) {
  const key = resolveKey(rawKey);

  if (iv?.length !== IV_BYTES || authTag?.length !== TAG_BYTES) {
    throw new CredentialError(
      'Stored credential is malformed (bad IV or auth tag length).',
      'DECRYPT_FAILED'
    );
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv));
    decipher.setAuthTag(Buffer.from(authTag));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]).toString(
      'utf8'
    );
  } catch {
    // Deliberately does not echo the underlying OpenSSL error, and does not
    // distinguish "wrong key" from "tampered data" — both mean the same thing
    // to a caller, and saying which is a small oracle.
    throw new CredentialError(
      'Could not decrypt the stored credential. The HAVEN_SECRET_KEY does not match ' +
        'the one it was encrypted with, or the stored value has been altered.',
      'DECRYPT_FAILED'
    );
  }
}
