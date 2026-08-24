import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertIssuable, isRetiredAsset } from '@cloudsforge/contracts-chain'
import { randomBytes } from 'node:crypto'

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
  // GENERATED, not written. `assertGeneratedSecret` refuses a typed value, and a fixture
  // exempt from the rule it is meant to exercise is how the placeholder in micro-org #142
  // survived every test in the estate. The literal that used to sit here was 32 characters
  // but only 24 BYTES, and is now refused — see the case that names it.
  OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64'),
  BILLING_LEDGER_URL: 'http://ledger.test:4000',
  BILLING_PRICING_URL: 'http://pricing.test:4000',
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

test('THE LEDGER IS A URL, NOT A DATABASE: no connection string reaches another service', () => {
  // Rule 1, and AD-06. A shared connection string would make the ledger's constraint triggers
  // optional for anything holding it, which is the entire safety argument of that service.
  //
  // The list grew by one on the network consolidation: `databaseUrlTestnet` is BILLING'S OWN
  // database on the other estate, which is the same service holding the same schema behind the
  // same triggers. It is not a second service's store, and that is the distinction this test
  // exists to police — so it is pinned by name rather than by count, and a third entry appearing
  // still has to be justified here.
  const keys = Object.keys(loadEnv(BASE))
  const urls = keys.filter((key) => /database/i.test(key))
  assert.deepEqual(urls, ['databaseUrl', 'databaseUrlTestnet', 'databasePoolMax'])
  assert.match(loadEnv(BASE).ledgerBaseUrl, /^https?:\/\//)
})

test('a ledger URL that is not absolute is refused rather than silently relative', () => {
  assert.throws(() => loadEnv({ ...BASE, BILLING_LEDGER_URL: 'ledger:4000' }), /absolute http/)
})

test('the identity credential is held to a CREDENTIAL shape, not to a deny-list', () => {
  // BILLING_LEDGER_TOKEN was the subject here. It is retired — a 600-second token read once at
  // boot — and the credential that replaced it was still on the deny-list guard until micro-org
  // #212: a fixed set of exact strings plus a 24-character floor.
  //
  // THIS TEST USED TO ASSERT THAT GUARD'S MESSAGES, which is why it never went red while the guard
  // could not fail. It now asserts REFUSAL of values the deny-list passed.
  assert.throws(
    () => loadEnv({ ...BASE, BILLING_IDENTITY_CREDENTIAL: 'changeme' }),
    /BILLING_IDENTITY_CREDENTIAL/,
  )
  assert.throws(() => loadEnv({ ...BASE, BILLING_IDENTITY_CREDENTIAL: 'short' }), /BILLING_IDENTITY_CREDENTIAL/)

  // 40 characters, on no deny-list, and the literal that was live on 44 containers. The old guard
  // passed it here; a credential guard refuses it because it carries no `cfsc_` prefix.
  assert.throws(
    () => loadEnv({ ...BASE, BILLING_IDENTITY_CREDENTIAL: 'estate-only-outbox-secret-00000000000000' }),
    /not a service credential/,
  )
  // The prefix is not the credential. Long enough and varied enough to clear the byte and entropy
  // floors — only the marker check on the BODY refuses it.
  assert.throws(
    () => loadEnv({ ...BASE, BILLING_IDENTITY_CREDENTIAL: 'cfsc_ci-only-Xq7Zm2Bv9Kd4Rt6Yw1Ns3Hj5Lp8Fg0Ac2De4Uz' }),
    /reads as a placeholder/,
  )
  // A JWT in a credential slot is a ten-minute bearer read once at boot — micro-org #197/#222.
  assert.throws(
    () => loadEnv({ ...BASE, BILLING_IDENTITY_CREDENTIAL: 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJiaWxsaW5nIn0.AAAA' }),
    /carries a TOKEN, not a credential/,
  )
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'placeholder' }), /known placeholder/)
})

