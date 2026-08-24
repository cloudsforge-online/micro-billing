/**
 * The HTTP surface.
 *
 * Plain `node:http`, following the service template. The parts that matter — request ids, RED
 * metrics, the child logger, the error shape, the auth-fault mapping — are framework-independent.
 *
 * ---------------------------------------------------------------------------------------------
 * **`GET /internal/entitlements/:userId` is the fourth defect, fixed.**
 *
 * The estate's entitlements route is `preHandler: requireAuth`
 * (`repos/forge-pay/services/pay/src/routes/monetization.ts`) and there is no other. A user's
 * browser can ask what they own; **nothing else in the estate can**. A world server holding a
 * purchase event has no way to confirm the buyer still owns the world, a game service cannot check
 * a season pass, and a refund cannot be enforced by anything downstream. That is a direct cause of
 * the headline defect in 04-domain-model.md §8.1: a purchased private world is never provisioned.
 *
 * The internal route is not a copy of the user-facing one. Both call `listEntitlements`, so they
 * cannot answer differently — a test asserts exactly that — and what differs is only who may ask:
 * a service token carrying `billing:read`, which is a scope that already exists in
 * contracts-auth and is described there as "Ask whether a subject holds an entitlement. Today no
 * service can ask at all."
 * ---------------------------------------------------------------------------------------------
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import {
  ForbiddenError,
  TokenError,
  bearerFrom,
  isAdmin,
  requireScope,
  statusFor,
  subjectUserId,
  type Principal,
} from '@cloudsforge/auth'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { NetworkUnknownError, requestNetwork, type Network } from '@cloudsforge/http'
import type { NetworkSql } from '@cloudsforge/db'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import { userSubject } from '@cloudsforge/contracts-money'
import { UnknownProductError, listCatalogue } from './catalogue.ts'
import {
  DEFAULT_PAGE_SIZE,
  InvalidScopeError,
  MAX_PAGE_SIZE,
  UnknownEntitlementError,
  listEntitlements,
  parseScope,
  toWire,
} from './entitlements.ts'
import { IdempotencyInFlightError, IdempotencyKeyReuseError, requestFingerprint } from './idempotency.ts'
import { InsufficientFundsError, LedgerRejectedError, LedgerUnavailableError } from './ledger.ts'
import {
  AlreadyRefundedError,
  PurchaseValidationError,
  UnknownPurchaseError,
  purchase,
  refund,
  type PurchaseDeps,
} from './purchases.ts'
import { listSubscriptions, toWire as subscriptionToWire } from './subscriptions.ts'
import {
  IDENTITY_USER_DELETED,
  SUBSCRIBED_TOPICS,
  UUID,
  eraseUser,
} from './erasure.ts'
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  verifyInboundDelivery,
  withInbox,
  type Db,
} from './outbox.ts'

/** The verifier as this file needs it. An interface, so a test does not need a JWKS. */
export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>
}

export interface ServerDeps {
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly verifier: PrincipalVerifier
  /**
   * The per-network SELECTOR, not a handle. Routes use `ctx.sql`; `NetworkSql` has no query
   * methods, so reaching for the process-wide handle does not compile.
   */
  readonly sql: NetworkSql
  /**
   * The network to assume when no `CF-Network` arrives, or `undefined` to refuse. `CF_NETWORK_SINGLE`,
   * for `pnpm dev`, which has no gateway in front of it. Never set in production.
   */
  readonly singleNetwork?: Network
  readonly purchases: PurchaseDeps
  /**
   * The secrets `POST /v1/events` will accept a delivery signature under.
   *
   * A LIST, not a string, and that is the whole point of it: `OUTBOX_SIGNING_SECRET` is one HMAC
   * key shared across the estate and it has to be replaceable. A rolling rotation only works if a
   * receiver accepts the outgoing and the incoming key at once for the length of the cutover —
   * otherwise the instant identity's relay moves, every erasure event 403s and retries for ever,
   * with a green `/livez`.
   */
  readonly eventAcceptSecrets: readonly string[]
  /** Refresh sampled gauges immediately before `/metrics` renders. */
  readonly beforeScrape?: () => Promise<void>
}

/**
 * The two scopes, taken from `@cloudsforge/contracts-auth` rather than spelled again.
 *
 * They are string literals here only so this module does not import the contract for two values;
 * a test asserts they are exactly the registry's, which is what stops a typo becoming a scope no
 * token can ever carry.
 */
