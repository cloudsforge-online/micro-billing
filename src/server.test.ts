/**
 * The HTTP surface.
 *
 * The test that matters most is the parity one: **the service-readable API returns exactly what
 * the user-facing one does.** Both call `listEntitlements`, and the point of the fourth defect is
 * that today only the user-facing implementation exists at all — so proving the two cannot diverge
 * is proving the new capability is the same capability, not a second, weaker one.
 */

import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { TokenError, VerifierUnavailableError, type Principal } from '@cloudsforge/auth'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { createServer, registerServiceMetrics, type PrincipalVerifier } from './server.ts'
import {
  ALICE,
  ALICE_ID,
  BOB_ID,
  EVENT_SECRET,
  enabled,
  signedEvent,
  fakeLedger,
  freshKey,
  migrateTestDb,
  openDb,
  resetBilling,
  skip,
  type FakeLedger,
  emberFor,
  fakePricing,
} from './testsupport.ts'
import type { Db } from './outbox.ts'
import type { PurchaseDeps } from './purchases.ts'

/**
 * A verifier keyed on the token text, so a test names the authority it wants.
 *
 * An interface rather than a real `Verifier`, so these tests need no JWKS endpoint and no signing
 * key — the mapping from auth fault to status is what is under test, not jose.
 */
const verifier: PrincipalVerifier = {
  async principal(token: string): Promise<Principal> {
    switch (token) {
      case 'alice':
        return { kind: 'user', userId: ALICE_ID, handle: 'alice', roles: ['player'] }
      case 'bob':
        return { kind: 'user', userId: BOB_ID, handle: 'bob', roles: ['player'] }
      case 'admin':
        return { kind: 'user', userId: 'admin-1', handle: 'ops-jane', roles: ['admin'] }
      case 'svc-read':
        return { kind: 'service', service: 'game', scopes: ['billing:read'] }
      case 'svc-grant':
        return { kind: 'service', service: 'promotions', scopes: ['billing:grant', 'billing:read'] }
      case 'svc-none':
        return { kind: 'service', service: 'nosy', scopes: ['other:read'] }
      case 'down':
        throw new VerifierUnavailableError('jwks unreachable')
      default:
        throw new TokenError('bad signature', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED')
    }
  },
}

let sql: postgres.Sql
let server: Server
let baseUrl: string
let ledger: FakeLedger

before(async () => {
  if (!enabled) return
  sql = openDb(8)
  await migrateTestDb(sql)
  ledger = fakeLedger()

  const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 1_000 })
  const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
  server = createServer({
    lifecycle,
    logger: new Logger({ service: 'billing-test', level: 'fatal', sink: () => {} }),
    metrics,
    verifier,
    sql: singleNetworkSql(sql),
    singleNetwork: 'mainnet' as const,
    purchases: {
      sql: sql as unknown as Db,
      // A getter, so `beforeEach` can hand the routes a fresh ledger between cases without
      // rebuilding the server.
      get ledger() {
        return ledger
      },
      producer: 'billing',
      priceAsset: 'USD',
      settlementAsset: 'EMBER',
      pricing: fakePricing(),
      // No `as never`. The cast that used to be here is why splitting `assetCode` into a price
      // asset and a settlement asset typechecked clean and then 500'd every purchase route at
      // runtime: `as never` silences the one check that would have named the missing field.
      // The getter above is the only reason a cast was ever reached for, and it does not need one.
    } satisfies PurchaseDeps,
    eventAcceptSecrets: [EVENT_SECRET],
  })
  await new Promise<void>((resolve) => server.listen(0, () => resolve()))
  lifecycle.markReady()
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  if (!enabled) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetBilling(sql)
  ledger = fakeLedger()
})

interface Response {
  readonly status: number
  readonly body: Record<string, never>
  readonly text: string
}

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; key?: string } = {},
): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
  const text = await response.text()
  let body: Record<string, never> = {} as Record<string, never>
  try {
    body = JSON.parse(text) as Record<string, never>
  } catch {
    /* /metrics is Prometheus text, not JSON */
  }
  return { status: response.status, body, text }
}

