/**
 * The fee recycle — docs/ecosystem/21 §3's second funding leg.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * "A configured percentage of platform fee revenue (billing) posts to the same treasury account
 * each period, so the engagement budget eventually funds itself from the activity it seeded."
 *
 * One closed UTC day at a time, one row per day per asset, one ledger entry per row. Billing
 * still holds no balance: this file computes a number out of billing's own records and asks the
 * ledger to move it, and the row it writes is a statement about an entry rather than a second
 * record of the money — the same rule `revenue.ts` states for invoices and payouts.
 *
 * ── IT STARTS AT 0%, AND THAT IS A DECISION, NOT AN OMISSION ───────────────────────────────────
 *
 * 21 closes with an open decision: "whether the fee recycle starts at 0% (pure mined funding
 * until revenue exists) — recommended, since it costs nothing to raise later through the action
 * that already requires approval." **Taken as recommended.** The rate lives in admin-api, whose
 * migration seeds it at 0 (admin-api/src/migrations.ts), and nothing in this repository has
 * an opinion about it or a default for it.
 *
 * The pipeline still RUNS at 0%. Every closed period gets a row recording the day's takings and
 * the rate that applied, `status = 'skipped'`, and no entry — because there is no entry to make
 * for nothing. Three things follow, and each is why the rows are written rather than the job
 * short-circuiting on a zero rate:
 *
 *   1. The day the operator raises the rate through `engagement.policy.set`, money starts moving
 *      with no deploy, no migration and no code path that has never executed.
 *   2. An operator can see what the recycle WOULD have been before deciding to turn it on — the
 *      basis is on the row, and the arithmetic is the database's.
 *   3. A pipeline that only executes once somebody has already committed to it is a pipeline
 *      whose first real run is also its first run. That is how the estate's `foresight.settlement_fee`
 *      posted nothing for months without anyone noticing.
 *
 * ── THE ORDER, WHICH IS THE SAFETY ARGUMENT ────────────────────────────────────────────────────
 *
 *   1. **Resolve pending rows first, and without reading the rate.** A pending row's rate, basis
 *      and amount were decided when it was written; re-posting it needs nothing new. So an
 *      unreachable admin-api never strands money that was already decided.
 *   2. **Claim the period row before any money is asked to move.** The unique index on
 *      `(asset_code, period_start)` is what makes a crashed run resumable rather than doubling:
 *      the second attempt loses the insert, adopts the row it finds, and re-posts under the same
 *      key. This is `market/src/engagement.ts`'s ordering — the bound binds at the database
 *      before the ledger is asked anything.
 *   3. **The idempotency key is derived from the PERIOD, never from the row.** A key derived from
 *      a row id does not survive the row being rewritten, and derives a second key on a retry —
 *      which is how the same money moves twice. `trade/src/fees.ts` invariant 0 is the same rule
 *      and the same reason.
 *   4. **An unknown outcome leaves the row pending.** A timeout is not a refusal: the entry may
 *      be committing right now. Writing it off would let the next run post a second one. Only
 *      the ledger saying yes retires a row, and it says yes to the same key on the next pass.
 *
 * ── THE UNIT IS EMBER WEI, AND THIS FILE SAID SHARDS UNTIL 2026-08-10 ─────────────────────────
 *
 * Every amount here — the basis, the row, the posting and the metadata key beside it — is minor
 * units of `deps.assetCode`, which is `env.settlementAsset`: EMBER, typed `IssuableAssetCode`,
 * i.e. `Exclude<AssetCode, 'SHARD'>`. So they are wei. They always were, and no figure was ever
 * wrong; the NAMES were, by eighteen orders of magnitude, and `micro-ledger` still permits SHARD
 * on a `transfer` (26,000 Shards across 14 accounts on mainnet) — which is why a reader could
 * take `grossShards = 40000000000000000` for a plausible Shard count rather than an obvious
 * error. Migration 13 renames the columns; micro-org#336 is the whole argument. See also
 * `src/ledger.ts`, which records the other half: admin-api's own `*_shards` → `*_wei` rename.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { LedgerAssetCode } from '@cloudsforge/contracts-money'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import {
  InsufficientFundsError,
  LedgerUnavailableError,
  feeRecyclePostings,
  type LedgerClient,
} from './ledger.ts'
import type { EngagementPolicyClient } from './adminapi.ts'
import type { Db } from './outbox.ts'

/** A period is one UTC day. Half-open: `[period_start, period_end)`. */
export const PERIOD = '1 day'