test('THE VALUE THAT SAT IN A PUBLIC REPOSITORY IS REFUSED, and every near miss with it', () => {
  // micro-org #142. Each of these cleared the old guard — a deny-list of exact strings plus a
  // 24-character floor — and each is a real string that was deployed or set in CI, not an invented
  // one. The first was live on 44 containers across both networks. If a future edit weakens the
  // floor, it fails against evidence rather than against taste.
  for (const value of [
    'estate-only-outbox-secret-00000000000000', // 54 lines of a PUBLIC compose file, 40 chars
    'ci-only-not-a-real-secret-000000000000', // this repository's own former smoke-env value
    'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4', // this file's own former fixture: 32 chars, 24 bytes
    '0'.repeat(64), // right alphabet, right length, no entropy
  ]) {
    assert.throws(
      () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: value }),
      (err: unknown) => {
        // The refusal must not echo the value: the reason this guard exists is that the value was
        // readable, and a message carrying it moves the secret to the log collector.
        const message = (err as Error).message
        assert.ok(!message.includes(value), 'the refusal echoed the value')
        assert.match(message, /OUTBOX_SIGNING_SECRET/)
        assert.match(message, /openssl rand -base64 48/)
        return true
      },
    )
    // AND THE ACCEPT LIST TOO. The signing key is what this service SENDS under; the accept list
    // is what it will BELIEVE. A rotation window that admits the leaked value is the whole defect
    // wearing a rotation's clothes, so the list gets the identical bar.
    assert.throws(
      () => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: value }),
      (err: unknown) => {
        const message = (err as Error).message
        assert.ok(!message.includes(value), 'the refusal echoed the value')
        assert.match(message, /OUTBOX_ACCEPT_SECRETS/)
        assert.match(message, /openssl rand -base64 48/)
        return true
      },
    )
  }
})

test('an unset signing secret is a refusal to boot, never a service that signs with nothing', () => {
  // `policy` was found running with this variable UNSET — measured at zero characters — while its
  // /livez stayed green. An empty value must reach `required`, not the shape guard, so the message
  // names the variable rather than describing an alphabet.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: undefined }),
    /OUTBOX_SIGNING_SECRET is required/,
  )
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: '   ' }), /OUTBOX_SIGNING_SECRET is required/)
})

test('a generated secret is accepted, in either alphabet, alone or as a rotation window', () => {
  const outgoing = randomBytes(48).toString('base64')
  const incoming = randomBytes(48).toString('base64')
  assert.doesNotThrow(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: outgoing }))
  assert.doesNotThrow(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: randomBytes(32).toString('hex') }))

  // The rotation window this variable exists for: both keys accepted, newest first, while
  // producers cut over one service at a time.
  const rotating = loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${incoming},${outgoing}` })
  assert.deepEqual(rotating.acceptSecrets, [incoming, outgoing])

  // Unset still means "just the signing key", so a deploy that ignores the variable is unchanged.
  assert.deepEqual(loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: outgoing }).acceptSecrets, [outgoing])

  // And a repeated entry is still refused: "which key verified this" is what tells an operator a
  // rotation has finished, and a duplicate makes that unanswerable.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${incoming},${incoming}` }),
    /lists the same secret twice/,
  )
})

test('purchases are priced in USD and settled in EMBER, neither configurable', () => {
  // Payments are crypto-native and settlement is on-chain-backed: EMBER, not the retired SHARD,
  // because a Shard balance was liability no chain stood behind. Making either a variable would
  // invite a deployment that priced in one thing and charged in another.
  //
  // USD is the PRICE unit only. It never reaches a posting — see `purchases.ts`, where
  // `purchasePostings` is given `settlementAsset` — so this does not reintroduce the Shard defect
  // under a different name.
  assert.equal(loadEnv(BASE).priceAsset, 'USD')
  assert.equal(loadEnv(BASE).settlementAsset, 'EMBER')
})

test('the settlement asset cannot be a retired one — the type is the enforcement', () => {
  // `settlementAsset` is `IssuableAssetCode`, i.e. `Exclude<AssetCode, 'SHARD'>`. There is no
  // runtime branch to exercise here because there is no runtime branch: restoring 'SHARD' in
  // env.ts does not compile. What IS checked is that the value never became a retired asset by
  // some other route, and that contracts-chain agrees about which assets those are.
  assert.equal(isRetiredAsset(loadEnv(BASE).settlementAsset), false)
  assert.equal(isRetiredAsset('SHARD'), true)
  assert.throws(() => assertIssuable('SHARD'), /retired/)
})

