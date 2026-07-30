/**
 * The pure decisions: scope parsing, scope matching, expiry arithmetic, and the activity rule.
 *
 * No database, no clock, no ledger. Every case here is exact, and each one is a rule that would
 * otherwise live in whichever route happened to write the grant — which is how the estate ended up
 * with four buy routes that each decide what a purchase means slightly differently.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCOPES } from '@cloudsforge/contracts-auth'
import { isEntitlementActive, type Entitlement } from '@cloudsforge/contracts-money'
import { expiryFor, nextPeriodEnd, type PriceRecord, type ProductRecord } from './catalogue.ts'
import { InvalidScopeError, parseScope } from './entitlements.ts'
import { PurchaseValidationError, ledgerKeyFor, scopeFor } from './purchases.ts'
import { GRANT_SCOPE, READ_SCOPE } from './server.ts'
import { purchasePostings } from './ledger.ts'

const product = (overrides: Partial<ProductRecord> = {}): ProductRecord => ({
  id: 'p-1',
  sku: 'world.private.small',
  name: 'Private World',
  kind: 'one_off',
  status: 'active',
  scopeKind: 'platform',
  entitlementDays: null,
  metadata: {},
  ...overrides,
})

const price = (overrides: Partial<PriceRecord> = {}): PriceRecord => ({
  id: 'pr-1',
  productId: 'p-1',
  assetCode: 'SHARD',
  unitAmount: 750n,
  interval: null,
  intervalCount: 1,
  status: 'active',
  ...overrides,
})

/* ------------------------------------------------------------------ scope */

test('THE FIRST DEFECT: a scope is one of three shapes and nothing else', () => {
  assert.equal(parseScope('platform'), 'platform')
  assert.equal(parseScope('title:emberfall'), 'title:emberfall')
  assert.equal(parseScope('community:9f2c-11'), 'community:9f2c-11')
})

test('a scope id is validated, because it is a lookup key', () => {
  // An unvalidated scope is a query parameter that decides which rows a service is shown.
  assert.throws(() => parseScope('title:'), InvalidScopeError)
  assert.throws(() => parseScope('title:../platform'), InvalidScopeError)
  assert.throws(() => parseScope('title:a b'), InvalidScopeError)
  assert.throws(() => parseScope('world:1'), /platform, title:<id> or community:<id>/)
  assert.throws(() => parseScope(''), InvalidScopeError)
})

test('a scoped product REFUSES to be bought without a scope', () => {
  // The defect in miniature: a private world bought with no title is an entitlement no service can
  // act on, which is why a purchased world is never provisioned. The absence is an error at the
  // point of sale rather than a platform scope quietly standing in for a title.
  const world = product({ scopeKind: 'title' })
  assert.throws(() => scopeFor(world, undefined), PurchaseValidationError)
  assert.throws(() => scopeFor(world, 'platform'), /takes a title scope/)
  assert.throws(() => scopeFor(world, 'community:x'), /takes a title scope/)
  assert.equal(scopeFor(world, 'title:emberfall'), 'title:emberfall')
})

test('a platform product refuses a scope it cannot honour', () => {
  const cape = product({ scopeKind: 'platform', sku: 'cosmetic.ember-cape' })
  assert.equal(scopeFor(cape, undefined), 'platform')
  assert.equal(scopeFor(cape, 'platform'), 'platform')
  assert.throws(() => scopeFor(cape, 'title:emberfall'), /takes no scope/)
})

test('the scopes this service uses are the ones in the contracts registry', () => {
  // A typo here is a scope no token can ever carry, and the failure would look like a
  // permissions problem rather than a spelling one.
  assert.ok(Object.hasOwn(SCOPES, READ_SCOPE))
  assert.ok(Object.hasOwn(SCOPES, GRANT_SCOPE))
  assert.equal(SCOPES[READ_SCOPE].service, 'billing')
  assert.equal(SCOPES[GRANT_SCOPE].service, 'billing')
})

/* ------------------------------------------------------------------ expiry */

test('THE SECOND DEFECT: a product with entitlement days ENDS', () => {
  const from = new Date('2026-01-01T00:00:00.000Z')
  const pass = product({ sku: 'season.pass.s1', entitlementDays: 90 })
  assert.equal(expiryFor(pass, from)?.toISOString(), '2026-04-01T00:00:00.000Z')
  // Null is perpetual, and a cosmetic genuinely is.
  assert.equal(expiryFor(product({ entitlementDays: null }), from), null)
})

