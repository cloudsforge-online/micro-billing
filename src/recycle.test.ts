/**
 * The engagement fee recycle — docs/ecosystem/21 §3 and §7.5, against the real tables.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * The properties this file exists to hold, and where each is enforced:
 *
 *   §7.5  "The fee-recycle percentage cannot exceed its schema ceiling." Proved by writing
 *         ceiling-plus-one through the same connection every handler uses and watching the
 *         CHECK refuse it — the same shape admin-api proves its own ceilings in.
 *         **And by the ceilings agreeing**: if admin-api ever publishes a different one, nothing
 *         recycles and the sentence names both numbers.
 *
 *   §7.4  "Every engagement grant resolves to a ledger entry pair; a grant with no posting
 *         cannot exist." For this leg it is the posted/entry-id pairing, enforced both ways by
 *         `engagement_fee_recycles_posted_names_entry`.
 *
 *   The starting rate  0 bps, taken from 21's closing open decision. Nothing here defaults to a
 *         rate; an unreadable rate is a refusal, never a zero, because a recycle of 0 and a
 *         recycle that could not be read look identical in the ledger.
 *
 *   The arithmetic  floor, always, and never a wei over the configured share — a wei and not a
 *         Shard, which is what this line said until 2026-08-10, because the recycle moves
 *         `settlementAsset` and that is EMBER (src/env.ts, typed `IssuableAssetCode`). It is a
 *         GENERATED column, so this suite asserts what the DATABASE computed rather than what
 *         the handler thought.
 *
 *   The unit  wei, in the columns AND in the durable ledger metadata. micro-org#336: the table
 *         held EMBER wei under `*_shards` names and the recycle wrote those names into the
 *         permanent audit of the entry it posted. The last describe below is the guard, and it
 *         reads the LIVE schema and the ACTUAL request rather than the source, because the
 *         defect survived a green suite by living where no assertion looked.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import {
  FEE_RECYCLE_CEILING_BPS,
  FeeRecycleUnavailableError,
  readRate,
  type EngagementPolicyClient,
} from './adminapi.ts'
import { feeRecyclePostings, LedgerUnavailableError, InsufficientFundsError } from './ledger.ts'
import {
  claimPeriod,
  duePeriods,
  listRecycles,
  periodBasis,
  recycleIdempotencyKey,
  runRecycle,
  settleRecycle,
  type RecycleDeps,
} from './recycle.ts'
import { purchase, type PurchaseDeps } from './purchases.ts'
import { requestFingerprint } from './idempotency.ts'
import {
  ALICE,
  enabled,
  fakeLedger,
  freshKey,
  migrateTestDb,
  openDb,
  resetBilling,
  skip,
  type FakeLedger,
  fakePricing,
  emberFor,
} from './testsupport.ts'
import type { Db } from './outbox.ts'

let sql: postgres.Sql
let db: Db
let ledger: FakeLedger

before(async () => {
  if (!enabled) return
  sql = openDb(8)
  db = sql as unknown as Db
  await migrateTestDb(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetBilling(sql)
  ledger = fakeLedger()
})

/** Mid-morning on the 3rd, so the closed periods are the 1st and the 2nd. */
const NOW = new Date('2026-08-03T10:00:00.000Z')
const DAY_1 = new Date('2026-08-01T00:00:00.000Z')
const DAY_2 = new Date('2026-08-02T00:00:00.000Z')
const DAY_3 = new Date('2026-08-03T00:00:00.000Z')

/** An admin-api that answers a fixed rate, or refuses. No HTTP anywhere in this suite. */
function policyClient(rate: number | Error): EngagementPolicyClient {
  return {
    async feeRecycleRate() {
      if (rate instanceof Error) throw rate
      return { recycleBps: rate, ceilingBps: FEE_RECYCLE_CEILING_BPS }
    },
  }
}

function deps(overrides: Partial<RecycleDeps> = {}): RecycleDeps {
  return {
    sql: db,
    ledger,
    logger: new Logger({ service: 'billing-test', level: 'error' }),
    metrics: new Metrics(),
    producer: 'billing',
    assetCode: 'EMBER',
    adminApi: policyClient(0),
    ...overrides,
  }
}

