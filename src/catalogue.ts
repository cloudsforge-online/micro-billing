/**
 * Products and prices.
 *
 * What this replaces: the estate's catalogue is four frozen arrays in a shared package —
 * `COSMETICS`, `CONVENIENCE_ITEMS`, `SEASON_PASS`, `PRIVATE_WORLD_OFFERS` in
 * `repos/forge-pay/services/pay/src/routes/monetization.ts` — with one hand-written buy route
 * each. Three consequences, all of them live:
 *
 *   1. **A price change is a deploy.** Of every service that imports the package.
 *   2. **Each route re-derives what a purchase means.** Four `grant(...)` calls with slightly
 *      different arguments, one of which (`private-worlds/rent`) passes `ownOnce: false` and gets
 *      a different code path for it.
 *   3. **A season pass has no notion of a season.** `SEASON_PASS.id` is a constant, so selling
 *      season two means editing the constant and hoping nobody had season one.
 *
 * Here a product is a row, a price is a row, and `entitlement_days` and `scope_kind` are data
 * rather than an argument somebody remembered to pass.
 */

import type { BillingInterval, LedgerAssetCode, ProductKind } from '@cloudsforge/contracts-money'
import type { Db } from './outbox.ts'

/** How a grant of this product is scoped. `title` and `community` require an id at purchase. */
export type ScopeKind = 'platform' | 'title' | 'community'

export interface ProductRecord {
  readonly id: string
  readonly sku: string
  readonly name: string
  readonly kind: ProductKind
  readonly status: 'draft' | 'active' | 'retired'
  readonly scopeKind: ScopeKind
  /** Null is perpetual. Present is what lets a season pass end. */
  readonly entitlementDays: number | null
  readonly metadata: Record<string, unknown>
}

export interface PriceRecord {
  readonly id: string
  readonly productId: string
  readonly assetCode: LedgerAssetCode
  /** Smallest units. A price is never a float, in any currency. */
  readonly unitAmount: bigint
  readonly interval: BillingInterval | null
  readonly intervalCount: number
  readonly status: 'active' | 'retired'
}

export interface CatalogueEntry {
  readonly product: ProductRecord
  readonly prices: readonly PriceRecord[]
}

/** A product does not exist, or is not on sale. */
export class UnknownProductError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnknownProductError'
  }
}

interface ProductRow {
  readonly id: string
  readonly sku: string
  readonly name: string
  readonly kind: string
  readonly status: string
  readonly scope_kind: string
  readonly entitlement_days: number | null
  readonly metadata: Record<string, unknown>
}

interface PriceRow {
  readonly id: string
  readonly product_id: string
  readonly asset_code: string
  readonly unit_amount: string
  readonly interval: string | null
  readonly interval_count: number
  readonly status: string
}

const toProduct = (row: ProductRow): ProductRecord => ({
  id: row.id,
  sku: row.sku,
  name: row.name,
  kind: row.kind as ProductKind,
  status: row.status as ProductRecord['status'],
  scopeKind: row.scope_kind as ScopeKind,
  entitlementDays: row.entitlement_days,
  metadata: row.metadata,
})

const toPrice = (row: PriceRow): PriceRecord => ({
  id: row.id,
  productId: row.product_id,
  assetCode: row.asset_code as LedgerAssetCode,
  // `numeric` comes back as a string, deliberately: it is wider than a JS number and the driver
  // refuses to lose the difference. BigInt reads it exactly.
  unitAmount: BigInt(row.unit_amount),
  interval: row.interval as BillingInterval | null,
  intervalCount: row.interval_count,
  status: row.status as PriceRecord['status'],
})

/**
 * The catalogue as a client sees it: active products with their active prices.
 *
 * A retired product is omitted rather than flagged. A client rendering a shop should not have to
 * know the difference, and an entitlement already granted for a retired product is unaffected —
 * retiring stops sales, it does not revoke.
 */
export async function listCatalogue(sql: Db): Promise<CatalogueEntry[]> {
  const products = await sql<ProductRow[]>`
    select id, sku, name, kind, status, scope_kind, entitlement_days, metadata
      from products
     where status = 'active'
     order by sku
  `
  const prices = await sql<PriceRow[]>`
    select id, product_id, asset_code, unit_amount, interval, interval_count, status
      from prices
     where status = 'active'
     order by asset_code
  `
  const byProduct = new Map<string, PriceRecord[]>()
  for (const row of prices) {
    const price = toPrice(row)
    const existing = byProduct.get(price.productId)
    if (existing) existing.push(price)
    else byProduct.set(price.productId, [price])
  }
  return products.map((row) => ({
    product: toProduct(row),
    prices: byProduct.get(row.id) ?? [],
  }))
}

