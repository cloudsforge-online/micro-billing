/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. There is no
 * `setInterval` in this repository doing domain work, and adding one fails review — the estate
 * runs eight of them today, each guarded only by a module-local boolean, which is a variable that
 * by construction cannot be seen by a second process.
 *
 * **The lease key names the contended resource, not the row.** This is the decision most likely to
 * be got wrong by someone extending this file. Ask: what would break if two of these ran at once?
 *
 *   | Work                  | Key                 | What two at once would break                  |
 *   |-----------------------|---------------------|-----------------------------------------------|
 *   | outbox.relay          | `stream`            | The outbox stream. Two relays deliver one     |
 *   |                       |                     | batch to one subscriber twice.                |
 *   | billing.entitlement.  | `global`            | Nothing, but two sweeps would emit two        |
 *   |   expire              |                     | `revoked` events for one expiry — and a       |
 *   |                       |                     | subscriber that tears down a world on that    |
 *   |                       |                     | event would do it twice. The UPDATE uses      |
 *   |                       |                     | SKIP LOCKED as a second line of defence.      |
 *   | billing.subscription. | `subscription:<id>` | THE subscription. Keying on the customer      |
 *   |   renew               |                     | would serialise their subscriptions for no    |
 *   |                       |                     | reason; keying globally would make one slow   |
 *   |                       |                     | renewal hold up every other. Keying on the    |
 *   |                       |                     | PERIOD instead would let a retry after a      |
 *   |                       |                     | period advance charge the next period early.  |
 *   | billing.renewals.scan | `global`            | The scan enqueues renewal jobs; two scans     |
 *   |                       |                     | would enqueue each twice — collapsed by the   |
 *   |                       |                     | (kind, key) uniqueness, but the second scan   |
 *   |                       |                     | is pure waste against the same index.         |
 *   | billing.idempotency.  | `global`            | Nothing, but two long DELETEs compete for the |
 *   |   reap                |                     | row locks at the head of every purchase.      |
 *   | billing.engagement.   | `global`            | Nothing that survives, because the unique     |
 *   |   recycle             |                     | index on (asset, period) and the period-      |
 *   |                       |                     | derived idempotency key each refuse the       |
 *   |                       |                     | double — but two runs would both call the     |
 *   |                       |                     | ledger for one period, and one of them would  |
 *   |                       |                     | be told 'replayed' for money it did not move. |
 *   |                       |                     | Keying on the PERIOD instead would let a run  |
 *   |                       |                     | that is behind close several days in          |
 *   |                       |                     | parallel, which is exactly the ordering the   |
 *   |                       |                     | contiguity rule in `recycle.ts` depends on.   |
 */

import { JobRunner, type JobQueue, type RunnerEvent } from '@cloudsforge/jobs'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import type { LedgerAssetCode } from '@cloudsforge/contracts-money'
import { createRelay, type RelayDeps, type Db, type Emit } from './outbox.ts'
import { expireDue, grantEntitlement } from './entitlements.ts'
import { reapIdempotencyKeys } from './idempotency.ts'
import { writeEvents } from './purchases.ts'
import { purchasePostings, InsufficientFundsError, type LedgerClient } from './ledger.ts'
import { advancePeriod, dueForRenewal, markPastDue, readSubscription } from './subscriptions.ts'
import { nextPeriodEnd, resolveTarget } from './catalogue.ts'
import { createInvoice } from './revenue.ts'
import { runRecycle, type RecycleDeps } from './recycle.ts'
import type { EngagementPolicyClient } from './adminapi.ts'