/** A completed purchase, backdated — the ordinary way fee revenue arrives in a period. */
async function buy(at: Date, sku = 'cosmetic.ember-cape', quantity = 1n): Promise<void> {
  const purchaseDeps: PurchaseDeps = { sql: db, ledger, producer: 'billing', priceAsset: 'USD', settlementAsset: 'EMBER', pricing: fakePricing() }
  const request = {
    subject: ALICE,
    sku,
    quantity,
    idempotencyKey: freshKey(),
    correlationId: 'corr-recycle',
    actor: `user:${ALICE}`,
  }
  const outcome = await purchase(purchaseDeps, request, requestFingerprint(request))
  // `created_at` defaults to now(); the tests are about which PERIOD revenue falls in, so the row
  // is moved rather than the clock. Only this column matters to `periodBasis`.
  await sql`update purchases set created_at = ${at} where id = ${outcome.result.purchase.id}`
}

/* ══════════════════════════════════════════════════════ the ceiling, in the schema */

describe('§7.5 — the percentage cannot exceed its schema ceiling', () => {
  test('the constant and the CHECK are the same number, proved against the live constraint', { skip }, async () => {
    // At the ceiling: accepted.
    await sql`
      insert into engagement_fee_recycles (asset_code, period_start, period_end, gross_wei, refunded_wei, recycle_bps)
      values ('EMBER', ${DAY_1}, ${DAY_2}, 0, 0, ${FEE_RECYCLE_CEILING_BPS})
    `
    // One basis point above it: refused by the database, not by a handler. This is the assertion
    // that keeps `FEE_RECYCLE_CEILING_BPS` honest — a drifting constant fails here.
    await assert.rejects(
      sql`
        insert into engagement_fee_recycles (asset_code, period_start, period_end, gross_wei, refunded_wei, recycle_bps)
        values ('EMBER', ${DAY_2}, ${DAY_3}, 0, 0, ${FEE_RECYCLE_CEILING_BPS + 1})
      `,
      /engagement_fee_recycles_within_ceiling/,
    )
  })

  test('a negative rate is refused too — a recycle is not a withdrawal', { skip }, async () => {
    await assert.rejects(
      sql`
        insert into engagement_fee_recycles (asset_code, period_start, period_end, gross_wei, refunded_wei, recycle_bps)
        values ('EMBER', ${DAY_1}, ${DAY_2}, 100, 0, -1)
      `,
      /engagement_fee_recycles_within_ceiling/,
    )
  })

  test('billing and admin-api cannot disagree about the ceiling without stopping', () => {
    // The read that would otherwise apply a rate under a ceiling this repository was never told
    // about. Refused, in the direction that stops rather than the one that guesses.
    assert.throws(
      () => readRate({ feeRecycle: { recycleBps: 100 }, ceilings: { feeRecycleBps: 5_000 } }),
      (err: unknown) =>
        err instanceof FeeRecycleUnavailableError && /must be the same number/.test(err.message),
    )
    // And a rate above OUR ceiling is refused whatever admin-api claims its ceiling is.
    assert.throws(
      () => readRate({ feeRecycle: { recycleBps: 9_000 }, ceilings: { feeRecycleBps: 9_000 } }),
      FeeRecycleUnavailableError,
    )
    assert.deepEqual(readRate({ feeRecycle: { recycleBps: 250 }, ceilings: { feeRecycleBps: 2_500 } }), {
      recycleBps: 250,
      ceilingBps: 2_500,
    })
  })

  test('an unreadable rate is a refusal, never a zero', () => {
    // A recycle of 0 and a recycle that could not be read are indistinguishable in the ledger and
    // mean opposite things about whether this pipeline works. Zero is also the recorded starting
    // rate, which is exactly why it must never be what a bad response degrades into.
    for (const body of [
      {},
      { feeRecycle: null, ceilings: { feeRecycleBps: 2_500 } },
      { feeRecycle: { recycleBps: '0' }, ceilings: { feeRecycleBps: 2_500 } },
      { feeRecycle: { recycleBps: 12.5 }, ceilings: { feeRecycleBps: 2_500 } },
      { feeRecycle: { recycleBps: 100 } },
    ]) {
      assert.throws(() => readRate(body), FeeRecycleUnavailableError, JSON.stringify(body))
    }
    // Zero itself is a real answer and must parse.
    assert.equal(readRate({ feeRecycle: { recycleBps: 0 }, ceilings: { feeRecycleBps: 2_500 } }).recycleBps, 0)
  })
})

