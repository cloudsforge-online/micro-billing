/**
 * What a subject owns, and when they stop owning it.
 *
 * The load-bearing test in this file is the last one: **the SQL predicate and the contract's
 * `isEntitlementActive` must agree on every boundary.** A list that says "owned" and a check that
 * says "not owned" is worse than either answer alone, and two copies of a predicate is exactly how
 * that happens.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { isEntitlementActive } from '@cloudsforge/contracts-money'
import {
  expireDue,
  grantEntitlement,
  listEntitlements,
  readEntitlement,
  revokeEntitlement,
  type EntitlementRecord,
} from './entitlements.ts'
import { writeEvents } from './purchases.ts'
import { ALICE, BOB, enabled, migrateTestDb, openDb, resetBilling, skip } from './testsupport.ts'
import type { Db, Emit } from './outbox.ts'

let sql: postgres.Sql
let db: Db

before(async () => {
  if (!enabled) return
  sql = openDb(4)
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
})

const AT = '2026-07-30T12:00:00.000Z'

/**
 * The default grant instant, and it is FIXTURE time, not the database's clock. Every activity
 * question in this file is asked at an instant on the fixture timeline (AT and its neighbours),
 * so a grant must land on that same timeline. Letting granted_at default to the database's now()
 * worked only while the wall clock was still before AT: the day after AT passed, every default
 * grant was created "after" the instant the assertions ask about — 0 rows listed where 1 was
 * expected — and the expiry fixtures started violating entitlements_expiry_after_grant outright,
 * because now() had overtaken them. A test timeline must be closed under the clock it uses.
 */
const GRANTED = new Date('2026-07-30T08:00:00.000Z')

async function productId(sku: string): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`select id from products where sku = ${sku}`
  return rows[0]!.id
}

/** Grant through the real path, collecting its events, so every test exercises the outbox too. */
async function grant(input: {
  subject?: string
  sku?: string
  scope?: EntitlementRecord['scope']
  grantedAt?: Date
  expiresAt?: Date | null
  quantity?: bigint
  journalEntryId?: string | null
}): Promise<EntitlementRecord> {
  const sku = input.sku ?? 'cosmetic.ember-cape'
  const id = await productId(sku)
  const outcome = await sql.begin(async (tx) => {
    const events: Parameters<Emit>[0][] = []
    const entitlement = await grantEntitlement(tx, (event) => events.push(event), {
      subject: input.subject ?? ALICE,
      productId: id,
      sku,
      scope: input.scope ?? 'platform',
      source: 'purchase',
      quantity: input.quantity ?? 1n,
      grantedAt: input.grantedAt ?? GRANTED,
      expiresAt: input.expiresAt ?? null,
      journalEntryId: input.journalEntryId ?? 'entry-000001',
      actor: 'user:test',
      correlationId: 'corr',
    })
    await writeEvents(tx, 'billing', events)
    return { value: entitlement }
  })
  return outcome.value
}

test('ONE CLOCK: a grant is active the instant it is made, whatever the database clock reads', { skip }, async () => {
  // The defect this pins: `granted_at` used to default to Postgres' `now()` while activity was
  // evaluated against the caller's clock. On a host whose database ran 60ms ahead, a purchase
  // answered `active: false` for something the customer had that moment paid for, and the list
  // route returned nothing. Every timestamp the activity rule reads now comes from one clock.
  const at = new Date()
  const entitlement = await grant({ grantedAt: at })
  assert.equal(entitlement.grantedAt, at.toISOString())
  assert.equal(isEntitlementActive(entitlement, at.toISOString()), true)
  assert.equal((await listEntitlements(db, { subject: ALICE, at: at.toISOString() })).length, 1)

  const stored = await readEntitlement(db, entitlement.id)
  assert.equal(stored?.grantedAt, at.toISOString(), 'the database did not stamp its own clock on it')
})

