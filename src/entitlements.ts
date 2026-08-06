/**
 * Entitlements: what a subject owns, where, until when, and whether it has been taken back.
 *
 * ---------------------------------------------------------------------------------------------
 * **The four things today's entitlements lack are the entire point of this file.**
 * 04-domain-model.md §8.1, and every one of them is a live defect:
 *
 *   1. **A scope.** `platform`, `title:<id>` or `community:<id>`, so a service can ask "does this
 *      user own X *for this title*". The estate's row is `(userId, sku, kind)` and a private world
 *      rented for one title is indistinguishable from one rented for another — which is part of
 *      why a purchased private world is never provisioned.
 *   2. **An expiry.** So a season pass ends. The estate grants `SEASON_PASS` once and for ever,
 *      so season two cannot be sold to anybody who bought season one.
 *   3. **Revocation.** So a refund removes what it paid for. There is no revocation column in the
 *      estate at all; a refunded purchase leaves its entitlement standing.
 *   4. **A service-readable API.** The estate's `GET /entitlements` is Bearer-only
 *      (`monetization.ts`, `preHandler: requireAuth`), so **no service can ask whether a user
 *      owns anything** — a world server holding no user token has no way to find out that a world
 *      was bought. `internalListEntitlements` below is that missing API, and it is why `subject`
 *      is an `AccountSubject` rather than a bare user id.
 *
 * **Activity is decided in two places and they must agree.** `isEntitlementActive` in
 * contracts-money is the contract every consumer evaluates; `ACTIVE_PREDICATE` below is the SQL
 * the list query filters on. A test asserts they agree on the boundary cases, because a service
 * whose list says "owned" and whose check says "not owned" is worse than either answer alone.
 * ---------------------------------------------------------------------------------------------
 */

import {
  isEntitlementActive,
  parseAccountSubject,
  type Entitlement,
  type EntitlementScope,
  type EntitlementSource,
} from '@cloudsforge/contracts-money'
import type { Db, Emit, Tx } from './outbox.ts'

/** The topic that finally provisions the thing that was paid for. 04-domain-model.md §8.1. */
export const GRANTED_TOPIC = 'billing.entitlement.granted'
export const REVOKED_TOPIC = 'billing.entitlement.revoked'

export class InvalidScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidScopeError'
  }
}

export class UnknownEntitlementError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnknownEntitlementError'
  }
}

/**
 * Parse a scope, refusing anything that is not one of the three shapes.
 *
 * Validated rather than trusted because the scope is a lookup key: a service asks for
 * `title:9f2c` and must not be answered with a grant whose scope is `title:9f2c/../platform` or
 * an empty id that matches everything. The database carries the same rule as a CHECK, so a row
 * inserted by hand obeys it too.
 */
export function parseScope(value: string): EntitlementScope {
  const text = value.trim()
  if (text === 'platform') return 'platform'
  for (const prefix of ['title:', 'community:'] as const) {
    if (!text.startsWith(prefix)) continue
    const id = text.slice(prefix.length)
    if (id.length === 0) throw new InvalidScopeError(`${prefix} scope needs an id`)
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) {
      throw new InvalidScopeError(`not a usable scope id: ${id}`)
    }
    return `${prefix}${id}` as EntitlementScope
  }
  throw new InvalidScopeError(`scope must be platform, title:<id> or community:<id> (got ${value})`)
}

/** A subject, validated by the same parser the ledger uses so the two cannot disagree. */
export function parseSubject(value: string): string {
  parseAccountSubject(value)
  return value
}

export interface EntitlementRecord extends Entitlement {
  /** The ledger entry that paid for this grant. A refund reverses it and revokes the row. */
  readonly journalEntryId: string | null
  readonly purchaseId: string | null
  readonly subscriptionId: string | null
  readonly revokedReason: string | null
}

interface EntitlementRow {
  readonly id: string
  readonly subject: string
  readonly product_id: string
  readonly sku: string
  readonly scope: string
  readonly source: string
  readonly granted_at: Date
  readonly expires_at: Date | null
  readonly revoked_at: Date | null
  readonly revoked_reason: string | null
  readonly quantity: string
  readonly metadata: Record<string, string | number | boolean | null>
  readonly journal_entry_id: string | null
  readonly purchase_id: string | null
  readonly subscription_id: string | null
}

