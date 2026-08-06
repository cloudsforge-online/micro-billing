/**
 * Buying something, and giving it back.
 *
 * ---------------------------------------------------------------------------------------------
 * **One purchase posts exactly one ledger entry, and the same idempotency key twice returns one
 * entitlement.** Everything in this file exists to make both halves of that true at once, under
 * concurrency, across a retry, and across a process that dies halfway.
 *
 * There are two idempotency keys and they are not the same thing:
 *
 *   - the caller's key, claimed in `idempotency_keys` here, which makes the *purchase* happen once;
 *   - a key derived from it, sent to the ledger, which makes the *entry* post once.
 *
 * The second is derived rather than random precisely so that a purchase transaction that rolls
 * back after posting cannot post again on the retry: the ledger recognises the key and replays its
 * stored answer. Without it, a crash between the ledger's COMMIT and ours would charge the
 * customer twice and grant them nothing — which is the failure mode the estate has today, where
 * the shard debit and the entitlement insert are two writes with nothing joining them.
 *
 * **Why the HTTP call is inside the transaction.** It holds a database connection for the length
 * of a bounded remote call, which is a real cost and the reason `BILLING_LEDGER_DEADLINE_MS`
 * exists. The alternative — commit the purchase, post the entry from a job — grants the
 * entitlement before the money has moved, so a customer with no balance receives what they did
 * not pay for and the reversal is a customer-visible retraction. Between "hold a connection for
 * five seconds" and "give away the thing", this is not a close decision.
 * ---------------------------------------------------------------------------------------------
 */

import type { EntryMetadata, LedgerAssetCode } from '@cloudsforge/contracts-money'
import { WEI_PER_SPARK, type IssuableAssetCode } from '@cloudsforge/contracts-chain'
import type { PricingClient } from './pricingclient.ts'
import { expiryFor, resolveTarget, type ProductRecord, type PriceRecord } from './catalogue.ts'

/**
 * A charge in Sparks, for display, or null when it is not a whole number of them.
 *
 * A Spark is 10⁻⁶ EMBER — a display denomination of one asset, never a second asset code. The
 * distinction is not pedantry: the ledger's balancing invariant is enforced per asset code
 * (`ledger/src/migrations.ts`), so a second code for the same money would let its two
 * halves drift apart with nothing able to notice. Nothing in this service posts a Spark, and
 * `contracts-chain` greps its own source to keep the string out of the asset union entirely.
 *
 * Null rather than rounded. A settlement amount is whatever the rate produced and will usually
 * carry sub-Spark wei; printing a rounded figure would show a price that is not the price.
 */
export function sparksForDisplay(wei: bigint): string | null {
  return wei % WEI_PER_SPARK === 0n ? (wei / WEI_PER_SPARK).toString() : null
}
import {
  grantEntitlement,
  parseScope,
  parseSubject,
  revokeEntitlement,
  toWire,
  type EntitlementRecord,
} from './entitlements.ts'
import { withIdempotency, type IdempotentOutcome } from './idempotency.ts'
import { purchasePostings, type LedgerClient } from './ledger.ts'
import { openSubscription } from './subscriptions.ts'
import { withOutbox, type Db, type Emit, type Tx } from './outbox.ts'
import type { EntitlementScope } from '@cloudsforge/contracts-money'

export class PurchaseValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PurchaseValidationError'
  }
}

export class UnknownPurchaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnknownPurchaseError'
  }
}

/** A refund of something already refunded. Idempotent by returning, not by refunding twice. */
export class AlreadyRefundedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AlreadyRefundedError'
  }
}

export interface PurchaseDeps {
  readonly sql: Db
  readonly ledger: LedgerClient
  readonly producer: string
  /**
   * What the catalogue is priced in — `USD`, held as cents. Selects the price row; never posted.
   */
  readonly priceAsset: LedgerAssetCode
  /**
   * What the customer is actually charged in — `EMBER`. The only asset that reaches a posting.
   *
   * The two were one field (`assetCode`) while the price and the charge were the same Shard
   * amount. Separating them is the whole of this change: the price is durable in dollars and the
   * charge is settled in an asset a chain backs, so nothing this service posts can create a
   * balance the chain does not back.
   */
  readonly settlementAsset: IssuableAssetCode
  /** Reads the USD→EMBER rate. Fails the purchase rather than guessing — see `pricingclient.ts`. */
  readonly pricing: PricingClient
  /** Injected so a test can grant at a controlled instant and assert on an expiry. */
  readonly now?: () => Date
}