test('a grant is listed for its subject and nobody else', { skip }, async () => {
  await grant({ subject: ALICE })
  assert.equal((await listEntitlements(db, { subject: ALICE, at: AT })).length, 1)
  assert.equal((await listEntitlements(db, { subject: BOB, at: AT })).length, 0)
})

test('THE SCOPE: a grant for one title does not satisfy a check for another', { skip }, async () => {
  await grant({ sku: 'world.private.small', scope: 'title:emberfall' })

  const here = await listEntitlements(db, { subject: ALICE, scope: 'title:emberfall', at: AT })
  const there = await listEntitlements(db, { subject: ALICE, scope: 'title:driftmoor', at: AT })
  const platform = await listEntitlements(db, { subject: ALICE, scope: 'platform', at: AT })

  assert.equal(here.length, 1)
  assert.equal(there.length, 0)
  assert.equal(platform.length, 0, 'a title grant is not a platform grant')
})

test('REVOCATION: a revoked entitlement stops satisfying a check IMMEDIATELY', { skip }, async () => {
  const entitlement = await grant({})
  assert.equal((await listEntitlements(db, { subject: ALICE, at: AT })).length, 1)

  const at = new Date(AT)
  await sql.begin(async (tx) => {
    const events: Parameters<Emit>[0][] = []
    await revokeEntitlement(tx, (event) => events.push(event), {
      id: entitlement.id,
      reason: 'refund',
      actor: 'user:ops',
      correlationId: 'c',
      at,
    })
    await writeEvents(tx, 'billing', events)
    return { value: null }
  })

  // The same instant the revocation was recorded at: not active. There is no window in which a
  // refunded customer still owns the thing.
  assert.equal((await listEntitlements(db, { subject: ALICE, at: AT })).length, 0)
  const stored = await readEntitlement(db, entitlement.id)
  assert.equal(isEntitlementActive(stored!, AT), false)
  // A moment before, it was theirs — the row is updated, never deleted, so "did they ever own
  // this" stays answerable.
  assert.equal(isEntitlementActive(stored!, '2026-07-30T11:59:59.999Z'), true)
})

test('a revoked grant is still visible with includeInactive, because it is history', { skip }, async () => {
  const entitlement = await grant({})
  await sql.begin(async (tx) => {
    await revokeEntitlement(tx, () => {}, {
      id: entitlement.id,
      reason: 'refund',
      actor: 'user:ops',
      correlationId: 'c',
      at: new Date(AT),
    })
    return { value: null }
  })
  const all = await listEntitlements(db, { subject: ALICE, at: AT, includeInactive: true })
  assert.equal(all.length, 1)
  assert.equal(all[0]?.revokedReason, 'refund')
})

test('EXPIRY: an expired entitlement stops satisfying a check, with no sweep involved', { skip }, async () => {
  // Activity is computed against `expires_at`, so a season pass ends whether or not any job runs.
  await grant({ sku: 'season.pass.s1', expiresAt: new Date('2026-07-30T11:00:00.000Z') })

  assert.equal((await listEntitlements(db, { subject: ALICE, at: AT })).length, 0)
  assert.equal(
    (await listEntitlements(db, { subject: ALICE, at: '2026-07-30T10:00:00.000Z' })).length,
    1,
    'it was owned before it expired',
  )
})

test('the expiry sweep emits an event so the delivering service can tear the thing down', { skip }, async () => {
  await grant({ sku: 'season.pass.s1', expiresAt: new Date('2026-07-30T11:00:00.000Z') })

  const outcome = await sql.begin(async (tx) => {
    const events: Parameters<Emit>[0][] = []
    const expired = await expireDue(tx, (event) => events.push(event), new Date(AT))
    await writeEvents(tx, 'billing', events)
    return { value: expired }
  })
  assert.equal(outcome.value.length, 1)

  const events = await sql<Array<{ topic: string; payload: Record<string, unknown> }>>`
    select topic, payload from outbox order by occurred_at
  `
  assert.deepEqual(
    events.map((e) => e.topic),
    ['billing.entitlement.granted', 'billing.entitlement.revoked'],
  )
  assert.equal(events[1]?.payload['reason'], 'expired')
  // Revoked AT the expiry, not at the sweep: the customer lost access when the pass ran out, and
  // the sweep is only how the rest of the estate hears about it.
  assert.equal(events[1]?.payload['revokedAt'], '2026-07-30T11:00:00.000Z')
})

