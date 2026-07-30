/**
 * Subscriptions: a recurring purchase whose entitlement expires with the period it paid for.
 *
 * The design decision that carries everything else: **an entitlement is granted per period, not
 * once at signup, and it expires when the period does.** A subscription that granted a perpetual
 * entitlement at signup would have to remember to revoke it on cancellation, and the day that
 * revocation is missed — a failed job, a crashed process — the customer keeps the thing for ever.
 * With a per-period expiry the default is loss of access and renewal is what extends it, so every
 * failure mode ends in "access stopped" rather than "access never stopped".
 *
 * `subscriptionConfersAccess` in contracts-money is the states-to-access mapping and is not
 * restated here: `trialing`, `active` and `past_due` confer access, and `past_due` doing so is
 * deliberate — cutting a customer off the instant a charge fails costs more than the grace does.
 */

import { subscriptionConfersAccess, type SubscriptionStatus } from '@cloudsforge/contracts-money'
import { nextPeriodEnd, type PriceRecord, type ProductRecord } from './catalogue.ts'
import type { Db, Tx } from './outbox.ts'
import type { EntitlementScope } from '@cloudsforge/contracts-money'

export interface SubscriptionRecord {
  readonly id: string
  readonly subject: string
  readonly productId: string
  readonly priceId: string
  readonly status: SubscriptionStatus
  readonly quantity: bigint
  readonly currentPeriodStart: string
  readonly currentPeriodEnd: string
  readonly cancelAt: string | null
  readonly cancelledAt: string | null
  readonly latestEntryId: string | null
  readonly scope: EntitlementScope
}

interface SubscriptionRow {
  readonly id: string
  readonly subject: string
  readonly product_id: string
  readonly price_id: string
  readonly status: string
  readonly quantity: string
  readonly current_period_start: Date
  readonly current_period_end: Date
  readonly cancel_at: Date | null
  readonly cancelled_at: Date | null
  readonly latest_entry_id: string | null
  readonly scope: string
}

const toSubscription = (row: SubscriptionRow): SubscriptionRecord => ({
  id: row.id,
  subject: row.subject,
  productId: row.product_id,
  priceId: row.price_id,
  status: row.status as SubscriptionStatus,
  quantity: BigInt(row.quantity),
  currentPeriodStart: row.current_period_start.toISOString(),
  currentPeriodEnd: row.current_period_end.toISOString(),
  cancelAt: row.cancel_at?.toISOString() ?? null,
  cancelledAt: row.cancelled_at?.toISOString() ?? null,
  latestEntryId: row.latest_entry_id,
  scope: row.scope as EntitlementScope,
})

export function toWire(subscription: SubscriptionRecord): Record<string, unknown> {
  return {
    id: subscription.id,
    subject: subscription.subject,
    productId: subscription.productId,
    priceId: subscription.priceId,
    status: subscription.status,
    quantity: subscription.quantity.toString(),
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAt: subscription.cancelAt,
    cancelledAt: subscription.cancelledAt,
    latestEntryId: subscription.latestEntryId,
    scope: subscription.scope,
    // Served rather than inferred by the client, so five products do not each decide for
    // themselves whether `past_due` still counts.
    confersAccess: subscriptionConfersAccess(subscription.status),
  }
}

export interface OpenSubscriptionInput {
  readonly subject: string
  readonly product: ProductRecord
  readonly price: PriceRecord
  readonly quantity: bigint
  readonly scope: EntitlementScope
  readonly journalEntryId: string
  readonly startsAt: Date
}

/**
 * Open a subscription for its first period, inside the purchase's transaction.
 *
 * `active` from the start rather than `trialing`: the first period has been paid for by the entry
 * whose id is recorded here, and a trial is a different product decision that belongs on the price
 * rather than being implied by signup.
 */
export async function openSubscription(tx: Tx, input: OpenSubscriptionInput): Promise<SubscriptionRecord> {
  const periodEnd = nextPeriodEnd(input.price, input.startsAt)
  const rows = await tx<SubscriptionRow[]>`
    insert into subscriptions (
      subject, product_id, price_id, status, quantity,
      current_period_start, current_period_end, latest_entry_id, scope
    )
    values (
      ${input.subject}, ${input.product.id}, ${input.price.id}, 'active',
      ${input.quantity.toString()}::numeric,
      ${input.startsAt.toISOString()}::timestamptz, ${periodEnd.toISOString()}::timestamptz,
      ${input.journalEntryId}, ${input.scope}
    )
    returning id, subject, product_id, price_id, status, quantity, current_period_start,
              current_period_end, cancel_at, cancelled_at, latest_entry_id, scope
  `
  const row = rows[0]
  if (!row) throw new Error('insert returned no row')
  return toSubscription(row)
}

