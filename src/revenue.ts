/**
 * Usage records, invoices and payouts.
 *
 * Three shapes, one rule between them: **none of these is a money system.** A usage record is a
 * measurement, an invoice is a statement of what a ledger entry did, and a payout is a ledger
 * movement plus optionally a withdrawal. Every one of them that involves value carries the id of
 * the journal entry that moved it, so "does billing agree with the ledger" is a join rather than
 * an argument.
 *
 * That is the difference from what is superseded. The estate has no payout concept at all and no
 * invoice; creator revenue is a `wallets.shards` increment, which cannot be reconciled against
 * anything and cannot be explained to the creator receiving it.
 */

import {
  isPayoutConsistent,
  payoutNet,
  type AccountSubject,
  type LedgerAssetCode,
  type Payout,
  type PayoutStatus,
} from '@cloudsforge/contracts-money'
import type { Db, Tx } from './outbox.ts'

/* ------------------------------------------------------------------------ usage */

export interface UsageInput {
  readonly subject: string
  readonly meter: string
  readonly quantity: bigint
  readonly subscriptionId?: string | null
  readonly occurredAt?: Date
  /**
   * Metering is at-least-once by nature — the thing being metered reports it and it retries — so
   * a key is what makes recording effectively-once. Optional, because a caller that genuinely has
   * no stable key should say so explicitly rather than have one invented for it.
   */
  readonly idempotencyKey?: string
}

export interface UsageRecord {
  readonly id: string
  readonly subject: string
  readonly meter: string
  readonly quantity: bigint
  readonly occurredAt: string
  readonly subscriptionId: string | null
  readonly invoiceId: string | null
}

interface UsageRow {
  readonly id: string
  readonly subject: string
  readonly meter: string
  readonly quantity: string
  readonly occurred_at: Date
  readonly subscription_id: string | null
  readonly invoice_id: string | null
}

const toUsage = (row: UsageRow): UsageRecord => ({
  id: String(row.id),
  subject: row.subject,
  meter: row.meter,
  quantity: BigInt(row.quantity),
  occurredAt: row.occurred_at.toISOString(),
  subscriptionId: row.subscription_id,
  invoiceId: row.invoice_id,
})

/**
 * Record usage. A duplicate key is a no-op that returns the original, not a second row.
 *
 * `on conflict do nothing` and then a read, rather than `do update`: overwriting the quantity on a
 * duplicate would let a retry with a different number silently replace a measurement that has
 * possibly already been invoiced.
 */
export async function recordUsage(sql: Db, input: UsageInput): Promise<UsageRecord> {
  const occurredAt = (input.occurredAt ?? new Date()).toISOString()
  const inserted = await sql<UsageRow[]>`
    insert into usage_records (subscription_id, subject, meter, quantity, occurred_at, idempotency_key)
    values (
      ${input.subscriptionId ?? null}, ${input.subject}, ${input.meter},
      ${input.quantity.toString()}::numeric, ${occurredAt}::timestamptz,
      ${input.idempotencyKey ?? null}
    )
    on conflict (idempotency_key) do nothing
    returning id, subject, meter, quantity, occurred_at, subscription_id, invoice_id
  `
  const row = inserted[0]
  if (row) return toUsage(row)

  const existing = await sql<UsageRow[]>`
    select id, subject, meter, quantity, occurred_at, subscription_id, invoice_id
      from usage_records
     where idempotency_key = ${input.idempotencyKey ?? null}
  `
  const found = existing[0]
  if (!found) throw new Error('usage insert conflicted but no row was found')
  return toUsage(found)
}

export async function unbilledUsage(sql: Db, subscriptionId: string, until: Date): Promise<UsageRecord[]> {
  const rows = await sql<UsageRow[]>`
    select id, subject, meter, quantity, occurred_at, subscription_id, invoice_id
      from usage_records
     where subscription_id = ${subscriptionId}
       and invoice_id is null
       and occurred_at <= ${until.toISOString()}::timestamptz
     order by occurred_at
  `
  return rows.map(toUsage)
}

/* ------------------------------------------------------------------------ invoices */

export interface InvoiceLineInput {
  readonly description: string
  readonly quantity: bigint
  readonly unitAmount: bigint
}

export interface InvoiceInput {
  readonly subject: string
  readonly subscriptionId?: string | null
  readonly periodStart: Date
  readonly periodEnd: Date
  readonly assetCode: LedgerAssetCode
  readonly lines: readonly InvoiceLineInput[]
  readonly journalEntryId?: string | null
  readonly status?: 'draft' | 'open' | 'paid' | 'void'
}

