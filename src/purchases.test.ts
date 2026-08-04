/**
 * Buying, replaying and refunding, against the real tables and a local ledger fake.
 *
 * **No test here requires a running ledger.** `fakeLedger` reproduces the two behaviours the
 * purchase path depends on — a repeated key returns the same entry, and a reversal is a new entry
 * naming the original — so "exactly one entry" is something the suite can count rather than infer.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { isEntitlementActive } from '@cloudsforge/contracts-money'
import { requestFingerprint, IdempotencyKeyReuseError } from './idempotency.ts'
import { listEntitlements, readEntitlement } from './entitlements.ts'
import { InsufficientFundsError, LedgerUnavailableError } from './ledger.ts'
import {
  PurchaseValidationError,
  purchase,
  refund,
  type PurchaseDeps,
  type PurchaseRequest,
} from './purchases.ts'
import { listSubscriptions } from './subscriptions.ts'
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

const NOW = new Date('2026-07-30T12:00:00.000Z')

function deps(overrides: Partial<PurchaseDeps> = {}): PurchaseDeps {
  return {
    sql: db,
    ledger,
    producer: 'billing',
    priceAsset: 'USD',
    settlementAsset: 'EMBER',
    pricing: fakePricing(),
    now: () => NOW,
    ...overrides,
  }
}

function request(overrides: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return {
    subject: ALICE,
    sku: 'cosmetic.ember-cape',
    quantity: 1n,
    idempotencyKey: freshKey(),
    correlationId: 'corr-1',
    actor: `user:${ALICE}`,
    ...overrides,
  }
}

const body = (request: PurchaseRequest) => ({
  sku: request.sku,
  quantity: request.quantity.toString(),
  scope: request.scope ?? null,
})

/* ------------------------------------------------------------------ the happy path */

test('A PURCHASE POSTS EXACTLY ONE LEDGER ENTRY, and billing holds no balance', { skip }, async () => {
  const input = request()
  const outcome = await purchase(deps(), input, requestFingerprint(body(input)))

  assert.equal(outcome.replayed, false)
  assert.equal(ledger.entries.length, 1, 'one purchase must produce exactly one entry')
  assert.equal(ledger.entries[0]?.kind, 'purchase')
  // The purchase row names the entry that moved the money. There is no path that creates one
  // without it, which is what makes "billing holds no balance" checkable rather than a claim.
  assert.equal(outcome.result.purchase.journalEntryId, ledger.entries[0]?.id)
  assert.equal(outcome.result.purchase.amount, emberFor(250n).toString())

  const rows = await sql`select count(*)::int as n from purchases`
  assert.equal(rows[0]?.['n'], 1)
})

test('the grant emits billing.entitlement.granted, IN THE SAME TRANSACTION', { skip }, async () => {
  // The invariant from 04-domain-model.md §8.1: the service that delivers the thing subscribes to
  // this event, and it is what finally builds the private world that is sold and never provisioned.
  const input = request({ sku: 'world.private.small', scope: 'title:emberfall' })
  const outcome = await purchase(deps(), input, requestFingerprint(body(input)))

  const events = await sql<Array<{ topic: string; key: string; payload: Record<string, unknown> }>>`
    select topic, key, payload from outbox order by occurred_at
  `
  assert.equal(events.length, 1)
  assert.equal(events[0]?.topic, 'billing.entitlement.granted')
  assert.equal(events[0]?.key, (outcome.result.entitlement as { id: string }).id)
  // The scope is ON the event. A subscriber that provisions a world needs to know WHICH title,
  // and having to call back for it is how a consumer ends up guessing.
  assert.equal(events[0]?.payload['scope'], 'title:emberfall')
  assert.equal(events[0]?.payload['sku'], 'world.private.small')
})

