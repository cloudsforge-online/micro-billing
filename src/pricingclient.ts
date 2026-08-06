/**
 * What a dollar costs in EMBER, as this service reads it — docs/ecosystem/15 §3.2.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **BILLING PRICES IN USD AND SETTLES IN EMBER. THIS MODULE IS THE JOIN, AND IT OWNS NO RATE.**
 *
 * The catalogue is durable in US cents (migration 11, which argues why). The ledger is posted in
 * EMBER, because EMBER is an asset a chain backs and the estate's central guarantee is that no
 * balance may exist that the chain does not back. Neither of those two numbers can be derived
 * from the other without a rate, and the rate belongs to `micro-pricing`. So it is read per
 * purchase and RECORDED ON THE PURCHASE ROW that used it (`purchases.rate_usd_scaled`), which is
 * the same discipline `adminapi.ts` applies to the fee-recycle percentage: one authority, and the
 * row says which answer it got.
 *
 * A cached rate is deliberately not offered. A stale rate here does not degrade a display, it
 * charges a customer the wrong amount of money.
 *
 * ── FAIL CLOSED ────────────────────────────────────────────────────────────────────────────────
 *
 * Pricing unreachable, or answering with `usable: false` — no rate was read, and an unread rate is
 * not a default one. The purchase is REFUSED. This is a real availability coupling and it is the
 * correct one: you cannot charge somebody in a currency you cannot price, and the alternative to
 * refusing is guessing at how much of their money to take.
 *
 * Note that `usable: false` is a 200 on the other side, with a `reason`
 * (`pricing/src/server.ts` — "a 404 would be a lie about the asset existing and a 503
 * would suggest retrying will help"). So a status check alone would read an unusable rate as a
 * usable one. **The flag is what is checked, not the status.** That is the same defect shape as
 * the wallet that read an unknown receipt as a successful payment.
 *
 * ── WHICH LEG, AND WHY NOT THE SPREAD ─────────────────────────────────────────────────────────
 *
 * `rate.usdScaled` — mid-market — and not `usdSellScaled`/`usdBuyScaled`. The spread is R7 in
 * docs/ecosystem/15 §3, a distinct revenue line charged on coin↔unit CONVERSION. A catalogue
 * purchase is not a conversion; the customer is buying a product whose stated price is $2.50.
 * Applying the conversion spread here would mean the amount actually taken did not correspond to
 * the stated dollar price, which is exactly what the owner's decision — "stated USD is unchanged"
 * — forbids. If the platform later wants a purchase spread it should be a stated, quoted line
 * item, not a silent adjustment to a rate lookup.
 *
 * ── THE ADMINISTERED RATE IS NOT A MARKET PRICE, AND THAT IS FINE HERE ────────────────────────
 *
 * EMBER's rate is administered (`pricing/src/rates.ts`), because Hearth has no exchange
 * listing. That is precisely why the CATALOGUE must not be stored in EMBER — an operator editing
 * the figure would silently restate every price. It is not a reason to avoid it at settlement:
 * at settlement it is doing the only job it can do, converting a stated dollar price into the
 * asset the customer actually holds, at a figure the platform has published and stands behind.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Route, verified against the other side
 *
 * `GET /rates/:asset` — `pricing/src/server.ts`. **Unauthenticated**: the rate board is public
 * in this estate by design (`pricing/src/server.ts`), and the neighbouring `/admin/prices`
 * routes are the ones behind `requireAdminAuthority`. So this client presents no credential and
 * needs no service-token grant.
 *
 * The body is `{ rate: RateView }` (`pricing/src/quotes.ts`), of which this file reads exactly
 * three fields: `usable`, `reason`, `usdScaled`. `rateScale` is also published — "so a consumer
 * never has to assume the scale it is doing BigInt maths at" — and is checked rather than
 * assumed, because assuming it is how a rate is applied at a factor of a million out.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import { RATE_SCALE, chainSpec, coinAmountForUsdCents } from '@cloudsforge/contracts-chain'
import type { IssuableAssetCode } from '@cloudsforge/contracts-chain'

/** A rate could not be obtained, or could not be trusted. Always refuses; never falls back. */
export class RateUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RateUnavailableError'
  }
}