/**
 * How many closed periods one run will attempt.
 *
 * A bound rather than "everything outstanding", because the first run after a long outage would
 * otherwise hold the job's lease across hundreds of ledger calls, and a lease that expires
 * mid-batch is a second worker starting the same batch. The remainder is picked up next run —
 * the periods are not going anywhere and each is independent of the others.
 */
export const MAX_PERIODS_PER_RUN = 14

export interface RecycleRow {
  readonly id: string
  readonly assetCode: string
  readonly periodStart: Date
  readonly periodEnd: Date
  readonly grossWei: bigint
  readonly refundedWei: bigint
  readonly recycleBps: number
  /**
   * The database's arithmetic, read back — never recomputed here. Defined GENERATED by migration
   * 10 and renamed out of `amount_shards` by migration 13.
   */
  readonly amountWei: bigint
  readonly status: 'pending' | 'posted' | 'skipped'
  readonly journalEntryId: string | null
}

interface Row {
  readonly id: string
  readonly asset_code: string
  readonly period_start: Date
  readonly period_end: Date
  readonly gross_wei: string
  readonly refunded_wei: string
  readonly recycle_bps: number
  readonly amount_wei: string
  readonly status: string
  readonly journal_entry_id: string | null
}

const COLUMNS = `id, asset_code, period_start, period_end, gross_wei::text,
                 refunded_wei::text, recycle_bps, amount_wei::text, status, journal_entry_id`

/**
 * A `numeric(78,0)::text` from Postgres is bare digits, and `BigInt('')` is `0n` — which would
 * turn an unreadable amount into "recycle nothing", quietly. Everything here is a sum the
 * database computed and coalesced, so anything else is a bug worth throwing on.
 */
function wei(value: string | null | undefined, field: string): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new Error(`engagement_fee_recycles.${field} is not a decimal amount: ${String(value)}`)
  }
  return BigInt(value)
}

function toRow(row: Row): RecycleRow {
  return {
    id: row.id,
    assetCode: row.asset_code,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    grossWei: wei(row.gross_wei, 'gross_wei'),
    refundedWei: wei(row.refunded_wei, 'refunded_wei'),
    recycleBps: row.recycle_bps,
    amountWei: wei(row.amount_wei, 'amount_wei'),
    status: row.status as RecycleRow['status'],
    journalEntryId: row.journal_entry_id,
  }
}

/**
 * The key one period's recycle is posted under, for ever.
 *
 * Derived from the asset and the period — both of which exist before the row does. See the
 * header, point 3.
 */
export function recycleIdempotencyKey(assetCode: string, periodStart: Date): string {
  return `billing:engagement-recycle:${assetCode}:${periodStart.toISOString()}`
}

/* ------------------------------------------------------------------ what a period is worth */

export interface PeriodBasis {
  readonly grossWei: bigint
  readonly refundedWei: bigint
}

/**
 * The platform fee revenue billing recognised in one period, and the refunds that reversed some
 * of it.
 *
 * **Every term corresponds to an entry billing actually posted**, which is the only definition
 * that keeps this table reconcilable against the ledger:
 *
 *   * `purchases` — every one credits `(platform, <asset>, fees)` through `purchasePostings`,
 *     including the FIRST charge of a subscription (`recordPurchase` opens the subscription from
 *     inside the purchase). Counted in the period it was created in, whatever its status is now:
 *     the money moved that day, and a refund three weeks later is that week's event, not this
 *     one's.
 *   * `invoices` with a `subscription_id` and a `journal_entry_id` — renewals, which post a
 *     `subscription_charge` through the same postings and write no purchase row. The two
 *     conditions together are what excludes an unpaid or draft invoice, which moved nothing.
 *   * refunds — `purchases.refunded_at` in the period. Each reversed its entry, debiting that
 *     same revenue account back, so it is a subtraction from the period the reversal landed in.
 *
 * The netting itself is the schema's: the row stores gross and refunded separately and migration
 * 10 generates `greatest(gross - refunded, 0)` into the amount. A period whose refunds exceed
 * its takings recycles nothing rather than moving money out of the treasury.
 */