test('the sweep does not touch a grant that has already been revoked', { skip }, async () => {
  const entitlement = await grant({
    sku: 'season.pass.s1',
    expiresAt: new Date('2026-07-30T11:00:00.000Z'),
  })
  await sql.begin(async (tx) => {
    await revokeEntitlement(tx, () => {}, {
      id: entitlement.id,
      reason: 'refund',
      actor: 'user:ops',
      correlationId: 'c',
      at: new Date('2026-07-30T09:00:00.000Z'),
    })
    return { value: null }
  })

  const outcome = await sql.begin(async (tx) => {
    const expired = await expireDue(tx, () => {}, new Date(AT))
    return { value: expired }
  })
  assert.equal(outcome.value.length, 0, 'a refunded grant must not be re-revoked as expired')
  const stored = await readEntitlement(db, entitlement.id)
  assert.equal(stored?.revokedReason, 'refund', 'the original reason survives')
})

test('a zero-quantity grant is not owned', { skip }, async () => {
  await grant({ quantity: 0n })
  assert.equal((await listEntitlements(db, { subject: ALICE, at: AT })).length, 0)
})

test('a sku filter narrows without changing the activity rule', { skip }, async () => {
  await grant({ sku: 'cosmetic.ember-cape' })
  await grant({ sku: 'convenience.extra-slot' })
  const capes = await listEntitlements(db, { subject: ALICE, sku: 'cosmetic.ember-cape', at: AT })
  assert.equal(capes.length, 1)
  assert.equal(capes[0]?.sku, 'cosmetic.ember-cape')
})

test('an impossible scope cannot be stored, whatever writes it', { skip }, async () => {
  // The CHECK, not the application, is what makes this true for a psql session too.
  const id = await productId('cosmetic.ember-cape')
  await assert.rejects(
    sql`insert into entitlements (subject, product_id, sku, scope, source, quantity)
        values (${ALICE}, ${id}, 'x', 'world:1', 'grant', 1)`,
    /violates check constraint/,
  )
})

test(
  'THE TWO PREDICATES AGREE: the SQL filter and isEntitlementActive answer identically',
  { skip },
  async () => {
    // Every boundary, in both implementations. Two copies of "is this live" that disagree is the
    // failure this test exists to make impossible.
    const expires = new Date('2026-07-30T12:00:00.000Z')
    const perpetual = await grant({ sku: 'cosmetic.ember-cape' })
    const expiring = await grant({ sku: 'season.pass.s1', expiresAt: expires })
    const revoked = await grant({ sku: 'convenience.extra-slot' })
    await sql.begin(async (tx) => {
      await revokeEntitlement(tx, () => {}, {
        id: revoked.id,
        reason: 'refund',
        actor: 'user:ops',
        correlationId: 'c',
        at: expires,
      })
      return { value: null }
    })

    const instants = [
      '2026-07-30T11:59:59.999Z',
      '2026-07-30T12:00:00.000Z',
      '2026-07-30T12:00:00.001Z',
      '2027-01-01T00:00:00.000Z',
    ]

    for (const at of instants) {
      const listed = new Set((await listEntitlements(db, { subject: ALICE, at })).map((e) => e.id))
      for (const id of [perpetual.id, expiring.id, revoked.id]) {
        const stored = await readEntitlement(db, id)
        assert.equal(
          listed.has(id),
          isEntitlementActive(stored!, at),
          `the list and the contract disagreed about ${id} at ${at}`,
        )
      }
    }
  },
)
