/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable the service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out (which
 * hands every container the whole estate's secrets) has nothing to justify it.
 *
 * Two behaviours are copied deliberately from the estate's custody service, which is the only
 * place that gets this right today:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A known placeholder is refused outright.** A default secret in source is not convenient,
 *      it is catastrophic.
 */

import { hostname } from 'node:os'
import type { LedgerAssetCode } from '@cloudsforge/contracts-money'
import type { IssuableAssetCode } from '@cloudsforge/contracts-chain'
import { assertGeneratedSecret, assertGeneratedSecretList, assertServiceCredential } from '@cloudsforge/secrets'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a
 * migration advisory lock. It is also what the ledger records as `originating_service` on every
 * entry this service posts, which is what finally makes per-product revenue derivable.
 */
export const SERVICE = 'billing'

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

/**
 * A comma-separated secret list, for a receiver that must accept more than one key at a time.
 *
 * Every entry is held to the same bar as a single secret, and since micro-org #142 that bar is
 * `assertGeneratedSecret` rather than a deny-list plus a 24-character floor. A LIST IS NOT A PLACE
 * WHERE THE RULE RELAXES: this variable exists to give a rotation an overlap window, and the
 * OUTGOING key is the one an attacker already has if it leaked. "Just for the drain" is exactly
 * how a placeholder survives a rotation that was supposed to remove it — and this list is the
 * accept side of the very key that sat in a public compose file on 44 live containers, so a
 * forged delivery to `POST /v1/events` is the concrete thing being prevented.
 *
 * A duplicate is refused because "which key verified this" is the answer that tells an operator a
 * rotation has finished and the old key can be dropped, and a repeated entry makes it ambiguous.
 * That check is local because it is a property of the LIST rather than of any entry.
 *
 * The index is named in the refusal and the entry is not: an operator with the file open can count
 * commas, and a log collector must not be handed the value.
 */
export function parseSecretList(raw: string, name: string): readonly string[] {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (entries.length === 0) throw new EnvError(`${name} is required — at least one secret`)
  assertGeneratedSecretList(name, entries)
  if (new Set(entries).size !== entries.length) {
    throw new EnvError(`${name} lists the same secret twice`)
  }
  return Object.freeze(entries)
}

/**
 * The estate's shared event-bus HMAC key, held to a shape rather than to a deny-list.
 *
 * THE LOCAL `requiredSecret`, `optionalSecret` AND `PLACEHOLDERS` ARE GONE RATHER THAN KEPT IN
 * FRONT. They refused a fixed list of exact strings and anything under 24 characters, and the
 * value that sat on 54 lines of a PUBLIC compose file — `estate-only-outbox-secret-00000000000000`
 * — was on no list and was 40 characters, so it passed every service in the estate (micro-org
 * #142) and was live on 44 containers across both networks. A check that could not fail read as
 * the absence of a problem. It matters here more than most: this service posts to the ledger, so a
 * forgeable event signature is a forgeable movement of somebody's money.
 *
 * `assertGeneratedSecret` asserts what a placeholder cannot have: the base64 or hex alphabet (no
 * hyphens — every placeholder this estate wrote had one), 32 decoded BYTES rather than 24
 * keystrokes, and a measured Shannon entropy floor. It has no NODE_ENV exemption and no escape
 * hatch, so CI generates a real value per run rather than being let through.
 *
 * `required` in front of it and nothing else, deliberately: the deleted checks were a strict
 * subset of the stronger ones, and running them first would answer a 40-character placeholder with
 * "must be at least 24 characters" — a message that is true, useless, and points the operator at
 * the wrong property.
 */
function requiredSigningSecret(source: Source, name: string): string {
  const value = required(source, name)
  assertGeneratedSecret(name, value)
  return value
}

/**
 * A service credential that may be absent, but must be a REAL credential if present.
 *
 * The distinction matters: absent is a deployment that has not been given one yet and is reported
 * by `/readyz`; a placeholder is a deployment that believes it HAS one, and fails on its first call
 * to a peer with a 401 that reads as "identity rejected billing" rather than "nobody set this
 * variable".
 *
 * ── WHY THIS IS `assertServiceCredential` AND NOT THE SIGNING-KEY RULE ABOVE ──────────────────
 *
 * The guard class is not predictable from the variable's name, so it was MEASURED rather than
 * inferred. `BILLING_IDENTITY_CREDENTIAL` on the live estate, both networks, 2026-08-06:
 *
 *     mainnet   cfsc_ + 43 characters, base64url body
 *     testnet   cfsc_ + 43 characters, base64url body
 *
 * A credential is minted by micro-identity, not by `openssl` — so it is neither wholly base64 nor
 * wholly hex, and the underscore in its own `cfsc_` prefix disqualifies it. Pointing this at
 * `assertGeneratedSecret`, which is the obvious-looking reuse, would refuse every credential the
 * estate has ever minted and exit 1 at boot on BOTH networks.
 *
 * The body is base64**url**, so it may contain a hyphen. Measured across the estate's credentials
 * on 2026-08-06, one network's body carries one and the other's does not for the same variable —
 * `MINT_IDENTITY_CREDENTIAL` has a hyphen on mainnet and none on testnet, `NDA_IDENTITY_CREDENTIAL`
 * the other way round. A "no hyphens" rule therefore reads as obviously right in review, passes
 * one estate and kills the other at boot. `@cloudsforge/secrets` pins a hyphenated fixture so that
 * regression fails CI instead of failing an estate.
 */
function optionalCredential(source: Source, name: string): string | null {
  const value = source[name]?.trim()
  if (!value) return null
  assertServiceCredential(name, value)
  return value
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be an integer between ${min} and ${max} (got ${raw})`)
  }
  return value
}

export interface Env {
  readonly port: number
  readonly env: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /**
   * Rule 1: one database, named by this service's own variable. The CI check greps for any other
   * connection-string variable, so adding a second one here fails the build rather than review.
   *
   * Note what is NOT here: a second URL for the ledger's database. Billing reaches the ledger over
   * HTTP through a scoped token, never by connecting to its tables — AD-06. A shared connection
   * string would make the ledger's constraint triggers optional for anything holding it.
   */
  readonly databaseUrl: string
  /**
   * The TESTNET database, when this deployment serves both networks. Empty means single-network —
   * `networkSql` then holds one handle and REFUSES a testnet request rather than answering it out
   * of mainnet rows (micro-deploy `docs/network-consolidation.md` §2.2).
   */
  readonly databaseUrlTestnet: string
  /**
   * The network to assume when a request carries no `CF-Network`, or empty to refuse. Set for
   * `pnpm dev`, which has no gateway. Never in production, where guessing makes a routing fault a
   * silent cross-network write.
   */
  readonly singleNetwork: string
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  /**
   * HMAC key for outbound event signatures, so a subscriber can prove an event came from us.
   * Exactly one, always: a producer signing under two keys at once has not rotated, it has forked.
   */
  readonly outboxSigningSecret: string
  /**
   * The secrets `POST /v1/events` will ACCEPT, newest first.
   *
   * Defaults to `[outboxSigningSecret]` when `OUTBOX_ACCEPT_SECRETS` is unset, so a deploy that
   * does not set it behaves exactly as it did before this route existed. That is deliberate: it
   * makes shipping the erasure subscriber a no-op for the deploy manifest, and it is what lets the
   * estate's shared secret be rotated one service at a time afterwards rather than on a flag day.
   * Without it, the moment identity's relay moved to a new key every erasure event would 403 and
   * retry for ever behind a green `/livez`.
   */
  readonly acceptSecrets: readonly string[]
  readonly instanceId: string
  /** Where the ledger is. Billing holds no balance; every movement of value is posted there. */
  readonly ledgerBaseUrl: string
  /**
   * Where identity is, for `POST /service-tokens/exchange`.
   *
   * Defaults to `IDENTITY_ISSUER`, which is already required and is identity's own base URL — the
   * issuer of a token is by definition where the token came from. `IDENTITY_URL` overrides it where
   * the two genuinely differ.
   */
  readonly identityUrl: string

  /**
   * **The long-lived credential this service exchanges for short-lived tokens.**
   *
   * It replaces `BILLING_LEDGER_TOKEN` and `BILLING_ADMIN_API_TOKEN`, both of which were 600-second
   * tokens read once at boot (identity/src/tokens.ts). Ten minutes into any deployment they
   * expired and every posting to the ledger failed; nothing could re-mint them, because minting
   * requires the `admin` role. A credential is not a token: it confers nothing by itself, it is
   * revocable, and it survives a restart.
   *
   * ONE credential for both peers, because identity reads the service off the credential ROW and
   * never off the request — so one credential mints every token billing is allowed. The two
   * clients ask it for different SCOPES, which is a request parameter, not a second secret.
   *
   * OPTIONAL, so the image can BOOT for CI's `/livez` smoke test, whose environment is fixed in a
   * workflow file. The absence is not silent: `/readyz` reports `identity-credential` as a HARD
   * failure and every upstream call fails closed with 503.
   */
  readonly identityCredential: string | null

  /** Whether the retired `BILLING_LEDGER_TOKEN` is still set. Read only so boot can say it is ignored. */
  readonly legacyServiceTokenPresent: boolean
  /**
   * Absolute wall-clock ceiling on a ledger call, across retries.
   *
   * It bounds how long the purchase transaction can be open, because the posting happens inside
   * it — see the note in `purchases.ts`. Too generous and a slow ledger holds a database
   * connection per in-flight purchase; too tight and a healthy retry never completes.
   */
  readonly ledgerDeadlineMs: number
  /**
   * What the catalogue is PRICED in. USD, held as cents.
   *
   * The durable figure, because there is no market price for EMBER to make an EMBER price durable
   * against — see `migrations.ts` version 11 and `pricingclient.ts`. USD never reaches a posting.
   *
   * Not configurable, for the same reason the old `purchaseAsset` was not: the price rows in the
   * database are denominated in one thing, and an environment variable that disagreed with them
   * would find no active price and fail every purchase with "no active X price".
   */
  readonly priceAsset: LedgerAssetCode
  /**
   * What a purchase is SETTLED in — what actually leaves the customer's balance. EMBER.
   *
   * Was `SHARD`. Shards sat outside the estate's central guarantee (no balance may exist that the
   * chain does not back), which is why they are gone from this path: a purchase now debits an
   * asset a chain backs, so the money it moves is money reconciliation can see.
   *
   * Typed `IssuableAssetCode`, not `LedgerAssetCode`. That excludes retired assets at COMPILE
   * time, so restoring `'SHARD'` here — the single edit that would put this service back to
   * minting unbacked liability — does not build. `USD` is excluded by the same type for a
   * different reason: it is a unit of account with no chain and no custody, so posting it would
   * recreate the Shard defect under a more respectable name.
   */
  readonly settlementAsset: IssuableAssetCode
  /** Where micro-pricing is, for the USD→EMBER rate. Required: a purchase cannot be priced without it. */
  readonly pricingBaseUrl: string
  readonly pricingDeadlineMs: number
  /** How long an idempotency key is honoured. Must outlive every caller's retry horizon. */
  readonly idempotencyTtlDays: number
  /**
   * Where micro-admin-api is, for the fee-recycle percentage — docs/ecosystem/21 §3.
   *
   * **`null` is a supported mode and means something true**: this deployment runs no engagement
   * programme, so no share of fee revenue is recycled into the treasury. The recycle job still
   * runs and still finishes any period the ledger already owes an answer about; it closes no new
   * ones. That is the notify-SMTP discipline — unconfigured is a state, not a fault — and it is
   * also the honest reading, because the rate itself lives in admin-api and a deployment without
   * one has nobody to ask.
   *
   * Note what is NOT here: a `BILLING_FEE_RECYCLE_BPS`. The percentage is an approval-gated
   * operator decision (21 §6) and a copy of it in this repository would be a second thing to
   * raise, bypassing the gate.
   */
  readonly adminApiBaseUrl: string | null
  readonly adminApiDeadlineMs: number
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

/**
 * Pure over its source so the failure paths are testable without mutating the process. The eager
 * export below is what makes the service fail fast.
 */
export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }

  // Read before the object literal because the accept list falls back to it.
  const outboxSigningSecret = requiredSigningSecret(source, 'OUTBOX_SIGNING_SECRET')

  const ledgerBaseUrl = required(source, 'BILLING_LEDGER_URL')
  if (!/^https?:\/\//i.test(ledgerBaseUrl)) {
    throw new EnvError(`BILLING_LEDGER_URL must be an absolute http(s) URL (got ${ledgerBaseUrl})`)
  }

  // REQUIRED, unlike ADMIN_API_URL. The recycle is an optional programme; pricing is on the
  // purchase path, so an unset URL is not "this deployment does without" — it is every purchase
  // failing at the moment of payment, which is a refusal that belongs at boot naming the variable.
  const pricingBaseUrl = required(source, 'BILLING_PRICING_URL')
  if (!/^https?:\/\//i.test(pricingBaseUrl)) {
    throw new EnvError(`BILLING_PRICING_URL must be an absolute http(s) URL (got ${pricingBaseUrl})`)
  }

  // Optional as a pair. Set neither (no engagement programme here) or set both — a URL with no
  // token would boot happily and then fail every hour inside a job, which is the failure mode
  // this file exists to convert into a refusal at startup naming the variable.
  const adminApiRaw = source['ADMIN_API_URL']?.trim()
  const adminApiBaseUrl = adminApiRaw && adminApiRaw.length > 0 ? adminApiRaw : null
  if (adminApiBaseUrl !== null && !/^https?:\/\//i.test(adminApiBaseUrl)) {
    throw new EnvError(`ADMIN_API_URL must be an absolute http(s) URL (got ${adminApiBaseUrl})`)
  }

  return {
    port: integer(source, 'PORT', 4000, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'BILLING_DATABASE_URL'),
    databaseUrlTestnet: source['BILLING_DATABASE_URL_TESTNET'] ?? '',
    singleNetwork: source['CF_NETWORK_SINGLE'] ?? '',
    // A pool larger than the database's own connection budget divided by the replica count is a
    // service that exhausts Postgres for everything else the moment it scales.
    databasePoolMax: integer(source, 'BILLING_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret,
    acceptSecrets: parseSecretList(
      optional(source, 'OUTBOX_ACCEPT_SECRETS', outboxSigningSecret),
      'OUTBOX_ACCEPT_SECRETS',
    ),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),
    ledgerBaseUrl,
    identityUrl: optional(source, 'IDENTITY_URL', required(source, 'IDENTITY_ISSUER')),
    // Optional, not required: see the field comment. The absence is caught by `/readyz`, which is
    // a check that can fail, rather than by a boot CI cannot perform. PRESENT is now held to the
    // credential SHAPE rather than to a deny-list plus 24 characters (micro-org #212).
    identityCredential: optionalCredential(source, 'BILLING_IDENTITY_CREDENTIAL'),
    legacyServiceTokenPresent:
      (source['BILLING_LEDGER_TOKEN']?.trim() ?? '').length > 0 ||
      (source['BILLING_ADMIN_API_TOKEN']?.trim() ?? '').length > 0,
    ledgerDeadlineMs: integer(source, 'BILLING_LEDGER_DEADLINE_MS', 5_000, 250, 30_000),
    priceAsset: 'USD',
    settlementAsset: 'EMBER',
    pricingBaseUrl,
    pricingDeadlineMs: integer(source, 'BILLING_PRICING_DEADLINE_MS', 5_000, 250, 30_000),
    idempotencyTtlDays: integer(source, 'BILLING_IDEMPOTENCY_TTL_DAYS', 30, 1, 3_650),
    adminApiBaseUrl,
    adminApiDeadlineMs: integer(source, 'BILLING_ADMIN_API_DEADLINE_MS', 5_000, 250, 30_000),
  }
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and
 * the only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand. It is built from a literal rather than routed through
 * the telemetry package: nothing that can itself fail may sit between a configuration error and
 * the report of it. The message is the one `loadEnv` produced, which by construction never
 * contains a value.
 */
function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  )
  process.exit(1)
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname())
  } catch (err) {
    fatalConfig(err)
  }
})()