export interface InvoiceRecord {
  readonly id: string
  readonly subject: string
  readonly subscriptionId: string | null
  readonly periodStart: string
  readonly periodEnd: string
  readonly assetCode: LedgerAssetCode
  readonly total: bigint
  readonly status: string
  readonly journalEntryId: string | null
}

interface InvoiceRow {
  readonly id: string
  readonly subject: string
  readonly subscription_id: string | null
  readonly period_start: Date
  readonly period_end: Date
  readonly asset_code: string
  readonly total: string
  readonly status: string
  readonly journal_entry_id: string | null
}

const toInvoice = (row: InvoiceRow): InvoiceRecord => ({
  id: row.id,
  subject: row.subject,
  subscriptionId: row.subscription_id,
  periodStart: row.period_start.toISOString(),
  periodEnd: row.period_end.toISOString(),
  assetCode: row.asset_code as LedgerAssetCode,
  total: BigInt(row.total),
  status: row.status,
  journalEntryId: row.journal_entry_id,
})

/**
 * Write an invoice and its lines.
 *
 * **The total is computed from the lines, never accepted from the caller.** A total that disagrees
 * with its lines is the arithmetic nobody checks: it reads correctly on the statement and settles
 * a different number.
 */
export async function createInvoice(tx: Tx, input: InvoiceInput): Promise<InvoiceRecord> {
  const total = input.lines.reduce((sum, line) => sum + line.quantity * line.unitAmount, 0n)

  const rows = await tx<InvoiceRow[]>`
    insert into invoices (
      subject, subscription_id, period_start, period_end, asset_code, total, status, journal_entry_id
    )
    values (
      ${input.subject}, ${input.subscriptionId ?? null},
      ${input.periodStart.toISOString()}::timestamptz, ${input.periodEnd.toISOString()}::timestamptz,
      ${input.assetCode}, ${total.toString()}::numeric,
      ${input.status ?? (input.journalEntryId ? 'paid' : 'open')}, ${input.journalEntryId ?? null}
    )
    returning id, subject, subscription_id, period_start, period_end, asset_code, total, status,
              journal_entry_id
  `
  const row = rows[0]
  if (!row) throw new Error('insert returned no row')

  for (const line of input.lines) {
    await tx`
      insert into invoice_lines (invoice_id, description, quantity, unit_amount, amount)
      values (
        ${row.id}, ${line.description}, ${line.quantity.toString()}::numeric,
        ${line.unitAmount.toString()}::numeric,
        ${(line.quantity * line.unitAmount).toString()}::numeric
      )
    `
  }

  return toInvoice(row)
}

/** Attach billed usage to the invoice that billed it, so it is never billed twice. */
export async function attachUsage(tx: Tx, invoiceId: string, usageIds: readonly string[]): Promise<void> {
  if (usageIds.length === 0) return
  await tx`
    update usage_records set invoice_id = ${invoiceId}
     where id = any(${usageIds.map((id) => Number(id))}::bigint[])
  `
}

export async function listInvoices(sql: Db, subject: string, limit: number): Promise<InvoiceRecord[]> {
  const rows = await sql<InvoiceRow[]>`
    select id, subject, subscription_id, period_start, period_end, asset_code, total, status,
           journal_entry_id
      from invoices
     where subject = ${subject}
     order by created_at desc
     limit ${limit}
  `
  return rows.map(toInvoice)
}

/* ------------------------------------------------------------------------ payouts */

export interface PayoutInput {
  readonly subject: string
  readonly periodStart: Date
  readonly periodEnd: Date
  readonly assetCode: LedgerAssetCode
  readonly gross: bigint
  readonly platformFee: bigint
  readonly destinationWalletId?: string | null
}

export interface PayoutRecord {
  readonly id: string
  /** An `AccountSubject`, so `isPayoutConsistent` can be applied to this record unchanged. */
  readonly subject: AccountSubject
  readonly periodStart: string
  readonly periodEnd: string
  readonly assetCode: LedgerAssetCode
  readonly gross: bigint
  readonly platformFee: bigint
  readonly net: bigint
  readonly status: PayoutStatus
  readonly journalEntryId: string | null
  readonly destinationWalletId: string | null
}

interface PayoutRow {
  readonly id: string
  readonly subject: string
  readonly period_start: Date
  readonly period_end: Date
  readonly asset_code: string
  readonly gross: string
  readonly platform_fee: string
  readonly net: string
  readonly status: string
  readonly journal_entry_id: string | null
  readonly destination_wallet_id: string | null
}

