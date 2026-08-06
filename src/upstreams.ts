/**
 * The peers, and the credential this service presents to them.
 *
 * ── WHY THIS IS A MODULE AND NOT TWENTY LINES OF `index.ts` ────────────────────────────────────
 *
 * Because the defect it fixes was a WIRING defect, and wiring that lives in the composition root
 * is wiring no test can reach. `index.ts` opens a pool, asserts a schema and calls `listen()`;
 * importing it from a test starts a server. So the line that was wrong —
 *
 *     token: () => env.ledgerToken        // index.ts, for months
 *
 * — was structurally untestable. Its comment even said the function was async by contract "so the
 * ten-minute service token identity issues can be refreshed here without anything else in the
 * service changing". The seam was right and the body was wrong. See `servicetoken.test.ts`.
 *
 * ── THE TEN-MINUTE CLIFF ───────────────────────────────────────────────────────────────────────
 *
 * A service token expires in 600 seconds (identity/src/tokens.ts). This service read one once
 * at boot and nothing re-minted it — nothing could, because minting required the `admin` role. Ten
 * minutes into every deployment, every posting to the ledger failed. No test here could see it: a
 * test mints a token and uses it within seconds.
 *
 * What this container holds at rest is now a CREDENTIAL: long-lived, revocable, worth nothing on
 * its own, and exchangeable for an ordinary ten-minute token whenever one is needed. The ten
 * minutes is unchanged and must stay unchanged — rotation IS expiry (SD-12).
 *
 * ── ONE CREDENTIAL, TWO PROVIDERS, AND WHY THAT IS NOT A CONTRADICTION ─────────────────────────
 *
 * `BILLING_LEDGER_TOKEN` and `BILLING_ADMIN_API_TOKEN` were two secrets because they carry
 * different scopes: the ledger needs `ledger:post`, admin-api exact-matches `admin:read`
 * (`adminapi.ts`, enforced at `admin-api/src/server.ts`). That separation is AD-05 and is
 * worth keeping — a process whose environment leaks should surrender the narrowest thing possible.
 *
 * It no longer needs two SECRETS to keep it. Identity reads the service off the credential ROW and
 * never off the request, so one credential mints everything billing is allowed; the scope set is a
 * request parameter. Two providers means two cached tokens with two narrow scope sets, from one
 * revocable secret — strictly better than two long-lived bearer strings.
 *
 * ── THE ADMIN-API PATH IS DORMANT, AND SAYS SO LOUDLY IF WOKEN ─────────────────────────────────
 *
 * `IDENTITY_SERVICE_TOKEN_GRANTS` currently gives billing `["ledger:read","ledger:post",
 * "ledger:reserve"]` and NOT `admin:read`, and no estate deployment sets `ADMIN_API_URL`, so the
 * engagement recycle is off everywhere and this client is never constructed.
 *
 * If a deployment turns it on before that allowlist gains `admin:read`, the exchange fails with
 * identity's `ScopeNotGrantedError`, which names the missing scope. That is deliberate and is
 * better than what the static token would have done: a 403 from admin-api with nothing saying why.
 * The fix is one entry in the estate's grants map, in micro-deploy.
 */

import {
  ServiceTokenProvider,
  ServiceTokenUnavailableError,
  type ProviderEvent,
} from '@cloudsforge/auth'
import { httpLedgerClient, type LedgerClient } from './ledger.ts'
import { ADMIN_API_SCOPES, httpAdminApiClient, type EngagementPolicyClient } from './adminapi.ts'
// TYPE-ONLY, and that matters. `./env.ts` validates the process environment at import and calls
// `process.exit(1)` when it is incomplete, so a value import here would make this module — and
// therefore every test of the wiring in it — impossible to load without a full environment. That
// is the same "untestable therefore unchecked" property that let the cliff survive.
import type { Env } from './env.ts'

export interface Upstreams {
  /**
   * `null` when no credential is configured. Handed to `serviceTokenProbe`, which reports that as
   * a hard readiness failure — the image must be able to BOOT without one so CI can smoke-test
   * `/livez`, but a replica in that state must never take traffic.
   */
  readonly identityTokens: ServiceTokenProvider | null
  readonly ledger: LedgerClient
  /** `undefined` when `ADMIN_API_URL` is unset — an absent client, not one that fails hourly. */
  readonly adminApi: EngagementPolicyClient | undefined
}

export interface UpstreamOptions {
  /** This service's name, for the ledger's `originating-service` header. `SERVICE` from `env.ts`. */
  readonly originatingService: string
  /** Test seam. Production uses the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly onEvent?: ((event: ProviderEvent) => void) | undefined
}

/** The subset of `Env` this needs. Named so a test does not have to build a whole environment. */
export type UpstreamEnv = Pick<
  Env,
  | 'identityUrl'
  | 'identityCredential'
  | 'ledgerBaseUrl'
  | 'ledgerDeadlineMs'
  | 'adminApiBaseUrl'
  | 'adminApiDeadlineMs'
>

export function buildUpstreams(env: UpstreamEnv, options: UpstreamOptions): Upstreams {
  const common = {
    identityUrl: env.identityUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  }

  // The ledger provider asks for the service's whole allowlist: a long-running provider cannot
  // know at boot which of its call sites will be reached.
  const identityTokens = env.identityCredential
    ? new ServiceTokenProvider({ ...common, credential: env.identityCredential })
    : null

  /**
   * Rejects rather than resolving `undefined` when there is no credential. `HttpClient` omits the
   * header entirely for `undefined`, so the request would go out unauthenticated and come back
   * 401 — telling an operator that the ledger rejected billing, when the truth is that nobody
   * configured billing. `ServiceTokenUnavailableError` is 503 under `statusFor`, the same answer
   * the estate already gives when a verifier is unreachable and for the same reason.
   */
  const tokenFrom = (provider: ServiceTokenProvider | null) => (): Promise<string> =>
    provider
      ? provider.token()
      : Promise.reject(new ServiceTokenUnavailableError('no identity credential is configured'))

  const ledger = httpLedgerClient({
    baseUrl: env.ledgerBaseUrl,
    token: tokenFrom(identityTokens),
    deadlineMs: env.ledgerDeadlineMs,
    originatingService: options.originatingService,
    ...(identityTokens?.authorizedFetch
      ? { fetch: identityTokens.authorizedFetch }
      : options.fetch
        ? { fetch: options.fetch }
        : {}),
  })

  // Constructed only when the URL is configured, so "no engagement programme in this deployment"
  // is an absent client rather than a client that fails hourly.
  let adminApi: EngagementPolicyClient | undefined
  if (env.adminApiBaseUrl !== null) {
    // Its OWN provider, narrowed to `admin:read`. Same credential, different scope set — see the
    // file header for why that is one secret and two tokens rather than two secrets.
    const adminTokens = env.identityCredential
      ? new ServiceTokenProvider({
          ...common,
          credential: env.identityCredential,
          scopes: ADMIN_API_SCOPES,
        })
      : null
    adminApi = httpAdminApiClient({
      baseUrl: env.adminApiBaseUrl,
      token: tokenFrom(adminTokens),
      deadlineMs: env.adminApiDeadlineMs,
      ...(adminTokens?.authorizedFetch
        ? { fetch: adminTokens.authorizedFetch }
        : options.fetch
          ? { fetch: options.fetch }
          : {}),
    })
  }

  return { identityTokens, ledger, adminApi }
}
