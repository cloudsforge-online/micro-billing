/**
 * Outbox, relay and inbox.
 *
 * Rule 5 of docs/ecosystem/03 §2: every state change others care about writes an outbox row **in
 * the same transaction as the change**. That single word is the whole design. A publish after
 * commit is a publish that is skipped when the process dies in between, and a publish before
 * commit is a publish of something that never happened; both failure modes are silent and both
 * are unrecoverable after the fact. Writing the event with the change makes the outbox row and
 * the domain row succeed or fail together, and turns delivery into a retry problem, which is a
 * problem with a solution.
 *
 * Delivery is at-least-once. The consumer is what makes it effectively-once: `withInbox` inserts
 * `(topic, event_id)` and runs the handler only if that insert was the one that won. Consumers
 * dedupe on `(topic, event_id)` — AD-10.
 *
 * No broker. Postgres already has transactions and `SKIP LOCKED`, and AD-10 records the four
 * measured conditions under which that stops being true.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  verifyDelivery,
  type EventVersion,
} from '@cloudsforge/contracts-events'
import { HttpClient } from '@cloudsforge/http'
import type { Logger } from '@cloudsforge/telemetry'
import type { Handler } from '@cloudsforge/jobs'

export type Db = Sql
export type Tx = TransactionSql

/** What a caller emits. The envelope's `id`, `occurredAt` and `producer` are added here. */
export interface DomainEvent {
  /** `<service>.<aggregate>.<past-tense-verb>` — `widget.widget.created`. */
  readonly topic: string
  /** Ordering is per `(topic, key)` only. Choose the aggregate id, never a timestamp. */
  readonly key: string
  readonly payload: Record<string, unknown>
  readonly actor?: string
  readonly correlationId?: string
  readonly version?: number
}

/**
 * The wire version, in the CONTRACT's shape.
 *
 * `@cloudsforge/contracts-events` types `EventEnvelope.version` as `${number}.${number}` — a
 * "major.minor" STRING — and every consumer refuses an envelope without one. This relay stamped
 * the stored INTEGER, so a delivery whose signature verified was still thrown away at the
 * envelope, before anything looked at a payload.
 *
 * Measured on 2026-08-11: this service's outbox is EMPTY, and so is `entitlements` — nobody has
 * been granted anything on this estate yet, which is the only reason nothing has been lost. The
 * emit sites are live (`entitlements.ts`, on grant and on both revoke paths), BOTH topics are in
 * the contract's registry, and `admin-api` holds an active subscription to each. So the first
 * entitlement this service ever grants is refused at the envelope, and the symptom is silence
 * rather than an error. That makes this the most dangerous of the eight rather than the mildest:
 * it is one paying customer away from being live, with nothing in the estate to report it.
 *
 *     as shipped -> malformed: version: missing
 *     fixed      -> valid
 *
 * The stored column stays an integer: storage records the major, and the mapping to the
 * contract's shape happens here, at the wire, in one place. `EventVersion` is IMPORTED rather
 * than restated so this cannot drift from the type consumers check against — restating it
 * locally is what let `version: number` typecheck clean in eight repositories at once.
 */
const wireVersion = (v: number): EventVersion => `${v}.0`

/**
 * The wire envelope. Additive-only, versioned per topic, schema-diff enforced — AD-02.
 *
 * `version`, `actor` and `correlationId` are the CONTRACT's types, not the column's. The stored
 * row is looser than the wire — `actor` and `correlation_id` are nullable columns, `version` is
 * an integer — and all three were passed straight through. Typing them here makes passing a
 * column through a compile error rather than a delivery nobody receives and nobody reports.
 */
export interface EventEnvelope {
  readonly id: string
  readonly topic: string
  readonly key: string
  readonly occurredAt: string
  readonly producer: string
  readonly version: EventVersion
  readonly actor: string
  readonly correlationId: string
  readonly payload: Record<string, unknown>
}

export type Emit = (event: DomainEvent) => void