const buy = (options: { token?: string; sku?: string; scope?: string; key?: string } = {}) =>
  call('POST', '/purchases', {
    token: options.token ?? 'alice',
    key: options.key ?? freshKey(),
    body: {
      sku: options.sku ?? 'cosmetic.ember-cape',
      quantity: 1,
      ...(options.scope ? { scope: options.scope } : {}),
    },
  })

/* ------------------------------------------------------------------ health and catalogue */

test('the three required endpoints answer', { skip }, async () => {
  assert.equal((await call('GET', '/livez')).status, 200)
  assert.equal((await call('GET', '/readyz')).status, 200)
  const metrics = await call('GET', '/metrics')
  assert.equal(metrics.status, 200)
  assert.match(metrics.text, /billing_entitlement_checks_total/)
  assert.match(metrics.text, /billing_purchases_total/)
})

test('GET /products is public and prices are strings', { skip }, async () => {
  const response = await call('GET', '/products')
  assert.equal(response.status, 200)
  const products = (response.body as unknown as { products: Array<Record<string, unknown>> }).products
  assert.equal(products.length, 5)
  const world = products.find((p) => p['sku'] === 'world.private.small')
  assert.equal(world?.['scopeKind'], 'title')
  assert.equal(world?.['entitlementDays'], 30)
  const price = (world?.['prices'] as Array<Record<string, unknown>>)[0]
  assert.equal(typeof price?.['unitAmount'], 'string')
  assert.equal(price?.['unitAmount'], '750')
})

/* ------------------------------------------------------------------ purchases */

test('POST /purchases requires a token and an idempotency key', { skip }, async () => {
  assert.equal((await call('POST', '/purchases', { body: { sku: 'cosmetic.ember-cape' } })).status, 401)
  const noKey = await call('POST', '/purchases', {
    token: 'alice',
    body: { sku: 'cosmetic.ember-cape' },
  })
  assert.equal(noKey.status, 400)
  // Optional would mean absent on the one request that gets retried.
  assert.match(noKey.text, /Idempotency-Key/)
})

test('a purchase returns 201 and the entitlement it granted', { skip }, async () => {
  const response = await buy()
  assert.equal(response.status, 201)
  const purchase = (response.body as unknown as { purchase: Record<string, unknown> }).purchase
  const entitlement = (response.body as unknown as { entitlement: Record<string, unknown> }).entitlement
  assert.equal(purchase['amount'], emberFor(250n).toString())
  assert.equal(entitlement['active'], true)
  assert.equal(entitlement['scope'], 'platform')
  assert.equal(typeof entitlement['quantity'], 'string')
  assert.equal(ledger.entries.length, 1)
})

test('THE SAME KEY TWICE: 201 then 200, and one entitlement', { skip }, async () => {
  const key = freshKey()
  const first = await buy({ key })
  const second = await buy({ key })

  assert.equal(first.status, 201)
  assert.equal(second.status, 200, 'a replay must be distinguishable from a fresh purchase')
  const firstId = (first.body as unknown as { entitlement: { id: string } }).entitlement.id
  const secondId = (second.body as unknown as { entitlement: { id: string } }).entitlement.id
  assert.equal(secondId, firstId)
  assert.equal(ledger.entries.length, 1)
})

test('a subject who cannot pay gets 402, which is an answer and not a fault', { skip }, async () => {
  ledger.refuseFunds()
  const response = await buy()
  assert.equal(response.status, 402)
  assert.match(response.text, /insufficient_balance/)
})

test('an unreachable ledger is 503, because retrying IS the right response', { skip }, async () => {
  ledger.goDown()
  const response = await buy()
  assert.equal(response.status, 503)
  assert.match(response.text, /ledger_unavailable/)
})

test('a scoped product refuses to be bought without a scope', { skip }, async () => {
  const response = await buy({ sku: 'world.private.small' })
  assert.equal(response.status, 400)
  assert.match(response.text, /must be bought for a title/)
})

test('a user may not buy on behalf of somebody else', { skip }, async () => {
  const response = await call('POST', '/purchases', {
    token: 'alice',
    key: freshKey(),
    body: { sku: 'cosmetic.ember-cape', userId: BOB_ID },
  })
  assert.equal(response.status, 403)
})