export function toEntitlement(row: EntitlementRow): EntitlementRecord {
  return {
    id: row.id,
    subject: row.subject as EntitlementRecord['subject'],
    productId: row.product_id,
    sku: row.sku,
    scope: row.scope as EntitlementScope,
    source: row.source as EntitlementSource,
    grantedAt: row.granted_at.toISOString(),
    ...(row.expires_at ? { expiresAt: row.expires_at.toISOString() } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {}),
    quantity: BigInt(row.quantity),
    metadata: row.metadata,
    journalEntryId: row.journal_entry_id,
    purchaseId: row.purchase_id,
    subscriptionId: row.subscription_id,
    revokedReason: row.revoked_reason,
  }
}

/**
 * The wire shape. `quantity` is a string for the same reason every other amount in the estate is:
 * a JSON number is a double, and a seat count that silently becomes 9007199254740993 is a support
 * ticket nobody can reproduce.
 */
export function toWire(entitlement: EntitlementRecord, at: string): Record<string, unknown> {
  return {
    id: entitlement.id,
    subject: entitlement.subject,
    productId: entitlement.productId,
    sku: entitlement.sku,
    scope: entitlement.scope,
    source: entitlement.source,
    grantedAt: entitlement.grantedAt,
    expiresAt: entitlement.expiresAt ?? null,
    revokedAt: entitlement.revokedAt ?? null,
    revokedReason: entitlement.revokedReason,
    quantity: entitlement.quantity.toString(),
    metadata: entitlement.metadata ?? {},
    journalEntryId: entitlement.journalEntryId,
    purchaseId: entitlement.purchaseId,
    subscriptionId: entitlement.subscriptionId,
    // Computed at an explicit instant, and served alongside the raw fields so a consumer can both
    // trust our answer and check it. This is the field a world server actually reads.
    active: isEntitlementActive(entitlement, at),
  }
}

export interface GrantInput {
  readonly subject: string
  readonly productId: string
  readonly sku: string
  readonly scope: EntitlementScope
  readonly source: EntitlementSource
  readonly quantity: bigint
  /**
   * When the grant takes effect. **Supplied by the application, never left to `now()`.**
   *
   * Every timestamp the activity rule reads — `granted_at`, `expires_at`, `revoked_at` — must come
   * from one clock domain. Defaulting this to the database's `now()` mixed two: the row was
   * stamped with the database's clock and `isEntitlementActive` then compared it against the
   * caller's, so a few tens of milliseconds of skew between the two hosts made a just-granted
   * entitlement read as "not yet active" — and the purchase response said `active: false` for
   * something the customer had at that moment paid for. It was caught by the tests here on a host
   * whose Postgres clock ran 60ms ahead.
   */
  readonly grantedAt?: Date
  readonly expiresAt?: Date | null
  readonly purchaseId?: string | null
  readonly subscriptionId?: string | null
  readonly journalEntryId?: string | null
  readonly metadata?: Record<string, string | number | boolean | null>
  readonly actor: string
  readonly correlationId: string
}

/**
 * Grant an entitlement and emit `billing.entitlement.granted`, **in one transaction**.
 *
 * The event is the invariant from 04-domain-model.md §8.1: "Every entitlement grant emits
 * `billing.entitlement.granted`. The service that delivers the thing subscribes. This is what
 * finally builds the private world that is currently sold and never provisioned."
 *
 * `emit` collects into the outbox inside the caller's transaction, so the grant and the event
 * commit together. Publishing after the commit is what loses the event when the process dies in
 * the gap — and a lost `granted` event is a customer who paid for a world that never appears.
 */