/**
 * Run a domain change and its events in one transaction.
 *
 *   const widget = await withOutbox(sql, SERVICE, async (tx, emit) => {
 *     const row = await insertWidget(tx, input)
 *     emit({ topic: 'widget.widget.created', key: row.id, payload: { id: row.id } })
 *     return row
 *   })
 *
 * `emit` collects rather than writes, so the events land after the handler has succeeded and a
 * caller cannot accidentally publish an event for a change it then rolled back.
 */
export async function withOutbox<T>(
  sql: Db,
  producer: string,
  fn: (tx: Tx, emit: Emit) => Promise<T>,
): Promise<T> {
  const outcome = await sql.begin(async (tx) => {
    const pending: DomainEvent[] = []
    const value = await fn(tx, (event) => {
      pending.push(event)
    })
    for (const event of pending) {
      await tx`
        insert into outbox (topic, key, producer, version, actor, correlation_id, payload)
        values (
          ${event.topic},
          ${event.key},
          ${producer},
          ${event.version ?? 1},
          ${event.actor ?? null},
          ${event.correlationId ?? null},
          ${tx.json(event.payload as Record<string, never>)}
        )
      `
    }
    // Wrapped so postgres.js does not treat an array-shaped result as a list of promises to
    // unwrap, which would rewrite the caller's return type.
    return { value }
  })
  return outcome.value
}

/* ------------------------------------------------------------------------ signing */

/**
 * The header THIS SERVICE'S RELAY SENDS. Still the local scheme, and deliberately untouched here.
 *
 * Every consumer of a `billing.*` topic verifies `sha256=<hmac>` under this name today, so moving
 * the producer half is a coordinated change across those consumers and is not what the erasure
 * subscriber needs. The INBOUND half below is a different question with a different answer.
 */
const LEGACY_SIGNATURE_HEADER = 'x-cloudsforge-signature'

