/**
 * micro-admin-api's fee-recycle percentage, as this service reads it — docs/ecosystem/21 §3.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **BILLING DOES NOT OWN THIS NUMBER AND DELIBERATELY KEEPS NO COPY OF IT.**
 *
 * 21 §4 puts every engagement cap in admin-api "because it already owns cross-service operator
 * state", and §6 makes the percentage an approval-gated action: raising it takes two operators
 * and a fresh approved `engagement.policy.set` (`engagement_raise_needs_approval`,
 * admin-api/src/migrations.ts version 8); lowering it takes one. A second copy of the rate in
 * this repository would be a second thing to raise, and the raise is the whole point of the gate.
 *
 * So the rate is read per run and recorded on the period row that applied it. There is one
 * authority, and the row says which answer it got.
 *
 * **FAIL CLOSED**, the same way `micro-foresight`'s seed gate does (foresight/src/adminapiclient.ts):
 *
 *   * Admin-api unreachable, or answering 4xx at this service — no rate was read, and an unread
 *     rate is not a permissive one. Nothing recycles. It costs nothing to wait: the period is
 *     still there next run, and its takings have not moved.
 *   * `ADMIN_API_URL` unset — recycling is off for this deployment. Unconfigured is a supported
 *     mode (the notify-SMTP discipline), and its meaning here is exactly true: this deployment
 *     runs no engagement programme. The client is not constructed at all.
 *
 * ── THE CEILING IS CHECKED AGAINST OURS, AND A MISMATCH STOPS THE RECYCLE ──────────────────────
 *
 * `GET /v1/engagement/policies` publishes `ceilings.feeRecycleBps` alongside the rate
 * (admin-api/src/server.ts). `FEE_RECYCLE_CEILING_BPS` below is billing's copy of the
 * same number, and it is also a CHECK constraint in migration 10 — so the schema refuses a rate
 * above it whatever this file does.
 *
 * Comparing the two published numbers turns a silent divergence into a reported one. If somebody
 * raises admin-api's ceiling without raising billing's, the constraint would refuse the first row
 * at the higher rate with an errcode; this refuses it first, with a sentence naming both numbers.
 * The direction is never reversed: a rate ABOVE our ceiling is refused no matter what admin-api
 * says its ceiling is, because the constraint is the enforcement of record and this file's job is
 * only to reach it with a better message.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Route, verified against the other side
 *
 * `GET /v1/engagement/policies` — `admin-api/src/server.ts`, guarded by `requireReader`
 * (`admin-api/src/server.ts`): a SERVICE token must hold the exact scope `admin:read`.
 * Admin-api matches scopes exactly, so `admin:*` will not do. The body carries `policies`,
 * `feeRecycle` (`{ recycleBps, lastChangeApprovalId, updatedAt, updatedBy }`) and `ceilings`.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { LiveScope } from '@cloudsforge/contracts-auth'

/**
 * The scope billing's admin-api token must hold. Exact-matched on the other side.
 *
 * `readonly LiveScope[]`, not `readonly string[]`. This constant is an OUTBOUND demand — what
 * billing presents to admin-api — and that direction had never been checked by anything.
 * `service-ci.yml`'s scope audit reads a repository's INBOUND route gates, which is why two
 * services in this estate declared scopes that do not exist (`policy:evaluate`,
 * `custody:address`) and nothing noticed. `micro-deploy`'s `derive-grants.mjs` reads this
 * constant into `IDENTITY_SERVICE_TOKEN_GRANTS`, and identity validates that list against the
 * registry at import and REFUSES TO BOOT on a name it does not know — so a typo here is not a 403
 * on one billing call, it is no token minting for the whole estate.
 *
 * `LiveScope` rather than `Scope` because `Scope` is `keyof typeof SCOPES` — every registered key,
 * DEPRECATED ones included — and identity will not mint a deprecated scope either. `LiveScope =
 * Exclude<Scope, DeprecatedScope>`, with `DeprecatedScope` computed FROM `SCOPES` by a conditional
 * type over the `deprecated` field rather than hand-listed, so it cannot drift from the registry
 * (`contracts/packages/auth/src/index.ts`). Reading a token stays wide — one may arrive
 * carrying a scope that has since died — and demanding is narrow. This is demanding.
 */
export const ADMIN_API_SCOPES: readonly LiveScope[] = Object.freeze(['admin:read'])