export async function grantEntitlement(
  tx: Tx,
  emit: Emit,
  input: GrantInput,
): Promise<EntitlementRecord> {
  const grantedAt = (input.grantedAt ?? new Date()).toISOString()
  const rows = await tx<EntitlementRow[]>`
    insert into entitlements (
      subject, product_id, sku, scope, source, granted_at, expires_at, quantity, metadata,
      purchase_id, subscription_id, journal_entry_id
    )
    values (
      ${input.subject}, ${input.productId}, ${input.sku}, ${input.scope}, ${input.source},
      ${grantedAt}::timestamptz,
      ${input.expiresAt ? input.expiresAt.toISOString() : null}, ${input.quantity.toString()}::numeric,
      ${tx.json((input.metadata ?? {}) as Record<string, never>)},
      ${input.purchaseId ?? null}, ${input.subscriptionId ?? null}, ${input.journalEntryId ?? null}
    )
    returning id, subject, product_id, sku, scope, source, granted_at, expires_at, revoked_at,
              revoked_reason, quantity, metadata, journal_entry_id, purchase_id, subscription_id
  `
  const row = rows[0]
  if (!row) throw new Error('insert returned no row')
  const entitlement = toEntitlement(row)

  emit({
    topic: GRANTED_TOPIC,
    // Ordering is only guaranteed per (topic, key), so the key is the aggregate: two events about
    // one entitlement stay in order, and two entitlements do not serialise against each other.
    key: entitlement.id,
    payload: {
      entitlementId: entitlement.id,
      subject: entitlement.subject,
      productId: entitlement.productId,
      sku: entitlement.sku,
      // The scope is on the event, not only on the row. A subscriber that provisions a private
      // world needs to know WHICH title it belongs to, and having to call back for it is how a
      // consumer ends up guessing.
      scope: entitlement.scope,
      source: entitlement.source,
      quantity: entitlement.quantity.toString(),
      grantedAt: entitlement.grantedAt,
      expiresAt: entitlement.expiresAt ?? null,
      metadata: entitlement.metadata ?? {},
    },
    actor: input.actor,
    correlationId: input.correlationId,
  })

  return entitlement
}

/**
 * The SQL half of "is this live", and the twin of `isEntitlementActive`.
 *
 * One fragment used by every query rather than the predicate repeated, because two copies of it
 * that drift is precisely how a list and a check come to disagree. The comparisons are against an
 * explicit instant rather than `now()` so a replay, a backfill and a test all get a deterministic
 * answer — the same reason the contract function takes one.
 *
 * The boundaries match the contract exactly: `granted_at <= at`, `revoked_at > at`,
 * `expires_at > at`. An entitlement revoked at 12:00 is not active AT 12:00, and one granted at
 * 12:00 is. A test asserts the two agree on every one of those edges.
 */
function activeAt(sql: Db, at: string) {
  return sql`
    quantity > 0
    and granted_at <= ${at}::timestamptz
    and (revoked_at is null or revoked_at > ${at}::timestamptz)
    and (expires_at is null or expires_at > ${at}::timestamptz)
  `
}

export interface ListQuery {
  readonly subject: string
  readonly scope?: EntitlementScope
  readonly sku?: string
  /** The instant activity is evaluated at. Defaults to now, but is always explicit on the wire. */
  readonly at: string
  /** Revoked and expired grants are history; a consumer asking "what do they own" wants neither. */
  readonly includeInactive?: boolean
  readonly limit?: number
}

export const DEFAULT_PAGE_SIZE = 200
export const MAX_PAGE_SIZE = 1_000

/**
 * What a subject owns.
 *
 * One implementation, used by BOTH the user-facing route and the service-readable one. That is
 * deliberate and it is the point of the fourth defect: two queries would be two answers, and the
 * whole reason a service cannot ask today is that the only implementation sits behind a user's
 * Bearer token.
 */
export async function listEntitlements(sql: Db, query: ListQuery): Promise<EntitlementRecord[]> {
  const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  // Composed from nested tagged fragments rather than string concatenation with `sql.unsafe`.
  // Every value is still a bound parameter, and the row types come back parsed — an `unsafe`
  // query hands jsonb back as text, which is the sort of difference that only shows up in
  // production.
  const rows = await sql<EntitlementRow[]>`
    select id, subject, product_id, sku, scope, source, granted_at, expires_at, revoked_at,
           revoked_reason, quantity, metadata, journal_entry_id, purchase_id, subscription_id
      from entitlements
     where subject = ${query.subject}
       ${query.scope !== undefined ? sql`and scope = ${query.scope}` : sql``}
       ${query.sku !== undefined ? sql`and sku = ${query.sku}` : sql``}
       ${query.includeInactive ? sql`` : sql`and ${activeAt(sql, query.at)}`}
     order by granted_at desc, id desc
     limit ${limit}
  `
  return rows.map(toEntitlement)
}

export async function readEntitlement(sql: Db, id: string): Promise<EntitlementRecord | null> {
  const rows = await sql<EntitlementRow[]>`
    select id, subject, product_id, sku, scope, source, granted_at, expires_at, revoked_at,
           revoked_reason, quantity, metadata, journal_entry_id, purchase_id, subscription_id
      from entitlements
     where id = ${id}
  `
  const row = rows[0]
  return row ? toEntitlement(row) : null
}

