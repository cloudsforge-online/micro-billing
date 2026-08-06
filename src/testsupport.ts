/**
 * Shared setup for the database tests, and the local ledger fake.
 *
 * **A database test runs only against a database whose name says it is a test database.** That is
 * not a convenience: `resetBilling` truncates every table in the schema, and requiring "test" in
 * the name is the difference between a red build and an emptied environment.
 *
 * **No test in this repository requires a running ledger.** `fakeLedger` below is the whole
 * counterparty. It is not a stub that returns a fixed id — it reproduces the two behaviours the
 * purchase path actually depends on:
 *
 *   1. **A repeated idempotency key returns the SAME entry, marked `replayed`.** That is what
 *      makes "one purchase posts exactly one entry" testable, and it is the real ledger's
 *      behaviour (`withIdempotency` there stores the response and replays it).
 *   2. **A reversal is a new entry that names the one it reverses.** A correction is never an
 *      edit, so a refund test can assert on both the original and its mirror.
 *
 * It also records every call, so a test can count entries rather than infer them from a balance
 * it would otherwise have to fake as well.
 *
 * Not a test file itself — it is excluded from the build and contains no `test()` call.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { chainSpec, coinAmountForUsdCents } from '@cloudsforge/contracts-chain'
import { EVENT_ID_HEADER, SIGNATURE_HEADER, signDelivery } from '@cloudsforge/contracts-events'
import { RateUnavailableError, type PricingClient } from './pricingclient.ts'
import { MIGRATIONS } from './migrations.ts'
import {
  InsufficientFundsError,
  LedgerUnavailableError,
  type LedgerClient,
  type PostEntryRequest,
  type PostedEntry,
  type ReverseEntryRequest,
} from './ledger.ts'

const url = process.env['BILLING_TEST_DATABASE_URL']

/** Both halves are required: a URL, and a URL that names a test database. */
export const enabled = Boolean(url && /test/i.test(url))

export const skip = enabled ? false : 'set BILLING_TEST_DATABASE_URL (name must contain "test")'

/** Every table this service owns. Order does not matter because CASCADE is used. */
const ALL_TABLES = [
  'engagement_fee_recycles',
  'invoice_lines',
  'invoices',
  'usage_records',
  'payouts',
  'entitlements',
  'subscriptions',
  'purchases',
  'idempotency_keys',
  'outbox_deliveries',
  'event_subscriptions',
  'outbox',
  'inbox',
  'jobs',
].join(', ')

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled')
  return postgres(url!, { max, onnotice: () => {} })
}

/**
 * Bring the schema up. Idempotent, so every test file may call it and only the first does work.
 *
 * Deliberately runs the real `MIGRATIONS` rather than a hand-written fixture schema. A fixture
 * would let the CHECK constraints — the scope shape, the payout arithmetic — drift away from the
 * tests that are supposed to prove they hold.
 */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'billing-test' })
}

/**
 * Empty every table, then put the seeded catalogue back.
 *
 * The catalogue is part of the schema, not of any one test's fixture: a suite that truncated it
 * away would be testing a database shape no deployment ever has.
 */
export async function resetBilling(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${ALL_TABLES} restart identity cascade`)
  const seed = MIGRATIONS.find((m) => m.name === 'seed_catalogue')
  if (!seed) throw new Error('the catalogue seed migration is missing')
  await sql.unsafe(redenominated(seed.up))
}

/**
 * Migration 9's seed, as migration 11 leaves it: priced in USD cents rather than Shards.
 *
 * ── WHY THIS TRANSFORM EXISTS AND IS NOT A HACK ───────────────────────────────────────────────
 *
 * `resetBilling` truncates and replays the seed to give each test file a known catalogue. Migration
 * 9 is immutable — `@cloudsforge/db` checksums it — so its text still says `'SHARD'`, and migration
 * 11 added a CHECK (`prices_no_new_shard`) that refuses a new ACTIVE Shard price. Replaying the
 * seed verbatim therefore now fails, and it SHOULD: the constraint caught this fixture on the first
 * run after it was added, which is the constraint working.
 *
 * The transform is the same one migration 11 argues at length, applied to text instead of rows: at
 * the documented peg of 100 Shards to the dollar, one Shard is exactly one cent, so ONLY the asset
 * code changes and the integer stays put. 250 Shards was $2.50; 250 cents is $2.50.
 *
 * Substituting the code rather than writing a fresh seed here is deliberate — a hand-written copy
 * of the product list would drift from migration 9 the first time a SKU is added, and a fixture
 * that disagrees with the schema is worse than no fixture. `migrations.test.ts` asserts the
 * post-reset catalogue holds no active Shard price and the expected USD amounts, so if this
 * transform ever stops matching what migration 11 does, that test fails rather than this quietly
 * seeding something production would never contain.
 */
function redenominated(seedSql: string): string {
  // The seed names the asset exactly once, in the prices insert. Asserted rather than assumed:
  // a silent zero-replacement would seed an empty catalogue and every test would fail obscurely.
  const occurrences = seedSql.match(/'SHARD'/g)?.length ?? 0
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly one 'SHARD' literal in the catalogue seed, found ${occurrences} — ` +
        'migration 9 changed shape, so this transform can no longer be trusted',
    )
  }
  return seedSql.replace("'SHARD'", "'USD'")
}