test('pricing is required, because a purchase cannot be priced without it', () => {
  // Unlike ADMIN_API_URL, which is optional and means "this deployment runs no engagement
  // programme". An absent pricing URL does not mean a deployment does without pricing; it means
  // every purchase fails at the moment of payment. That belongs at boot, naming the variable.
  const { BILLING_PRICING_URL: _omitted, ...without } = BASE
  assert.throws(() => loadEnv(without), /BILLING_PRICING_URL/)
  assert.throws(
    () => loadEnv({ ...BASE, BILLING_PRICING_URL: 'pricing:4000' }),
    /must be an absolute http\(s\) URL/,
  )
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
})

test('an ADMIN_API_URL no longer needs a SECOND secret — one credential mints both scopes', () => {
  // BILLING_ADMIN_API_TOKEN used to be required alongside the URL, and was refused at boot without
  // it. Both it and BILLING_LEDGER_TOKEN were 600-second tokens read once at boot. Identity reads
  // the service off the credential ROW and never off the request, so one credential mints
  // everything billing is allowed and the scope set is a request parameter, not a second secret.
  const configured = loadEnv({ ...BASE, ADMIN_API_URL: 'http://admin-api.test:4000' })
  assert.equal(configured.adminApiBaseUrl, 'http://admin-api.test:4000')
})

test('the admin-api URL must be absolute', () => {
  assert.throws(() => loadEnv({ ...BASE, ADMIN_API_URL: 'admin-api:4000' }), /absolute http/)
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

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * The credential that replaced BILLING_LEDGER_TOKEN and BILLING_ADMIN_API_TOKEN.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

test('the identity credential is read, and its absence is a null rather than a throw', () => {
  // THE BODY CARRIES A HYPHEN ON PURPOSE. A credential body is base64**url**, and measured live on
  // 2026-08-06 one estate's body contains a hyphen for a given variable while the other's does not
  // — `MINT_IDENTITY_CREDENTIAL` has one on mainnet and none on testnet, `NDA_IDENTITY_CREDENTIAL`
  // the other way round. A "no hyphens" rule reads as obviously right, passes one estate and kills
  // the other at boot; this fixture makes that regression fail CI instead.
  //
  // The literal that used to sit here, `cfsc_a-long-lived-credential-that-does-not-expire`, is a
  // TYPED English phrase: 43 characters and 32 bytes, but 3.785 bits per character, below the 4.0
  // floor. It is now correctly refused, and a fixture exempt from the rule it exercises is how the
  // placeholder in micro-org #142 survived every test in the estate.
  const CREDENTIAL = 'cfsc_vFpu5q-4UwZTvGSezkD9nTOy8r6lxWbhIBm8eaJoXiE'
  assert.equal(
    loadEnv({ ...BASE, BILLING_IDENTITY_CREDENTIAL: CREDENTIAL }).identityCredential,
    CREDENTIAL,
  )
  // Absent must LOAD — the image has to boot without one so the CI smoke test can read /livez —
  // and is caught by the hard `identity-credential` readiness probe instead.
  assert.equal(loadEnv(BASE).identityCredential, null)
})

test('identityUrl derives from the issuer, and IDENTITY_URL overrides it', () => {
  assert.equal(loadEnv(BASE).identityUrl, BASE['IDENTITY_ISSUER'])
  assert.equal(
    loadEnv({ ...BASE, IDENTITY_URL: 'http://identity.internal:4000' }).identityUrl,
    'http://identity.internal:4000',
  )
})

test('either retired token being set is reported rather than obeyed', () => {
  assert.equal(loadEnv(BASE).legacyServiceTokenPresent, false)
  const legacyLedger = loadEnv({ ...BASE, BILLING_LEDGER_TOKEN: 'retired-ignored-see-src-env-ts' })
  assert.equal(legacyLedger.legacyServiceTokenPresent, true)
  // And it confers nothing: setting it must not make the service look configured.
  assert.equal(legacyLedger.identityCredential, null)
  assert.equal(
    loadEnv({ ...BASE, BILLING_ADMIN_API_TOKEN: 'A3kL9mZ2qW7xR4bV6nP1sD8jH5fG0yTc' })
      .legacyServiceTokenPresent,
    true,
  )
})