test('a service needs billing:grant to buy for a user', { skip }, async () => {
  const refused = await call('POST', '/purchases', {
    token: 'svc-read',
    key: freshKey(),
    body: { sku: 'cosmetic.ember-cape', userId: ALICE_ID },
  })
  assert.equal(refused.status, 403)

  const allowed = await call('POST', '/purchases', {
    token: 'svc-grant',
    key: freshKey(),
    body: { sku: 'cosmetic.ember-cape', userId: ALICE_ID },
  })
  assert.equal(allowed.status, 201)
})

/* ------------------------------------------------------------------ entitlements */

test('GET /entitlements returns what the caller owns, and only that', { skip }, async () => {
  await buy({ token: 'alice' })
  const alice = await call('GET', '/entitlements', { token: 'alice' })
  const bob = await call('GET', '/entitlements', { token: 'bob' })
  assert.equal((alice.body as unknown as { entitlements: unknown[] }).entitlements.length, 1)
  assert.equal((bob.body as unknown as { entitlements: unknown[] }).entitlements.length, 0)
})

test('a user cannot read another user, but an admin can', { skip }, async () => {
  await buy({ token: 'alice' })
  assert.equal((await call('GET', `/entitlements?userId=${BOB_ID}`, { token: 'alice' })).status, 403)
  const asAdmin = await call('GET', `/entitlements?userId=${ALICE_ID}`, { token: 'admin' })
  assert.equal(asAdmin.status, 200)
  assert.equal((asAdmin.body as unknown as { entitlements: unknown[] }).entitlements.length, 1)
})

test('THE FOURTH DEFECT: a SERVICE can ask whether a user owns something', { skip }, async () => {
  // The estate's entitlements route is Bearer-only, so nothing but a browser can ask. This is the
  // route that lets a world server confirm the buyer still owns the world.
  await buy({ token: 'alice', sku: 'world.private.small', scope: 'title:emberfall' })

  const anonymous = await call('GET', `/internal/entitlements/${ALICE_ID}`)
  assert.equal(anonymous.status, 401)
  const unscoped = await call('GET', `/internal/entitlements/${ALICE_ID}`, { token: 'svc-none' })
  assert.equal(unscoped.status, 403)
  // A user token is refused here even for its own id: this route is for services, and a route
  // that quietly accepted both would make the scoped-token boundary decorative.
  const asUser = await call('GET', `/internal/entitlements/${ALICE_ID}`, { token: 'alice' })
  assert.equal(asUser.status, 403)

  const service = await call('GET', `/internal/entitlements/${ALICE_ID}`, { token: 'svc-read' })
  assert.equal(service.status, 200)
  const entitlements = (service.body as unknown as { entitlements: Array<Record<string, unknown>> })
    .entitlements
  assert.equal(entitlements.length, 1)
  assert.equal(entitlements[0]?.['scope'], 'title:emberfall')
  assert.equal(entitlements[0]?.['active'], true)
})

test('THE PARITY: the service-readable API returns what the user-facing one does', { skip }, async () => {
  await buy({ token: 'alice', sku: 'cosmetic.ember-cape' })
  await buy({ token: 'alice', sku: 'world.private.small', scope: 'title:emberfall' })

  const at = new Date().toISOString()
  const user = await call('GET', `/entitlements?at=${encodeURIComponent(at)}`, { token: 'alice' })
  const service = await call(
    'GET',
    `/internal/entitlements/${ALICE_ID}?at=${encodeURIComponent(at)}`,
    { token: 'svc-read' },
  )

  const userList = (user.body as unknown as { entitlements: unknown[] }).entitlements
  const serviceList = (service.body as unknown as { entitlements: unknown[] }).entitlements
  assert.equal(userList.length, 2)
  // Byte-for-byte the same records. Two implementations would be two answers, and the whole
  // reason a service cannot ask today is that only one implementation exists.
  assert.deepEqual(serviceList, userList)
})