/* ══════════════════════════════════════════════════════ the arithmetic is the database's */

describe('the amount is generated, floored, and never over the share', () => {
  test('floor, not round — 500 bps of 99,999 is 4,999 and not 5,000', { skip }, async () => {
    await sql`
      insert into engagement_fee_recycles (asset_code, period_start, period_end, gross_wei, refunded_wei, recycle_bps)
      values ('EMBER', ${DAY_1}, ${DAY_2}, 99999, 0, 500)
    `
    const [row] = await sql<{ amount: string }[]>`
      select amount_wei::text as amount from engagement_fee_recycles where period_start = ${DAY_1}
    `
    assert.equal(row?.amount, '4999', 'the recycle must never exceed the configured share')
  })

  test('refunds beyond the takings recycle nothing rather than draining the treasury', { skip }, async () => {
    await sql`
      insert into engagement_fee_recycles (asset_code, period_start, period_end, gross_wei, refunded_wei, recycle_bps)
      values ('EMBER', ${DAY_1}, ${DAY_2}, 10, 40, 2500)
    `
    const [row] = await sql<{ amount: string }[]>`
      select amount_wei::text as amount from engagement_fee_recycles where period_start = ${DAY_1}
    `
    // Reversing an engagement transfer is an operator decision with an approval behind it, not
    // something a background job does because a big refund landed on a quiet day.
    assert.equal(row?.amount, '0')
  })

  test('the amount cannot be written by hand — it is the schema that computes it', { skip }, async () => {
    await assert.rejects(
      sql`
        insert into engagement_fee_recycles
          (asset_code, period_start, period_end, gross_wei, refunded_wei, recycle_bps, amount_wei)
        values ('EMBER', ${DAY_1}, ${DAY_2}, 100, 0, 100, 99999)
      `,
      /non-DEFAULT value into column "amount_wei"/,
    )
  })
})

/* ══════════════════════════════════════════════════════ the pairing, both ways */

describe('§7.4 — a posted recycle names its entry, and only a posted one does', () => {
  test('an entry id without a posting is unrepresentable', { skip }, async () => {
    await assert.rejects(
      sql`
        insert into engagement_fee_recycles
          (asset_code, period_start, period_end, gross_wei, refunded_wei, recycle_bps, status, journal_entry_id)
        values ('EMBER', ${DAY_1}, ${DAY_2}, 100, 0, 100, 'pending', 'entry-000001')
      `,
      /engagement_fee_recycles_posted_names_entry/,
    )
  })

  test('a posting without an entry id is unrepresentable', { skip }, async () => {
    await assert.rejects(
      sql`
        insert into engagement_fee_recycles
          (asset_code, period_start, period_end, gross_wei, refunded_wei, recycle_bps, status)
        values ('EMBER', ${DAY_1}, ${DAY_2}, 100, 0, 100, 'posted')
      `,
      /engagement_fee_recycles_posted_names_entry/,
    )
  })

  test('a period with money in it cannot be recorded as skipped', { skip }, async () => {
    // Without this, a bug that skipped a fundable period would look exactly like a quiet day.
    await assert.rejects(
      sql`
        insert into engagement_fee_recycles
          (asset_code, period_start, period_end, gross_wei, refunded_wei, recycle_bps, status)
        values ('EMBER', ${DAY_1}, ${DAY_2}, 1000, 0, 500, 'skipped')
      `,
      /engagement_fee_recycles_skipped_moves_nothing/,
    )
  })
})

/* ══════════════════════════════════════════════════════ what a period is worth */