export const READ_SCOPE = 'billing:read'
export const GRANT_SCOPE = 'billing:grant'

const MAX_BODY_BYTES = 64 * 1024
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Domain metrics, declared rather than inferred from a log line — AD-20.
 *
 * `billing_entitlement_checks_total{result}` is the one that answers a question nobody in the
 * estate can currently ask: how often a service asks whether a subject owns something, and how
 * often the answer is no.
 */
export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'billing_purchases_total',
      help: 'Purchases, by sku and outcome',
      kind: 'counter',
      labels: ['sku', 'outcome'],
    })
    .register({
      name: 'billing_entitlements_granted_total',
      help: 'Entitlements granted, by source',
      kind: 'counter',
      labels: ['source'],
    })
    .register({
      name: 'billing_entitlements_revoked_total',
      help: 'Entitlements revoked, by reason class (refund or operator)',
      kind: 'counter',
      labels: ['refunded'],
    })
    .register({
      name: 'billing_entitlements_expired_total',
      help: 'Entitlements the expiry sweep ended',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'billing_entitlement_checks_total',
      help: 'Service-token entitlement lookups, by result. Today no service can ask at all.',
      kind: 'counter',
      labels: ['result'],
    })
    .register({
      name: 'billing_renewals_total',
      help: 'Subscription renewal attempts, by outcome',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'billing_ledger_failures_total',
      help: 'Ledger calls that could not be completed. A non-zero rate means purchases are failing.',
      kind: 'counter',
      labels: ['kind'],
    })
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
}

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
  readonly params: Readonly<Record<string, string>>
  /**
   * The network THIS REQUEST belongs to, from the `CF-Network` header the gateway stamped.
   *
   * Not a property of the process: one pod serves both estates since the network consolidation
   * (micro-deploy `docs/network-consolidation.md`), so "which network am I" has no answer.
   */
  readonly network: Network
  /**
   * The database handle for `network`, resolved ONCE, at the edge of the request.
   *
   * Every route uses this rather than reaching for the process-wide handle, because a wrong handle
   * is not an error — it is a query that SUCCEEDS against the other estate's rows and says nothing.
   * `deps.sql` is a `NetworkSql` with no query methods, so the mistake does not compile.
   */
  readonly sql: Db
}

/**
 * Routes that answer without belonging to a network.
 *
 * Kubelet probes the first two and Prometheus scrapes the third; none arrives through the gateway,
 * so none carries `CF-Network`. Refusing them turns a data-isolation rule into a CrashLoopBackOff —
 * which is exactly what agora's first build did: 500 on every probe, container never ready.
 *
 * A literal SET rather than a prefix, because this is an exemption from a data boundary and
 * widening it should be a deliberate edit. Every member must answer without touching the database.
 */
const OPERATIONAL_ROUTES: ReadonlySet<string> = new Set(['/livez', '/readyz', '/metrics'])