export const RELAY_KIND = 'outbox.relay'
export const EXPIRE_KIND = 'billing.entitlement.expire'
export const RENEW_KIND = 'billing.subscription.renew'
export const RENEWAL_SCAN_KIND = 'billing.renewals.scan'
export const REAP_KIND = 'billing.idempotency.reap'
export const RECYCLE_KIND = 'billing.engagement.recycle'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export interface JobDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly metrics: Metrics
  readonly ledger: LedgerClient
  readonly producer: string
  readonly assetCode: LedgerAssetCode
  readonly signingSecret: string
  readonly idempotencyTtlDays: number
  /**
   * micro-admin-api, for the fee-recycle percentage — 21 §3.
   *
   * Optional on purpose. `ADMIN_API_URL` unset means this deployment runs no engagement
   * programme, which is a supported mode and a true statement rather than a misconfiguration.
   * The recurring job still runs and still finishes any period the ledger already owes an
   * answer about; it just closes no new ones.
   */
  readonly adminApi?: EngagementPolicyClient | undefined
}

export interface RecurringJob {
  readonly kind: string
  readonly key: string
  readonly everyMs: number
}

/**
 * Jobs that must exist whether or not anything enqueued them, and how often they repeat.
 *
 * A recurring job is a producer plus a leased job, never a timer. The producer is the boot seed
 * plus the reschedule on completion — so the interval survives a restart, is visible in a table an
 * operator can query, and is claimed by exactly one replica.
 */
export const RECURRING: readonly RecurringJob[] = Object.freeze([
  { kind: RELAY_KIND, key: 'stream', everyMs: 1_000 },
  // A minute. An expired entitlement already fails every check the moment it expires — activity is
  // computed against `expires_at`, not against this sweep — so the interval only bounds how late
  // the `revoked` event is, not how long access lingers.
  { kind: EXPIRE_KIND, key: 'global', everyMs: MINUTE },
  { kind: RENEWAL_SCAN_KIND, key: 'global', everyMs: 5 * MINUTE },
  { kind: REAP_KIND, key: 'global', everyMs: 24 * HOUR },
  // Hourly, for a job that closes whole UTC days. Not daily: an hourly cadence means a period
  // that could not be closed — admin-api unreachable, the ledger's answer lost — is retried
  // within the hour rather than tomorrow, and the cost of a run with nothing to do is two
  // indexed selects. It also makes the FIRST run after a deploy happen within the hour, which is
  // when a misconfigured token gets found.
  { kind: RECYCLE_KIND, key: 'global', everyMs: HOUR },
])

/** Enqueue the recurring set at boot. `keep` means N replicas booting together produce one row. */
export async function seedRecurring(queue: JobQueue): Promise<void> {
  for (const job of RECURRING) {
    await queue.enqueue({ kind: job.kind, key: job.key, onConflict: 'keep' })
  }
}

/**
 * Re-arm a recurring job once it has finished.
 *
 * It cannot re-arm itself from inside its own handler: the runner deletes the row on success
 * *after* the handler returns, so a self-enqueue would be deleted a moment later and the schedule
 * would stop.
 *
 * A dead-lettered recurring job is deliberately **not** re-armed. The row stays, `jobs_dead_total`
 * increments and `jobs_overdue` climbs, which is how an operator finds out. A renewal that has
 * failed its whole attempt budget is a subscription nobody is charging, and hiding that behind a
 * busy loop would make it invisible until the customer complains.
 */
export function rescheduleRecurring(queue: JobQueue, logger: Logger): (event: RunnerEvent) => void {
  const byKey = new Map(RECURRING.map((job) => [`${job.kind}|${job.key}`, job]))
  return (event) => {
    if (event.type !== 'completed') return
    const recurring = event.kind && event.key ? byKey.get(`${event.kind}|${event.key}`) : undefined
    if (!recurring) return
    void queue
      .enqueue({
        kind: recurring.kind,
        key: recurring.key,
        runAt: new Date(Date.now() + recurring.everyMs),
        onConflict: 'earliest',
      })
      .catch((err: unknown) => logger.error('failed to re-arm recurring job', { kind: recurring.kind, err }))
  }
}