/* ------------------------------------------------------------------ fixtures */

export const ALICE_ID = '11111111-1111-4111-8111-111111111111'
export const BOB_ID = '22222222-2222-4222-8222-222222222222'
export const ALICE = `user:${ALICE_ID}`
export const BOB = `user:${BOB_ID}`

/**
 * The secret the test server accepts event deliveries under.
 *
 * GENERATED per run, because a fixture that would be rejected by the real `loadEnv` is a fixture
 * testing a configuration no deploy can have. The bar it has to clear moved: `parseSecretList` now
 * holds every entry to `assertGeneratedSecret`, so the written literal that used to sit here —
 * 34 characters, hyphenated, and therefore not base64 — would be refused at boot even though it
 * cleared the old 24-character floor. That gap between "passes the fixture" and "passes the
 * deploy" is exactly what micro-org #142 lived in.
 */
export const EVENT_SECRET = randomBytes(48).toString('base64')

/**
 * An envelope signed the way identity's relay signs it, and the reason this helper exists at all.
 *
 * `signDelivery` is imported from the CONTRACT rather than reimplemented here. A hand-rolled signer
 * in the test fixture would pass against a hand-rolled verifier in the service and both could be
 * wrong together — which is exactly the failure that would leave every real erasure event rejected
 * while the suite stayed green.
 */
export function signedEvent(
  topic: string,
  payload: Record<string, unknown>,
  options: { readonly id?: string; readonly key?: string; readonly secret?: string } = {},
): { readonly body: string; readonly headers: Record<string, string> } {
  const id = options.id ?? randomUUID()
  const body = JSON.stringify({
    id,
    topic,
    key: options.key ?? String(payload['userId'] ?? id),
    occurredAt: new Date().toISOString(),
    producer: 'identity',
    version: 1,
    actor: null,
    correlationId: null,
    payload,
  })
  return {
    body,
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signDelivery(body, options.secret ?? EVENT_SECRET),
      [EVENT_ID_HEADER]: id,
    },
  }
}

let counter = 0

/** A unique idempotency key per call, so tests never collide on a reused key by accident. */
export function freshKey(prefix = 'k'): string {
  counter += 1
  return `${prefix}-${process.pid}-${Date.now()}-${counter}`
}

/* ------------------------------------------------------------------ the ledger fake */

export interface RecordedEntry {
  readonly id: string
  readonly kind: string
  readonly idempotencyKey: string
  readonly actor: string
  readonly reversesEntryId: string | null
  readonly postings: PostEntryRequest['postings']
}

export interface FakeLedger extends LedgerClient {
  /** Every entry that exists, in the order it was created. Replays do not add one. */
  readonly entries: RecordedEntry[]
  /** How many calls arrived, including the ones answered from a stored response. */
  readonly calls: number
  /** Make the next N posts fail as the subject being unable to pay. */
  refuseFunds(times?: number): void
  /** Make the next N posts fail as an unreachable ledger. */
  goDown(times?: number): void
  entriesFor(idempotencyKey: string): RecordedEntry[]
}

/**
 * A ledger that behaves like the real one on the two axes the purchase path depends on.
 *
 * Written as a real object rather than a mocking library on purpose: the behaviour under test is
 * "the same key posts once", and a library that records calls would let a test pass while the
 * second call posted a second entry.
 */