export interface ResolvedPurchaseTarget {
  readonly product: ProductRecord
  readonly price: PriceRecord
}

/**
 * Resolve what is being bought, by SKU or by price id.
 *
 * By SKU is what a client sends; by price id is what a renewal sends, because a subscription must
 * charge the price it was created at even if a newer one has since replaced it. Resolving a
 * renewal through the SKU would silently reprice every subscriber the moment a price changed.
 */
export async function resolveTarget(
  sql: Db,
  input: { readonly sku?: string; readonly priceId?: string; readonly assetCode: LedgerAssetCode },
): Promise<ResolvedPurchaseTarget> {
  if (input.priceId) {
    // Two queries rather than a join, deliberately: a join of two tables that both have `id`,
    // `status` and `metadata` needs aliases on nearly every column, and an alias that drifts from
    // its row type is a silent mis-mapping rather than a compile error.
    const priceRows = await sql<PriceRow[]>`
      select id, product_id, asset_code, unit_amount, interval, interval_count, status
        from prices
       where id = ${input.priceId}
    `
    const priceRow = priceRows[0]
    if (!priceRow) throw new UnknownProductError(`no price ${input.priceId}`)

    const productRows = await sql<ProductRow[]>`
      select id, sku, name, kind, status, scope_kind, entitlement_days, metadata
        from products
       where id = ${priceRow.product_id}
    `
    const productRow = productRows[0]
    if (!productRow) throw new UnknownProductError(`price ${input.priceId} has no product`)
    return { product: toProduct(productRow), price: toPrice(priceRow) }
  }

  if (!input.sku) throw new UnknownProductError('a purchase must name a sku or a priceId')

  const products = await sql<ProductRow[]>`
    select id, sku, name, kind, status, scope_kind, entitlement_days, metadata
      from products
     where sku = ${input.sku}
  `
  const productRow = products[0]
  if (!productRow) throw new UnknownProductError(`no product with sku ${input.sku}`)
  const product = toProduct(productRow)
  if (product.status !== 'active') {
    // Refused rather than sold quietly: a retired product that can still be bought is a product
    // nobody can actually withdraw from sale.
    throw new UnknownProductError(`${product.sku} is ${product.status} and is not on sale`)
  }

  const prices = await sql<PriceRow[]>`
    select id, product_id, asset_code, unit_amount, interval, interval_count, status
      from prices
     where product_id = ${product.id} and asset_code = ${input.assetCode} and status = 'active'
  `
  const price = prices[0]
  if (!price) {
    throw new UnknownProductError(`${product.sku} has no active ${input.assetCode} price`)
  }
  return { product, price: toPrice(price) }
}

/**
 * When a grant of this product ends, given when it starts.
 *
 * Null is perpetual. Expressed in days rather than as an absolute date on the product, because a
 * season pass bought on the last day of the season must still last its full ninety days — dating
 * the product rather than the grant is how a customer pays full price for an hour of access.
 */
export function expiryFor(product: ProductRecord, from: Date): Date | null {
  if (product.entitlementDays === null) return null
  return new Date(from.getTime() + product.entitlementDays * 24 * 60 * 60 * 1000)
}

/** Advance a period by a price's interval. Used by the renewal job. */
export function nextPeriodEnd(price: PriceRecord, from: Date): Date {
  const count = price.intervalCount
  const next = new Date(from.getTime())
  switch (price.interval) {
    case 'day':
      next.setUTCDate(next.getUTCDate() + count)
      return next
    case 'week':
      next.setUTCDate(next.getUTCDate() + 7 * count)
      return next
    case 'month':
      // Calendar months, not thirty days: a monthly subscription bought on the 3rd renews on the
      // 3rd. `setUTCMonth` clamps 31 January + 1 month to 28 February, which is the behaviour a
      // subscriber expects and the one every billing system converges on.
      next.setUTCMonth(next.getUTCMonth() + count)
      return next
    case 'year':
      next.setUTCFullYear(next.getUTCFullYear() + count)
      return next
    case null:
      throw new RangeError('a one-off price has no next period')
  }
}
