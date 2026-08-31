import { config } from '../config.js';
import { CredentialError, decrypt, encrypt } from './crypto.js';

/**
 * Storage for connector credentials, encrypted at rest.
 *
 * Nothing here has a plaintext fallback path. If `HAVEN_SECRET_KEY` is absent,
 * `set` throws — it does not warn and store the value anyway. docs/SECURITY.md
 * treats "a credential in the database in the clear" as the failure this whole
 * layer exists to prevent, and a fallback is exactly how that happens.
 */
export function createCredentialStore(db, { secretKey = config.secretKey } = {}) {
  const insert = db.prepare(`
    INSERT INTO credentials (name, ciphertext, iv, auth_tag)
    VALUES (@name, @ciphertext, @iv, @authTag)
    ON CONFLICT (name) DO UPDATE SET
      ciphertext = excluded.ciphertext,
      iv         = excluded.iv,
      auth_tag   = excluded.auth_tag,
      updated_at = datetime('now')
  `);

  const selectOne = db.prepare('SELECT * FROM credentials WHERE name = ?');
  const deleteOne = db.prepare('DELETE FROM credentials WHERE name = ?');
  const selectNames = db.prepare('SELECT name FROM credentials ORDER BY name');

  return {
    /** @throws {CredentialError} NO_SECRET_KEY when no key is configured. */
    set(name, value) {
      if (typeof name !== 'string' || name.trim() === '') {
        throw new CredentialError('Credential name must be a non-empty string.', 'BAD_NAME');
      }
      if (typeof value !== 'string' || value === '') {
        throw new CredentialError('Credential value must be a non-empty string.', 'BAD_VALUE');
      }

      // resolveKey (inside encrypt) throws before anything touches the
      // database, so a missing key cannot leave a half-written row.
      const { ciphertext, iv, authTag } = encrypt(value, secretKey);
      insert.run({ name, ciphertext, iv, authTag });
      return { name };
    },

    /**
     * @returns {string|null} the plaintext, or null if no such credential.
     * @throws {CredentialError} DECRYPT_FAILED on a key mismatch — never
     *         garbage, and never null-as-if-absent, because "the key rotated"
     *         and "it was never set" need different fixes.
     */
    get(name) {
      const row = selectOne.get(name);
      if (!row) return null;

      return decrypt({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag }, secretKey);
    },

    /** Names only — deliberately never the values. Safe to log. */
    list() {
      return selectNames.all().map((row) => row.name);
    },

    has(name) {
      return selectOne.get(name) !== undefined;
    },

    delete(name) {
      return deleteOne.run(name).changes > 0;
    },
  };
}

export { CredentialError } from './crypto.js';