export interface PurchaseRequest {
  readonly subject: string
  readonly sku?: string
  readonly priceId?: string
  readonly quantity: bigint
  /** `platform`, `title:<id>` or `community:<id>`. Required when the product is scoped. */
  readonly scope?: string
  readonly idempotencyKey: string
  readonly correlationId: string
  readonly actor: string
  readonly metadata?: EntryMetadata
}

/** The JSON-safe response, stored verbatim in the idempotency claim and replayed to a retry. */
export interface PurchaseResponse {
  readonly purchase: {
    readonly id: string
    readonly subject: string
    readonly sku: string
    readonly scope: string
    readonly quantity: string
    /** The settlement asset — what was charged. `EMBER`. */
    readonly assetCode: string
    /** The charge, in the settlement asset's smallest units. Wei, for EMBER. */
    readonly amount: string
    /**
     * The same charge in Sparks, for display only.
     *
     * A Spark is 10⁻⁶ EMBER. It is a DISPLAY DENOMINATION and never an asset code — see
     * `contracts-chain`, which greps its own source to keep it that way. It is a string here for
     * the same reason `amount` is: a JSON number cannot hold wei.
     *
     * Null when the charge is not a whole number of Sparks. Rounding it for display would print a
     * price that is not the price; a client that wants a rounded figure can round it knowingly.
     */
    readonly amountSparks: string | null
    /** What the customer was quoted: `USD`, and cents. The durable figure. */
    readonly priceAssetCode: string
    readonly priceAmount: string
    /** The rate the conversion used, at `RATE_SCALE`. Null for a purchase made before migration 11. */
    readonly rateUsdScaled: string | null
    readonly journalEntryId: string
    readonly status: string
    readonly createdAt: string
  }
  readonly entitlement: Record<string, unknown>
  readonly subscriptionId: string | null
}

interface PurchaseRow {
  readonly id: string
  readonly subject: string
  readonly product_id: string
  readonly price_id: string
  readonly quantity: string
  readonly asset_code: string
  readonly amount: string
  readonly price_asset_code: string
  readonly price_amount: string
  readonly rate_usd_scaled: string | null
  readonly scope: string
  readonly journal_entry_id: string
  readonly status: string
  readonly refund_entry_id: string | null
  readonly created_at: Date
}

/**
 * The scope a grant of this product takes, refusing a mismatch rather than defaulting.
 *
 * A private world bought with no title is an entitlement no service can act on — it is the exact
 * shape of the defect that leaves a purchased world unprovisioned — so the absence is an error at
 * the point of sale rather than a `platform` scope quietly standing in for a title.
 */
export function scopeFor(product: ProductRecord, requested: string | undefined): EntitlementScope {
  if (product.scopeKind === 'platform') {
    if (requested !== undefined && requested !== 'platform') {
      throw new PurchaseValidationError(`${product.sku} is a platform product and takes no scope`)
    }
    return 'platform'
  }
  if (requested === undefined) {
    throw new PurchaseValidationError(
      `${product.sku} must be bought for a ${product.scopeKind}: pass scope="${product.scopeKind}:<id>"`,
    )
  }
  const scope = parseScope(requested)
  if (!scope.startsWith(`${product.scopeKind}:`)) {
    throw new PurchaseValidationError(
      `${product.sku} takes a ${product.scopeKind} scope, not ${scope}`,
    )
  }
  return scope
}

/**
 * The key the ledger sees.
 *
 * Derived from the caller's key and never randomly generated, so a retry of a purchase that
 * already posted is recognised by the ledger and replayed rather than posted a second time.
 */
export function ledgerKeyFor(clientKey: string): string {
  return `billing:purchase:${clientKey}`
}

