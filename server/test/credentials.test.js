import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createCredentialStore } from '../src/db/credentials.js';
import { decrypt, encrypt } from '../src/db/crypto.js';
import { migrate } from '../src/db/migrate.js';

const aKey = () => randomBytes(32).toString('base64');

const freshDb = (t) => {
  const db = new Database(':memory:');
  migrate(db);
  t.after(() => db.close());
  return db;
};

test('a credential round-trips through the store', (t) => {
  const db = freshDb(t);
  const store = createCredentialStore(db, { secretKey: aKey() });

  store.set('example.token', 'correct horse battery staple');

  assert.equal(store.get('example.token'), 'correct horse battery staple');
});

test('the stored row holds no plaintext', (t) => {
  const db = freshDb(t);
  const secret = 'a-distinctive-value-to-search-for';
  createCredentialStore(db, { secretKey: aKey() }).set('example.token', secret);

  const row = db.prepare('SELECT * FROM credentials WHERE name = ?').get('example.token');

  const asText = Buffer.concat([row.ciphertext, row.iv, row.auth_tag]).toString('latin1');
  assert.ok(!asText.includes(secret), 'ciphertext must not contain the plaintext');
  assert.ok(!Object.keys(row).includes('value'), 'there must be no plaintext column');
});

test('storing a credential with no key set is refused, not silently plaintext', (t) => {
  const db = freshDb(t);
  const store = createCredentialStore(db, { secretKey: null });

  assert.throws(
    () => store.set('example.token', 'hunter2'),
    (err) => err.code === 'NO_SECRET_KEY' && /HAVEN_SECRET_KEY/.test(err.message)
  );

  // The critical half: nothing was written.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credentials').get().n, 0);
});

test('an empty-string key is refused too', (t) => {
  const db = freshDb(t);
  assert.throws(
    () => createCredentialStore(db, { secretKey: '' }).set('example.token', 'hunter2'),
    (err) => err.code === 'NO_SECRET_KEY'
  );
});

test('a key of the wrong length is refused rather than stretched', (t) => {
  const db = freshDb(t);
  const store = createCredentialStore(db, { secretKey: Buffer.from('short').toString('base64') });

  assert.throws(
    () => store.set('example.token', 'hunter2'),
    (err) => err.code === 'BAD_SECRET_KEY'
  );
});

test('the wrong key fails to decrypt rather than returning garbage', (t) => {
  const db = freshDb(t);
  const rightKey = aKey();
  const wrongKey = aKey();

  createCredentialStore(db, { secretKey: rightKey }).set('example.token', 'the-real-value');

  const withWrongKey = createCredentialStore(db, { secretKey: wrongKey });

  assert.throws(
    () => withWrongKey.get('example.token'),
    (err) => err.code === 'DECRYPT_FAILED'
  );

  // And the right key still works — the record was not damaged by the attempt.
  assert.equal(
    createCredentialStore(db, { secretKey: rightKey }).get('example.token'),
    'the-real-value'
  );
});

test('tampered ciphertext fails the auth tag', (t) => {
  const db = freshDb(t);
  const key = aKey();
  createCredentialStore(db, { secretKey: key }).set('example.token', 'the-real-value');

  const row = db.prepare('SELECT ciphertext FROM credentials WHERE name = ?').get('example.token');
  const tampered = Buffer.from(row.ciphertext);
  tampered[0] ^= 0xff;
  db.prepare('UPDATE credentials SET ciphertext = ? WHERE name = ?').run(tampered, 'example.token');

  assert.throws(
    () => createCredentialStore(db, { secretKey: key }).get('example.token'),
    (err) => err.code === 'DECRYPT_FAILED'
  );
});

test('each encryption uses a fresh IV', () => {
  const key = aKey();
  const a = encrypt('same-value', key);
  const b = encrypt('same-value', key);

  assert.notDeepEqual(a.iv, b.iv, 'IV must never repeat under the same key');
  assert.notDeepEqual(a.ciphertext, b.ciphertext, 'identical plaintexts must not encrypt alike');

  assert.equal(decrypt(a, key), 'same-value');
  assert.equal(decrypt(b, key), 'same-value');
});

test('set overwrites, list names only, delete removes', (t) => {
  const db = freshDb(t);
  const store = createCredentialStore(db, { secretKey: aKey() });

  store.set('a.token', 'first');
  store.set('a.token', 'second');
  store.set('b.token', 'other');

  assert.equal(store.get('a.token'), 'second');
  assert.deepEqual(store.list(), ['a.token', 'b.token']);
  assert.equal(store.has('a.token'), true);

  assert.equal(store.delete('a.token'), true);
  assert.equal(store.get('a.token'), null);
  assert.equal(store.delete('a.token'), false);
});

test('a missing credential is null, which is different from a failed decrypt', (t) => {
  const db = freshDb(t);
  assert.equal(createCredentialStore(db, { secretKey: aKey() }).get('never.set'), null);
});
