/**
 * The ledger, over HTTP.
 *
 * **Billing holds no balance.** Every movement of value a purchase, a subscription charge or a
 * refund causes is a balanced journal entry posted to the ledger through this client, with an
 * idempotency key. Nothing in this repository decrements a column.
 *
 * That is the whole difference from what is being superseded. `repos/forge-pay` records a sale and
 * decrements `wallets.shards` in the same service, in the same transaction, against a running
 * column that IS the truth — so nothing can check that the sale and the money agree, and a coin
 * deposit writes no ledger row at all. Here the money is somebody else's job, the entry is
 * double-entry and balanced by a deferred constraint trigger, and the purchase row carries the
 * entry id that paid for it.
 *
 * Two things this file is careful about:
 *
 *   1. **Amounts cross the wire as strings.** A JSON number is an IEEE 754 double and the ledger
 *      refuses one that is not already a safe integer. Sending `amount.toString()` means the value
 *      the ledger stores is exactly the value computed here.
 *   2. **A 4xx from the ledger is the ledger deciding.** Insufficient funds is not a fault to
 *      retry, it is an answer — and it must reach the user as "you cannot afford this", not as a
 *      500. `@cloudsforge/http` already declines to retry a peer-decided status; this file maps it
 *      onto a domain error so the route does not have to know what a status code is.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { AccountPurpose, AccountType, EntryKind, EntryMetadata, LedgerAssetCode } from '@cloudsforge/contracts-money'

/** The account an entry names, in the shape the ledger's `POST /entries` accepts. */
export interface LedgerAccount {
  readonly subject: string
  readonly assetCode: LedgerAssetCode
  readonly purpose: AccountPurpose
  readonly type: AccountType
}

export interface LedgerPosting {
  readonly account: LedgerAccount
  readonly direction: 'debit' | 'credit'
  readonly amount: bigint
  readonly assetCode: LedgerAssetCode
  readonly sequence: number
}

export interface PostEntryRequest {
  readonly kind: EntryKind
  readonly actor: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
  readonly metadata?: EntryMetadata
  readonly postings: readonly LedgerPosting[]
}

export interface ReverseEntryRequest {
  readonly actor: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
  readonly metadata?: EntryMetadata
}

export interface PostedEntry {
  readonly id: string
  /** True when the ledger answered from a stored idempotent response rather than by posting. */
  readonly replayed: boolean
}

/** The port the domain sees. An interface, so a test needs no running ledger. */
export interface LedgerClient {
  postEntry(request: PostEntryRequest): Promise<PostedEntry>
  reverseEntry(entryId: string, request: ReverseEntryRequest): Promise<PostedEntry>
}

/** The subject could not pay. A decision, not a fault: 402 to the caller, never a retry. */
export class InsufficientFundsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InsufficientFundsError'
  }
}

/** The ledger refused the entry for a reason that will not change on a retry. */
export class LedgerRejectedError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'LedgerRejectedError'
    this.status = status
    this.code = code
  }
}

/**
 * The ledger is unreachable or answered 5xx.
 *
 * Distinct from a rejection because the correct response is different: **we do not know whether
 * the entry posted.** The purchase transaction rolls back, so no entitlement is granted, and the
 * caller's retry carries the same idempotency key — which is what makes the unknown safe.
 */
export class LedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerUnavailableError'
  }
}

export interface LedgerClientOptions {
  readonly baseUrl: string
  /** Async, so a ten-minute service token can be refreshed without rebuilding the client. */
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly originatingService: string
  readonly fetch?: typeof globalThis.fetch
}

interface EntryResponse {
  readonly entry?: { readonly id?: string }
  readonly replayed?: boolean
}

interface LedgerErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string }
}