/** `sha256=<hex>` over the exact bytes sent, so a subscriber verifies before parsing. */
export function signEvent(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

/** Timing-safe, because a byte-at-a-time comparison of a MAC is a byte-at-a-time forgery oracle. */
export function verifyEventSignature(body: string, secret: string, presented: string): boolean {
  const expected = Buffer.from(signEvent(body, secret))
  const actual = Buffer.from(presented)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/* ------------------------------------------------------------------------ inbound signing */

/**
 * **What arrives here is signed the CONTRACT'S way, not this file's, and that is a fact about
 * another repository rather than a preference.**
 *
 * The one producer this service subscribes to is identity, and `identity/src/outbox.ts` imports
 * `signDelivery` from `@cloudsforge/contracts-events`: `cf-signature: t=<seconds>,v1=<hmac over
 * "<seconds>.<body>">`. Verifying inbound with the local `verifyEventSignature` above — which
 * expects `x-cloudsforge-signature: sha256=<hmac over body>` under a different header name — would
 * reject every `identity.user.deleted` delivery for ever, with a green `/livez` and a relay
 * retrying a 403 until someone read the delivery-failure table. That is the erasure gap this
 * subscriber exists to close, reintroduced one layer down.
 *
 * So the inbound arm is the contract's, imported rather than copied, and there is deliberately no
 * legacy arm: nothing in the estate has ever delivered an event to this service, so there is no
 * installed base to keep working and no dead code to justify later. The contract's scheme also
 * binds a timestamp INSIDE the signed message, which the local scheme does not, so a captured
 * delivery stops being a credential after `DELIVERY_TOLERANCE_MS`.
 *
 * `secrets` is a list for rotation: an endpoint publishes a new secret, accepts both for a window,
 * then drops the old one. Every candidate is compared timing-safely inside `verifyDelivery`.
 */
export function verifyInboundDelivery(
  body: string,
  presented: string,
  secrets: string | readonly string[],
): boolean {
  if (presented.length === 0) return false
  return verifyDelivery(body, presented, secrets).ok
}

export { EVENT_ID_HEADER, SIGNATURE_HEADER }

/* ------------------------------------------------------------------------ relay */

export interface RelayDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly signingSecret: string
  readonly batchSize?: number
  readonly deadlineMs?: number
  /** Test seam. Production builds one `HttpClient` per subscription URL. */
  readonly clientFor?: (url: string) => Pick<HttpClient, 'request'>
}

export interface OutboxRow {
  readonly id: string
  readonly topic: string
  readonly key: string
  readonly occurred_at: Date
  readonly producer: string
  readonly version: number
  readonly actor: string | null
  readonly correlation_id: string | null
  readonly payload: Record<string, unknown>
}

/**
 * A stored row, as the envelope that goes on the wire. THE ONLY PLACE AN ENVELOPE IS BUILT.
 *
 * Exported and separated from `createRelay` so the wire shape can be asserted WITHOUT a database.
 * That is the whole reason the version defect survived: this suite covered the outbox insert and
 * the signing scheme, both of which were right, and never once looked at what was inside the
 * bytes it signed. A seam that needs a Postgres to observe is a seam that goes unobserved.
 */
export function buildEnvelope(row: OutboxRow): EventEnvelope {
  return {
    id: row.id,
    topic: row.topic,
    key: row.key,
    occurredAt: row.occurred_at.toISOString(),
    producer: row.producer,
    version: wireVersion(row.version),
    // `system` is the contract's own value for "no principal did this" — a scheduled entitlement expiry, which
    // is exactly what a null actor column means here. A missing correlation id falls back to the
    // event id: an id that ties the event to itself is weaker than one that ties it to the
    // request, but it is never absent, and an absent one is where a cross-service investigation
    // stops — the contract's own wording for the defect it answers with.
    actor: row.actor ?? 'system',
    correlationId: row.correlation_id ?? row.id,
    payload: row.payload,
  }
}

interface SubscriptionRow {
  readonly id: string
  readonly url: string
}

/**
 * The relay job.
 *
 * A leased job rather than a `setInterval`, for the reason rule 8 exists: two replicas running an
 * interval-driven relay both read the same unpublished rows and every subscriber receives every
 * event twice. The lease key names the contended resource — the outbox stream — so exactly one
 * replica relays at a time whatever the replica count is.
 */
export function createRelay(deps: RelayDeps): Handler {
  const batchSize = deps.batchSize ?? 50
  const deadlineMs = deps.deadlineMs ?? 5_000
  // Clients are cached for the life of the process so a circuit breaker accumulates state across
  // ticks. A fresh client per tick has a permanently closed circuit and hammers a dead subscriber.
  const clients = new Map<string, Pick<HttpClient, 'request'>>()
  const clientFor =
    deps.clientFor ??
    ((url: string) => {
      const existing = clients.get(url)
      if (existing) return existing
      const parsed = new URL(url)
      const client = new HttpClient({ baseUrl: parsed.origin, name: `subscriber:${parsed.host}` })
      clients.set(url, client)
      return client
    })

  return async (_job, ctx) => {
    const events = await deps.sql<OutboxRow[]>`
      select id, topic, key, occurred_at, producer, version, actor, correlation_id, payload
        from outbox
       where published_at is null
       order by occurred_at
       limit ${batchSize}
    `

    for (const event of events) {
      if (ctx.signal.aborted) return

      const subscriptions = await deps.sql<SubscriptionRow[]>`
        select id, url from event_subscriptions where topic = ${event.topic} and active = true
      `

      const envelope = buildEnvelope(event)
      // Signed over the exact bytes `HttpClient` will send: it stringifies the same object with
      // the same key order, so the MAC a subscriber recomputes over the received body matches.
      const signature = signEvent(JSON.stringify(envelope), deps.signingSecret)

      for (const subscription of subscriptions) {
        await deliver(deps, clientFor, subscription, envelope, signature, deadlineMs)
      }

      // Only when nothing is outstanding.
      //
      // THE GUARANTEE THIS USED TO CLAIM IS FALSE, and it was carried verbatim by eighteen
      // repositories. It said "a subscriber added after the event was written still receives it",
      // which holds only while some OTHER subscriber is still undelivered. With no active
      // subscription for the topic — the ordinary case for a new event type — the count below is
      // zero on the first pass, the row is published immediately, and it is never reconsidered. A
      // subscriber added afterwards gets nothing.
      //
      // The behaviour is right: an outbox row that stays unpublished because nobody is listening
      // is a backlog that grows for ever. It is the promise that was wrong, and a false guarantee
      // is worse than none, because an integrator plans around it — "register the subscription
      // whenever, the outbox will catch up" is a reasonable thing to believe from the old wording
      // and will silently lose every event published before the subscription existed.
      //
      // Delivery rows ARE computed from the live subscription set on every pass, which is what
      // makes a subscriber added mid-flight receive the remainder. That is the true half.
      const outstanding = await deps.sql<{ n: number }[]>`
        select count(*)::int as n
          from event_subscriptions s
          left join outbox_deliveries d
            on d.subscription_id = s.id and d.event_id = ${event.id}
         where s.topic = ${event.topic}
           and s.active = true
           and d.delivered_at is null
      `
      if ((outstanding[0]?.n ?? 0) === 0) {
        await deps.sql`update outbox set published_at = now() where id = ${event.id}`
      }

      // A long backlog must not outlive the lease and hand the same events to a second replica.
      await ctx.heartbeat()
    }
  }
}

async function deliver(
  deps: RelayDeps,
  clientFor: (url: string) => Pick<HttpClient, 'request'>,
  subscription: SubscriptionRow,
  envelope: EventEnvelope,
  signature: string,
  deadlineMs: number,
): Promise<boolean> {
  const claimed = await deps.sql<{ delivered_at: Date | null }[]>`
    insert into outbox_deliveries (event_id, subscription_id, attempts)
    values (${envelope.id}, ${subscription.id}, 0)
    on conflict (event_id, subscription_id) do update set attempts = outbox_deliveries.attempts + 1
    returning delivered_at
  `
  if (claimed[0]?.delivered_at) return true

  const parsed = new URL(subscription.url)
  try {
    await clientFor(subscription.url).request(`${parsed.pathname}${parsed.search}`, {
      method: 'POST',
      body: envelope,
      deadlineMs,
      // The event id is the idempotency key, which is what makes this POST safe to retry and is
      // the same value the subscriber dedupes on.
      idempotencyKey: envelope.id,
      headers: { [LEGACY_SIGNATURE_HEADER]: signature, 'x-event-id': envelope.id },
      ...(envelope.correlationId ? { requestId: envelope.correlationId } : {}),
    })
    await deps.sql`
      update outbox_deliveries set delivered_at = now(), last_error = null
       where event_id = ${envelope.id} and subscription_id = ${subscription.id}
    `
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await deps.sql`
      update outbox_deliveries set last_error = ${message.slice(0, 2_000)}
       where event_id = ${envelope.id} and subscription_id = ${subscription.id}
    `
    // Logged, not thrown: one unreachable subscriber must not stop the other subscribers or the
    // rest of the batch. The job succeeds; the undelivered row is the durable record, and the
    // next pass retries it.
    deps.logger.warn('event delivery failed', {
      topic: envelope.topic,
      eventId: envelope.id,
      subscriptionId: subscription.id,
      err: message,
    })
    return false
  }
}

/* ------------------------------------------------------------------------ inbox */

export type InboxOutcome<T> = { readonly status: 'processed'; readonly value: T } | { readonly status: 'duplicate' }

/**
 * Run an inbound event's handler exactly once.
 *
 * The insert and the handler share one transaction, so a handler that fails leaves no inbox row
 * and the redelivery is processed rather than swallowed — which is the mistake that makes a naive
 * "record then handle" dedupe lose events.
 */
export async function withInbox<T>(
  sql: Db,
  topic: string,
  eventId: string,
  handle: (tx: Tx) => Promise<T>,
): Promise<InboxOutcome<T>> {
  const outcome = await sql.begin(async (tx) => {
    const claimed = await tx<{ event_id: string }[]>`
      insert into inbox (topic, event_id) values (${topic}, ${eventId})
      on conflict (topic, event_id) do nothing
      returning event_id
    `
    if (claimed.length === 0) return { result: { status: 'duplicate' } as InboxOutcome<T> }
    const value = await handle(tx)
    return { result: { status: 'processed', value } as InboxOutcome<T> }
  })
  return outcome.result
}