interface Route {
  readonly method: string
  /** `/entitlements/:id/revoke`. Used verbatim as the metric label, so cardinality is bounded. */
  readonly path: string
  readonly pattern: RegExp
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

/**
 * Compile `/entitlements/:id/revoke` into a matcher. The segment pattern excludes `/` so a
 * parameter cannot swallow the rest of the path and make one route answer for another.
 */
function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? `(?<${segment.slice(1)}>[^/]+)`
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/')
  return new RegExp(`^${source}$`)
}

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes()
  let inFlight = 0

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const presented = headerOf(req, 'x-request-id')
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId()

    // Echoed before anything can fail, so even a 500 carries the id the user will quote.
    res.setHeader('x-request-id', requestId)

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`)
    const method = req.method ?? 'GET'

    let matched: Route | undefined
    let params: Record<string, string> = {}
    for (const route of routes) {
      if (route.method !== method) continue
      const match = route.pattern.exec(url.pathname)
      if (match) {
        matched = route
        params = { ...match.groups }
        break
      }
    }

    // Unmatched paths collapse to one label. Using the raw path would let any caller mint unbounded
    // time series and take the scrape target down with cardinality.
    const routeLabel = matched ? matched.path : 'unmatched'
    const log = deps.logger.child({ requestId, method, route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number, metricNetwork: string) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', {
        method,
        route: routeLabel,
        status: String(status),
        // One target now serves both estates, so the network has to be on the SERIES. Labelled
        // per target it would say nothing — micro-org#398 in a form nothing could recover.
        network: metricNetwork,
      })
      deps.metrics.observe('http_request_duration_ms', durationMs, {
        method,
        route: routeLabel,
        network: metricNetwork,
      })
    }

    // ── THE NETWORK, THEN THE HANDLE, BEFORE ANY ROUTE RUNS ──────────────────────────────────
    //
    // `requestNetwork` REFUSES an unstamped request rather than assuming mainnet: a 500 is a
    // routing fault made loud, where a default is a cross-network write nothing would ever flag.
    //
    // The operational endpoints are exempt because kubelet and Prometheus do not come through the
    // gateway and never send the header. Refusing them makes the pod never become ready.
    const networkless = matched !== undefined && OPERATIONAL_ROUTES.has(matched.path)
    let network: Network
    try {
      network = networkless
        ? (deps.singleNetwork ?? deps.sql.networks[0] ?? 'mainnet')
        : requestNetwork(req.headers, deps.singleNetwork ? { fallback: deps.singleNetwork } : {})
    } catch (err) {
      log.error('request carries no usable network', {
        err: err instanceof NetworkUnknownError ? err.message : err,
      })
      send(
        res,
        errorReply(500, 'network_unknown', 'this request could not be attributed to a network', requestId),
        requestId,
      )
      finish(500, 'unknown')
      return
    }

    // ── RESOLVED INSIDE A TRY, AND THAT IS NOT DEFENSIVE PADDING ───────────────────────────────
    //
    // `deps.sql.for()` THROWS when this deployment holds no handle for that network, and that
    // refusal is the safety property the consolidation rests on — better a loud 500 than a query
    // answered out of the other estate's rows.
    //
    // It runs BEFORE `handle` returns a promise, so an uncaught throw escapes the `void` expression
    // past a `.catch` that is not attached yet, and the listener returns having sent NOTHING. The
    // connection then hangs until the client gives up: the one path the design most depends on
    // being loud was the one path that was silent.
    let sql: Db
    try {
      sql = deps.sql.for(network) as unknown as Db
    } catch (err) {
      log.error('no usable database handle for this request', { err, network })
      send(
        res,
        errorReply(500, 'network_unavailable', 'this deployment cannot serve that network', requestId),
        requestId,
      )
      finish(500, network)
      return
    }
    void handle(matched, { req, url, requestId, log, params, network, sql }, forRequest(deps, sql))
      .then((reply) => {
        send(res, reply, requestId)
        finish(reply.status, network)
      })
      .catch((err: unknown) => {
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500, network)
      })
  })
}

/**
 * Map every failure onto a status, grouped by what the caller should do about it.
 *
 *   * **400** — the request could not be a legal purchase. Fix it; retrying will not help.
 *   * **402** — the subject cannot afford it. The ledger decided, and this is the answer a user
 *     sees. It is deliberately NOT a 500: the estate already answers 402 here and it is right.
 *   * **404** — something named does not exist.
 *   * **409** — well formed, but the state refuses it: a key reused with a different body, a
 *     refund of something already refunded.
 *   * **503** — the ledger is unreachable. We do not know whether the entry posted, the purchase
 *     rolled back, and the caller's retry carries the same key. Retrying IS the right response,
 *     which is exactly what 503 tells a client and 500 does not.
 */
/**
 * The deps a REQUEST sees: the purchase bundle rebuilt against this request's handle.
 *
 * `purchases` carries a ledger client next to the handle, so a purchase written through the wrong
 * one succeeds AND posts to the other estate's ledger — two sides that agree with each other and
 * are both wrong.
 */
function forRequest(deps: ServerDeps, sql: Db): ServerDeps {
  return { ...deps, purchases: { ...deps.purchases, sql } }
}

async function handle(route: Route | undefined, ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  if (!route) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId)
  }
  try {
    return await route.handle(ctx, deps)
  } catch (err) {
    const authStatus = statusFor(err)
    if (authStatus === 401) {
      // The reason is logged, never returned — "signature verification failed" versus "expired"
      // tells an attacker which half of a forged token to fix.
      ctx.log.info('unauthenticated request', { err })
      return errorReply(401, 'unauthenticated', 'a valid bearer token is required', ctx.requestId)
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown'
      ctx.log.info('forbidden request', { required })
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId)
    }
    if (authStatus === 503) {
      ctx.log.error('token verifier unavailable', { err })
      return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId)
    }

    if (err instanceof InsufficientFundsError) {
      return errorReply(402, 'insufficient_balance', err.message, ctx.requestId)
    }
    if (
      err instanceof BadRequestError ||
      err instanceof PurchaseValidationError ||
      err instanceof InvalidScopeError ||
      err instanceof RangeError
    ) {
      return errorReply(400, 'bad_request', err.message, ctx.requestId)
    }
    if (
      err instanceof NotFoundError ||
      err instanceof UnknownProductError ||
      err instanceof UnknownEntitlementError ||
      err instanceof UnknownPurchaseError
    ) {
      return errorReply(404, 'not_found', err.message, ctx.requestId)
    }
    if (err instanceof IdempotencyKeyReuseError) {
      return errorReply(409, 'idempotency_key_reuse', err.message, ctx.requestId)
    }
    if (err instanceof IdempotencyInFlightError) {
      return errorReply(409, 'idempotency_in_flight', err.message, ctx.requestId)
    }
    if (err instanceof AlreadyRefundedError) {
      return errorReply(409, 'already_refunded', err.message, ctx.requestId)
    }
    if (err instanceof LedgerRejectedError) {
      // The ledger decided, so this is not our fault and not worth a retry — but it IS worth a
      // loud log, because a balanced-entry rejection means this service built an entry wrongly.
      ctx.log.error('the ledger refused an entry', { err, code: err.code, status: err.status })
      deps.metrics.increment('billing_ledger_failures_total', { kind: 'rejected' })
      return errorReply(409, 'ledger_rejected', err.message, ctx.requestId)
    }
    if (err instanceof LedgerUnavailableError) {
      ctx.log.error('the ledger could not be reached', { err })
      deps.metrics.increment('billing_ledger_failures_total', { kind: 'unavailable' })
      return errorReply(503, 'ledger_unavailable', 'the purchase could not be completed; retry', ctx.requestId)
    }

    ctx.log.error('unhandled request failure', { err })
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
  }
}

function buildRoutes(): Route[] {
  const define = (
    method: string,
    path: string,
    handler: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>,
  ): Route => ({ method, path, pattern: compile(path), handle: handler })

  return [
    define('GET', '/livez', async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz()
      return { status: report.ready ? 200 : 503, body: report }
    }),

    define('GET', '/metrics', async (ctx, deps) => {
      try {
        await deps.beforeScrape?.()
      } catch (err) {
        // A gauge that could not be sampled is a stale gauge. Failing the scrape instead would
        // lose every other metric too, and blind the dashboard at the moment it is needed.
        ctx.log.warn('gauge refresh failed; serving the previous values', { err })
      }
      return {
        status: 200,
        text: deps.metrics.render(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      }
    }),

    /**
     * The catalogue. Public: a shop that needs a token to show its prices cannot be browsed by
     * anybody who has not signed up, which is the wrong way round for a shop.
     */
    define('GET', '/products', async (ctx, deps) => {
      const catalogue = await listCatalogue(ctx.sql)
      return {
        status: 200,
        body: {
          products: catalogue.map(({ product, prices }) => ({
            id: product.id,
            sku: product.sku,
            name: product.name,
            kind: product.kind,
            scopeKind: product.scopeKind,
            entitlementDays: product.entitlementDays,
            metadata: product.metadata,
            prices: prices.map((price) => ({
              id: price.id,
              assetCode: price.assetCode,
              // A string. A price of 9007199254740993 shards is absurd, but the habit of sending
              // amounts as JSON numbers is how an 18-decimal amount loses its low bits elsewhere.
              unitAmount: price.unitAmount.toString(),
              interval: price.interval,
              intervalCount: price.intervalCount,
            })),
          })),
        },
      }
    }),

    /**
     * Buy something. Idempotent on the caller's key.
     *
     * The key is required rather than optional. An optional idempotency key is an idempotency key
     * that is absent on the one request that gets retried, and a purchase is exactly the shape of
     * request a client retries after a timeout.
     */
    define('POST', '/purchases', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, GRANT_SCOPE)
      const body = await readJson(ctx.req)

      const idempotencyKey =
        headerOf(ctx.req, 'idempotency-key') ??
        (typeof body['idempotencyKey'] === 'string' ? body['idempotencyKey'] : undefined)
      if (!idempotencyKey || idempotencyKey.trim().length === 0) {
        throw new BadRequestError('an Idempotency-Key header or idempotencyKey field is required')
      }

      const userId = subjectUserId(
        principal,
        typeof body['userId'] === 'string' ? body['userId'] : undefined,
      )
      const quantity = readQuantity(body['quantity'])

      const done = deps.lifecycle.track()
      try {
        const outcome = await purchase(
          deps.purchases,
          {
            subject: userSubject(userId),
            ...(typeof body['sku'] === 'string' ? { sku: body['sku'] } : {}),
            ...(typeof body['priceId'] === 'string' ? { priceId: body['priceId'] } : {}),
            quantity,
            ...(typeof body['scope'] === 'string' ? { scope: body['scope'] } : {}),
            idempotencyKey: idempotencyKey.trim(),
            correlationId: ctx.requestId,
            actor: actorOf(principal),
          },
          // The fingerprint covers the request as sent, so the same key with a different body is
          // refused rather than answered with the first request's result.
          requestFingerprint(body),
        )

        const sku = outcome.result.purchase.sku
        if (outcome.replayed) {
          deps.metrics.increment('billing_purchases_total', { sku, outcome: 'replayed' })
        } else {
          deps.metrics.increment('billing_purchases_total', { sku, outcome: 'completed' })
          deps.metrics.increment('billing_entitlements_granted_total', {
            source: String((outcome.result.entitlement as { source?: string }).source ?? 'purchase'),
          })
        }
        ctx.log.info(outcome.replayed ? 'purchase replayed' : 'purchase completed', {
          purchaseId: outcome.result.purchase.id,
          sku,
          journalEntryId: outcome.result.purchase.journalEntryId,
          replayed: outcome.replayed,
        })
        // 200 on a replay, 201 on a fresh purchase: a client can tell whether its retry did the
        // work or merely found it done, without comparing bodies.
        return {
          status: outcome.replayed ? 200 : 201,
          body: { ...outcome.result, replayed: outcome.replayed },
        }
      } finally {
        done()
      }
    }),

    /** What the calling user owns. */
    define('GET', '/entitlements', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      const requested = ctx.url.searchParams.get('userId') ?? undefined
      // Three authorities, one line. An operator with the admin role may read anyone; a service
      // reads whoever its call names; a user reads only itself, and `subjectUserId` throws
      // ForbiddenError — mapped to 403 above — if it asks for another.
      const userId = isAdmin(principal) && requested ? requested : subjectUserId(principal, requested)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)

      const at = readAt(ctx)
      const entitlements = await listEntitlements(ctx.sql, {
        subject: userSubject(userId),
        at,
        ...scopeFilter(ctx),
        ...(ctx.url.searchParams.get('sku') ? { sku: ctx.url.searchParams.get('sku')! } : {}),
        includeInactive: ctx.url.searchParams.get('includeInactive') === 'true',
        limit: readLimit(ctx),
      })
      return {
        status: 200,
        body: { at, entitlements: entitlements.map((e) => toWire(e, at)) },
      }
    }),

    /**
     * **The service-readable API.** A service token with `billing:read` asks whether a subject
     * owns something — the question nothing in the estate can currently ask.
     *
     * A user token is refused here even for its own id: this route exists for services, and a
     * route that quietly accepted both would make the scoped-token boundary decorative. Users have
     * `GET /entitlements`, which runs the same query.
     */
    define('GET', '/internal/entitlements/:userId', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind !== 'service') {
        throw new ForbiddenError(`${READ_SCOPE} (service token required)`)
      }
      requireScope(principal, READ_SCOPE)

      const at = readAt(ctx)
      const entitlements = await listEntitlements(ctx.sql, {
        subject: userSubject(ctx.params['userId'] ?? ''),
        at,
        ...scopeFilter(ctx),
        ...(ctx.url.searchParams.get('sku') ? { sku: ctx.url.searchParams.get('sku')! } : {}),
        includeInactive: ctx.url.searchParams.get('includeInactive') === 'true',
        limit: readLimit(ctx),
      })
      // The metric that makes the new capability observable: how often services ask, and how often
      // the answer is no.
      deps.metrics.increment('billing_entitlement_checks_total', {
        result: entitlements.length > 0 ? 'owned' : 'not_owned',
      })
      return {
        status: 200,
        body: {
          at,
          userId: ctx.params['userId'] ?? '',
          entitlements: entitlements.map((e) => toWire(e, at)),
        },
      }
    }),

    /**
     * Revoke a grant, optionally refunding what paid for it.
     *
     * `refund: true` reverses the ledger entry first and revokes second — see `refund()`. An
     * operator taking something back without a refund passes `refund: false`, and the reason is
     * required either way, because "why did this customer lose access" is the first question
     * asked afterwards.
     */
    define('POST', '/entitlements/:id/revoke', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, GRANT_SCOPE)
      else if (!isAdmin(principal)) throw new ForbiddenError(`${GRANT_SCOPE} or role:admin`)

      const body = await readJson(ctx.req)
      const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : ''
      if (reason.length === 0) throw new BadRequestError('reason is required')
      const wantsRefund = body['refund'] === true

      const done = deps.lifecycle.track()
      try {
        const result = await refund(deps.purchases, {
          entitlementId: ctx.params['id'] ?? '',
          reason,
          actor: actorOf(principal),
          correlationId: ctx.requestId,
          refund: wantsRefund,
        })
        if (!result.alreadyRevoked) {
          deps.metrics.increment('billing_entitlements_revoked_total', {
            refunded: String(wantsRefund),
          })
        }
        ctx.log.info('entitlement revoked', {
          entitlementId: ctx.params['id'],
          refunded: wantsRefund,
          reversalEntryId: result.reversalEntryId,
          alreadyRevoked: result.alreadyRevoked,
        })
        return { status: 200, body: result }
      } finally {
        done()
      }
    }),

    define('GET', '/subscriptions', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      const requested = ctx.url.searchParams.get('userId') ?? undefined
      const userId = isAdmin(principal) && requested ? requested : subjectUserId(principal, requested)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)

      const subscriptions = await listSubscriptions(ctx.sql, userSubject(userId), readLimit(ctx))
      return { status: 200, body: { subscriptions: subscriptions.map(subscriptionToWire) } }
    }),

    /**
     * The inbound event webhook — and the only unauthenticated write surface in this service.
     *
     * There is no bearer token here and there must not be: the MAC over the body IS the
     * credential, and it is checked over the RAW BYTES before anything is parsed. Parsing first
     * would put the JSON parser in front of the check, which is an unauthenticated caller reaching
     * a parser; comparing byte-at-a-time would make the MAC comparison a forgery oracle.
     * `verifyInboundDelivery` does both correctly, over the contract's scheme — see its header for
     * why the contract's and not this file's.
     *
     * A bad signature is **403, not 401**. 401 says "authenticate and try again", which invites a
     * caller to go looking for a token that does not exist for this route; 403 says the credential
     * presented was wrong, which is the truth.
     *
     * A topic this service does not subscribe to is **202 ignored, never 4xx**. The relay treats
     * any non-2xx as a delivery failure and retries it, so 4xx-ing an event nobody is wrong about
     * would pin the producer in a retry loop for ever.
     */
    define('POST', '/v1/events', async (ctx, deps) => {
      const raw = await readRaw(ctx.req)
      if (!verifyInboundDelivery(raw, headerOf(ctx.req, SIGNATURE_HEADER) ?? '', deps.eventAcceptSecrets)) {
        ctx.log.warn('event rejected: bad signature', { eventId: headerOf(ctx.req, EVENT_ID_HEADER) })
        return errorReply(403, 'bad_signature', 'the event signature did not verify', ctx.requestId)
      }

      let envelope: { id?: unknown; topic?: unknown; payload?: unknown }
      try {
        envelope = JSON.parse(raw) as typeof envelope
      } catch {
        throw new BadRequestError('the event body is not valid JSON')
      }
      const topic = typeof envelope.topic === 'string' ? envelope.topic : ''
      const eventId = typeof envelope.id === 'string' ? envelope.id : ''
      if (!UUID.test(eventId)) throw new BadRequestError('the event id must be a uuid')
      if (!SUBSCRIBED_TOPICS.has(topic)) return { status: 202, body: { status: 'ignored' } }

      const payload = (envelope.payload ?? {}) as Record<string, unknown>
      const userId = payload['userId']
      // A 400 here, and the relay WILL retry it for ever — which is correct. An erasure request
      // this service cannot read is a person whose data is still here and whose deletion is being
      // reported as done, and it must stay visible rather than being absorbed into a 202.
      if (typeof userId !== 'string' || !UUID.test(userId)) {
        throw new BadRequestError(`${IDENTITY_USER_DELETED} requires a uuid userId`)
      }

      const done = deps.lifecycle.track()
      try {
        const outcome = await withInbox(ctx.sql, topic, eventId, (tx) => eraseUser(tx, userId))
        // Counts and field names only. The user id is never logged — logging the identifier of the
        // person who asked to be forgotten, into an aggregator with its own retention, is the
        // shape of defect this handler exists to fix.
        ctx.log.info('erasure processed', {
          topic,
          eventId,
          outcome: outcome.status,
          ...(outcome.status === 'processed' ? outcome.value : {}),
        })
        if (outcome.status === 'processed' && outcome.value.payoutsCancelled > 0) {
          // Not a failure, but somebody left with money owed. Surfaced at warn so it is not buried
          // in an info line nobody reads.
          ctx.log.warn('erasure cancelled unpaid payouts', {
            eventId,
            payoutsCancelled: outcome.value.payoutsCancelled,
          })
        }
        return {
          status: 202,
          body: { status: outcome.status === 'duplicate' ? 'duplicate' : 'recorded' },
        }
      } finally {
        done()
      }
    }),
  ]
}

/* ------------------------------------------------------------------------ request helpers */

function scopeFilter(ctx: RequestContext): { scope?: ReturnType<typeof parseScope> } {
  const raw = ctx.url.searchParams.get('scope')
  // Parsed rather than passed through: the scope is a lookup key, and an unvalidated one is a
  // query parameter that decides which rows a service is shown.
  return raw ? { scope: parseScope(raw) } : {}
}

/**
 * The instant activity is evaluated at.
 *
 * Explicit on the wire so a caller replaying an event, backfilling, or writing a test gets a
 * deterministic answer — the same reason `isEntitlementActive` takes one rather than reading the
 * clock. Defaults to now, which is what every live caller wants.
 */
function readAt(ctx: RequestContext): string {
  const raw = ctx.url.searchParams.get('at')
  if (!raw) return new Date().toISOString()
  const parsed = Date.parse(raw)
  if (Number.isNaN(parsed)) throw new BadRequestError(`at must be an ISO-8601 timestamp (got ${raw})`)
  return new Date(parsed).toISOString()
}

function readLimit(ctx: RequestContext): number {
  const raw = ctx.url.searchParams.get('limit')
  if (!raw) return DEFAULT_PAGE_SIZE
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new BadRequestError(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`)
  }
  return value
}