export function httpLedgerClient(options: LedgerClientOptions): LedgerClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'ledger',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  const post = async (path: string, body: unknown, idempotencyKey: string): Promise<PostedEntry> => {
    let response: EntryResponse
    try {
      response = await client.post<EntryResponse>(path, body, {
        // The key is what makes this POST retriable at all. Without it `@cloudsforge/http`
        // attempts a non-idempotent method exactly once, deliberately — retrying a POST that
        // debits a wallet is how a user gets charged twice.
        idempotencyKey,
        deadlineMs: options.deadlineMs,
      })
    } catch (err) {
      throw translate(err)
    }
    const id = response.entry?.id
    if (typeof id !== 'string' || id.length === 0) {
      throw new LedgerUnavailableError('the ledger accepted the entry but returned no entry id')
    }
    return { id, replayed: response.replayed === true }
  }

  return {
    postEntry: (request) =>
      post(
        '/entries',
        {
          kind: request.kind,
          originatingService: options.originatingService,
          actor: request.actor,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
          ...(request.description !== undefined ? { description: request.description } : {}),
          ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
          postings: request.postings.map((posting) => ({
            account: posting.account,
            direction: posting.direction,
            // A string, always. The ledger accepts a JSON number only when it is already a safe
            // integer, and an amount that lost precision before it was serialised is not the
            // amount anybody intended.
            amount: posting.amount.toString(),
            assetCode: posting.assetCode,
            sequence: posting.sequence,
          })),
        },
        request.idempotencyKey,
      ),

    reverseEntry: (entryId, request) =>
      post(
        `/entries/${encodeURIComponent(entryId)}/reverse`,
        {
          originatingService: options.originatingService,
          actor: request.actor,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
          ...(request.description !== undefined ? { description: request.description } : {}),
          ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
        },
        request.idempotencyKey,
      ),
  }
}

/**
 * Map a transport failure onto a domain error.
 *
 * The distinction that matters is "the ledger decided" against "we do not know". Only the second
 * is worth retrying, and only the first should ever reach a user as an explanation.
 */
export function translate(err: unknown): Error {
  if (err instanceof HttpError) {
    const body = parseBody(err.body)
    const code = body.error?.code ?? 'ledger_error'
    const message = body.error?.message ?? err.message
    if (err.peerDecided) {
      if (code === 'insufficient_funds') return new InsufficientFundsError(message)
      return new LedgerRejectedError(err.status, code, message)
    }
    return new LedgerUnavailableError(message)
  }
  return new LedgerUnavailableError(err instanceof Error ? err.message : String(err))
}

function parseBody(text: string): LedgerErrorBody {
  try {
    return JSON.parse(text) as LedgerErrorBody
  } catch {
    return {}
  }
}

/* ------------------------------------------------------------------------ posting shapes */

/**
 * What a purchase looks like as double entry: the subject's spendable liability falls, platform
 * revenue rises.
 *
 * Both sides are named rather than one, because that is the point of a journal: the estate's
 * single-sided `ledger.delta` column can express "the user lost 500" and cannot express where it
 * went, so per-product revenue is not derivable from it at all.
 *
 * Directions follow `normalBalance` in contracts-money: a liability is credit-normal, so debiting
 * the user's available account reduces what we owe them; revenue is credit-normal, so crediting
 * platform fees increases it. The entry balances because it is the same number.
 */
