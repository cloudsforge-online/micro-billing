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

const PLACEHOLDERS = new Set([
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'dev-secret',
  'dev-outbox-signing-secret',
  'replace-with-a-real-secret',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
])

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

function requiredSecret(source: Source, name: string, minLength = 24): string {
  const value = required(source, name)
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new EnvError(`${name} is set to a known placeholder — generate a real secret`)
  }
  // Length is a proxy for entropy and the only one available here. It is set above the point at
  // which a human-chosen string is plausible, so a memorable password fails this check too.
  if (value.length < minLength) {
    throw new EnvError(`${name} must be at least ${minLength} characters (got ${value.length})`)
  }
  return value
}

/**
 * A secret that may be absent, but must be real if present.
 *
 * The distinction matters for the identity credential: absent is a deployment that has not been
 * given one yet and is reported by `/readyz`; a short placeholder is a deployment that believes it
 * HAS one, and would fail on its first call to a peer with a 401 that reads as "identity rejected
 * billing" rather than "nobody set this variable".
 */
function optionalSecret(source: Source, name: string, minLength = 24): string | null {
  const value = source[name]?.trim()
  if (!value) return null
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new EnvError(`${name} is set to a known placeholder — generate a real secret`)
  }
  if (value.length < minLength) {
    throw new EnvError(`${name} must be at least ${minLength} characters (got ${value.length})`)
  }
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
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  /** HMAC key for outbound event signatures, so a subscriber can prove an event came from us. */
  readonly outboxSigningSecret: string
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
   * tokens read once at boot (identity/src/tokens.ts:28). Ten minutes into any deployment they
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
   * What a purchase is denominated in. SHARD, because Shards are the platform's unit of account
   * and are funded by on-chain deposit only — there is no fiat path to configure.
   */
  readonly purchaseAsset: LedgerAssetCode
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

  const ledgerBaseUrl = required(source, 'BILLING_LEDGER_URL')
  if (!/^https?:\/\//i.test(ledgerBaseUrl)) {
    throw new EnvError(`BILLING_LEDGER_URL must be an absolute http(s) URL (got ${ledgerBaseUrl})`)
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
    // A pool larger than the database's own connection budget divided by the replica count is a
    // service that exhausts Postgres for everything else the moment it scales.
    databasePoolMax: integer(source, 'BILLING_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: requiredSecret(source, 'OUTBOX_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),
    ledgerBaseUrl,
    identityUrl: optional(source, 'IDENTITY_URL', required(source, 'IDENTITY_ISSUER')),
    // Not `requiredSecret`: see the field comment. The absence is caught by `/readyz`, which is
    // a check that can fail, rather than by a boot CI cannot perform.
    identityCredential: optionalSecret(source, 'BILLING_IDENTITY_CREDENTIAL'),
    legacyServiceTokenPresent:
      (source['BILLING_LEDGER_TOKEN']?.trim() ?? '').length > 0 ||
      (source['BILLING_ADMIN_API_TOKEN']?.trim() ?? '').length > 0,
    ledgerDeadlineMs: integer(source, 'BILLING_LEDGER_DEADLINE_MS', 5_000, 250, 30_000),
    purchaseAsset: 'SHARD',
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