test('the service API filters by scope, which is the question it exists to answer', { skip }, async () => {
  await buy({ token: 'alice', sku: 'world.private.small', scope: 'title:emberfall' })
  const owned = await call(`GET`, `/internal/entitlements/${ALICE_ID}?scope=title:emberfall`, {
    token: 'svc-read',
  })
  const other = await call('GET', `/internal/entitlements/${ALICE_ID}?scope=title:driftmoor`, {
    token: 'svc-read',
  })
  assert.equal((owned.body as unknown as { entitlements: unknown[] }).entitlements.length, 1)
  assert.equal((other.body as unknown as { entitlements: unknown[] }).entitlements.length, 0)
  // A malformed scope is a 400, not an unfiltered list.
  assert.equal(
    (await call('GET', `/internal/entitlements/${ALICE_ID}?scope=nonsense`, { token: 'svc-read' }))
      .status,
    400,
  )
})

/* ------------------------------------------------------------------ revocation */

test('A REVOKE MAKES THE ENTITLEMENT STOP SATISFYING A CHECK, on both routes', { skip }, async () => {
  const bought = await buy({ token: 'alice' })
  const entitlementId = (bought.body as unknown as { entitlement: { id: string } }).entitlement.id

  const revoked = await call('POST', `/entitlements/${entitlementId}/revoke`, {
    token: 'admin',
    body: { reason: 'customer refund', refund: true },
  })
  assert.equal(revoked.status, 200)
  assert.equal((revoked.body as unknown as { reversalEntryId: string }).reversalEntryId, 'entry-000002')

  const user = await call('GET', '/entitlements', { token: 'alice' })
  const service = await call('GET', `/internal/entitlements/${ALICE_ID}`, { token: 'svc-read' })
  assert.equal((user.body as unknown as { entitlements: unknown[] }).entitlements.length, 0)
  assert.equal((service.body as unknown as { entitlements: unknown[] }).entitlements.length, 0)
  assert.equal(ledger.entries.length, 2, 'the purchase and its reversal')
})

test('a player may not revoke; an admin or a billing:grant service may', { skip }, async () => {
  const bought = await buy({ token: 'alice' })
  const id = (bought.body as unknown as { entitlement: { id: string } }).entitlement.id
  const body = { reason: 'x' }
  assert.equal((await call('POST', `/entitlements/${id}/revoke`, { token: 'alice', body })).status, 403)
  assert.equal((await call('POST', `/entitlements/${id}/revoke`, { token: 'svc-none', body })).status, 403)
  assert.equal((await call('POST', `/entitlements/${id}/revoke`, { token: 'svc-grant', body })).status, 200)
})

test('a revoke without a reason is refused', { skip }, async () => {
  const bought = await buy({ token: 'alice' })
  const id = (bought.body as unknown as { entitlement: { id: string } }).entitlement.id
  const response = await call('POST', `/entitlements/${id}/revoke`, { token: 'admin', body: {} })
  assert.equal(response.status, 400)
})

test('revoking something that does not exist is a 404', { skip }, async () => {
  const response = await call(
    'POST',
    '/entitlements/00000000-0000-4000-8000-000000000000/revoke',
    { token: 'admin', body: { reason: 'x' } },
  )
  assert.equal(response.status, 404)
})

/* ------------------------------------------------------------------ subscriptions */

test('GET /subscriptions lists the caller"s subscriptions with their access state', { skip }, async () => {
  await buy({ token: 'alice', sku: 'guild.hall.monthly', scope: 'community:sanctum' })
  const response = await call('GET', '/subscriptions', { token: 'alice' })
  assert.equal(response.status, 200)
  const subscriptions = (response.body as unknown as { subscriptions: Array<Record<string, unknown>> })
    .subscriptions
  assert.equal(subscriptions.length, 1)
  assert.equal(subscriptions[0]?.['status'], 'active')
  assert.equal(subscriptions[0]?.['confersAccess'], true)
  assert.equal(subscriptions[0]?.['scope'], 'community:sanctum')
})

/* ------------------------------------------------------------------ auth faults */

test('an identity outage is 503, never 401 — a 401 would sign the estate out', { skip }, async () => {
  assert.equal((await call('GET', '/entitlements', { token: 'down' })).status, 503)
})

test('an unmatched path is a 404 carrying the request id', { skip }, async () => {
  const response = await call('GET', '/nope')
  assert.equal(response.status, 404)
  assert.match(response.text, /"requestId"/)
})

/* ------------------------------------------------------------------ POST /v1/events */