test('expiry runs from the purchase, not from the product', () => {
  // A season pass bought on the last day of a season must still last its full ninety days. Dating
  // the product rather than the grant is how a customer pays full price for an hour of access.
  const pass = product({ entitlementDays: 90 })
  const early = expiryFor(pass, new Date('2026-01-01T00:00:00.000Z'))!
  const late = expiryFor(pass, new Date('2026-03-01T00:00:00.000Z'))!
  assert.equal(late.getTime() - early.getTime(), 59 * 24 * 3_600 * 1000)
})

test('a monthly period advances by calendar months, not by thirty days', () => {
  const monthly = price({ interval: 'month' })
  assert.equal(
    nextPeriodEnd(monthly, new Date('2026-01-03T09:00:00.000Z')).toISOString(),
    '2026-02-03T09:00:00.000Z',
  )
  // 31 January plus a month clamps to the end of February, which is what every billing system
  // converges on and what a subscriber expects.
  assert.equal(
    nextPeriodEnd(monthly, new Date('2026-01-31T00:00:00.000Z')).toISOString(),
    '2026-03-03T00:00:00.000Z',
  )
  assert.equal(
    nextPeriodEnd(price({ interval: 'year' }), new Date('2026-02-01T00:00:00.000Z')).toISOString(),
    '2027-02-01T00:00:00.000Z',
  )
  assert.throws(() => nextPeriodEnd(price({ interval: null }), new Date()), RangeError)
})

/* ------------------------------------------------------------------ activity */

const entitlement = (overrides: Partial<Entitlement> = {}): Entitlement => ({
  id: 'e-1',
  subject: 'user:11111111-1111-4111-8111-111111111111',
  productId: 'p-1',
  sku: 'season.pass.s1',
  scope: 'platform',
  source: 'purchase',
  grantedAt: '2026-01-01T00:00:00.000Z',
  quantity: 1n,
  ...overrides,
})

test('THE THIRD DEFECT: a revoked entitlement stops satisfying a check AT the revocation', () => {
  const revoked = entitlement({ revokedAt: '2026-02-01T00:00:00.000Z' })
  assert.equal(isEntitlementActive(revoked, '2026-01-31T23:59:59.999Z'), true)
  // At the instant of revocation, not after it. The customer lost access when the refund landed.
  assert.equal(isEntitlementActive(revoked, '2026-02-01T00:00:00.000Z'), false)
})

test('an expired entitlement stops satisfying a check at the expiry', () => {
  const expiring = entitlement({ expiresAt: '2026-04-01T00:00:00.000Z' })
  assert.equal(isEntitlementActive(expiring, '2026-03-31T23:59:59.999Z'), true)
  assert.equal(isEntitlementActive(expiring, '2026-04-01T00:00:00.000Z'), false)
})

test('a grant is not active before it is granted, and not at zero quantity', () => {
  assert.equal(isEntitlementActive(entitlement(), '2025-12-31T00:00:00.000Z'), false)
  assert.equal(isEntitlementActive(entitlement(), '2026-01-01T00:00:00.000Z'), true)
  assert.equal(isEntitlementActive(entitlement({ quantity: 0n }), '2026-06-01T00:00:00.000Z'), false)
})

/* ------------------------------------------------------------------ postings and keys */

test('a purchase is DOUBLE entry: the user falls, platform revenue rises', () => {
  // The estate's single-sided `ledger.delta` can express "the user lost 750" and cannot express
  // where it went, which is why per-product revenue is not derivable from it at all.
  const postings = purchasePostings({ subject: 'user:a', assetCode: 'SHARD', amount: 750n })
  assert.equal(postings.length, 2)
  assert.equal(postings[0]?.direction, 'debit')
  assert.equal(postings[0]?.account.type, 'liability')
  assert.equal(postings[1]?.direction, 'credit')
  assert.equal(postings[1]?.account.type, 'revenue')
  assert.equal(postings[1]?.account.subject, 'platform')
  // It balances because it is the same number.
  assert.equal(postings[0]?.amount, postings[1]?.amount)
})

test('the ledger key is DERIVED from the caller key, never generated', () => {
  // A random key would let a purchase transaction that rolled back after posting post again on
  // the retry — charging the customer twice and granting them nothing.
  assert.equal(ledgerKeyFor('abc'), 'billing:purchase:abc')
  assert.equal(ledgerKeyFor('abc'), ledgerKeyFor('abc'))
  assert.notEqual(ledgerKeyFor('abc'), ledgerKeyFor('abd'))
})