describe('periodBasis — every term is an entry billing actually posted', () => {
  test('purchases in the period, and not the ones on either side of it', { skip }, async () => {
    await buy(new Date('2026-08-01T09:00:00.000Z')) // 250, in
    await buy(new Date('2026-08-01T23:59:59.000Z'), 'convenience.extra-slot') // 400, in
    await buy(new Date('2026-08-02T00:00:00.000Z'), 'season.pass.s1') // 1000, next period
    await buy(new Date('2026-07-31T23:59:59.000Z'), 'cosmetic.ember-cape') // 250, previous

    const basis = await periodBasis(db, 'EMBER', DAY_1, DAY_2)
    assert.equal(basis.grossWei, emberFor(250n) + emberFor(400n), 'the period is half-open: [start, end)')
    assert.equal(basis.refundedWei, 0n)
  })

  test('a refund subtracts from the period it LANDED in, not the one that took the money', { skip }, async () => {
    await buy(new Date('2026-08-01T09:00:00.000Z'))
    // The reversal debits the same revenue account back on the day it happens, so that is the
    // period it belongs to. Attributing it to the sale's period would rewrite a period that has
    // already been recycled.
    await sql`update purchases set status = 'refunded', refunded_at = ${new Date('2026-08-02T09:00:00.000Z')}`

    const first = await periodBasis(db, 'EMBER', DAY_1, DAY_2)
    assert.equal(first.grossWei, emberFor(250n), 'the sale still happened that day')
    assert.equal(first.refundedWei, 0n)

    const second = await periodBasis(db, 'EMBER', DAY_2, DAY_3)
    assert.equal(second.grossWei, 0n)
    assert.equal(second.refundedWei, emberFor(250n))
  })

  test('a renewal invoice counts, and an invoice that moved nothing does not', { skip }, async () => {
    // Renewals write no purchase row — `renewSubscription` posts the charge and writes an invoice
    // — so the invoice is the record of that revenue. A draft or unpaid invoice has no entry id
    // and moved nothing, which is what the `journal_entry_id is not null` condition excludes.
    await sql`
      insert into invoices (subject, subscription_id, period_start, period_end, asset_code, total, status, journal_entry_id, created_at)
      values (${ALICE}, null, ${DAY_1}, ${DAY_2}, 'EMBER', ${emberFor(500n).toString()}::numeric, 'paid', 'entry-r1', ${DAY_1})
    `
    let basis = await periodBasis(db, 'EMBER', DAY_1, DAY_2)
    assert.equal(basis.grossWei, 0n, 'an invoice with no subscription is not a renewal')

    const [sub] = await sql<{ id: string }[]>`
      insert into subscriptions (subject, product_id, price_id, status, quantity, current_period_start, current_period_end)
      select ${ALICE}, p.id, pr.id, 'active', 1, ${DAY_1}, ${DAY_2}
        from products p join prices pr on pr.product_id = p.id
       where p.sku = 'guild.hall.monthly'
      returning id
    `
    await sql`
      insert into invoices (subject, subscription_id, period_start, period_end, asset_code, total, status, journal_entry_id, created_at)
      values (${ALICE}, ${sub!.id}, ${DAY_1}, ${DAY_2}, 'EMBER', ${emberFor(500n).toString()}::numeric, 'paid', 'entry-r2', ${DAY_1})
    `
    await sql`
      insert into invoices (subject, subscription_id, period_start, period_end, asset_code, total, status, journal_entry_id, created_at)
      values (${ALICE}, ${sub!.id}, ${DAY_1}, ${DAY_2}, 'EMBER', ${emberFor(900n).toString()}::numeric, 'open', null, ${DAY_1})
    `
    basis = await periodBasis(db, 'EMBER', DAY_1, DAY_2)
    assert.equal(basis.grossWei, emberFor(500n), 'only the renewal that posted an entry counts')
  })
})

/* ══════════════════════════════════════════════════════ which periods are due */