export async function purchase(
  deps: PurchaseDeps,
  request: PurchaseRequest,
  requestHash: string,
): Promise<IdempotentOutcome<PurchaseResponse>> {
  if (request.quantity <= 0n) {
    throw new PurchaseValidationError('quantity must be a positive integer')
  }
  const subject = parseSubject(request.subject)
  const target = await resolveTarget(deps.sql, {
    ...(request.sku !== undefined ? { sku: request.sku } : {}),
    ...(request.priceId !== undefined ? { priceId: request.priceId } : {}),
    // The PRICE asset, not the settlement asset. The catalogue is denominated in USD; asking for
    // an EMBER price row would find nothing, because there is deliberately no EMBER price row.
    assetCode: deps.priceAsset,
  })
  const scope = scopeFor(target.product, request.scope)

  // The price, in the durable unit: US cents.
  const priceAmount = target.price.unitAmount * request.quantity

  // The charge, in the settled asset. Read OUTSIDE the idempotency claim and before the ledger
  // call, deliberately: it is a network read that can fail, and failing it here leaves nothing to
  // unwind. Inside `run` it would sit in the same transaction as the posting, holding a database
  // connection open across a second upstream.
  //
  // A failure here refuses the purchase. That is the fail-closed choice argued in
  // `pricingclient.ts`: you cannot charge somebody in a currency you cannot price, and the only
  // alternative to refusing is guessing how much of their money to take.
  const quote = await deps.pricing.quote(deps.settlementAsset, priceAmount)
  const amount = quote.amount

  // Belt and braces over `coinAmountForUsdCents`, which already refuses this. A positive price
  // that settles to nothing is a free purchase, and the entitlement is granted in the same
  // transaction as the posting — so a zero here would hand over the goods for a balanced entry
  // that moved no money. Migration 11 refuses the row as well (`purchases_no_free_lunch`).
  if (priceAmount > 0n && amount <= 0n) {
    throw new PurchaseValidationError(
      `a price of ${priceAmount} cents settled to ${amount} — refusing to charge nothing for something`,
    )
  }

  const now = deps.now?.() ?? new Date()

  return withIdempotency<PurchaseResponse>(deps.sql, {
    caller: deps.producer,
    route: 'POST /purchases',
    clientKey: request.idempotencyKey,
    requestHash,
    run: async (tx, storedKey) => {
      // The ledger call is inside the claim transaction. See the note at the top of this file: the
      // entitlement must not exist unless the money moved, and the derived key is what makes the
      // remote side of that safe to repeat.
      const entry = await deps.ledger.postEntry({
        kind: 'purchase',
        actor: request.actor,
        correlationId: request.correlationId,
        idempotencyKey: ledgerKeyFor(request.idempotencyKey),
        description: `${target.product.name} x${request.quantity}`,
        metadata: {
          sku: target.product.sku,
          scope,
          quantity: request.quantity.toString(),
          ...(request.metadata ?? {}),
        },
        postings: purchasePostings({ subject, assetCode: deps.settlementAsset, amount }),
      })

      const response = await recordPurchase(tx, {
        subject,
        product: target.product,
        price: target.price,
        quantity: request.quantity,
        assetCode: deps.settlementAsset,
        amount,
        priceAssetCode: deps.priceAsset,
        priceAmount,
        rateUsdScaled: quote.usdScaled,
        scope,
        journalEntryId: entry.id,
        idempotencyKey: storedKey,
        correlationId: request.correlationId,
        actor: request.actor,
        now,
        producer: deps.producer,
        // Spread rather than assigned: under `exactOptionalPropertyTypes` an absent field and a
        // field set to `undefined` are different types, and the distinction is the point — it is
        // what stops an optional value being silently written as null.
        ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
      })
      return { response, resourceId: response.purchase.id }
    },
  })
}

interface RecordInput {
  readonly subject: string
  readonly product: ProductRecord
  readonly price: PriceRecord
  readonly quantity: bigint
  readonly assetCode: LedgerAssetCode
  readonly amount: bigint
  readonly priceAssetCode: LedgerAssetCode
  readonly priceAmount: bigint
  readonly rateUsdScaled: bigint
  readonly scope: EntitlementScope
  readonly journalEntryId: string
  readonly idempotencyKey: string
  readonly correlationId: string
  readonly actor: string
  readonly now: Date
  readonly producer: string
  readonly metadata?: EntryMetadata
}

/**
 * Write the purchase, the subscription if there is one, and the entitlement — with its event.
 *
 * `withOutbox` cannot be used here because the enclosing transaction already exists; the events
 * are emitted through a collector that writes them to the outbox before this transaction commits,
 * which is the same guarantee by a different route. `emitInto` is that collector.
 */