export async function periodBasis(
  sql: Db,
  assetCode: LedgerAssetCode,
  periodStart: Date,
  periodEnd: Date,
): Promise<PeriodBasis> {
  const rows = await sql<{ gross: string; refunded: string }[]>`
    select
      (
        coalesce((
          select sum(amount) from purchases
           where asset_code = ${assetCode}
             and created_at >= ${periodStart} and created_at < ${periodEnd}
        ), 0)
        + coalesce((
          select sum(total) from invoices
           where asset_code = ${assetCode}
             and subscription_id is not null
             and journal_entry_id is not null
             and created_at >= ${periodStart} and created_at < ${periodEnd}
        ), 0)
      )::text as gross,
      coalesce((
        select sum(amount) from purchases
         where asset_code = ${assetCode}
           and refunded_at is not null
           and refunded_at >= ${periodStart} and refunded_at < ${periodEnd}
      ), 0)::text as refunded
  `
  const row = rows[0]
  if (!row) throw new Error('the basis query returned no row')
  return {
    grossWei: wei(row.gross, 'gross_wei'),
    refundedWei: wei(row.refunded, 'refunded_wei'),
  }
}

/* ------------------------------------------------------------------ which periods are due */

/**
 * The closed periods this asset still owes a row, oldest first.
 *
 * A period is a candidate only once it has fully elapsed — `date_trunc('day', now())` is
 * exclusive, so today is never closed early and a late-arriving purchase can never land in a
 * period that has already been recycled.
 *
 * **Where the sequence starts** is the part worth stating. In order:
 *
 *   1. The day after the latest period already recorded. This is the ordinary case and it makes
 *      the sequence contiguous — a gap in it would be revenue nothing ever considered.
 *   2. Failing that (nothing recorded yet), the day of the earliest revenue this service holds.
 *      A fresh deployment therefore recycles from its first sale rather than from the epoch.
 *   3. Failing that too (no revenue at all), yesterday — so an empty deployment writes one
 *      zero-basis row a day and the pipeline is visibly alive rather than merely untested.
 *
 * `generate_series` is bounded by `MAX_PERIODS_PER_RUN` in SQL rather than by slicing the result,
 * so a deployment that has been down for a year does not build a year of timestamps to throw
 * most of away.
 */
export async function duePeriods(
  sql: Db,
  assetCode: LedgerAssetCode,
  now: Date,
  limit: number = MAX_PERIODS_PER_RUN,
): Promise<readonly { periodStart: Date; periodEnd: Date }[]> {
  const rows = await sql<{ period_start: Date; period_end: Date }[]>`
    with bounds as (
      select
        coalesce(
          (select max(period_start) + interval '1 day'
             from engagement_fee_recycles where asset_code = ${assetCode}),
          (select date_trunc('day', least(
             (select min(created_at) from purchases where asset_code = ${assetCode}),
             (select min(created_at) from invoices
               where asset_code = ${assetCode} and journal_entry_id is not null)
           ) at time zone 'utc') at time zone 'utc'),
          date_trunc('day', ${now}::timestamptz at time zone 'utc') at time zone 'utc'
            - interval '1 day'
        ) as first_start,
        date_trunc('day', ${now}::timestamptz at time zone 'utc') at time zone 'utc' as horizon
    )
    select g as period_start, g + interval '1 day' as period_end
      from bounds,
           generate_series(
             bounds.first_start,
             -- Half-open on the right: the current day is never a candidate.
             bounds.horizon - interval '1 day',
             interval '1 day'
           ) as g
     where g < bounds.horizon
     order by g
     limit ${limit}
  `
  return rows.map((row) => ({ periodStart: row.period_start, periodEnd: row.period_end }))
}

/* ------------------------------------------------------------------ the row */

/**
 * Claim one period, or adopt the row that already claims it.
 *
 * `on conflict do nothing` and then a read, rather than `do update`: a second run must not
 * overwrite a basis or a rate that a first run has already posted an entry against. The row that
 * won is the one that owns this period, and its numbers are the ones the ledger was told.
 */
export async function claimPeriod(
  sql: Db,
  input: {
    readonly assetCode: LedgerAssetCode
    readonly periodStart: Date
    readonly periodEnd: Date
    readonly basis: PeriodBasis
    readonly recycleBps: number
  },
): Promise<RecycleRow> {
  await sql`
    insert into engagement_fee_recycles (
      asset_code, period_start, period_end, gross_wei, refunded_wei, recycle_bps, status
    )
    values (
      ${input.assetCode}, ${input.periodStart}, ${input.periodEnd},
      ${input.basis.grossWei.toString()}::numeric,
      ${input.basis.refundedWei.toString()}::numeric,
      ${input.recycleBps}, 'pending'
    )
    on conflict (asset_code, period_start) do nothing
  `
  const rows = await sql<Row[]>`
    select ${sql.unsafe(COLUMNS)} from engagement_fee_recycles
     where asset_code = ${input.assetCode} and period_start = ${input.periodStart}
  `
  const row = rows[0]
  if (!row) throw new Error('the recycle row conflicted but no row was found')
  return toRow(row)
}