describe('duePeriods — closed days only, contiguous, oldest first', () => {
  test('today is never a candidate, however late in the day it is', { skip }, async () => {
    await buy(new Date('2026-08-01T09:00:00.000Z'))
    const due = await duePeriods(db, 'EMBER', new Date('2026-08-03T23:59:59.000Z'))
    assert.deepEqual(
      due.map((p) => p.periodStart.toISOString()),
      [DAY_1.toISOString(), DAY_2.toISOString()],
      'a period is only closed once it has fully elapsed',
    )
  })

  test('it resumes from the last recorded period, leaving no gap', { skip }, async () => {
    await buy(new Date('2026-08-01T09:00:00.000Z'))
    await sql`
      insert into engagement_fee_recycles (asset_code, period_start, period_end, gross_wei, refunded_wei, recycle_bps, status)
      values ('EMBER', ${DAY_1}, ${DAY_2}, 250, 0, 0, 'skipped')
    `
    const due = await duePeriods(db, 'EMBER', NOW)
    assert.deepEqual(
      due.map((p) => p.periodStart.toISOString()),
      [DAY_2.toISOString()],
      'a gap in the sequence would be revenue nothing ever considered',
    )
  })

  test('an empty deployment closes yesterday, so the pipeline is visibly alive', { skip }, async () => {
    const due = await duePeriods(db, 'EMBER', NOW)
    assert.equal(due.length, 1)
    assert.equal(due[0]?.periodStart.toISOString(), DAY_2.toISOString())
  })

  test('the run is bounded, so a long outage does not hold the lease across a year', { skip }, async () => {
    await buy(new Date('2025-08-01T09:00:00.000Z'))
    const due = await duePeriods(db, 'EMBER', NOW)
    assert.equal(due.length, 14, 'MAX_PERIODS_PER_RUN caps one pass; the rest is next run')
    assert.equal(due[0]?.periodStart.toISOString(), '2025-08-01T00:00:00.000Z')
  })
})

/* ══════════════════════════════════════════════════════ the run */