async function recordPurchase(tx: Tx, input: RecordInput): Promise<PurchaseResponse> {
  const events: Parameters<Emit>[0][] = []
  const emit: Emit = (event) => events.push(event)

  const rows = await tx<PurchaseRow[]>`
    insert into purchases (
      subject, product_id, price_id, quantity, asset_code, amount,
      price_asset_code, price_amount, rate_usd_scaled, scope,
      journal_entry_id, idempotency_key, correlation_id, actor
    )
    values (
      ${input.subject}, ${input.product.id}, ${input.price.id}, ${input.quantity.toString()}::numeric,
      ${input.assetCode}, ${input.amount.toString()}::numeric,
      ${input.priceAssetCode}, ${input.priceAmount.toString()}::numeric,
      ${input.rateUsdScaled.toString()}::numeric, ${input.scope},
      ${input.journalEntryId}, ${input.idempotencyKey}, ${input.correlationId}, ${input.actor}
    )
    returning id, subject, product_id, price_id, quantity, asset_code, amount,
              price_asset_code, price_amount, rate_usd_scaled, scope,
              journal_entry_id, status, refund_entry_id, created_at
  `
  const purchaseRow = rows[0]
  if (!purchaseRow) throw new Error('insert returned no row')

  // A subscription product opens a subscription, and its entitlement expires with the period
  // rather than with the product's own `entitlement_days`: what was paid for is this period.
  const subscription =
    input.product.kind === 'subscription' && input.price.interval !== null
      ? await openSubscription(tx, {
          subject: input.subject,
          product: input.product,
          price: input.price,
          quantity: input.quantity,
          scope: input.scope,
          journalEntryId: input.journalEntryId,
          startsAt: input.now,
        })
      : null

  const expiresAt = subscription
    ? new Date(subscription.currentPeriodEnd)
    : expiryFor(input.product, input.now)

  const entitlement = await grantEntitlement(tx, emit, {
    subject: input.subject,
    productId: input.product.id,
    sku: input.product.sku,
    scope: input.scope,
    source: subscription ? 'subscription' : 'purchase',
    quantity: input.quantity,
    // The application's clock, not the database's — see the note on `GrantInput.grantedAt`. It is
    // also the instant the response reports `active` at, so the two cannot disagree.
    grantedAt: input.now,
    expiresAt,
    purchaseId: purchaseRow.id,
    subscriptionId: subscription?.id ?? null,
    journalEntryId: input.journalEntryId,
    metadata: { sku: input.product.sku },
    actor: input.actor,
    correlationId: input.correlationId,
  })

  await writeEvents(tx, input.producer, events)

  return {
    purchase: {
      id: purchaseRow.id,
      subject: purchaseRow.subject,
      sku: input.product.sku,
      scope: purchaseRow.scope,
      // Strings, because a JSON number is a double and a quantity or an amount that silently
      // changes value on the way out is the defect this estate is full of.
      quantity: BigInt(purchaseRow.quantity).toString(),
      assetCode: purchaseRow.asset_code,
      amount: BigInt(purchaseRow.amount).toString(),
      amountSparks: sparksForDisplay(BigInt(purchaseRow.amount)),
      priceAssetCode: purchaseRow.price_asset_code,
      priceAmount: BigInt(purchaseRow.price_amount).toString(),
      // `?? null`, never `?? '0'`. A missing rate means "this purchase predates the conversion",
      // and a zero would assert something false about the arithmetic that produced the charge.
      rateUsdScaled:
        purchaseRow.rate_usd_scaled === null ? null : BigInt(purchaseRow.rate_usd_scaled).toString(),
      journalEntryId: purchaseRow.journal_entry_id,
      status: purchaseRow.status,
      createdAt: purchaseRow.created_at.toISOString(),
    },
    entitlement: toWire(entitlement, input.now.toISOString()),
    subscriptionId: subscription?.id ?? null,
  }
}

/**
 * Write collected events to the outbox inside the caller's transaction.
 *
 * The same insert `withOutbox` performs. It exists separately because the purchase path composes
 * an idempotency claim, a ledger call and several writes into one transaction that `withOutbox`
 * does not own — and rule 5 is about the events committing WITH the change, not about which
 * helper opened the transaction.
 */
export async function writeEvents(
  tx: Tx,
  producer: string,
  events: readonly Parameters<Emit>[0][],
): Promise<void> {
  for (const event of events) {
    await tx`
      insert into outbox (topic, key, producer, version, actor, correlation_id, payload)
      values (
        ${event.topic}, ${event.key}, ${producer}, ${event.version ?? 1},
        ${event.actor ?? null}, ${event.correlationId ?? null},
        ${tx.json(event.payload as Record<string, never>)}
      )
    `
  }
}