/**
 * A quantity, as a string or a safe integer.
 *
 * A JSON number beyond `Number.MAX_SAFE_INTEGER` has already lost precision before this code ran,
 * so the honest answer is to refuse it and say why rather than to store a number that is quietly
 * not the one the caller meant.
 */
function readQuantity(value: unknown): bigint {
  if (value === undefined || value === null) return 1n
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new BadRequestError('quantity must be a positive integer; send a string if it is large')
    }
    return BigInt(value)
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw new BadRequestError('quantity must be a positive integer')
  }
  const parsed = BigInt(value.trim())
  if (parsed < 1n) throw new BadRequestError('quantity must be a positive integer')
  return parsed
}

/* ------------------------------------------------------------------------ auth */

async function authenticate(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than being
  // a separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')
  return deps.verifier.principal(token)
}

function actorOf(principal: Principal): string {
  return principal.kind === 'user' ? `user:${principal.userId}` : `service:${principal.service}`
}

/* ------------------------------------------------------------------------ body parsing */

/**
 * The body as the bytes that were sent, for the one route that has to verify a MAC over them.
 *
 * Separate from `readJson` rather than a flag on it, because the property this needs is that
 * NOTHING has been parsed yet. A re-serialised body is a different byte string — a different key
 * order, a different number rendering — and the signature would fail against it for reasons that
 * look exactly like an attack.
 */
async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // Capped before buffering, not after: an unbounded body is a memory exhaustion primitive that
    // any authenticated caller could otherwise reach.
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestError('request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    throw new BadRequestError('request body is not valid JSON')
  }
}

/* ------------------------------------------------------------------------ replies */

/**
 * The error shape, identical on every failure and always carrying the request id.
 *
 * The id in the body rather than only in the header is what makes a support conversation work: a
 * user can read back what their browser showed them, and it joins to the log line, the trace and
 * the Lantern issue.
 */
function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`
  res.writeHead(reply.status, {
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    // What a subject owns is a point-in-time fact. A cached "owned" served after a refund is
    // exactly the lie revocation exists to stop telling.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