export async function listSubscriptions(sql: Db, subject: string, limit: number): Promise<SubscriptionRecord[]> {
  const rows = await sql<SubscriptionRow[]>`
    select id, subject, product_id, price_id, status, quantity, current_period_start,
           current_period_end, cancel_at, cancelled_at, latest_entry_id, scope
      from subscriptions
     where subject = ${subject}
     order by created_at desc
     limit ${limit}
  `
  return rows.map(toSubscription)
}

export async function readSubscription(sql: Db, id: string): Promise<SubscriptionRecord | null> {
  const rows = await sql<SubscriptionRow[]>`
    select id, subject, product_id, price_id, status, quantity, current_period_start,
           current_period_end, cancel_at, cancelled_at, latest_entry_id, scope
      from subscriptions
     where id = ${id}
  `
  const row = rows[0]
  return row ? toSubscription(row) : null
}

/**
 * Subscriptions whose period has run out and which are still meant to be conferring access.
 *
 * `for update skip locked` is not used here: this is a read that decides which renewal jobs to
 * enqueue, and each job then takes the row under its own lease keyed on the subscription id. The
 * contended resource is the subscription, not this query.
 */
export async function dueForRenewal(sql: Db, at: Date, limit = 200): Promise<SubscriptionRecord[]> {
  const rows = await sql<SubscriptionRow[]>`
    select id, subject, product_id, price_id, status, quantity, current_period_start,
           current_period_end, cancel_at, cancelled_at, latest_entry_id, scope
      from subscriptions
     where status in ('trialing', 'active', 'past_due')
       and current_period_end <= ${at.toISOString()}::timestamptz
     order by current_period_end
     limit ${limit}
  `
  return rows.map(toSubscription)
}

export interface AdvanceInput {
  readonly id: string
  readonly periodStart: Date
  readonly periodEnd: Date
  readonly journalEntryId: string
}

/** Move a subscription into its next paid period. */
export async function advancePeriod(tx: Tx, input: AdvanceInput): Promise<SubscriptionRecord> {
  const rows = await tx<SubscriptionRow[]>`
    update subscriptions
       set current_period_start = ${input.periodStart.toISOString()}::timestamptz,
           current_period_end   = ${input.periodEnd.toISOString()}::timestamptz,
           latest_entry_id      = ${input.journalEntryId},
           status               = 'active',
           updated_at           = now()
     where id = ${input.id}
    returning id, subject, product_id, price_id, status, quantity, current_period_start,
              current_period_end, cancel_at, cancelled_at, latest_entry_id, scope
  `
  const row = rows[0]
  if (!row) throw new Error(`no subscription ${input.id}`)
  return toSubscription(row)
}

/**
 * Mark a subscription as unpaid.
 *
 * `past_due` rather than `cancelled`, because a failed charge is usually a temporary balance
 * problem and `subscriptionConfersAccess` deliberately keeps access during it. What must not
 * happen is the entitlement being extended: it expired with the period, so the customer is in
 * grace on the subscription's status, not on a grant that outlived its payment.
 */
export async function markPastDue(sql: Db, id: string, at: Date): Promise<void> {
  await sql`
    update subscriptions
       set status = 'past_due', updated_at = ${at.toISOString()}::timestamptz
     where id = ${id} and status in ('trialing', 'active')
  `
}

export interface CancelInput {
  readonly id: string
  readonly at: Date
  /** Immediate cancellation ends access now; scheduled lets the paid period run out. */
  readonly immediately: boolean
}

/**
 * Cancel a subscription.
 *
 * Scheduled by default: the customer paid for this period and taking it away early is taking
 * something they own. `cancel_at` records the intent and the renewal job simply does not renew;
 * the entitlement expires on its own because it was only ever granted for the period.
 */
export async function cancelSubscription(sql: Db, input: CancelInput): Promise<SubscriptionRecord | null> {
  const rows = input.immediately
    ? await sql<SubscriptionRow[]>`
        update subscriptions
           set status = 'cancelled', cancelled_at = ${input.at.toISOString()}::timestamptz,
               cancel_at = ${input.at.toISOString()}::timestamptz, updated_at = now()
         where id = ${input.id}
        returning id, subject, product_id, price_id, status, quantity, current_period_start,
                  current_period_end, cancel_at, cancelled_at, latest_entry_id, scope
      `
    : await sql<SubscriptionRow[]>`
        update subscriptions
           set cancel_at = current_period_end, updated_at = now()
         where id = ${input.id}
        returning id, subject, product_id, price_id, status, quantity, current_period_start,
                  current_period_end, cancel_at, cancelled_at, latest_entry_id, scope
      `
  const row = rows[0]
  return row ? toSubscription(row) : null
}

export { subscriptionConfersAccess }