/** Rows the ledger still owes an answer about, oldest first. */
export async function pendingRecycles(sql: Db, assetCode: LedgerAssetCode): Promise<readonly RecycleRow[]> {
  const rows = await sql<Row[]>`
    select ${sql.unsafe(COLUMNS)} from engagement_fee_recycles
     where asset_code = ${assetCode} and status = 'pending'
     order by period_start
  `
  return rows.map(toRow)
}

export async function listRecycles(sql: Db, assetCode: LedgerAssetCode, limit: number): Promise<readonly RecycleRow[]> {
  const rows = await sql<Row[]>`
    select ${sql.unsafe(COLUMNS)} from engagement_fee_recycles
     where asset_code = ${assetCode}
     order by period_start desc
     limit ${limit}
  `
  return rows.map(toRow)
}

/* ------------------------------------------------------------------ settling one period */

export type RecycleOutcome = 'posted' | 'skipped' | 'deferred'

export interface RecycleDeps {
  readonly sql: Db
  readonly ledger: LedgerClient
  readonly logger: Logger
  readonly metrics: Metrics
  readonly producer: string
  readonly assetCode: LedgerAssetCode
  /** Absent when `ADMIN_API_URL` is unset — no engagement programme in this deployment. */
  readonly adminApi?: EngagementPolicyClient | undefined
}

/**
 * Settle one claimed row: post its entry, or record that there was nothing to post.
 *
 * Takes the row rather than the period, so the resume path and the fresh path are the same code
 * over the same numbers. Nothing here recomputes the amount — it is the database's generated
 * value, read back off the row.
 */
export async function settleRecycle(deps: RecycleDeps, row: RecycleRow): Promise<RecycleOutcome> {
  if (row.status !== 'pending') return row.status

  if (row.amountWei <= 0n) {
    // No entry for nothing. This is every period at the recorded starting rate of 0 bps, and it
    // is also a genuinely quiet day at any rate — the row still records the basis and the rate,
    // which is what makes "we recycled nothing" a statement rather than a silence.
    await deps.sql`
      update engagement_fee_recycles
         set status = 'skipped', updated_at = now()
       where id = ${row.id} and status = 'pending'
    `
    deps.metrics.increment('billing_fee_recycles_total', { outcome: 'skipped' })
    return 'skipped'
  }

  const periodStart = row.periodStart.toISOString()
  let entryId: string
  try {
    const entry = await deps.ledger.postEntry({
      kind: 'transfer',
      actor: `service:${deps.producer}`,
      correlationId: `engagement-recycle-${row.assetCode}-${periodStart}`,
      // From the PERIOD, never from `row.id`. See the header, point 3.
      idempotencyKey: recycleIdempotencyKey(row.assetCode, row.periodStart),
      description: `engagement fee recycle for ${periodStart.slice(0, 10)} (${row.recycleBps} bps)`,
      // ── THESE KEYS OUTLIVE EVERY DEPLOY, AND ARE NOT REWRITTEN WHEN THEY ARE WRONG ──────────
      //
      // A journal entry is settled financial history. `micro-ledger` corrects by REVERSAL — a new
      // entry naming the one it reverses — and never by edit, which is the property that lets 21
      // §4's auditor reconstruct the programme from the ledger alone. Its metadata is part of what
      // was recorded at the time and inherits that rule: an UPDATE over `journal_entries.metadata`
      // would silently restate an audit trail that other records already quote.
      //
      // So the fix for micro-org#336 was forwards-only by construction. It cost nothing here:
      // measured on the live estate 2026-08-10, `billing.engagement_fee_recycles` held 0 rows on
      // both mainnet and testnet, and no journal entry on either network carried a metadata key
      // matching '%shard%' or a `correlation_id like 'engagement-recycle%'` — 0 of 70 on mainnet,
      // 0 of 1 on testnet. `recycle_bps` is 0 platform-wide, which is why. Nothing was left
      // behind, and nothing needed a back-fill.
      //
      // Had a recycle already posted, the columns would still have been renamed and these keys
      // would still have been corrected for future entries — and the posted entries would have
      // been LEFT, with this note as the record of why. The names are the defect; the figures are
      // right in every entry either way, so there is no reading of an old entry that is wrong
      // about the money, and rewriting settled metadata to spare a reader eighteen orders of
      // magnitude of ambiguity is a worse trade than a comment.
      metadata: {
        periodStart,
        recycleBps: row.recycleBps.toString(),
        grossWei: row.grossWei.toString(),
        refundedWei: row.refundedWei.toString(),
      },
      postings: feeRecyclePostings({ assetCode: deps.assetCode, amount: row.amountWei }),
    })
    entryId = entry.id
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      // The platform's own fee revenue will not cover it — refunds booked against an earlier
      // period have already taken it out. A decision, not a fault, and NOT a reason to write the
      // row off: revenue accrues, and the next run asks again under the same key. Deferring
      // costs nothing, and recycling revenue the platform does not hold would be an engagement
      // programme funding itself from an overdraft.
      deps.metrics.increment('billing_fee_recycles_total', { outcome: 'insufficient_funds' })
      deps.logger.warn('fee recycle deferred — platform fee revenue would go negative', {
        recycleId: row.id,
        periodStart,
        amountWei: row.amountWei.toString(),
      })
      return 'deferred'
    }
    // Unavailable, or anything else: the outcome is UNKNOWN, so the row stays pending and the
    // next run re-sends the identical key. Marking it anything else here is how one lost
    // response becomes two entries.
    deps.metrics.increment('billing_fee_recycles_total', { outcome: 'unresolved' })
    deps.logger.warn('fee recycle outcome is unknown — left pending for the next run', {
      recycleId: row.id,
      periodStart,
      err,
    })
    if (err instanceof LedgerUnavailableError) return 'deferred'
    throw err
  }

  await deps.sql`
    update engagement_fee_recycles
       set status = 'posted', journal_entry_id = ${entryId}, updated_at = now()
     where id = ${row.id} and status = 'pending'
  `
  deps.metrics.increment('billing_fee_recycles_total', { outcome: 'posted' })
  deps.logger.info('engagement fee recycle posted', {
    recycleId: row.id,
    periodStart,
    recycleBps: row.recycleBps,
    amountWei: row.amountWei.toString(),
    journalEntryId: entryId,
  })
  return 'posted'
}