/* ------------------------------------------------------------------------ refunds */

export interface RefundInput {
  readonly entitlementId: string
  readonly reason: string
  readonly actor: string
  readonly correlationId: string
  /** When false, the grant is revoked and no money moves — an operator taking something back. */
  readonly refund: boolean
}

export interface RefundResult {
  readonly entitlement: Record<string, unknown>
  /** The reversing entry, when money moved back. Null when nothing was refunded. */
  readonly reversalEntryId: string | null
  readonly alreadyRevoked: boolean
}

/**
 * Revoke a grant and, when it is a refund, reverse the entry that paid for it.
 *
 * **Order matters and is deliberate: the ledger first, then the revocation.** If the reversal
 * fails, the transaction rolls back and the customer keeps what they paid for — which is the
 * correct way round to fail. Revoking first and then failing to refund takes the thing away and
 * keeps the money.
 *
 * The reversal is a NEW entry with its own idempotency key, derived from the entitlement id so a
 * retried refund reverses once. `reverseEntry` in contracts-money is what the ledger uses to build
 * it: postings flipped, `reversesEntryId` set, the original untouched. A correction is never an
 * edit.
 */
export async function refund(deps: PurchaseDeps, input: RefundInput): Promise<RefundResult> {
  const now = deps.now?.() ?? new Date()

  const outcome = await deps.sql.begin(async (tx) => {
    const rows = await tx<
      Array<{ id: string; journal_entry_id: string | null; purchase_id: string | null; revoked_at: Date | null }>
    >`
      select id, journal_entry_id, purchase_id, revoked_at
        from entitlements
       where id = ${input.entitlementId}
       for update
    `
    const row = rows[0]
    if (!row) throw new UnknownPurchaseError(`no entitlement ${input.entitlementId}`)

    let reversalEntryId: string | null = null
    if (input.refund && row.revoked_at === null) {
      if (!row.journal_entry_id) {
        // A grant with no entry behind it was never paid for — a reward or an operator grant. It
        // can be revoked, but there is nothing to refund, and inventing a reversal would credit
        // money that was never taken.
        throw new PurchaseValidationError(
          'this entitlement was not paid for, so there is nothing to refund; revoke it instead',
        )
      }
      if (row.purchase_id) {
        const already = await tx<Array<{ status: string }>>`
          select status from purchases where id = ${row.purchase_id} for update
        `
        if (already[0]?.status === 'refunded') throw new AlreadyRefundedError('already refunded')
      }

      const reversal = await deps.ledger.reverseEntry(row.journal_entry_id, {
        actor: input.actor,
        correlationId: input.correlationId,
        idempotencyKey: `billing:refund:${input.entitlementId}`,
        description: `Refund: ${input.reason}`,
      })
      reversalEntryId = reversal.id

      if (row.purchase_id) {
        await tx`
          update purchases
             set status = 'refunded', refund_entry_id = ${reversalEntryId}, refunded_at = ${now.toISOString()}::timestamptz
           where id = ${row.purchase_id}
        `
      }
    }

    const events: Parameters<Emit>[0][] = []
    const revoked = await revokeEntitlement(tx, (event) => events.push(event), {
      id: input.entitlementId,
      reason: input.reason,
      actor: input.actor,
      correlationId: input.correlationId,
      at: now,
    })
    await writeEvents(tx, deps.producer, events)

    return {
      value: {
        entitlement: toWire(revoked.entitlement, now.toISOString()),
        reversalEntryId,
        alreadyRevoked: revoked.alreadyRevoked,
      } satisfies RefundResult,
    }
  })

  return outcome.value
}

/** What a subject has bought. Reads only; the money it moved lives in the ledger. */
export async function listPurchases(sql: Db, subject: string, limit: number): Promise<PurchaseRow[]> {
  return sql<PurchaseRow[]>`
    select id, subject, product_id, price_id, quantity, asset_code, amount, scope,
           journal_entry_id, status, refund_entry_id, created_at
      from purchases
     where subject = ${subject}
     order by created_at desc
     limit ${limit}
  `
}

/** Re-exported so the composition root has one import for the purchase path. */
export { withOutbox }
export type { EntitlementRecord }
