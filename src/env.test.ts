import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * A valid environment, applied to the process before `./env.ts` is imported.
 *
 * The import itself is a test: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all. The
 * failure cases below go through `loadEnv`, which is pure over its source and therefore testable
 * without a child process.
 */
const VALID: Record<string, string> = {
  BILLING_DATABASE_URL: 'postgres://billing:pw@127.0.0.1:5432/billing',
  IDENTITY_JWKS_URL: 'http://identity.test/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://identity.test',
  OUTBOX_SIGNING_SECRET: 'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4',
  BILLING_LEDGER_URL: 'http://ledger.test:4000',
  BILLING_LEDGER_TOKEN: 'T7uW2kM9pX4bV6nQ1sD8jH3fG5rL0yZa',
}
for (const [key, value] of Object.entries(VALID)) process.env[key] = value

const { EnvError, SERVICE, env, loadEnv } = await import('./env.ts')

const BASE = VALID

test('a complete environment loads, and importing the module did not exit', () => {
  assert.equal(env.databaseUrl, VALID['BILLING_DATABASE_URL'])
  assert.equal(SERVICE, 'billing')
})

test('a missing variable names itself', () => {
  assert.throws(
    () => loadEnv({ ...BASE, BILLING_DATABASE_URL: undefined }),
    (err: unknown) => err instanceof EnvError && /BILLING_DATABASE_URL is required/.test(err.message),
  )
  assert.throws(() => loadEnv({ ...BASE, BILLING_LEDGER_URL: undefined }), /BILLING_LEDGER_URL is required/)
})

test('THE LEDGER IS A URL, NOT A DATABASE: there is no second connection string', () => {
  // Rule 1, and AD-06. A shared connection string would make the ledger's constraint triggers
  // optional for anything holding it, which is the entire safety argument of that service.
  const keys = Object.keys(loadEnv(BASE))
  const urls = keys.filter((key) => /database/i.test(key))
  assert.deepEqual(urls, ['databaseUrl', 'databasePoolMax'])
  assert.match(loadEnv(BASE).ledgerBaseUrl, /^https?:\/\//)
})

test('a ledger URL that is not absolute is refused rather than silently relative', () => {
  assert.throws(() => loadEnv({ ...BASE, BILLING_LEDGER_URL: 'ledger:4000' }), /absolute http/)
})

test('the ledger token is a secret, so a placeholder is refused', () => {
  assert.throws(() => loadEnv({ ...BASE, BILLING_LEDGER_TOKEN: 'changeme' }), /known placeholder/)
  assert.throws(() => loadEnv({ ...BASE, BILLING_LEDGER_TOKEN: 'short' }), /at least 24 characters/)
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'placeholder' }), /known placeholder/)
})

test('purchases are denominated in SHARD, which is not configurable', () => {
  // Payments are crypto-native: Shards are funded by on-chain deposit only, and there is no fiat
  // path to configure. Making the asset a variable would invite one.
  assert.equal(loadEnv(BASE).purchaseAsset, 'SHARD')
})

test('the ledger deadline is bounded at both ends', () => {
  // Too generous and a slow ledger holds a database connection per in-flight purchase — the
  // posting happens inside the purchase transaction. Too tight and a healthy retry never lands.
  assert.equal(loadEnv(BASE).ledgerDeadlineMs, 5_000)
  assert.throws(() => loadEnv({ ...BASE, BILLING_LEDGER_DEADLINE_MS: '100' }), /between 250 and 30000/)
  assert.throws(() => loadEnv({ ...BASE, BILLING_LEDGER_DEADLINE_MS: '60000' }), /between 250 and 30000/)
})

test('the idempotency TTL cannot be set to zero days', () => {
  // Expiring a key EARLY means the next replay of it buys the thing a second time.
  assert.throws(() => loadEnv({ ...BASE, BILLING_IDEMPOTENCY_TTL_DAYS: '0' }), /between 1 and 3650/)
  assert.equal(loadEnv(BASE).idempotencyTtlDays, 30)
})

test('LOG_LEVEL is a closed set', () => {
  assert.throws(() => loadEnv({ ...BASE, LOG_LEVEL: 'verbose' }), /LOG_LEVEL must be one of/)
})

/* ------------------------------------------------------------------ the engagement fee recycle */

test('no ADMIN_API_URL is a supported mode, not a missing variable', () => {
  // docs/ecosystem/21 §3. Unconfigured means this deployment runs no engagement programme, which
  // is a true statement rather than a fault — the notify-SMTP discipline. Requiring it would make
  // every deployment without an operator surface refuse to boot.
  assert.equal(loadEnv(BASE).adminApiBaseUrl, null)
  assert.equal(loadEnv(BASE).adminApiToken, null)
})

test('an ADMIN_API_URL without a token is refused AT BOOT, not hourly inside a job', () => {
  assert.throws(
    () => loadEnv({ ...BASE, ADMIN_API_URL: 'http://admin-api.test:4000' }),
    /BILLING_ADMIN_API_TOKEN is required/,
  )
  const configured = loadEnv({
    ...BASE,
    ADMIN_API_URL: 'http://admin-api.test:4000',
    BILLING_ADMIN_API_TOKEN: 'A3kL9mZ2qW7xR4bV6nP1sD8jH5fG0yTc',
  })
  assert.equal(configured.adminApiBaseUrl, 'http://admin-api.test:4000')
  assert.match(configured.adminApiToken ?? '', /^A3kL/)
})

test('the admin-api URL must be absolute, and its token is a secret', () => {
  assert.throws(() => loadEnv({ ...BASE, ADMIN_API_URL: 'admin-api:4000' }), /absolute http/)
  assert.throws(
    () => loadEnv({ ...BASE, ADMIN_API_URL: 'http://admin-api.test:4000', BILLING_ADMIN_API_TOKEN: 'changeme' }),
    /known placeholder/,
  )
})

test('THE PERCENTAGE IS NOT AN ENVIRONMENT VARIABLE', () => {
  // 21 §6 makes the fee-recycle rate an approval-gated action: raising it needs two operators.
  // A variable here would be a third way to raise it — one that needs a deploy and no approval,
  // and that nothing in admin-api's audit trail would ever record.
  const keys = Object.keys(loadEnv(BASE))
  assert.deepEqual(
    keys.filter((key) => /recycl|bps|percent/i.test(key)),
    [],
    'the rate lives in admin-api and is read at run time, never configured here',
  )
})