test('a scoped product carries its scope onto the entitlement', { skip }, async () => {
  const input = request({ sku: 'world.private.small', scope: 'title:emberfall' })
  await purchase(deps(), input, requestFingerprint(body(input)))

  const forTitle = await listEntitlements(db, {
    subject: ALICE,
    scope: 'title:emberfall',
    at: NOW.toISOString(),
  })
  const forOther = await listEntitlements(db, {
    subject: ALICE,
    scope: 'title:something-else',
    at: NOW.toISOString(),
  })
  assert.equal(forTitle.length, 1)
  // THE question the estate cannot answer: owned for THIS title, and not for that one.
  assert.equal(forOther.length, 0)
})

test('a product with entitlement days grants something that ends', { skip }, async () => {
  const input = request({ sku: 'season.pass.s1' })
  const outcome = await purchase(deps(), input, requestFingerprint(body(input)))
  const expiresAt = (outcome.result.entitlement as { expiresAt: string }).expiresAt
  assert.equal(expiresAt, '2026-10-28T12:00:00.000Z', '90 days after the purchase')

  // Active now, and not after the season.
  const stored = await readEntitlement(db, (outcome.result.entitlement as { id: string }).id)
  assert.ok(stored)
  assert.equal(isEntitlementActive(stored, NOW.toISOString()), true)
  assert.equal(isEntitlementActive(stored, '2026-11-01T00:00:00.000Z'), false)
})

test('a scoped product cannot be bought without a scope', { skip }, async () => {
  const input = request({ sku: 'world.private.small' })
  await assert.rejects(
    purchase(deps(), input, requestFingerprint(body(input))),
    PurchaseValidationError,
  )
  assert.equal(ledger.entries.length, 0, 'nothing may reach the ledger for a request we refuse')
})

test('a subscription product opens a subscription whose entitlement expires with the period', { skip }, async () => {
  const input = request({ sku: 'guild.hall.monthly', scope: 'community:sanctum' })
  const outcome = await purchase(deps(), input, requestFingerprint(body(input)))

  const subscriptions = await listSubscriptions(db, ALICE, 10)
  assert.equal(subscriptions.length, 1)
  assert.equal(subscriptions[0]?.status, 'active')
  assert.equal(subscriptions[0]?.currentPeriodEnd, '2026-08-30T12:00:00.000Z')
  // The entitlement ends with the period it paid for. A perpetual grant would have to be revoked
  // on cancellation, and the day that revocation is missed the customer keeps it for ever.
  assert.equal(
    (outcome.result.entitlement as { expiresAt: string }).expiresAt,
    subscriptions[0]?.currentPeriodEnd,
  )
  assert.equal(outcome.result.subscriptionId, subscriptions[0]?.id)
})

/* ------------------------------------------------------------------ idempotency */

test('THE SAME KEY TWICE RETURNS ONE ENTITLEMENT AND ONE ENTRY', { skip }, async () => {
  const input = request()
  const hash = requestFingerprint(body(input))

  const first = await purchase(deps(), input, hash)
  const second = await purchase(deps(), input, hash)

  assert.equal(first.replayed, false)
  assert.equal(second.replayed, true, 'the second call must be a replay, not a second purchase')
  assert.equal(
    (second.result.entitlement as { id: string }).id,
    (first.result.entitlement as { id: string }).id,
    'a retry must be told about the same entitlement',
  )
  assert.equal(ledger.entries.length, 1)
  assert.equal(second.result.purchase.id, first.result.purchase.id)

  const counts = await sql<Array<{ purchases: number; entitlements: number }>>`
    select (select count(*)::int from purchases) as purchases,
           (select count(*)::int from entitlements) as entitlements
  `
  assert.equal(counts[0]?.purchases, 1)
  assert.equal(counts[0]?.entitlements, 1)
})