/**
 * What the fee recycle looks like as double entry — docs/ecosystem/21 §3.
 *
 * Platform fee revenue **out**, the engagement treasury **in**. Both accounts are the platform's
 * own, so nothing here touches a user, and the entry is the ordinary `transfer` kind — the same
 * one `micro-admin-api` posts for `engagement.transfer` (admin-api/src/actions.ts), because
 * moving the platform's money between two of the platform's own accounts is what both are.
 *
 * ── THE ACCOUNT TYPES ARE NOT A CHOICE, AND ONE OF THEM HAS ALREADY BITTEN THE ESTATE ──────────
 *
 * The ledger keys an account on `(subject, asset_code, purpose)` and REFUSES an entry that names
 * an existing account with a different `type` (`ledger/src/accounts.ts`, `AccountConflictError`
 * — "a wrong balance that still balances"). So both spellings below are copied from the services
 * that already write these two accounts, not chosen:
 *
 *   * `(platform, EMBER, fees)` is **revenue**, exactly as `purchasePostings` below already
 *     credits it, and as `micro-market` (market/src/ledgerclient.ts), `micro-trade`
 *     (trade/src/ledgerclient.ts), `micro-wallet` and `micro-mint` all spell it. Debiting a
 *     credit-normal account reduces it, which is what recycling revenue IS.
 *   * `(platform:engagement-treasury, EMBER, treasury)` is **equity**, exactly as admin-api's
 *     `engagement.transfer` debits it (admin-api/src/actions.ts) and as
 *     `engagementAccount` in contracts-money spells the per-service accounts below it. Equity is
 *     NOT overdraft-exempt, which is the property that makes an unfunded treasury refuse a grant
 *     rather than go negative.
 *
 * ── THE ASSET IS EMBER, AND THIS PARAGRAPH SAID SHARD UNTIL 2026-08-10 ─────────────────────────
 *
 * Both triples above are written with the asset spelled out because the ledger's account key
 * INCLUDES it, so getting it wrong here does not mislabel an account — it names a different one.
 * The code was always right: the asset is `input.assetCode`, and the only caller (src/index.ts,
 * the job deps) passes `env.settlementAsset`, which is `'EMBER'` typed `IssuableAssetCode`, i.e.
 * `Exclude<AssetCode, 'SHARD'>`. Restoring the retired spelling there does not compile. Only the
 * prose named a retired asset, and it named it in the one position where a reader would take it
 * as the account's identity rather than an example.
 *
 * It is corrected now rather than earlier because until today the other end of
 * `platform:engagement-treasury` disagreed with this one. `micro-admin-api`'s `engagement.transfer`
 * posted both its legs `assetCode: 'SHARD'`; its migration 13 (`engagement-in-ember-wei`,
 * micro-org#226, merged 2026-08-10) renamed `transfer_cap_shards`/`amount_shards` to
 * `transfer_cap_wei`/`amount_wei`, converted them at 1 Shard = 4e16 wei, and now posts
 * `ENGAGEMENT_ASSET: IssuableAssetCode = 'EMBER'`. So the two services fund and spend one account
 * in one asset, and 21 §4's "an auditor reconstructs the entire programme from the ledger alone"
 * is reconstructible in a single unit. Nothing had to be unwound: measured on live mainnet
 * 2026-08-10, no ledger account whose subject matches `engagement` exists in any asset, and the
 * only `platform*` accounts are `(platform, EMBER, treasury)` and `(platform, EMBER, payout_due)`.
 *
 * SHARD itself is retired but not extinct — 26,000 Shards across 14 accounts on mainnet, measured
 * the same day — which is why `micro-ledger` still permits it on `transfer` and why a recycle that
 * named it would have POSTED rather than raised. That is the trap, and the type is what closes it.
 *
 * The revenue side is not overdraft-exempt either (`ledger_assert_no_overdraft` exempts only
 * `clearing`, `suspense` and an explicit `overdraft_allowed`), and that is a feature here: a
 * recycle larger than the fee revenue the platform actually holds is refused by the ledger rather
 * than conjured. The engagement programme cannot spend revenue that has not been earned.
 */
export function feeRecyclePostings(input: {
  readonly assetCode: LedgerAssetCode
  readonly amount: bigint
}): readonly LedgerPosting[] {
  return [
    {
      account: {
        subject: 'platform',
        assetCode: input.assetCode,
        purpose: 'fees',
        type: 'revenue',
      },
      direction: 'debit',
      amount: input.amount,
      assetCode: input.assetCode,
      sequence: 0,
    },
    {
      account: {
        // 21 §4's tree, spelled as `contracts/packages/money`'s `ENGAGEMENT_TREASURY` spells it.
        subject: 'platform:engagement-treasury',
        assetCode: input.assetCode,
        purpose: 'treasury',
        type: 'equity',
      },
      direction: 'credit',
      amount: input.amount,
      assetCode: input.assetCode,
      sequence: 1,
    },
  ]
}

export function purchasePostings(input: {
  readonly subject: string
  readonly assetCode: LedgerAssetCode
  readonly amount: bigint
}): readonly LedgerPosting[] {
  return [
    {
      account: {
        subject: input.subject,
        assetCode: input.assetCode,
        purpose: 'available',
        type: 'liability',
      },
      direction: 'debit',
      amount: input.amount,
      assetCode: input.assetCode,
      sequence: 0,
    },
    {
      account: {
        subject: 'platform',
        assetCode: input.assetCode,
        purpose: 'fees',
        type: 'revenue',
      },
      direction: 'credit',
      amount: input.amount,
      assetCode: input.assetCode,
      sequence: 1,
    },
  ]
}
