import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checksumOf } from '@cloudsforge/db'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'

const sql = MIGRATIONS.map((m) => m.up).join('\n')

/**
 * The DDL with `--` comments removed.
 *
 * Assertions that a migration does *not* contain something must run against the statements, not
 * the prose: these migrations explain their reasoning at length, and a comment about why a column
 * is not a float contains the word "float".
 */
const statementsOf = (text: string): string => text.replace(/--[^\n]*/g, '')

test('versions are unique and ascending', () => {
  const versions = MIGRATIONS.map((m) => m.version)
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b))
  assert.equal(new Set(versions).size, versions.length, 'a duplicate version makes the run refuse')
})

test('SCHEMA_VERSION is the highest migration, so a new one raises the boot assertion', () => {
  assert.equal(SCHEMA_VERSION, Math.max(...MIGRATIONS.map((m) => m.version)))
})

test('a new service baselines nothing', () => {
  // The estate's entitlements table has no scope, no expiry and no revocation, so no version here
  // describes it and baselining it in would record a schema that does not exist.
  assert.equal(BASELINE_VERSION, 0)
})

test('no migration interpolates anything into its SQL', () => {
  for (const m of MIGRATIONS) {
    assert.doesNotMatch(m.up, /\$\{/, `${m.name} interpolates into its SQL`)
  }
})

test('checksums are whitespace-insensitive at the edges, and nowhere else', () => {
  for (const m of MIGRATIONS) {
    assert.equal(checksumOf(m), checksumOf({ ...m, up: `\n  ${m.up}  \n` }), `${m.name} is whitespace-sensitive`)
    assert.notEqual(checksumOf(m), checksumOf({ ...m, up: `${m.up}\nselect 1;` }))
  }
})

test('every table the service reads or writes is created', () => {
  for (const table of [
    'jobs',
    'outbox',
    'event_subscriptions',
    'outbox_deliveries',
    'inbox',
    'products',
    'prices',
    'purchases',
    'idempotency_keys',
    'subscriptions',
    'entitlements',
    'usage_records',
    'invoices',
    'invoice_lines',
    'payouts',
    'engagement_fee_recycles',
  ]) {
    assert.match(sql, new RegExp(`create table if not exists ${table}\\b`), `${table} is missing`)
  }
})

test('the fee recycle carries its ceiling in the schema — 21 §7.5', () => {
  // The ceiling is the one guarantee that cannot live in a client: admin-api owns the percentage
  // and billing reads it, so the only thing stopping a bad read, a bypassed client or a psql
  // session from recycling 90% of revenue is this CHECK. 2500 bps is the same number as
  // admin-api's `engagement_fee_recycle_within_ceiling` (admin-api/src/migrations.ts:451), and
  // `recycle.test.ts` proves it against the live constraint.
  assert.match(statementsOf(sql), /engagement_fee_recycles_within_ceiling/)
  assert.match(statementsOf(sql), /check \(recycle_bps >= 0 and recycle_bps <= 2500\)/)
})

test('the recycled amount is the DATABASE’s arithmetic, and it floors', () => {
  // A generated column, so a handler cannot compute a different number from the one the row
  // claims. `div` truncates and both operands are non-negative, so the recycle is always at most
  // the configured share — the safe direction for a transfer out of revenue.
  assert.match(statementsOf(sql), /amount_shards\s+numeric\(78, 0\)\s+generated always as/)
  assert.match(statementsOf(sql), /div\(greatest\(gross_shards - refunded_shards, 0::numeric\) \* recycle_bps, 10000::numeric\)/)
})

test('a recycle names its entry exactly when it posted one — 21 §7.4', () => {
  // Both directions in one constraint: no entry id without a posting, no posting without one.
  assert.match(statementsOf(sql), /engagement_fee_recycles_posted_names_entry/)
  assert.match(statementsOf(sql), /check \(\(status = 'posted'\) = \(journal_entry_id is not null\)\)/)
})

test('one recycle row per period per asset, so a crashed run resumes rather than doubles', () => {
  assert.match(
    statementsOf(sql),
    /create unique index if not exists engagement_fee_recycles_period_uniq\s+on engagement_fee_recycles \(asset_code, period_start\)/,
  )
})

test('billing declares no fee-recycle PERCENTAGE of its own', () => {
  // 21 §6 makes the rate an approval-gated operator decision in admin-api. A default, a column or
  // a settings row here would be a second thing to raise, bypassing the two-operator gate — so
  // the schema holds periods and a ceiling, and never a rate anybody can set from this side.
  assert.doesNotMatch(statementsOf(sql), /recycle_bps\s+integer\s+not null\s+default/)
  assert.doesNotMatch(statementsOf(sql), /create table if not exists engagement_fee_recycle\b/)
})

/* ------------------------------------------------------------------ the four defects */

test('DEFECT 1: an entitlement has a scope, and the shape is enforced by a CHECK', () => {
  // In the constraint rather than the application, so a row inserted by hand obeys it too.
  assert.match(statementsOf(sql), /scope text not null default 'platform'/)
  assert.match(
    statementsOf(sql),
    /check \(scope = 'platform' or scope like 'title:%' or scope like 'community:%'\)/,
  )
})

test('DEFECT 2: an entitlement has an expiry, and it cannot precede the grant', () => {
  assert.match(statementsOf(sql), /expires_at timestamptz/)
  assert.match(statementsOf(sql), /entitlements_expiry_after_grant/)
})

test('DEFECT 3: an entitlement can be revoked, with a reason', () => {
  assert.match(statementsOf(sql), /revoked_at\s+timestamptz/)
  assert.match(statementsOf(sql), /revoked_reason text/)
})

test('DEFECT 4: the lookup index is the one a service-readable check uses', () => {
  // (subject, scope, sku), partial on the live set: a revoked grant is history and the question a
  // service asks is always about now.
  assert.match(
    statementsOf(sql),
    /create index if not exists entitlements_live_idx\s+on entitlements \(subject, scope, sku\)\s+where revoked_at is null/,
  )
})

/* ------------------------------------------------------------------ money invariants */

test('a purchase cannot exist without the ledger entry that paid for it', () => {
  // The proof that billing holds no balance: the column is NOT NULL, so there is no path that
  // records a sale with no money behind it.
  assert.match(statementsOf(sql), /journal_entry_id text not null/)
})

test('every amount column is numeric, never a float', () => {
  assert.doesNotMatch(statementsOf(sql), /float|double precision|\breal\b/)
  for (const column of ['unit_amount', 'amount', 'quantity', 'total', 'gross', 'platform_fee', 'net']) {
    assert.match(statementsOf(sql), new RegExp(`${column}\\s+numeric\\(78, 0\\)`), `${column} is not numeric`)
  }
})

test('a payout that does not add up cannot be stored', () => {
  // isPayoutConsistent from contracts-money, enforced where a psql session has to obey it too. A
  // payout whose parts disagree balances as a journal entry while paying the wrong amount.
  assert.match(statementsOf(sql), /payouts_net_consistent/)
  assert.match(statementsOf(sql), /check \(platform_fee <= gross and net = gross - platform_fee\)/)
})

test('the idempotency key on a purchase is unique', () => {
  // The same guarantee as the claim table's primary key, in the place the purchase itself lives.
  assert.match(statementsOf(sql), /idempotency_key text not null unique/)
})

test('the seeded catalogue includes the two products whose defects this service fixes', () => {
  // A season pass that must END, and a private world that must be scoped to its title.
  assert.match(sql, /'season\.pass\.s1'.*'one_off',\s*'platform',\s*90/)
  assert.match(sql, /'world\.private\.small'.*'one_off',\s*'title',\s*30/)
})

/* ═══════════════════════════════════════════ migration 11 — Shards out, USD in, EMBER settled */

test('no migration creates a new active Shard price, and one forbids it outright', () => {
  // The constraint, not a convention. It refuses the row whatever the application believes, and
  // it caught `resetBilling` replaying migration 9's seed on the first run after it was added.
  assert.match(statementsOf(sql), /constraint prices_no_new_shard/)
  assert.match(statementsOf(sql), /check \(asset_code <> 'SHARD' or status = 'retired'\)/)
})

test('the Shard prices are superseded, never rewritten and never deleted', () => {
  const eleven = MIGRATIONS.find((m) => m.version === 11)?.up ?? ''
  const statements = statementsOf(eleven)

  // Retired in place. `purchases.price_id` and `subscriptions.price_id` reference these rows, so a
  // past purchase must keep pointing at a row that says what it actually cost.
  assert.match(statements, /update prices set status = 'retired' where asset_code = 'SHARD'/)

  // Never destroyed. A DELETE here would drop the only record of what a historical purchase was
  // priced at, and the FK would refuse it anyway — loudly in CI, or quietly never exercised.
  assert.equal(/delete\s+from\s+prices/i.test(statements), false, 'migration 11 deletes a price row')

  // Never re-labelled. This is the eighteen-orders-of-magnitude bug: SHARD has decimals 0 and
  // EMBER has 18, so `update prices set asset_code='EMBER'` would read a stored 250 as 250 wei.
  assert.equal(
    /update\s+prices\s+set\s+asset_code/i.test(statements),
    false,
    'migration 11 rewrites an asset code in place — that is a silent scale change',
  )
})

test('the re-denomination is the identity on the stored integer', () => {
  // The whole safety argument, asserted rather than trusted to the prose. The new USD rows are
  // built by SELECTing `unit_amount` from the retired Shard rows — no multiplication, no division,
  // no rounding — because at the documented 100-Shards-to-the-dollar peg one Shard IS one cent.
  const eleven = statementsOf(MIGRATIONS.find((m) => m.version === 11)?.up ?? '')
  assert.match(eleven, /select p\.product_id, 'USD', p\.unit_amount,/)
  // No arithmetic anywhere near the amount.
  assert.equal(
    /unit_amount\s*[*\/+-]/.test(eleven),
    false,
    'the conversion applies arithmetic to a stored price',
  )
})

test('a purchase records the price, the charge AND the rate between them', () => {
  const eleven = statementsOf(MIGRATIONS.find((m) => m.version === 11)?.up ?? '')
  for (const column of ['price_asset_code', 'price_amount', 'rate_usd_scaled']) {
    assert.match(eleven, new RegExp(`add column if not exists ${column}`), `${column} is missing`)
  }
  // Without the rate, `amount` and `price_amount` are two numbers with no stated relationship and
  // nobody can tell a rate change from a bug.
  assert.match(eleven, /rate_usd_scaled\s+numeric\(78, 0\)/)
})

test('a positive price may never have been charged as nothing', () => {
  // The BigInt('') = 0n hazard, given a home in the schema. The application refuses a zero
  // conversion too, but the application is one deploy away from being wrong and the row outlives
  // the deploy.
  assert.match(statementsOf(sql), /constraint purchases_no_free_lunch/)
  assert.match(statementsOf(sql), /check \(price_amount = 0 or amount > 0\)/)
})

test('SPARK is not an asset code in any migration', () => {
  // A Spark is a display denomination of EMBER. The ledger's balancing invariant is enforced per
  // asset code, so a second code for the same money could drift from it with nothing able to
  // notice. `contracts-chain` keeps the same guard over its own source.
  assert.equal(/'SPARK'/.test(sql), false, "'SPARK' appears as an asset code in a migration")
})