test('a reused key with a DIFFERENT body is refused, not replayed', { skip }, async () => {
  // Returning the first request's answer to a second, different request is worse than an error:
  // the caller believes the thing it asked for happened.
  const key = freshKey()
  const first = request({ idempotencyKey: key, sku: 'cosmetic.ember-cape' })
  await purchase(deps(), first, requestFingerprint(body(first)))

  const second = request({ idempotencyKey: key, sku: 'convenience.extra-slot' })
  await assert.rejects(
    purchase(deps(), second, requestFingerprint(body(second))),
    IdempotencyKeyReuseError,
  )
  assert.equal(ledger.entries.length, 1)
})

test('different keys buy different things', { skip }, async () => {
  for (const sku of ['cosmetic.ember-cape', 'convenience.extra-slot']) {
    const input = request({ sku })
    await purchase(deps(), input, requestFingerprint(body(input)))
  }
  assert.equal(ledger.entries.length, 2)
  const owned = await listEntitlements(db, { subject: ALICE, at: NOW.toISOString() })
  assert.equal(owned.length, 2)
})

/* ------------------------------------------------------------------ failure */

test('a subject who cannot pay gets NOTHING — no purchase, no entitlement, no event', { skip }, async () => {
  ledger.refuseFunds()
  const input = request()
  await assert.rejects(
    purchase(deps(), input, requestFingerprint(body(input))),
    InsufficientFundsError,
  )

  const counts = await sql<Array<{ purchases: number; entitlements: number; events: number; keys: number }>>`
    select (select count(*)::int from purchases) as purchases,
           (select count(*)::int from entitlements) as entitlements,
           (select count(*)::int from outbox) as events,
           (select count(*)::int from idempotency_keys) as keys
  `
  assert.equal(counts[0]?.purchases, 0)
  assert.equal(counts[0]?.entitlements, 0)
  assert.equal(counts[0]?.events, 0)
  // The claim rolled back with everything else, so the customer's retry is a fresh attempt rather
  // than a permanently poisoned key.
  assert.equal(counts[0]?.keys, 0)
})

test('an unreachable ledger leaves no half-purchase, and the retry succeeds on the same key', { skip }, async () => {
  ledger.goDown()
  const input = request()
  const hash = requestFingerprint(body(input))
  await assert.rejects(purchase(deps(), input, hash), LedgerUnavailableError)

  const afterFailure = await sql`select count(*)::int as n from purchases`
  assert.equal(afterFailure[0]?.['n'], 0)

  // The same key again. This is the case the derived ledger key exists for: nothing posted, so
  // the retry posts once.
  const outcome = await purchase(deps(), input, hash)
  assert.equal(outcome.replayed, false)
  assert.equal(ledger.entries.length, 1)
})

/* ------------------------------------------------------------------ refunds */

test('A REFUND REVERSES THE LEDGER ENTRY AND REVOKES THE GRANT', { skip }, async () => {
  const input = request()
  const bought = await purchase(deps(), input, requestFingerprint(body(input)))
  const entitlementId = (bought.result.entitlement as { id: string }).id
  const originalEntryId = bought.result.purchase.journalEntryId

  const result = await refund(deps(), {
    entitlementId,
    reason: 'customer refund',
    actor: 'user:ops',
    correlationId: 'corr-refund',
    refund: true,
  })

  // A correction is a NEW entry that names the original. Postings are never edited.
  assert.equal(ledger.entries.length, 2)
  const reversal = ledger.entries[1]!
  assert.equal(reversal.reversesEntryId, originalEntryId)
  assert.equal(result.reversalEntryId, reversal.id)
  assert.equal(reversal.postings[0]?.direction, 'credit', 'the debit is mirrored')
  assert.equal(reversal.postings[1]?.direction, 'debit')

  // And the grant is gone, immediately.
  const stored = await readEntitlement(db, entitlementId)
  assert.ok(stored?.revokedAt)
  assert.equal(isEntitlementActive(stored, new Date().toISOString()), false)

  const purchases = await sql<Array<{ status: string; refund_entry_id: string }>>`
    select status, refund_entry_id from purchases
  `
  assert.equal(purchases[0]?.status, 'refunded')
  assert.equal(purchases[0]?.refund_entry_id, reversal.id)
})

