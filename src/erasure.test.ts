/**
 * Right to erasure, end to end.
 *
 * The tests that matter here are not "the row changed". They are the four that a plausible-looking
 * handler passes only if it is actually correct:
 *
 *   1. Erasure leaves NOTHING behind under either spelling of the subject. A survey that greps for
 *      `subject` columns misses `idempotency_keys.response`, which holds a verbatim second copy.
 *   2. An erased subscription cannot be charged again. That is a schema property, and it is asserted
 *      against the schema — an UPDATE straight back to `active` must be refused by Postgres, not by
 *      a handler that a later change could route around.
 *   3. An erased row cannot be re-attributed, by anything, including a direct UPDATE.
 *   4. The money that was already counted still counts. The fee recycle's gross is a SUM over
 *      `purchases` and `invoices`, and an erasure that changed it would silently restate a period
 *      whose entry has already posted to the ledger.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { ERASED_SUBJECT, eraseUser, subjectForms, UUID } from './erasure.ts'
import {
  ALICE,
  ALICE_ID,
  BOB,
  BOB_ID,
  enabled,
  migrateTestDb,
  openDb,
  resetBilling,
  skip,
} from './testsupport.ts'
import type { Db, Tx } from './outbox.ts'

let sql: postgres.Sql

before(async () => {
  if (!enabled) return
  sql = openDb(4)
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

/** `eraseUser` takes a transaction, because in production `withInbox` is the one that opens it. */
async function erase(userId: string): Promise<Awaited<ReturnType<typeof eraseUser>>> {
  const outcome = await (sql as unknown as Db).begin(async (tx) => ({
    value: await eraseUser(tx as unknown as Tx, userId),
  }))
  return outcome.value
}

async function productId(sku: string): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`select id from products where sku = ${sku}`
  const row = rows[0]
  if (!row) throw new Error(`no product ${sku}`)
  return row.id
}