export function fakeLedger(): FakeLedger {
  const byKey = new Map<string, RecordedEntry>()
  const entries: RecordedEntry[] = []
  let calls = 0
  let refuseFor = 0
  let downFor = 0
  let sequence = 0

  const nextId = () => {
    sequence += 1
    return `entry-${sequence.toString().padStart(6, '0')}`
  }

  const claim = (
    idempotencyKey: string,
    build: (id: string) => RecordedEntry,
  ): PostedEntry => {
    const existing = byKey.get(idempotencyKey)
    // The real ledger replays a stored response rather than posting again. Reproducing that here
    // is what makes a retry of a purchase safe in the test as well as in production.
    if (existing) return { id: existing.id, replayed: true }
    const entry = build(nextId())
    byKey.set(idempotencyKey, entry)
    entries.push(entry)
    return { id: entry.id, replayed: false }
  }

  const guard = () => {
    if (downFor > 0) {
      downFor -= 1
      throw new LedgerUnavailableError('the ledger is not answering')
    }
    if (refuseFor > 0) {
      refuseFor -= 1
      throw new InsufficientFundsError('SHARD available balance would go negative')
    }
  }

  return {
    entries,
    get calls() {
      return calls
    },
    refuseFunds(times = 1) {
      refuseFor = times
    },
    goDown(times = 1) {
      downFor = times
    },
    entriesFor(idempotencyKey: string) {
      return entries.filter((entry) => entry.idempotencyKey === idempotencyKey)
    },

    async postEntry(request: PostEntryRequest): Promise<PostedEntry> {
      calls += 1
      guard()
      return claim(request.idempotencyKey, (id) => ({
        id,
        kind: request.kind,
        idempotencyKey: request.idempotencyKey,
        actor: request.actor,
        reversesEntryId: null,
        postings: request.postings,
      }))
    },

    async reverseEntry(entryId: string, request: ReverseEntryRequest): Promise<PostedEntry> {
      calls += 1
      guard()
      const original = entries.find((entry) => entry.id === entryId)
      if (!original) throw new LedgerUnavailableError(`no entry ${entryId}`)
      return claim(request.idempotencyKey, (id) => ({
        id,
        kind: 'reversal',
        idempotencyKey: request.idempotencyKey,
        actor: request.actor,
        // A correction is a NEW entry that names the original, never an edit of it.
        reversesEntryId: entryId,
        postings: original.postings.map((posting) => ({
          ...posting,
          direction: posting.direction === 'debit' ? ('credit' as const) : ('debit' as const),
        })),
      }))
    },
  }
}

/**
 * A pricing client that converts at a fixed, stated rate.
 *
 * The default is EMBER's real administered price — 0.25 USD, `pricing/src/migrations.ts` —
 * so a test's arithmetic is the arithmetic production will do, not a rounder number chosen to make
 * the assertions tidy. At 0.25 USD, $2.50 is exactly 10 EMBER.
 *
 * It calls the real `coinAmountForUsdCents` rather than reimplementing the conversion, because a
 * fake that does its own maths is a fake that can agree with a broken implementation.
 */
export function fakePricing(options: { usdScaled?: bigint; fail?: string } = {}): PricingClient & {
  readonly calls: () => number
} {
  const usdScaled = options.usdScaled ?? 250_000n
  let calls = 0
  return {
    calls: () => calls,
    async quote(asset, cents) {
      calls += 1
      if (options.fail) throw new RateUnavailableError(options.fail)
      return { usdScaled, amount: coinAmountForUsdCents(cents, chainSpec(asset).decimals, usdScaled) }
    },
  }
}

/**
 * What a price in US cents settles to in EMBER wei, at `fakePricing`'s default rate.
 *
 * Tests assert against this rather than against a copied literal so that the expectation and the
 * conversion cannot disagree — and so that the numbers in a test stay readable as the DOLLAR
 * amounts they came from. `emberFor(250n)` says "the $2.50 cape" in a way that
 * `10000000000000000000n` does not.
 */
export function emberFor(cents: bigint, usdScaled = 250_000n): bigint {
  return coinAmountForUsdCents(cents, chainSpec('EMBER').decimals, usdScaled)
}