describe('runRecycle — at 0%, which is where 21 says to start', () => {
  test('every closed period is recorded, and not one wei moves', { skip }, async () => {
    await buy(new Date('2026-08-01T09:00:00.000Z'))
    await buy(new Date('2026-08-02T09:00:00.000Z'), 'season.pass.s1')

    const summary = await runRecycle(deps({ adminApi: policyClient(0) }), NOW)
    assert.equal(summary.skipped, 2)
    assert.equal(summary.posted, 0)
    assert.equal(ledger.entries.length, 2, 'the two entries are the PURCHASES; the recycle posted none')

    const rows = await listRecycles(db, 'EMBER', 10)
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.equal(row.status, 'skipped')
      assert.equal(row.journalEntryId, null)
      assert.equal(row.recycleBps, 0)
      assert.equal(row.amountWei, 0n)
    }
    // The basis is still recorded at 0%, which is the whole reason the rows are written: an
    // operator can see what the recycle WOULD have been before deciding to turn it on.
    assert.equal(rows.find((r) => r.periodStart.getTime() === DAY_1.getTime())?.grossWei, emberFor(250n))
    assert.equal(rows.find((r) => r.periodStart.getTime() === DAY_2.getTime())?.grossWei, emberFor(1000n))
  })

  test('the day the rate is raised, money moves with no deploy', { skip }, async () => {
    await buy(new Date('2026-08-01T09:00:00.000Z')) // the $2.50 cape, settled in EMBER wei
    const before = ledger.entries.length

    // 1000 bps = 10% of what $2.50 settled to, i.e. `emberFor(250n) / 10n` wei.
    const summary = await runRecycle(deps({ adminApi: policyClient(1_000) }), NOW)
    assert.equal(summary.posted, 1, 'the 1st had revenue')
    assert.equal(summary.skipped, 1, 'the 2nd had none')

    const entry = ledger.entries[before]
    assert.ok(entry, 'the recycle posted an entry')
    assert.equal(entry.kind, 'transfer', 'the same kind admin-api posts for engagement.transfer')
    assert.equal(entry.idempotencyKey, recycleIdempotencyKey('EMBER', DAY_1))

    // Revenue OUT, treasury IN — and the account types are the ones every other service already
    // uses for these two keys. A different `type` here would be refused by the ledger's
    // `AccountConflictError` in production while every fake in this repo happily accepted it.
    assert.deepEqual(
      entry.postings.map((p) => [p.direction, p.account.subject, p.account.purpose, p.account.type, p.amount]),
      [
        ['debit', 'platform', 'fees', 'revenue', emberFor(250n) / 10n],
        ['credit', 'platform:engagement-treasury', 'treasury', 'equity', emberFor(250n) / 10n],
      ],
    )

    const posted = (await listRecycles(db, 'EMBER', 10)).find((r) => r.status === 'posted')
    assert.equal(posted?.amountWei, emberFor(250n) / 10n)
    assert.equal(posted?.journalEntryId, entry.id)
  })

  test('a second run closes nothing twice, and posts no second entry', { skip }, async () => {
    await buy(new Date('2026-08-01T09:00:00.000Z'))
    await runRecycle(deps({ adminApi: policyClient(1_000) }), NOW)
    const after = ledger.entries.length

    const second = await runRecycle(deps({ adminApi: policyClient(1_000) }), NOW)
    assert.equal(second.posted, 0)
    assert.equal(second.skipped, 0)
    assert.equal(ledger.entries.length, after, 'one period, one entry, for ever')
    assert.equal((await listRecycles(db, 'EMBER', 10)).length, 2)
  })

  test('a lost ledger answer leaves the row pending and the retry replays the same key', { skip }, async () => {
    await buy(new Date('2026-08-01T09:00:00.000Z'))
    ledger.goDown(1)

    const first = await runRecycle(deps({ adminApi: policyClient(1_000) }), NOW)
    assert.equal(first.deferred, 1, 'an unknown outcome is not a refusal')
    const pending = (await listRecycles(db, 'EMBER', 10)).find((r) => r.periodStart.getTime() === DAY_1.getTime())
    assert.equal(pending?.status, 'pending')
    assert.equal(pending?.journalEntryId, null, 'a row that never posted names no entry')

    // The next pass re-sends the identical key, and the basis is the one the first pass recorded
    // rather than one recomputed against a table that may have moved since.
    const second = await runRecycle(deps({ adminApi: policyClient(1_000) }), NOW)
    assert.equal(second.resolved, 1)
    const settled = (await listRecycles(db, 'EMBER', 10)).find((r) => r.periodStart.getTime() === DAY_1.getTime())
    assert.equal(settled?.status, 'posted')
    assert.equal(ledger.entriesFor(recycleIdempotencyKey('EMBER', DAY_1)).length, 1)
  })

  test('an outstanding row is finished even when admin-api cannot be reached', { skip }, async () => {
    // Its rate and basis were decided when it was written. Needing a fresh rate to finish it
    // would let an operator-surface outage strand money the ledger is already owed.
    await buy(new Date('2026-08-01T09:00:00.000Z'))
    ledger.goDown(1)
    await runRecycle(deps({ adminApi: policyClient(1_000) }), NOW)

    // A day later, so the 3rd is now a closed period nobody has recorded.
    const summary = await runRecycle(
      deps({ adminApi: policyClient(new FeeRecycleUnavailableError('admin-api could not be reached')) }),
      new Date('2026-08-04T10:00:00.000Z'),
    )
    assert.equal(summary.resolved, 1, 'the outstanding row was finished')
    assert.equal(summary.posted, 1)
    assert.ok(summary.halted, 'but nothing NEW was closed')
    assert.equal(
      (await listRecycles(db, 'EMBER', 10)).filter((r) => r.periodStart.getTime() === DAY_3.getTime()).length,
      0,
      'an unread rate closes no new period',
    )
  })

  test('with no ADMIN_API_URL the pipeline is off, not defaulted to zero', { skip }, async () => {
    await buy(new Date('2026-08-01T09:00:00.000Z'))
    const summary = await runRecycle(deps({ adminApi: undefined }), NOW)
    assert.match(summary.halted ?? '', /ADMIN_API_URL/)
    assert.equal((await listRecycles(db, 'EMBER', 10)).length, 0, 'no rows, so no rate was assumed')
  })

  test('a refused debit defers rather than writing the period off', { skip }, async () => {
    // The platform's own fee revenue will not cover it. Revenue accrues; the next run asks again
    // under the same key. Writing the row off would forgive revenue the programme is owed.
    await buy(new Date('2026-08-01T09:00:00.000Z'))
    ledger.refuseFunds(1)
    const summary = await runRecycle(deps({ adminApi: policyClient(1_000) }), NOW)
    assert.equal(summary.deferred, 1)
    const row = (await listRecycles(db, 'EMBER', 10)).find((r) => r.periodStart.getTime() === DAY_1.getTime())
    assert.equal(row?.status, 'pending')
  })
})