async function priceId(product: string): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    select id from prices where product_id = ${product} and status = 'active' limit 1
  `
  const row = rows[0]
  if (!row) throw new Error('no active price')
  return row.id
}

/**
 * One of everything, for one subject.
 *
 * Deliberately writes through raw SQL rather than through the purchase path: this file is about
 * what happens to rows that EXIST, and routing the fixture through the money path would couple
 * every assertion here to the ledger fake and to pricing.
 */
async function seed(subject: string, key: string): Promise<{ purchase: string; subscription: string }> {
  const product = await productId('cosmetic.ember-cape')
  const price = await priceId(product)

  const purchases = await sql<Array<{ id: string }>>`
    insert into purchases (
      subject, product_id, price_id, quantity, asset_code, amount, journal_entry_id,
      idempotency_key, actor, price_asset_code, price_amount
    )
    values (
      ${subject}, ${product}, ${price}, 1, 'EMBER', 500, ${`entry-${key}`},
      ${`idem-${key}`}, ${subject}, 'USD', 125
    )
    returning id
  `
  const purchase = purchases[0]!.id

  // The claim, exactly as `runOnce` writes it: the response is a copy of the purchase reply, and
  // it carries the subject. This is the row a subject-column survey never finds.
  await sql`
    insert into idempotency_keys (key, route, request_hash, response, resource_id)
    values (
      ${`billing:${key}`}, 'POST /purchases', 'hash',
      ${sql.json({ purchase: { id: purchase, subject } })}, ${purchase}
    )
  `

  const subscriptions = await sql<Array<{ id: string }>>`
    insert into subscriptions (
      subject, product_id, price_id, status, current_period_start, current_period_end
    )
    values (${subject}, ${product}, ${price}, 'active', now(), now() + interval '30 days')
    returning id
  `
  const subscription = subscriptions[0]!.id

  await sql`
    insert into entitlements (subject, product_id, sku, source)
    values (${subject}, ${product}, 'cosmetic.ember-cape', 'purchase')
  `
  await sql`
    insert into usage_records (subscription_id, subject, meter, quantity)
    values (${subscription}, ${subject}, 'api.calls', 42)
  `
  await sql`
    insert into invoices (
      subject, subscription_id, period_start, period_end, asset_code, total, status
    )
    values (${subject}, ${subscription}, now() - interval '30 days', now(), 'EMBER', 500, 'paid')
  `
  await sql`
    insert into payouts (
      subject, period_start, period_end, asset_code, gross, platform_fee, net, status,
      destination_wallet_id
    )
    values (
      ${subject}, now() - interval '30 days', now(), 'EMBER', 1000, 100, 900, 'pending',
      ${`wallet-${key}`}
    )
  `
  return { purchase, subscription }
}

test('the two spellings of one person are both matched, and only those two', { skip }, () => {
  // The payload carries a bare uuid; this service stores `user:<uuid>`. Getting this wrong in
  // either direction erases nothing and reports success, which is the defect being fixed.
  assert.deepEqual(subjectForms(ALICE_ID), [`user:${ALICE_ID}`, ALICE_ID])
})

test('erasure removes what has no basis and keeps what does', { skip }, async () => {
  await seed(ALICE, 'a')
  const counts = await erase(ALICE_ID)

  assert.deepEqual(counts, {
    purchases: 1,
    subscriptions: 1,
    invoices: 1,
    payouts: 1,
    payoutsCancelled: 1,
    entitlements: 1,
    usageRecords: 1,
    idempotencyKeys: 1,
  })

  const gone = await sql<Array<{ table_name: string; n: number }>>`
    select 'entitlements' as table_name, count(*)::int as n from entitlements
     union all select 'usage_records', count(*)::int from usage_records
     union all select 'idempotency_keys', count(*)::int from idempotency_keys
  `
  for (const row of gone) assert.equal(row.n, 0, `${row.table_name} should be empty`)

  const kept = await sql<Array<{ n: number }>>`
    select count(*)::int as n from purchases where erased_at is not null and subject = ${ERASED_SUBJECT}
  `
  assert.equal(kept[0]?.n, 1)
})

test('NO row anywhere still names the person, under either spelling', { skip }, async () => {
  await seed(ALICE, 'a')
  await erase(ALICE_ID)

  // Every text and jsonb column in the service, swept for the uuid — not just the columns the
  // handler happens to touch. `idempotency_keys.response` is the reason this is a sweep and not a
  // list: a jsonb copy of the subject is invisible to any survey of `subject` columns.
  const hits = await sql<Array<{ relname: string; attname: string }>>`
    select c.relname, a.attname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      join pg_type t on t.oid = a.atttypid
     where n.nspname = 'public'
       and c.relkind = 'r'
       and t.typname in ('text', 'varchar', 'jsonb', 'json')
  `
  for (const column of hits) {
    const found = await sql<Array<{ n: number }>>`
      select count(*)::int as n from ${sql(column.relname)}
       where ${sql(column.attname)}::text like ${`%${ALICE_ID}%`}
    `
    assert.equal(found[0]?.n, 0, `${column.relname}.${column.attname} still names the erased user`)
  }
})

test('erasing one person does not touch another', { skip }, async () => {
  await seed(ALICE, 'a')
  await seed(BOB, 'b')
  await erase(ALICE_ID)

  const bob = await sql<Array<{ n: number }>>`
    select count(*)::int as n from entitlements where subject = ${BOB}
  `
  assert.equal(bob[0]?.n, 1)
  const bobPurchase = await sql<Array<{ subject: string; erased_at: Date | null }>>`
    select subject, erased_at from purchases where idempotency_key = 'idem-b'
  `
  assert.equal(bobPurchase[0]?.subject, BOB)
  assert.equal(bobPurchase[0]?.erased_at, null)
  void BOB_ID
})

test('THE ONE THAT COSTS MONEY: an erased subscription can never be charged again', { skip }, async () => {
  const { subscription } = await seed(ALICE, 'a')
  await erase(ALICE_ID)

  const row = await sql<Array<{ status: string; cancelled_at: Date | null }>>`
    select status, cancelled_at from subscriptions where id = ${subscription}
  `
  assert.equal(row[0]?.status, 'cancelled')
  assert.notEqual(row[0]?.cancelled_at, null)

  // The renewal job's access path is `subscriptions_due_idx`, partial on exactly these states.
  const due = await sql<Array<{ n: number }>>`
    select count(*)::int as n from subscriptions
     where status in ('trialing', 'active', 'past_due')
  `
  assert.equal(due[0]?.n, 0)

  // And the schema refuses to let it back, so a future change to the renewal job cannot undo this.
  await assert.rejects(
    () => sql`update subscriptions set status = 'active' where id = ${subscription}`,
    /subscriptions_erased_is_terminal/,
  )
})

test('an erased row cannot be re-attributed, even by a direct UPDATE', { skip }, async () => {
  const { purchase } = await seed(ALICE, 'a')
  await erase(ALICE_ID)

  await assert.rejects(
    () => sql`update purchases set subject = ${ALICE} where id = ${purchase}`,
    /cannot be re-attributed/,
  )
  await assert.rejects(
    () => sql`update purchases set erased_at = null where id = ${purchase}`,
    /cannot be un-erased/,
  )
})

test('the placeholder and the timestamp cannot exist without each other', { skip }, async () => {
  await seed(ALICE, 'a')
  // A handler that set the subject and forgot the timestamp would look like it worked.
  await assert.rejects(
    () => sql`update invoices set subject = ${ERASED_SUBJECT} where subject = ${ALICE}`,
    /invoices_erased_names_placeholder/,
  )
  // And the mirror: a timestamp with a live subject still on the row.
  await assert.rejects(
    () => sql`update invoices set erased_at = now() where subject = ${ALICE}`,
    /invoices_erased_names_placeholder/,
  )
})

test('a de-identified purchase that still names its actor is refused', { skip }, async () => {
  const { purchase } = await seed(ALICE, 'a')
  // `actor` is the second identifier on this table and was absent from the issue's list. Erasing
  // only `subject` leaves the same person named in the column beside it, and the schema says no.
  await assert.rejects(
    () => sql`
      update purchases set subject = ${ERASED_SUBJECT}, erased_at = now() where id = ${purchase}
    `,
    /purchases_erased_names_no_actor/,
  )
})

test('an erased payout names no wallet and is not still owed', { skip }, async () => {
  await seed(ALICE, 'a')
  await erase(ALICE_ID)

  const row = await sql<Array<{ status: string; destination_wallet_id: string | null; net: string }>>`
    select status, destination_wallet_id, net from payouts where subject = ${ERASED_SUBJECT}
  `
  assert.equal(row[0]?.status, 'cancelled')
  assert.equal(row[0]?.destination_wallet_id, null)
  // The arithmetic survives: payouts_net_consistent is still checkable, which is the whole reason
  // the row is de-identified rather than deleted.
  assert.equal(row[0]?.net, '900')
})

test('THE SUMS DO NOT MOVE: recycle gross is identical before and after', { skip }, async () => {
  await seed(ALICE, 'a')
  const before = await sql<Array<{ gross: string; earliest: Date }>>`
    select coalesce(sum(amount), 0)::text as gross, min(created_at) as earliest from purchases
  `
  await erase(ALICE_ID)
  const after = await sql<Array<{ gross: string; earliest: Date }>>`
    select coalesce(sum(amount), 0)::text as gross, min(created_at) as earliest from purchases
  `
  // `recycle.ts` and read exactly these two. A closed period has already posted its
  // entry to the ledger, so a change to either would restate money that has moved.
  assert.equal(after[0]?.gross, before[0]?.gross)
  assert.deepEqual(after[0]?.earliest, before[0]?.earliest)

  const invoices = await sql<Array<{ total: string }>>`
    select coalesce(sum(total), 0)::text as total from invoices
  `
  assert.equal(invoices[0]?.total, '500')
})

test('a second delivery of the same erasure is a no-op, not a second cancellation', { skip }, async () => {
  await seed(ALICE, 'a')
  await erase(ALICE_ID)
  // `withInbox` is what makes this unreachable in production. Asserted anyway, because at-least-once
  // delivery plus a handler that is not idempotent is a bug waiting for a relay retry.
  const again = await erase(ALICE_ID)
  assert.deepEqual(again, {
    purchases: 0,
    subscriptions: 0,
    invoices: 0,
    payouts: 0,
    payoutsCancelled: 0,
    entitlements: 0,
    usageRecords: 0,
    idempotencyKeys: 0,
  })
})

test('a person stored under the bare uuid is erased too', { skip }, async () => {
  // Defensive: nothing writes this spelling today, and if anything ever does, the erasure must not
  // quietly skip it. This is the assertion that makes `subjectForms` more than a comment.
  await seed(ALICE_ID, 'bare')
  const counts = await erase(ALICE_ID)
  assert.equal(counts.purchases, 1)
  assert.equal(counts.entitlements, 1)
})

/**
 * THE REGRESSION THAT SHIPPED, AND WHY EVERY TEST IN THIS FILE MISSED IT.
 *
 * `UUID` constrained the version nibble to `[1-5]` and the variant to `[89ab]` —
 * the RFC 4122 shape for versions 1 to 5. Every user id in this estate is a
 * **UUIDv7**: 04-domain-model section 0 requires it, and `identity/src/ids.ts`
 * mints them. So the handler answered 400 to every real erasure event, the relay
 * retried the same event for ever, and the person's rows stayed exactly where
 * they were while the account service reported the deletion as complete.
 *
 * Every test in this file passed the whole time, because the fixtures are v4
 * uuids. Both sides of the test agreed with each other and neither agreed with
 * the producer, which is the failure mode a fixture shared between a test and
 * the code under test cannot detect.
 *
 * The literal below is a real UUIDv7 as identity emits it: 48 bits of Unix
 * milliseconds, then the version nibble `7`. It is not derived from anything in
 * this repository on purpose — a fixture generated by this test would drift back
 * to whatever this repository believes an id looks like, which is the bug.
 *
 * No database. It runs on every checkout, including one with no Postgres.
 */
test('the uuid pattern accepts a UUIDv7, which is the only kind identity mints', () => {
  assert.ok(UUID.test('019fd1a6-c82c-7000-9951-445d80d64a45'), 'a v7 user id must be accepted')
  // v4 stays accepted: event ids come from `gen_random_uuid()` and are v4.
  assert.ok(UUID.test('11111111-1111-4111-8111-111111111111'), 'a v4 event id must be accepted')
  // Still a uuid and nothing else — the shape is checked, the version is not.
  assert.ok(!UUID.test('not-a-uuid'))
  assert.ok(!UUID.test('019fd1a6-c82c-7000-9951-445d80d64a4'), 'one hex short is not a uuid')
  assert.ok(!UUID.test('019fd1a6c82c70009951445d80d64a45'), 'unhyphenated is not this shape')
})