export interface RevokeInput {
  readonly id: string
  readonly reason: string
  readonly actor: string
  readonly correlationId: string
  /** Explicit so a revocation can be recorded at the instant a refund was decided. */
  readonly at?: Date
}

/**
 * Revoke a grant, and emit `billing.entitlement.revoked`.
 *
 * **Revoking is idempotent and never moves the revocation date.** A second revoke of the same
 * entitlement returns the row unchanged rather than resetting `revoked_at` to now: the first one
 * is when the customer lost access, and rewriting it would silently extend the window in which
 * they still had it.
 *
 * The row is updated, never deleted. A deleted entitlement cannot answer "did this user ever own
 * this", which is the first question asked when a refund is disputed.
 */
export async function revokeEntitlement(
  tx: Tx,
  emit: Emit,
  input: RevokeInput,
): Promise<{ entitlement: EntitlementRecord; alreadyRevoked: boolean }> {
  const existing = await tx<EntitlementRow[]>`
    select id, subject, product_id, sku, scope, source, granted_at, expires_at, revoked_at,
           revoked_reason, quantity, metadata, journal_entry_id, purchase_id, subscription_id
      from entitlements
     where id = ${input.id}
     for update
  `
  const current = existing[0]
  if (!current) throw new UnknownEntitlementError(`no entitlement ${input.id}`)
  if (current.revoked_at !== null) {
    return { entitlement: toEntitlement(current), alreadyRevoked: true }
  }

  const at = (input.at ?? new Date()).toISOString()
  const rows = await tx<EntitlementRow[]>`
    update entitlements
       set revoked_at = ${at}::timestamptz, revoked_reason = ${input.reason}
     where id = ${input.id}
    returning id, subject, product_id, sku, scope, source, granted_at, expires_at, revoked_at,
              revoked_reason, quantity, metadata, journal_entry_id, purchase_id, subscription_id
  `
  const row = rows[0]
  if (!row) throw new UnknownEntitlementError(`no entitlement ${input.id}`)
  const entitlement = toEntitlement(row)

  emit({
    topic: REVOKED_TOPIC,
    key: entitlement.id,
    payload: {
      entitlementId: entitlement.id,
      subject: entitlement.subject,
      productId: entitlement.productId,
      sku: entitlement.sku,
      scope: entitlement.scope,
      reason: input.reason,
      revokedAt: entitlement.revokedAt ?? at,
      // Named on the event so the subscriber that provisioned the thing can tear down exactly
      // what it built rather than recomputing which grant this was.
      journalEntryId: entitlement.journalEntryId,
    },
    actor: input.actor,
    correlationId: input.correlationId,
  })

  return { entitlement, alreadyRevoked: false }
}

/**
 * Expire grants whose time has passed, so the outbox carries an event for each.
 *
 * Activity does not depend on this running — `isEntitlementActive` and the list predicate both
 * compare against `expires_at`, so an expired grant stops satisfying a check the moment it
 * expires, sweep or no sweep. What the sweep adds is the *notification*: a season pass that has
 * ended is a thing the game server needs to hear about, not merely a thing it would discover if
 * it happened to ask.
 */
export async function expireDue(
  tx: Tx,
  emit: Emit,
  at: Date,
  limit = 500,
): Promise<EntitlementRecord[]> {
  const rows = await tx<EntitlementRow[]>`
    update entitlements
       set revoked_at = expires_at, revoked_reason = 'expired'
     where id in (
       select id from entitlements
        where revoked_at is null
          and expires_at is not null
          and expires_at <= ${at.toISOString()}::timestamptz
        order by expires_at
        limit ${limit}
        for update skip locked
     )
    returning id, subject, product_id, sku, scope, source, granted_at, expires_at, revoked_at,
              revoked_reason, quantity, metadata, journal_entry_id, purchase_id, subscription_id
  `
  const expired = rows.map(toEntitlement)
  for (const entitlement of expired) {
    emit({
      topic: REVOKED_TOPIC,
      key: entitlement.id,
      payload: {
        entitlementId: entitlement.id,
        subject: entitlement.subject,
        productId: entitlement.productId,
        sku: entitlement.sku,
        scope: entitlement.scope,
        reason: 'expired',
        revokedAt: entitlement.revokedAt ?? at.toISOString(),
        journalEntryId: entitlement.journalEntryId,
      },
      actor: 'system',
      correlationId: `expiry-${at.toISOString()}`,
    })
  }
  return expired
}

/** Re-exported so a consumer of this module never reaches for a second definition of "active". */
export { isEntitlementActive }