/* ------------------------------------------------------------------ the run */

export interface RecycleRunSummary {
  readonly resolved: number
  readonly posted: number
  readonly skipped: number
  readonly deferred: number
  /** Set when the run did no NEW periods and why — the rate could not be read, or there are none. */
  readonly halted?: string
}

/**
 * One pass: finish what is outstanding, then close whatever periods have elapsed.
 *
 * Returns rather than throws for every expected refusal, because the caller is a leased job and a
 * throw is a retry with backoff — which is the right answer for a lost ledger response and the
 * wrong one for "admin-api says 0%" or "there is nothing to do".
 */
export async function runRecycle(deps: RecycleDeps, now: Date = new Date()): Promise<RecycleRunSummary> {
  let posted = 0
  let skipped = 0
  let deferred = 0

  const tally = (outcome: RecycleOutcome): void => {
    if (outcome === 'posted') posted += 1
    else if (outcome === 'skipped') skipped += 1
    else deferred += 1
  }

  // 1. Outstanding rows first, and WITHOUT the rate. Their rate and basis were decided when they
  //    were written, so an unreachable admin-api must not strand an entry that is already owed.
  const outstanding = await pendingRecycles(deps.sql, deps.assetCode)
  for (const row of outstanding) tally(await settleRecycle(deps, row))
  const resolved = outstanding.length

  // 2. New periods need the live rate, and an unread rate is a refusal — never a zero.
  if (!deps.adminApi) {
    return { resolved, posted, skipped, deferred, halted: 'ADMIN_API_URL is unset — no engagement programme here' }
  }

  let recycleBps: number
  try {
    recycleBps = (await deps.adminApi.feeRecycleRate(`engagement-recycle-${now.toISOString()}`)).recycleBps
  } catch (err) {
    deps.metrics.increment('billing_fee_recycles_total', { outcome: 'rate_unavailable' })
    deps.logger.warn('fee recycle rate could not be read — nothing new will be closed this run', { err })
    return {
      resolved,
      posted,
      skipped,
      deferred,
      halted: err instanceof Error ? err.message : String(err),
    }
  }

  for (const period of await duePeriods(deps.sql, deps.assetCode, now)) {
    const basis = await periodBasis(deps.sql, deps.assetCode, period.periodStart, period.periodEnd)
    const row = await claimPeriod(deps.sql, {
      assetCode: deps.assetCode,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      basis,
      recycleBps,
    })
    tally(await settleRecycle(deps, row))
  }

  return { resolved, posted, skipped, deferred }
}
