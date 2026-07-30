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

import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
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
  await sql.unsafe(seed.up)
}

/* ------------------------------------------------------------------ fixtures */

export const ALICE_ID = '11111111-1111-4111-8111-111111111111'
export const BOB_ID = '22222222-2222-4222-8222-222222222222'
export const ALICE = `user:${ALICE_ID}`
export const BOB = `user:${BOB_ID}`

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