/**
 * 2500 bps = 25%. Billing's copy of `engagement_fee_recycle_within_ceiling`
 * (admin-api/src/migrations.ts) and of `FEE_RECYCLE_CEILING_BPS`
 * (admin-api/src/engagement.ts). It is a CHECK in migration 10 as well, and
 * `recycle.test.ts` proves this constant against that constraint by writing ceiling-plus-one
 * through a raw connection and watching the database refuse it.
 */
export const FEE_RECYCLE_CEILING_BPS = 2_500

/** The rate could not be read, or could not be trusted. Never a default, never a zero. */
export class FeeRecycleUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeeRecycleUnavailableError'
  }
}

export interface FeeRecycleRate {
  /** Basis points of platform fee revenue to move into the treasury. 0 is a real answer. */
  readonly recycleBps: number
  /** The ceiling admin-api published with it, already checked against ours. */
  readonly ceilingBps: number
}

export interface EngagementPolicyClient {
  /** Throws `FeeRecycleUnavailableError` rather than returning a rate nobody stands behind. */
  feeRecycleRate(correlationId: string): Promise<FeeRecycleRate>
}

export interface AdminApiClientOptions {
  readonly baseUrl: string
  /** Async, so a short-lived service token can be refreshed without rebuilding the client. */
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
}

interface PoliciesBody {
  readonly feeRecycle?: { readonly recycleBps?: unknown } | null
  readonly ceilings?: { readonly feeRecycleBps?: unknown } | null
}

/** A whole number in 0..max, or null. `Number('')` is 0, so the type is checked before the range. */
function wholeBps(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

export function httpAdminApiClient(options: AdminApiClientOptions): EngagementPolicyClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'admin-api',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async feeRecycleRate(correlationId) {
      let body: PoliciesBody
      try {
        body = await client.request<PoliciesBody>('/v1/engagement/policies', {
          method: 'GET',
          requestId: correlationId,
        })
      } catch (err) {
        // A 4xx is admin-api refusing THIS SERVICE — a scope or deployment fault, not an
        // operator's answer about the rate. Either way no rate was read.
        const detail =
          err instanceof HttpError
            ? `admin-api answered ${err.status}`
            : 'admin-api could not be reached'
        throw new FeeRecycleUnavailableError(detail)
      }
      return readRate(body)
    },
  }
}

/**
 * Parse and check one policies body. Exported so a test can drive every refusal without a server.
 *
 * A body missing `feeRecycle` entirely is refused rather than read as 0. Zero is the recorded
 * starting rate and therefore an extremely plausible-looking answer — which is exactly why it
 * must never be the thing an unparseable response degrades into. A recycle of 0 and a recycle
 * that could not be read look identical in the ledger and mean opposite things about whether
 * this pipeline works.
 */
export function readRate(body: PoliciesBody): FeeRecycleRate {
  const recycleBps = wholeBps(body.feeRecycle?.recycleBps)
  if (recycleBps === null) {
    throw new FeeRecycleUnavailableError(
      'admin-api did not answer a whole-number feeRecycle.recycleBps — an unreadable rate is not zero',
    )
  }
  const ceilingBps = wholeBps(body.ceilings?.feeRecycleBps)
  if (ceilingBps === null) {
    throw new FeeRecycleUnavailableError(
      'admin-api did not publish ceilings.feeRecycleBps — the two ceilings cannot be compared',
    )
  }
  if (ceilingBps !== FEE_RECYCLE_CEILING_BPS) {
    // The two schemas have diverged. Refusing is the only safe direction: if theirs is higher
    // this repository's CHECK would refuse the write anyway and this says why in a sentence; if
    // theirs is lower, applying our own higher bound would recycle past what the operator
    // surface believes it permits.
    throw new FeeRecycleUnavailableError(
      `admin-api publishes a fee-recycle ceiling of ${ceilingBps} bps and billing's schema ` +
        `enforces ${FEE_RECYCLE_CEILING_BPS} — the two must be the same number ` +
        '(admin-api migration 8, billing migration 10); nothing recycles until they are',
    )
  }
  if (recycleBps > FEE_RECYCLE_CEILING_BPS) {
    throw new FeeRecycleUnavailableError(
      `admin-api answered a recycle rate of ${recycleBps} bps, above the ${FEE_RECYCLE_CEILING_BPS} ` +
        'bps ceiling both schemas enforce',
    )
  }
  return { recycleBps, ceilingBps }
}