async function post(event: { body: string; headers: Record<string, string> }): Promise<Response> {
  const response = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: event.headers,
    body: event.body,
  })
  const text = await response.text()
  let body: Record<string, never> = {} as Record<string, never>
  try {
    body = JSON.parse(text) as Record<string, never>
  } catch {
    /* not JSON */
  }
  return { status: response.status, body, text }
}

test('an unsigned or wrongly signed delivery is 403 — never 401', { skip }, async () => {
  // 401 would say "authenticate and try again", which invites a caller to go looking for a bearer
  // token this route does not have. The MAC is the credential, and it was wrong.
  const forged = signedEvent(
    'identity.user.deleted',
    { userId: ALICE_ID },
    { secret: 'a-different-secret-that-is-long-enough' },
  )
  assert.equal((await post(forged)).status, 403)

  const unsigned = signedEvent('identity.user.deleted', { userId: ALICE_ID })
  const stripped = { body: unsigned.body, headers: { 'content-type': 'application/json' } }
  assert.equal((await post(stripped)).status, 403)
})

test('a signature is checked over the bytes as sent, so a re-serialised body fails', { skip }, async () => {
  const event = signedEvent('identity.user.deleted', { userId: ALICE_ID })
  // Same JSON, different bytes. If the route parsed first and verified against a re-serialisation,
  // this would pass — and so would a forgery that round-trips to the same object.
  const reserialised = JSON.stringify(JSON.parse(event.body), null, 2)
  assert.equal((await post({ body: reserialised, headers: event.headers })).status, 403)
})

test('a topic this service does not consume is 202 ignored, never 4xx', { skip }, async () => {
  // A 4xx makes the producer's relay retry the same event for ever.
  const response = await post(signedEvent('identity.session.created', { userId: ALICE_ID }))
  assert.equal(response.status, 202)
  assert.equal(response.body['status'], 'ignored')
})

test('a correctly signed erasure is accepted, and erases', { skip }, async () => {
  await buy({ token: 'alice' })
  const before = await sql<Array<{ n: number }>>`
    select count(*)::int as n from entitlements where subject = ${ALICE}
  `
  assert.equal(before[0]?.n, 1)

  const response = await post(signedEvent('identity.user.deleted', { userId: ALICE_ID }))
  assert.equal(response.status, 202)
  assert.equal(response.body['status'], 'recorded')

  const after = await sql<Array<{ n: number }>>`
    select count(*)::int as n from entitlements where subject = ${ALICE}
  `
  assert.equal(after[0]?.n, 0)
  const purchase = await sql<Array<{ subject: string; actor: string }>>`
    select subject, actor from purchases
  `
  assert.equal(purchase[0]?.subject, 'erased:user')
  assert.equal(purchase[0]?.actor, 'erased:user')
})

test('a redelivery is a duplicate, not a second erasure', { skip }, async () => {
  await buy({ token: 'alice' })
  const event = signedEvent('identity.user.deleted', { userId: ALICE_ID })
  assert.equal((await post(event)).status, 202)

  // The same envelope, byte for byte, as an at-least-once relay would resend it. `withInbox`
  // dedupes on (topic, event_id) — the insert that loses is the one that skips the handler.
  const again = await post(event)
  assert.equal(again.status, 202)
  assert.equal(again.body['status'], 'duplicate')
})

test('an erasure with no uuid userId is 400, and stays visible', { skip }, async () => {
  // Deliberately NOT absorbed into a 202. A request this service cannot read is a person whose
  // data is still here while the deletion is being reported as done.
  assert.equal((await post(signedEvent('identity.user.deleted', {}))).status, 400)
  assert.equal((await post(signedEvent('identity.user.deleted', { userId: 'nope' }))).status, 400)
})

test('an event with no uuid envelope id is 400', { skip }, async () => {
  const event = signedEvent('identity.user.deleted', { userId: ALICE_ID }, { id: 'not-a-uuid' })
  assert.equal((await post(event)).status, 400)
})

/**
 * One handle, presented as the per-network selector the server now takes. The fixture runs against
 * a single test database, so mainnet is the only configured network — which exercises the REFUSAL
 * path for free: anything reaching for testnet throws rather than reusing this handle.
 */
function singleNetworkSql(db: unknown) {
  return networkSql({ mainnet: db as RuntimeSql })
}