const toPayout = (row: PayoutRow): PayoutRecord => ({
  id: row.id,
  subject: row.subject as AccountSubject,
  periodStart: row.period_start.toISOString(),
  periodEnd: row.period_end.toISOString(),
  assetCode: row.asset_code as LedgerAssetCode,
  gross: BigInt(row.gross),
  platformFee: BigInt(row.platform_fee),
  net: BigInt(row.net),
  status: row.status as PayoutStatus,
  journalEntryId: row.journal_entry_id,
  destinationWalletId: row.destination_wallet_id,
})

/** The record as the contract's `Payout`, so `isPayoutConsistent` applies to it unchanged. */
export function toContractPayout(payout: PayoutRecord): Payout {
  return {
    id: payout.id,
    subject: payout.subject,
    periodStart: payout.periodStart,
    periodEnd: payout.periodEnd,
    assetCode: payout.assetCode,
    gross: payout.gross,
    platformFee: payout.platformFee,
    net: payout.net,
    status: payout.status,
    ...(payout.journalEntryId !== null ? { journalEntryId: payout.journalEntryId } : {}),
    ...(payout.destinationWalletId !== null
      ? { destinationWalletId: payout.destinationWalletId }
      : {}),
  }
}

/**
 * Create a payout in `pending`.
 *
 * `net` is computed by `payoutNet` from contracts-money rather than taken from the caller, and the
 * table carries the same rule as a CHECK. Two enforcements of one invariant, because the
 * application binds this code path and the constraint binds a psql session as well — and a payout
 * whose parts do not add up balances as a journal entry while paying the wrong amount.
 */
export async function createPayout(sql: Db, input: PayoutInput): Promise<PayoutRecord> {
  const net = payoutNet(input.gross, input.platformFee)
  const rows = await sql<PayoutRow[]>`
    insert into payouts (
      subject, period_start, period_end, asset_code, gross, platform_fee, net, status,
      destination_wallet_id
    )
    values (
      ${input.subject}, ${input.periodStart.toISOString()}::timestamptz,
      ${input.periodEnd.toISOString()}::timestamptz, ${input.assetCode},
      ${input.gross.toString()}::numeric, ${input.platformFee.toString()}::numeric,
      ${net.toString()}::numeric, 'pending', ${input.destinationWalletId ?? null}
    )
    returning id, subject, period_start, period_end, asset_code, gross, platform_fee, net, status,
              journal_entry_id, destination_wallet_id
  `
  const row = rows[0]
  if (!row) throw new Error('insert returned no row')
  const payout = toPayout(row)
  // The contract's `Payout` leaves the entry id absent rather than null when there is none — an
  // unpaid payout has no entry, and `undefined` is how the type says so. The record keeps `null`
  // because that is what the column holds; the conversion happens here rather than by widening
  // the contract, which is exact-pinned.
  if (!isPayoutConsistent(toContractPayout(payout))) {
    // Unreachable while the CHECK exists, and asserted anyway: reaching it would mean the
    // constraint was dropped, and a payout is not a thing to discover an inconsistency in later.
    throw new Error(`payout ${payout.id} does not add up`)
  }
  return payout
}

/** Record that a payout was settled by a ledger entry. */
export async function markPayoutPaid(sql: Db, id: string, journalEntryId: string): Promise<void> {
  await sql`
    update payouts
       set status = 'paid', journal_entry_id = ${journalEntryId}, updated_at = now()
     where id = ${id} and status in ('pending', 'approved')
  `
}

export async function listPayouts(sql: Db, subject: string, limit: number): Promise<PayoutRecord[]> {
  const rows = await sql<PayoutRow[]>`
    select id, subject, period_start, period_end, asset_code, gross, platform_fee, net, status,
           journal_entry_id, destination_wallet_id
      from payouts
     where subject = ${subject}
     order by period_end desc
     limit ${limit}
  `
  return rows.map(toPayout)
}

export function payoutToWire(payout: PayoutRecord): Record<string, unknown> {
  return {
    id: payout.id,
    subject: payout.subject,
    periodStart: payout.periodStart,
    periodEnd: payout.periodEnd,
    assetCode: payout.assetCode,
    gross: payout.gross.toString(),
    platformFee: payout.platformFee.toString(),
    net: payout.net.toString(),
    status: payout.status,
    journalEntryId: payout.journalEntryId,
    destinationWalletId: payout.destinationWalletId,
  }
}