/* ══════════════════════════════════════════════════════ the pieces, directly */

describe('claimPeriod and settleRecycle', () => {
  test('a second claim adopts the first row rather than overwriting its numbers', { skip }, async () => {
    const input = {
      assetCode: 'EMBER' as const,
      periodStart: DAY_1,
      periodEnd: DAY_2,
      basis: { grossWei: 1_000n, refundedWei: 0n },
      recycleBps: 1_000,
    }
    const first = await claimPeriod(db, input)
    // A second run with a DIFFERENT basis and rate — which is what a late-arriving row or a
    // freshly raised rate would produce. The row the ledger was told about must win.
    const second = await claimPeriod(db, {
      ...input,
      basis: { grossWei: 9_999n, refundedWei: 0n },
      recycleBps: 2_500,
    })
    assert.equal(second.id, first.id)
    assert.equal(second.grossWei, 1_000n)
    assert.equal(second.recycleBps, 1_000)
    assert.equal(second.amountWei, 100n)
  })

  test('settling an already-settled row is a no-op, not a second entry', { skip }, async () => {
    const row = await claimPeriod(db, {
      assetCode: 'EMBER',
      periodStart: DAY_1,
      periodEnd: DAY_2,
      basis: { grossWei: 1_000n, refundedWei: 0n },
      recycleBps: 1_000,
    })
    assert.equal(await settleRecycle(deps(), row), 'posted')
    const settled = (await listRecycles(db, 'EMBER', 1))[0]!
    assert.equal(await settleRecycle(deps(), settled), 'posted')
    assert.equal(ledger.entries.length, 1)
  })

  test('the idempotency key is derived from the period, never from the row', () => {
    // A key derived from a row id does not survive the row being rewritten and derives a second
    // key on a retry — which is how the same money moves twice.
    assert.equal(
      recycleIdempotencyKey('EMBER', DAY_1),
      'billing:engagement-recycle:EMBER:2026-08-01T00:00:00.000Z',
    )
    assert.notEqual(recycleIdempotencyKey('EMBER', DAY_1), recycleIdempotencyKey('EMBER', DAY_2))
  })
})

describe('feeRecyclePostings', () => {
  test('balances, and spells both accounts the way the rest of the estate spells them', () => {
    const postings = feeRecyclePostings({ assetCode: 'EMBER', amount: 4_200n })
    const debits = postings.filter((p) => p.direction === 'debit').reduce((n, p) => n + p.amount, 0n)
    const credits = postings.filter((p) => p.direction === 'credit').reduce((n, p) => n + p.amount, 0n)
    assert.equal(debits, credits)

    // `(platform, EMBER, fees)` is REVENUE. billing/src/ledger.ts's own purchasePostings credits
    // it as revenue, and so do market, trade, wallet and mint. The ledger throws
    // `AccountConflictError` on a type mismatch (ledger/src/accounts.ts), so a service that
    // spelled this `expense` would have every entry refused in production while its own fake
    // ledger accepted them — which is exactly how the estate found the collision in micro-worlds.
    const fees = postings.find((p) => p.account.subject === 'platform')
    assert.equal(fees?.account.type, 'revenue')
    assert.equal(fees?.account.purpose, 'fees')
    assert.equal(fees?.direction, 'debit', 'recycling revenue REDUCES a credit-normal account')

    // `platform:engagement-treasury` under purpose `treasury` is EQUITY, exactly as admin-api's
    // engagement.transfer debits it and as contracts-money's engagementAccount spells the
    // per-service accounts below it. Equity is not overdraft-exempt, which is what makes an
    // unfunded treasury refuse a grant rather than go negative.
    const treasury = postings.find((p) => p.account.subject === 'platform:engagement-treasury')
    assert.equal(treasury?.account.type, 'equity')
    assert.equal(treasury?.account.purpose, 'treasury')
    assert.equal(treasury?.direction, 'credit')
  })
})