export function registerHandlers(runner: JobRunner, deps: JobDeps): JobRunner {
  const relayDeps: RelayDeps = {
    sql: deps.sql,
    logger: deps.logger.child({ job: RELAY_KIND }),
    signingSecret: deps.signingSecret,
  }
  runner.register(RELAY_KIND, createRelay(relayDeps))

  /**
   * Emit a `revoked` event for every entitlement whose expiry has passed.
   *
   * The sweep does not create the expiry — a season pass stops satisfying a check the instant
   * `expires_at` passes, whether or not this ever runs. What it adds is the notification, which is
   * what lets the service that built the thing take it down.
   */
  runner.register(EXPIRE_KIND, async () => {
    const at = new Date()
    const outcome = await deps.sql.begin(async (tx) => {
      const events: Parameters<Emit>[0][] = []
      const expired = await expireDue(tx, (event) => events.push(event), at)
      await writeEvents(tx, deps.producer, events)
      return { value: expired }
    })
    if (outcome.value.length > 0) {
      deps.metrics.increment('billing_entitlements_expired_total', {}, outcome.value.length)
      deps.logger.info('entitlements expired', {
        job: EXPIRE_KIND,
        count: outcome.value.length,
        skus: [...new Set(outcome.value.map((e) => e.sku))],
      })
    }
  })

  /**
   * Find subscriptions whose period has ended and enqueue one renewal job each.
   *
   * A scan plus a per-subscription job, rather than one job that renews them all: a single job
   * would make one customer's failed charge either abort the batch or be swallowed, and its lease
   * would have to cover every renewal at once.
   */
  runner.register(RENEWAL_SCAN_KIND, async () => {
    const due = await dueForRenewal(deps.sql, new Date())
    for (const subscription of due) {
      if (subscription.cancelAt !== null && Date.parse(subscription.cancelAt) <= Date.now()) {
        // Cancellation was scheduled for the period end and the period has ended. Not renewing IS
        // the cancellation: the entitlement expired with the period, so nothing has to be revoked.
        await deps.sql`
          update subscriptions
             set status = 'cancelled', cancelled_at = coalesce(cancelled_at, now()), updated_at = now()
           where id = ${subscription.id}
        `
        continue
      }
      await queueRenewal(deps, subscription.id)
    }
  })

  runner.register<{ subscriptionId?: string }>(RENEW_KIND, async (job) => {
    const subscriptionId = job.payload.subscriptionId ?? job.key.replace(/^subscription:/, '')
    await renewSubscription(deps, subscriptionId)
  })

  runner.register(REAP_KIND, async () => {
    const removed = await reapIdempotencyKeys(deps.sql, deps.idempotencyTtlDays)
    if (removed > 0) {
      deps.logger.info('reaped idempotency keys', { removed, ttlDays: deps.idempotencyTtlDays })
    }
  })

  /**
   * Recycle a share of platform fee revenue into the engagement treasury — 21 §3.
   *
   * The whole decision procedure is in `recycle.ts`, including why an unreadable rate closes
   * nothing and why an unknown ledger outcome leaves the row pending. What belongs here is the
   * one thing a job handler owes its runner: `runRecycle` returns for every expected refusal and
   * throws only for the genuinely unknown, so a throw out of this handler means "retry with
   * backoff" and nothing else does.
   */
  runner.register(RECYCLE_KIND, async () => {
    const recycleDeps: RecycleDeps = {
      sql: deps.sql,
      ledger: deps.ledger,
      logger: deps.logger.child({ job: RECYCLE_KIND }),
      metrics: deps.metrics,
      producer: deps.producer,
      assetCode: deps.assetCode,
      ...(deps.adminApi ? { adminApi: deps.adminApi } : {}),
    }
    const summary = await runRecycle(recycleDeps)
    if (summary.posted > 0 || summary.deferred > 0 || summary.halted !== undefined) {
      deps.logger.info('engagement fee recycle pass', { job: RECYCLE_KIND, ...summary })
    }
  })

  return runner
}

/** The queue is not in `JobDeps`, so the scan enqueues through the same table directly. */
async function queueRenewal(deps: JobDeps, subscriptionId: string): Promise<void> {
  await deps.sql`
    insert into jobs (kind, key, payload)
    values (${RENEW_KIND}, ${`subscription:${subscriptionId}`}, ${deps.sql.json({ subscriptionId } as never)})
    on conflict (kind, key) do nothing
  `
}

