/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * Each step below carries the reason it must precede the next; the ordering is the substance of
 * this file, and getting it wrong reproduces a defect the estate already has.
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a
 * separate one-shot process. See AD-17 and rule 7.
 *
 * Traces are exported by the OpenTelemetry SDK loaded ahead of this module —
 * `NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register` in the deploy, which
 * reads `OTEL_EXPORTER_OTLP_ENDPOINT` and friends from the environment itself. That is why no
 * `OTEL_*` variable appears in `src/env.ts`: the service does not read them, so under rule 9 it
 * must not declare them.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, type Sql as DbSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier } from '@cloudsforge/auth'
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { SERVICE, env } from './env.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { createServer, registerServiceMetrics } from './server.ts'
import { registerHandlers, rescheduleRecurring, seedRecurring, type JobDeps } from './jobs.ts'
import { httpLedgerClient } from './ledger.ts'
import type { PurchaseDeps } from './purchases.ts'
import type { Db } from './outbox.ts'

// 1. Environment. Importing `./env.ts` validated it; a missing or placeholder secret has already
//    exited with a structured line naming the variable.

// 2. Telemetry, before anything that can fail. A logger that exists before the pool means the
//    pool's failure is a structured, searchable, redacted line rather than a bare V8 stack the
//    collector drops.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
})
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
logger.info('starting', { version: env.version, schemaVersion: SCHEMA_VERSION })

// 3. The database pool. Opened before the schema assertion because the assertion is a query, and
//    before the Lifecycle because the readiness probe closes over it.
const sql = postgres(env.databaseUrl, {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a
  // connection string ends up in a log the collector cannot parse.
  onnotice: () => {},
})

// 4. Assert the schema. This does **not** migrate. It matters here because the entitlements table
//    is the service: a replica running against a schema without `scope`, `expires_at` or
//    `revoked_at` would grant entitlements that no service can scope, that never end and that a
//    refund cannot take back — which is precisely the state this service exists to leave behind.
try {
  // The runtime packages accept a narrow structural `Sql` rather than importing postgres.js, so
  // they stay testable and driver-swappable. The cast is the price of that.
  await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 5. The Lifecycle and its probes, before the routes, because `/readyz` is a route and it needs
//    something to report. The service is `starting` from here until `markReady()`.
const lifecycle = new Lifecycle({
  // Must exceed one load-balancer probe interval, or the balancer is still sending traffic when
  // the process stops accepting it.
  drainDelayMs: 5_000,
  drainTimeoutMs: 25_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
})

lifecycle
  .addProbe(
    postgresProbe('postgres', (signal) =>
      // The probe deadline is enforced by the Lifecycle's AbortSignal, but a driver that ignored
      // the signal would hang `/readyz` for ever. Racing the signal here is what turns "the
      // database is not answering" into a fail rather than a hung readiness endpoint.
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
        }),
      ]),
    ),
  )
  .addProbe(
    // Soft. If identity is down this service still serves the catalogue and every entitlement
    // check a service token has already been issued for — and marking it hard means one identity
    // blip removes every service in the estate from its balancer at once, which is a cascade.
    httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }),
  )
  .addProbe(
    // Soft, and this one is a genuine judgement call. A ledger that is down means no purchase can
    // complete — but entitlement checks, the catalogue and the subscription list all still work,
    // and those are what the rest of the estate depends on this service for. Answering 503 on
    // `/readyz` would take the entitlement API out too, so a purchase outage would become an
    // "everybody loses access to what they already bought" outage.
    httpProbe('ledger', `${env.ledgerBaseUrl.replace(/\/+$/, '')}/livez`, { kind: 'soft' }),
  )

const ledger = httpLedgerClient({
  baseUrl: env.ledgerBaseUrl,
  // Async by contract, so the ten-minute service token identity issues can be refreshed here
  // without anything else in the service changing.
  token: () => env.ledgerToken,
  deadlineMs: env.ledgerDeadlineMs,
  originatingService: SERVICE,
})

const purchases: PurchaseDeps = {
  sql: sql as unknown as Db,
  ledger,
  producer: SERVICE,
  assetCode: env.purchaseAsset,
}

// 6. Routes. Constructed after the Lifecycle so the health handlers report real state, and after
//    the pool so the stores are real rather than a lazily-connected surprise on first request.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })
const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  sql: sql as unknown as Db,
  purchases,
  // Sampled at scrape time rather than on a timer. There is no `setInterval` in this repository
  // and CI greps for one — rule 8. A scrape is already periodic, so the scrape is when to sample.
  beforeScrape: async () => {
    const stats = await queue.stats()
    metrics.set('jobs_pending', stats.pending)
    metrics.set('jobs_overdue', stats.overdue)
  },
})

// 7. The job runner, started before `listen()`. Background work is claimed under a lease, so a
//    replica that is draining stops claiming before it stops serving — `shouldClaim` is wired to
//    the Lifecycle for exactly that.
const jobDeps: JobDeps = {
  sql: sql as unknown as Db,
  logger,
  metrics,
  ledger,
  producer: SERVICE,
  assetCode: env.purchaseAsset,
  signingSecret: env.outboxSigningSecret,
  idempotencyTtlDays: env.idempotencyTtlDays,
}

const queue = new JobQueue(sql as unknown as JobsSql, { owner: env.instanceId })
const reschedule = rescheduleRecurring(queue, logger)
const runner = new JobRunner({
  queue,
  concurrency: 4,
  pollMs: 1_000,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind })
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind })
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind })
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind })
      if (event.durationMs !== undefined) {
        metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind })
      }
    }
    if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
      logger.error('job failure', { ...event })
    }
    reschedule(event)
  },
})

registerHandlers(runner, jobDeps)
await seedRecurring(queue)
runner.start()

// 8. Listen. Last of the construction steps, because a socket that accepts before its dependencies
//    exist is a socket that answers 500.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve())
})
logger.info('listening', { port: env.port })

// 9. Ready. Only now: the state moves `starting → ready`, `/readyz` starts answering 200, and the
//    balancer is allowed to send traffic.
lifecycle.markReady()

// 10. Signal handlers, last of all. Installing them earlier means a SIGTERM arriving mid-boot
//     drains a service that was never ready, and the drain races the construction above.
//     Hooks run in reverse registration order, so the server closes first, then the runner stops
//     claiming and drains, then the pool closes with nothing left to use it.
//
//     The drain matters more here than in most services: a purchase holds a transaction open
//     across a ledger call, and cutting it mid-flight loses the response to a caller whose money
//     may already have moved. `lifecycle.track()` around the purchase route is what makes the
//     drain wait for it.
lifecycle.onShutdown(async () => {
  await sql.end({ timeout: 5 })
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  const clean = await runner.stop(20_000)
  logger.info('job runner stopped', { clean })
})
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Idle keep-alive sockets hold the server open past the drain budget. Closing them is what
      // makes `server.close()` a bounded operation rather than a wait on the slowest client.
      server.closeIdleConnections()
    }),
)

installSignalHandlers(lifecycle)