test('a refund emits billing.entitlement.revoked naming the entry it reversed', { skip }, async () => {
  const input = request({ sku: 'world.private.small', scope: 'title:emberfall' })
  const bought = await purchase(deps(), input, requestFingerprint(body(input)))
  await refund(deps(), {
    entitlementId: (bought.result.entitlement as { id: string }).id,
    reason: 'refund',
    actor: 'user:ops',
    correlationId: 'c',
    refund: true,
  })

  const events = await sql<Array<{ topic: string; payload: Record<string, unknown> }>>`
    select topic, payload from outbox order by occurred_at
  `
  assert.deepEqual(
    events.map((e) => e.topic),
    ['billing.entitlement.granted', 'billing.entitlement.revoked'],
  )
  // The subscriber that built the world can tear down exactly what it built.
  assert.equal(events[1]?.payload['scope'], 'title:emberfall')
  assert.equal(events[1]?.payload['journalEntryId'], bought.result.purchase.journalEntryId)
})

test('refunding twice does not reverse twice', { skip }, async () => {
  const input = request()
  const bought = await purchase(deps(), input, requestFingerprint(body(input)))
  const entitlementId = (bought.result.entitlement as { id: string }).id
  const once = await refund(deps(), {
    entitlementId,
    reason: 'refund',
    actor: 'user:ops',
    correlationId: 'c',
    refund: true,
  })
  const twice = await refund(deps(), {
    entitlementId,
    reason: 'refund again',
    actor: 'user:ops',
    correlationId: 'c',
    refund: true,
  })

  assert.equal(twice.alreadyRevoked, true)
  assert.equal(ledger.entries.length, 2, 'a second refund must not post a third entry')
  // The revocation date is not moved. The first one is when the customer lost access, and
  // rewriting it would silently extend the window in which they still had it.
  assert.equal(
    (twice.entitlement as { revokedAt: string }).revokedAt,
    (once.entitlement as { revokedAt: string }).revokedAt,
  )
})

test('an operator may revoke WITHOUT refunding, and no money moves', { skip }, async () => {
  const input = request()
  const bought = await purchase(deps(), input, requestFingerprint(body(input)))
  const result = await refund(deps(), {
    entitlementId: (bought.result.entitlement as { id: string }).id,
    reason: 'terms violation',
    actor: 'user:ops',
    correlationId: 'c',
    refund: false,
  })
  assert.equal(result.reversalEntryId, null)
  assert.equal(ledger.entries.length, 1)
  assert.equal((result.entitlement as { active: boolean }).active, false)
})

test('a grant nobody paid for cannot be refunded', { skip }, async () => {
  // Inventing a reversal would credit money that was never taken.
  const rows = await sql<Array<{ id: string }>>`
    insert into entitlements (subject, product_id, sku, scope, source, quantity)
    select ${ALICE}, id, sku, 'platform', 'reward', 1 from products where sku = 'cosmetic.ember-cape'
    returning id
  `
  await assert.rejects(
    refund(deps(), {
      entitlementId: rows[0]!.id,
      reason: 'refund',
      actor: 'user:ops',
      correlationId: 'c',
      refund: true,
    }),
    /nothing to refund/,
  )
})

/* ═══════════════════════════════════ priced in dollars, charged in EMBER, and never in Shards */

