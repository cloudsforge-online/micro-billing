/**
 * The race.
 *
 * A retry of a purchase is not a hypothetical: a client whose request times out at four seconds
 * retries at four seconds and one, while the first attempt is still inside its ledger call. If the
 * two are allowed to proceed independently the customer is charged twice and owns one thing.
 *
 * These tests fire the calls with `Promise.allSettled` and assert on the aggregate, because a race
 * that needs help to appear is a race the test cannot prove is closed.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { requestFingerprint } from './idempotency.ts'
import { purchase, type PurchaseDeps, type PurchaseRequest } from './purchases.ts'
import {
  ALICE,
  BOB,
  enabled,
  fakeLedger,
  freshKey,
  migrateTestDb,
  openDb,
  resetBilling,
  skip,
  type FakeLedger,
  fakePricing,
} from './testsupport.ts'
import type { Db } from './outbox.ts'

let sql: postgres.Sql
let ledger: FakeLedger

before(async () => {
  if (!enabled) return
  // A pool wide enough that the parallel calls genuinely overlap. With `max: 1` they would
  // serialise on the connection and the test would prove nothing.
  sql = openDb(16)
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

function deps(): PurchaseDeps {
  return { sql: sql as unknown as Db, ledger, producer: 'billing', priceAsset: 'USD', settlementAsset: 'EMBER', pricing: fakePricing() }
}

function request(overrides: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return {
    subject: ALICE,
    sku: 'cosmetic.ember-cape',
    quantity: 1n,
    idempotencyKey: freshKey(),
    correlationId: 'corr',
    actor: 'user:test',
    ...overrides,
  }
}

const bodyOf = (r: PurchaseRequest) => ({ sku: r.sku, quantity: r.quantity.toString() })

test(
  'CONCURRENCY: ten parallel purchases with ONE key produce one entry and one entitlement',
  { skip },
  async () => {
    const input = request()
    const hash = requestFingerprint(bodyOf(input))

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => purchase(deps(), input, hash)),
    )

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    assert.ok(fulfilled.length >= 1, 'at least one call must succeed')
    for (const result of results) {
      if (result.status === 'rejected') {
        // The only acceptable rejection is "still in flight": the claim existed but its
        // transaction had not committed a response yet, which is honest rather than a guess.
        assert.match(
          String((result as PromiseRejectedResult).reason),
          /in flight/,
          `unexpected failure: ${String((result as PromiseRejectedResult).reason)}`,
        )
      }
    }

    // The assertions that matter.
    assert.equal(ledger.entries.length, 1, 'ten parallel calls posted more than one ledger entry')

    const counts = await sql<Array<{ purchases: number; entitlements: number; events: number }>>`
      select (select count(*)::int from purchases) as purchases,
             (select count(*)::int from entitlements) as entitlements,
             (select count(*)::int from outbox) as events
    `
    assert.equal(counts[0]?.purchases, 1)
    assert.equal(counts[0]?.entitlements, 1)
    assert.equal(counts[0]?.events, 1, 'a duplicate grant event would provision the thing twice')

    // And every caller that got an answer was told about the same entitlement.
    const ids = new Set(
      fulfilled.map(
        (r) =>
          ((r as PromiseFulfilledResult<Awaited<ReturnType<typeof purchase>>>).value.result
            .entitlement as { id: string }).id,
      ),
    )
    assert.equal(ids.size, 1, 'callers were told about different entitlements')
  },
)

test('CONCURRENCY: parallel purchases with DIFFERENT keys all land', { skip }, async () => {
  const inputs = Array.from({ length: 12 }, (_, index) =>
    request({ subject: index % 2 === 0 ? ALICE : BOB }),
  )
  const results = await Promise.allSettled(
    inputs.map((input) => purchase(deps(), input, requestFingerprint(bodyOf(input)))),
  )
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 12)
  assert.equal(ledger.entries.length, 12)

  const rows = await sql<Array<{ n: number }>>`select count(*)::int as n from entitlements`
  assert.equal(rows[0]?.n, 12)
})

test(
  'CONCURRENCY: two different keys for the same sku are two purchases, not a collision',
  { skip },
  async () => {
    // Buying two capes is legal. The idempotency key is the caller's statement of intent, and
    // deduplicating on (subject, sku) instead would make a second genuine purchase impossible —
    // which is the `ownOnce` flag the estate carries on each buy route, decided per route.
    const inputs = [request(), request()]
    await Promise.all(
      inputs.map((input) => purchase(deps(), input, requestFingerprint(bodyOf(input)))),
    )
    assert.equal(ledger.entries.length, 2)
  },
)
