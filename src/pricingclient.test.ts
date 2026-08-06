/**
 * The USD→EMBER join, and the four ways it must refuse rather than improvise.
 *
 * Every case here is a way the estate has previously lost money or nearly did: a 200 that carried
 * a refusal, a `BigInt('')` that became `0n`, an assumed scale, and a rounding that reached zero.
 * None of them are hypothetical — see the citations in `pricingclient.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RATE_SCALE, WEI_PER_SPARK } from '@cloudsforge/contracts-chain'
import { RateUnavailableError, httpPricingClient } from './pricingclient.ts'

/** EMBER's real administered price: 0.25 USD, `pricing/src/migrations.ts`. */
const QUARTER = '250000'

function clientReturning(rate: unknown, status = 200) {
  return httpPricingClient({
    baseUrl: 'http://pricing.test',
    deadlineMs: 1_000,
    fetch: (async () =>
      new Response(JSON.stringify({ rate }), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch,
  })
}

const usable = (over: Record<string, unknown> = {}) => ({
  usable: true,
  usdScaled: QUARTER,
  rateScale: RATE_SCALE.toString(),
  ...over,
})

test('a usable rate converts a dollar price into wei', async () => {
  const client = clientReturning(usable())
  // $2.50 at $0.25/EMBER is 10 EMBER.
  const quote = await client.quote('EMBER', 250n)
  assert.equal(quote.amount, 10n * 10n ** 18n)
  assert.equal(quote.usdScaled, 250_000n)
  // And it lands on a whole number of Sparks, which is what a client will be shown.
  assert.equal(quote.amount % WEI_PER_SPARK, 0n)
})

test('AN UNUSABLE RATE IS A 200, AND IS STILL REFUSED', async () => {
  // The defect shape this test exists for: pricing answers 200 with `usable: false` and a reason,
  // deliberately (`pricing/src/server.ts`). A client that checked only the status code
  // would read a refusal as a price — the same mistake as the wallet that read an unknown receipt
  // as a successful payment. The FLAG is what is checked.
  const client = clientReturning({
    usable: false,
    reason: 'no administered price set',
    usdScaled: null,
    rateScale: RATE_SCALE.toString(),
  })
  await assert.rejects(
    () => client.quote('EMBER', 250n),
    (err: unknown) =>
      err instanceof RateUnavailableError && /no administered price set/.test(err.message),
  )
})

test('a missing `usable` is not a usable rate', async () => {
  // `usable !== true`, not `usable === false`. An absent field is not an assertion of health.
  await assert.rejects(
    () => clientReturning({ usdScaled: QUARTER, rateScale: RATE_SCALE.toString() }).quote('EMBER', 250n),
    RateUnavailableError,
  )
  await assert.rejects(
    () => clientReturning({ usable: 'true', usdScaled: QUARTER, rateScale: RATE_SCALE.toString() }).quote('EMBER', 250n),
    RateUnavailableError,
  )
})

test('BigInt("") IS 0n, SO THE PARSER NEVER REACHES BigInt WITH ANYTHING BUT DIGITS', async () => {
  // Each of these, passed to `BigInt(value ?? '0')`, yields either 0n or a throw at a place that
  // cannot say what was wrong. 0n here is a free purchase.
  const hazards: unknown[] = [
    '', ' ', '1e3', '0x10', '-1', '1.0', '250 ', null, undefined, 250_000, true, {},
    '1'.repeat(79),
  ]
  for (const usdScaled of hazards) {
    await assert.rejects(
      () => clientReturning(usable({ usdScaled })).quote('EMBER', 250n),
      RateUnavailableError,
      `accepted usdScaled = ${JSON.stringify(usdScaled)}`,
    )
  }
})

test('the published scale is checked, not assumed', async () => {
  // A rate applied at the wrong scale misprices by that factor and nothing in either service
  // would notice. Pricing publishes `rateScale` precisely "so a consumer never has to assume the
  // scale it is doing BigInt maths at" — so it is read.
  await assert.rejects(
    () => clientReturning(usable({ rateScale: '1000' })).quote('EMBER', 250n),
    (err: unknown) => err instanceof RateUnavailableError && /scale/.test(err.message),
  )
  await assert.rejects(
    () => clientReturning(usable({ rateScale: undefined })).quote('EMBER', 250n),
    RateUnavailableError,
  )
})

test('a zero or negative rate cannot price anything', async () => {
  await assert.rejects(() => clientReturning(usable({ usdScaled: '0' })).quote('EMBER', 250n), RateUnavailableError)
})

test('A POSITIVE PRICE THAT CONVERTS TO ZERO IS REFUSED, NOT ROUNDED DOWN TO FREE', async () => {
  // Rounding down is right for dust and catastrophic at the boundary. An absurdly high rate makes
  // one cent worth less than a wei; the answer is a refusal, not a gift.
  const client = clientReturning(usable({ usdScaled: (10n ** 40n).toString() }))
  await assert.rejects(
    () => client.quote('EMBER', 1n),
    (err: unknown) => err instanceof RangeError && /converts to zero/.test(err.message),
  )
})

test('an unreachable or refusing pricing service fails the purchase — it does not default', async () => {
  const down = httpPricingClient({
    baseUrl: 'http://pricing.test',
    deadlineMs: 100,
    fetch: (async () => {
      throw new TypeError('fetch failed')
    }) as typeof globalThis.fetch,
  })
  await assert.rejects(() => down.quote('EMBER', 250n), RateUnavailableError)

  // A 4xx too. A rate we were refused is not a rate we may improvise.
  await assert.rejects(() => clientReturning(usable(), 403).quote('EMBER', 250n), RateUnavailableError)

  // And a body with no rate object at all.
  await assert.rejects(() => clientReturning(undefined).quote('EMBER', 250n), RateUnavailableError)
})

test('a negative price is refused before a rate is even read', async () => {
  await assert.rejects(() => clientReturning(usable()).quote('EMBER', -1n), RateUnavailableError)
})

test('a zero price is legitimate and converts to zero without complaint', async () => {
  // A free product is a real thing; "nothing for nothing" is not the defect. "Something for
  // nothing" is, and that is the case above.
  assert.equal((await clientReturning(usable()).quote('EMBER', 0n)).amount, 0n)
})