test('THE PRICE IS USD AND THE CHARGE IS EMBER, and the row records both plus the rate', { skip }, async () => {
  // The whole of the money migration, end to end. The cape is $2.50 — unchanged, which is the
  // owner's decision (docs/ecosystem/15 §3.2: "stated USD is unchanged and the unit changes") —
  // and at EMBER's administered 0.25 USD that is 10 EMBER.
  const input = request()
  const outcome = await purchase(deps(), input, requestFingerprint(body(input)))
  const p = outcome.result.purchase

  assert.equal(p.priceAssetCode, 'USD')
  assert.equal(p.priceAmount, '250', 'still $2.50 — the stated price did not move')
  assert.equal(p.assetCode, 'EMBER', 'and the charge is in an asset a chain backs')
  assert.equal(p.amount, (10n * 10n ** 18n).toString())
  assert.equal(p.rateUsdScaled, '250000', 'the arithmetic is auditable after the fact')

  // 10 EMBER is 10,000,000 Sparks. Display only — there is no SPARK asset code and there must
  // never be one, because the ledger's balancing invariant is enforced per asset code.
  assert.equal(p.amountSparks, '10000000')

  // The POSTING is what the ledger sees, and it is EMBER on both legs. A Shard posting here is
  // the defect this whole change removes: liability with no chain behind it.
  const postings = ledger.entries[0]?.postings ?? []
  assert.deepEqual(
    postings.map((x) => [x.assetCode, x.direction, x.amount]),
    [
      ['EMBER', 'debit', 10n * 10n ** 18n],
      ['EMBER', 'credit', 10n * 10n ** 18n],
    ],
  )
  assert.equal(
    postings.some((x) => x.assetCode === 'SHARD' || x.assetCode === 'USD'),
    false,
    'a posting escaped in a unit no chain backs',
  )
})

test('the stored row agrees with the response — the durable figure is the dollars', { skip }, async () => {
  const input = request({ sku: 'world.private.small', scope: 'title:emberfall' })
  await purchase(deps(), input, requestFingerprint(body(input)))

  const rows = await sql<Array<Record<string, string>>>`
    select asset_code, amount::text, price_asset_code, price_amount::text, rate_usd_scaled::text
      from purchases
  `
  const row = rows[0]!
  // $7.50 at $0.25 is 30 EMBER.
  assert.equal(row['price_asset_code'], 'USD')
  assert.equal(row['price_amount'], '750')
  assert.equal(row['asset_code'], 'EMBER')
  assert.equal(row['amount'], (30n * 10n ** 18n).toString())
  assert.equal(row['rate_usd_scaled'], '250000')
})

test('A PURCHASE IS REFUSED WHEN THE RATE CANNOT BE READ — it is never charged at a guess', { skip }, async () => {
  // Fail closed. You cannot charge somebody in a currency you cannot price, and the alternative to
  // refusing is guessing how much of their money to take.
  const input = request()
  await assert.rejects(
    () => purchase(deps({ pricing: fakePricing({ fail: 'the EMBER rate is not usable' }) }), input, requestFingerprint(body(input))),
    /not usable/,
  )

  // And nothing was left behind: no entry, no purchase, no entitlement. The rate is read BEFORE
  // the idempotency claim opens, so there is nothing to unwind.
  assert.equal(ledger.entries.length, 0)
  const rows = await sql`select count(*)::int as n from purchases`
  assert.equal(rows[0]?.['n'], 0)
  const grants = await sql`select count(*)::int as n from entitlements`
  assert.equal(grants[0]?.['n'], 0)
})

test('the catalogue holds no active Shard price, and the database refuses a new one', { skip }, async () => {
  const active = await sql<Array<{ asset_code: string; unit_amount: string }>>`
    select asset_code, unit_amount::text from prices where status = 'active' order by prices.unit_amount
  `
  assert.deepEqual(
    active.map((r) => r.asset_code),
    ['USD', 'USD', 'USD', 'USD', 'USD'],
  )
  // The peg made this the identity on the integer: 250 Shards was $2.50, 250 cents is $2.50.
  assert.deepEqual(
    active.map((r) => r.unit_amount),
    ['250', '400', '500', '750', '1000'],
  )

  // The constraint, exercised rather than asserted from the DDL text.
  await assert.rejects(
    () => sql`
      insert into prices (product_id, asset_code, unit_amount, status)
      select id, 'SHARD', 250, 'active' from products limit 1
    `,
    /prices_no_new_shard/,
  )
})