/**
 * Charge the next period and extend the entitlement.
 *
 * **The idempotency key is derived from the period being charged**, not from the attempt: a retry
 * after a partial failure presents the same key and the ledger replays its answer rather than
 * charging twice. Keying on the attempt, or on `now()`, is how a customer is billed twice for one
 * month.
 */
export async function renewSubscription(deps: JobDeps, subscriptionId: string): Promise<void> {
  const subscription = await readSubscription(deps.sql, subscriptionId)
  if (!subscription) return
  if (!['trialing', 'active', 'past_due'].includes(subscription.status)) return

  const target = await resolveTarget(deps.sql, {
    priceId: subscription.priceId,
    assetCode: deps.assetCode,
  })
  const periodStart = new Date(subscription.currentPeriodEnd)
  const periodEnd = nextPeriodEnd(target.price, periodStart)
  const amount = target.price.unitAmount * subscription.quantity

  let entryId: string
  try {
    const entry = await deps.ledger.postEntry({
      kind: 'subscription_charge',
      actor: `service:${deps.producer}`,
      correlationId: `renew-${subscriptionId}-${periodStart.toISOString()}`,
      idempotencyKey: `billing:renew:${subscriptionId}:${periodStart.toISOString()}`,
      description: `${target.product.name} renewal`,
      metadata: { sku: target.product.sku, subscriptionId },
      postings: purchasePostings({
        subject: subscription.subject,
        assetCode: deps.assetCode,
        amount,
      }),
    })
    entryId = entry.id
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      // A balance problem, not a fault. `past_due` keeps access — `subscriptionConfersAccess`
      // says so — while the entitlement itself has already expired with the period, so the
      // customer is in grace on a status rather than on a grant that outlived its payment.
      await markPastDue(deps.sql, subscriptionId, new Date())
      deps.metrics.increment('billing_renewals_total', { outcome: 'insufficient_funds' })
      deps.logger.warn('subscription renewal could not be charged', { subscriptionId, err })
      return
    }
    // Anything else is unknown, so the job fails and its backoff retries with the same key.
    throw err
  }

  await deps.sql.begin(async (tx) => {
    const events: Parameters<Emit>[0][] = []
    const emit: Emit = (event) => events.push(event)

    await advancePeriod(tx, { id: subscriptionId, periodStart, periodEnd, journalEntryId: entryId })

    // A fresh grant per period rather than an extension of the old row, so the history says what
    // was owned when. The previous period's entitlement has already expired on its own.
    await grantEntitlement(tx, emit, {
      subject: subscription.subject,
      productId: target.product.id,
      sku: target.product.sku,
      scope: subscription.scope,
      source: 'subscription',
      quantity: subscription.quantity,
      grantedAt: periodStart,
      expiresAt: periodEnd,
      subscriptionId,
      journalEntryId: entryId,
      metadata: { sku: target.product.sku, renewal: true },
      actor: `service:${deps.producer}`,
      correlationId: `renew-${subscriptionId}-${periodStart.toISOString()}`,
    })

    await createInvoice(tx, {
      subject: subscription.subject,
      subscriptionId,
      periodStart,
      periodEnd,
      assetCode: deps.assetCode,
      journalEntryId: entryId,
      lines: [
        {
          description: `${target.product.name} (${periodStart.toISOString().slice(0, 10)} to ${periodEnd
            .toISOString()
            .slice(0, 10)})`,
          quantity: subscription.quantity,
          unitAmount: target.price.unitAmount,
        },
      ],
    })

    await writeEvents(tx, deps.producer, events)
    return { value: null }
  })

  deps.metrics.increment('billing_renewals_total', { outcome: 'charged' })
  deps.logger.info('subscription renewed', { subscriptionId, periodEnd: periodEnd.toISOString() })
}