/* ══════════════════════════════════════════════════════ the unit — micro-org#336 */

describe('the recycle counts EMBER wei, and says so everywhere it writes', () => {
  test('no column of the table is named for the retired asset', { skip }, async () => {
    // Against the LIVE schema rather than the migration text, because the schema is the sum of
    // every migration: migration 10 created these columns as `*_shards` and migration 13 renamed
    // them, and only a query can tell you which one the database ended up with. A future
    // migration that reintroduced the name would pass a text assertion over migration 13 and
    // fail here.
    const columns = await sql<{ name: string }[]>`
      select column_name as name from information_schema.columns
       where table_schema = 'public' and table_name = 'engagement_fee_recycles'
       order by ordinal_position
    `
    const names = columns.map((c) => c.name)
    assert.deepEqual(
      names.filter((n) => /shard/i.test(n)),
      [],
      'the values are EMBER wei — a Shard-named column misreads them by eighteen orders of magnitude',
    )
    for (const expected of ['gross_wei', 'refunded_wei', 'amount_wei']) {
      assert.ok(names.includes(expected), `${expected} is missing`)
    }
  })

  test('the generated amount survived the rename, expression and value both', { skip }, async () => {
    // A rename and not a drop/re-add: the expression must still be the one migration 10 argued
    // for, over the renamed columns, and it must still be the DATABASE that computes it.
    const [generated] = await sql<{ expr: string; kind: string }[]>`
      select generation_expression as expr, is_generated as kind
        from information_schema.columns
       where table_schema = 'public' and table_name = 'engagement_fee_recycles'
         and column_name = 'amount_wei'
    `
    assert.equal(generated?.kind, 'ALWAYS')
    assert.match(generated?.expr ?? '', /gross_wei - refunded_wei/)
    assert.match(generated?.expr ?? '', /recycle_bps/)
    assert.doesNotMatch(generated?.expr ?? '', /shard/i)

    // And it still floors, at the same numbers migration 10 chose — proof that the rename did not
    // quietly recompute anything.
    await sql`
      insert into engagement_fee_recycles (asset_code, period_start, period_end, gross_wei, refunded_wei, recycle_bps)
      values ('EMBER', ${DAY_1}, ${DAY_2}, 99999, 0, 500)
    `
    const [row] = await sql<{ amount: string }[]>`
      select amount_wei::text as amount from engagement_fee_recycles where period_start = ${DAY_1}
    `
    assert.equal(row?.amount, '4999')
  })

  test('the durable ledger metadata names wei — the keys are permanent, so they are asserted', { skip }, async () => {
    // THE ASSERTION THAT WAS MISSING. A journal entry is never edited — micro-ledger corrects by
    // reversal — so a metadata key is written once and read for ever. Until micro-org#336 nothing
    // in this repository looked at the request's metadata at all, which is how `grossShards`
    // reached the audit of record of an entry whose postings were EMBER.
    await buy(new Date('2026-08-01T09:00:00.000Z'))
    await runRecycle(deps({ adminApi: policyClient(1_000) }), NOW)

    const entry = ledger.entriesFor(recycleIdempotencyKey('EMBER', DAY_1))[0]
    assert.ok(entry, 'the recycle posted an entry')
    assert.deepEqual(
      Object.keys(entry.metadata ?? {}).sort(),
      ['grossWei', 'periodStart', 'recycleBps', 'refundedWei'],
      'a Shard-named key here is permanent audit metadata naming a retired asset',
    )
    // The figures were never wrong, and stay exactly what they were: the basis in wei.
    assert.equal(entry.metadata?.['grossWei'], emberFor(250n).toString())
    assert.equal(entry.metadata?.['refundedWei'], '0')
    assert.equal(entry.metadata?.['recycleBps'], '1000')
  })
})

/* The two error classes are re-exported through this suite's imports; naming them keeps a
 * refactor that deletes one from silently passing. */
test('the ledger error classes the recycle distinguishes still exist', () => {
  assert.equal(typeof LedgerUnavailableError, 'function')
  assert.equal(typeof InsufficientFundsError, 'function')
})