/**
 * A scaled decimal string of digits, and nothing else.
 *
 * **`BigInt('')` is `0n`**, and a rate of zero would make `coinAmountForUsdCents` throw rather
 * than silently produce a free purchase — but only by luck of that function's guard. The estate
 * has been bitten by this repeatedly, so the value is made unreachable rather than handled: the
 * pattern is required BEFORE `BigInt` is called, the way `market/src/money.ts` does it.
 * A missing field, an empty string, `null`, a JSON number, `'1e3'` and `'0x10'` all refuse here.
 */
const SCALED_PATTERN = /^\d{1,78}$/

function parseScaled(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !SCALED_PATTERN.test(value)) {
    throw new RateUnavailableError(
      `pricing returned a ${field} that is not a decimal string of up to 78 digits`,
    )
  }
  return BigInt(value)
}

export interface Quote {
  /** Mid-market USD per one whole coin, at `RATE_SCALE`. */
  readonly usdScaled: bigint
  /** The coin amount, in smallest units, that the requested price converts to. */
  readonly amount: bigint
}

export interface PricingClient {
  /**
   * Convert a price in US cents into smallest units of `asset`, at the current published rate.
   *
   * Typed `IssuableAssetCode`, so a caller cannot ask this to denominate a purchase in a retired
   * asset. That is a compile error rather than a comment.
   */
  quote(asset: IssuableAssetCode, cents: bigint): Promise<Quote>
}

export interface PricingClientOptions {
  readonly baseUrl: string
  readonly deadlineMs: number
  /** Injected in tests. Absent in production, where the global is used. */
  readonly fetch?: typeof globalThis.fetch
}

interface RateBody {
  readonly rate?: {
    readonly usable?: unknown
    readonly reason?: unknown
    readonly usdScaled?: unknown
    readonly rateScale?: unknown
  }
}

export function httpPricingClient(options: PricingClientOptions): PricingClient {
  const http = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'pricing',
    defaultDeadlineMs: options.deadlineMs,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async quote(asset, cents) {
      if (cents < 0n) throw new RateUnavailableError('a price in cents must not be negative')

      let body: RateBody
      try {
        body = await http.get<RateBody>(`/rates/${asset}`)
      } catch (err) {
        // Including a 4xx. A rate we were refused is not a rate we may improvise.
        const detail = err instanceof HttpError ? `HTTP ${err.status}` : String(err)
        throw new RateUnavailableError(`could not read the ${asset} rate from pricing (${detail})`)
      }

      const rate = body.rate
      if (!rate || typeof rate !== 'object') {
        throw new RateUnavailableError('pricing returned no rate object')
      }

      // The flag, not the status code. See the header: unusable is served as a 200.
      if (rate.usable !== true) {
        const reason = typeof rate.reason === 'string' ? rate.reason : 'no reason given'
        throw new RateUnavailableError(`the ${asset} rate is not usable: ${reason}`)
      }

      // Checked, not assumed. If pricing ever republished at a different scale, applying our own
      // would misprice by that factor and nothing else in either service would notice.
      const publishedScale = parseScaled(rate.rateScale, 'rateScale')
      if (publishedScale !== RATE_SCALE) {
        throw new RateUnavailableError(
          `pricing publishes rates at a scale of ${publishedScale}, but this service computes at ${RATE_SCALE}`,
        )
      }

      const usdScaled = parseScaled(rate.usdScaled, 'usdScaled')
      if (usdScaled <= 0n) {
        throw new RateUnavailableError(`the ${asset} rate is ${usdScaled}, which cannot price anything`)
      }

      // Throws rather than returning 0n for a positive price — a free purchase is not an outcome
      // this path may reach. See contracts-chain.
      const amount = coinAmountForUsdCents(cents, chainSpec(asset).decimals, usdScaled)
      return { usdScaled, amount }
    },
  }
}
