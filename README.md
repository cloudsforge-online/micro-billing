# `micro-billing`

[![ci](https://github.com/cloudsforge-online/micro-billing/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-billing/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml) [![licence](https://img.shields.io/badge/licence-MIT-blue)](./LICENSE)

The catalogue, purchases, subscriptions and — the part this service exists for — **entitlements
with a scope, an expiry and a revocation**. It answers "does this subject own this thing, for this
title, right now" to a *service*, which is a question nothing in the estate could previously ask.

Design authority: [`ecosystem/03-repository-responsibilities.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/03-repository-responsibilities.md)

> **It holds no money.** Every purchase, renewal and refund is a balanced journal entry posted to
> `micro-ledger` over HTTP with a scoped token. There is no second connection string in
> `src/env.ts`, and the file says why: a shared connection string would make the ledger's constraint
> triggers optional for anything holding it (`src/env.ts:92-96`). AD-06.

> **There is no fiat path to configure.** `purchaseAsset` is the literal `'SHARD'`
> (`src/env.ts:165`) — not a variable — because Shards are the platform's unit of account and are
> funded by on-chain deposit only (`src/env.ts:123-126`).

---

## The four things the estate's entitlements lack

`src/entitlements.ts:4-20` names them, and each is a live defect the schema now refuses:

1. **A scope.** `platform`, `title:<id>` or `community:<id>`, so a service can ask "does this user
   own X *for this title*". The estate's row is `(userId, sku, kind)`, so **a private world rented
   for one title is indistinguishable from one rented for another — which is part of why a
   purchased private world is never provisioned.**
2. **An expiry.** So a season pass ends. The estate grants `SEASON_PASS` once and for ever, so
   season two cannot be sold to anybody who bought season one.
3. **Revocation.** So a refund removes what it paid for. There is **no revocation column in the
   estate at all**; a refunded purchase leaves its entitlement standing.
4. **A service-readable API.** The estate's `GET /entitlements` is Bearer-only
   (`monetization.ts:32`), so **no service can ask whether a user owns anything** — a world server
   holding no user token has no way to find out that a world was bought.
   `GET /internal/entitlements/:userId` is that missing API, and it is why `subject` is an
   `AccountSubject` rather than a bare user id.

**Activity is decided in two places and they must agree.** `isEntitlementActive` in
`contracts-money` is the contract every consumer evaluates; `ACTIVE_PREDICATE` is the SQL the list
query filters on. A test asserts they agree on the boundary cases, "because a service whose list
says *owned* and whose check says *not owned* is worse than either answer alone"
(`src/entitlements.ts:21-25`).

---

## `granted_at` must come from one clock domain

This is the defect that made tests pass by luck until the wall clock overtook a fixture, and it is
the most easily re-introduced line in the repository.

`grantedAt` is **supplied by the application, never left to the column's `now()` default**
(`src/entitlements.ts:167`, applied at `:203`). The schema still carries
`granted_at timestamptz not null default now()` (`src/migrations.ts:274`) — the default remains for
a hand-written row, but every grant this service makes overrides it.

Why (`src/entitlements.ts:169-176`): every timestamp the activity rule reads — `granted_at`,
`expires_at`, `revoked_at` — must come from one clock. Defaulting `granted_at` to the database's
`now()` mixed two: the row was stamped with the **database's** clock and `isEntitlementActive` then
compared it against the **caller's**, so a few tens of milliseconds of skew between two hosts made a
just-granted entitlement read as "not yet active" — **and the purchase response said
`active: false` for something the customer had at that moment paid for**. It was caught by the tests
here on a host whose Postgres clock ran 60 ms ahead. Before that host, the same code passed.

---

## Routes

Read out of `src/server.ts`. `authenticate()` resolves the bearer token and nothing more
(`src/server.ts:651`); scope is checked per-route and, except on `/internal/…`, **only for service
principals**.

| Method | Path | Who | Idempotency-Key | What it does |
| --- | --- | --- | --- | --- |
| `GET` | `/livez` | **no auth** | — | liveness (`src/server.ts:349`) |
| `GET` | `/readyz` | **no auth** | — | 200/503 (`src/server.ts:351`) |
| `GET` | `/metrics` | **no auth** | — | Prometheus text (`src/server.ts:356`) |
| `GET` | `/products` | **no auth** | — | the catalogue. Public: a catalogue behind a token cannot be browsed (`src/server.ts:375`) |
| `POST` | `/purchases` | user or admin; service needs `billing:grant` | **required** | buys a SKU: one ledger entry, one entitlement, one transaction. 201 fresh, **200 on a replay** (`src/server.ts:409`, key at `:415-419`) |
| `GET` | `/entitlements` | user or admin; service needs `billing:read` | — | what the calling user owns. Supports `at`, `scope`, `sku`, `includeInactive`, `limit` (`src/server.ts:473`) |
| `GET` | `/internal/entitlements/:userId` | **service only**, `billing:read` | — | **the service-readable API.** A user token is refused here **even for its own id** (`src/server.ts:505`, refusal at `:507-509`) |
| `POST` | `/entitlements/:id/revoke` | user or admin; service needs `billing:grant` | — | revokes, optionally refunding. **A reason is required either way** (`src/server.ts:544`, reasoning at `:537-543`) |
| `GET` | `/subscriptions` | user or admin; service needs `billing:read` | — | the caller's subscriptions (`src/server.ts:580`) |

**Four routes make no `authenticate()` call**: `/livez`, `/readyz`, `/metrics` and `/products`.

**`GET /internal/entitlements/:userId` refuses a user token even for that user's own id**
(`src/server.ts:507`). That is not an oversight: the route exists for services, users have
`GET /entitlements` which runs the same query, and "a route that quietly accepted both would make
the scoped-token boundary decorative" (`src/server.ts:499-503`).

### The `Idempotency-Key` on `/purchases` is mandatory

The header is read first and an `idempotencyKey` body field is accepted as a fallback; **absent
both, the request is a 400** (`src/server.ts:415-419`). The reason is stated at `src/server.ts:405`:
*an optional idempotency key is an idempotency key that is absent on the one request that gets
retried, and a purchase is exactly the shape of request a client retries after a timeout.*

The fingerprint covers the request **as sent**, so the same key with a different body is refused
rather than answered with the first request's result (`src/server.ts:441-442`).

`scope` on a read is **parsed, not passed through**: it is a lookup key, and an unvalidated one is a
query parameter that decides which rows a service is shown (`src/server.ts:594-597`).

---

## One purchase, one entry — and there are two idempotency keys

`src/purchases.ts:1-26` is the argument, and it is worth reading before changing anything here.

* **The caller's key**, claimed in `idempotency_keys`, makes the *purchase* happen once.
* **A key derived from it**, sent to the ledger, makes the *entry* post once.

The second is **derived rather than random** precisely so that a purchase transaction which rolls
back *after* posting cannot post again on the retry: the ledger recognises the key and replays its
stored answer. Without it, a crash between the ledger's COMMIT and this service's would **charge the
customer twice and grant them nothing** — which is the estate's failure mode today, where the shard
debit and the entitlement insert are two writes with nothing joining them.

**Why the HTTP call is inside the transaction** (`src/purchases.ts:20-25`): it holds a database
connection for the length of a bounded remote call, which is a real cost and the reason
`BILLING_LEDGER_DEADLINE_MS` exists. The alternative — commit the purchase, post the entry from a
job — **grants the entitlement before the money has moved**, so a customer with no balance receives
what they did not pay for and the reversal is a customer-visible retraction. "Between *hold a
connection for five seconds* and *give away the thing*, this is not a close decision."

The grant and its `billing.entitlement.granted` event commit together, through the outbox, in the
caller's transaction. Publishing after the commit loses the event when the process dies in the gap —
**and a lost `granted` event is a customer who paid for a world that never appears**
(`src/entitlements.ts:187-196`). That topic is the one `micro-worlds` subscribes to.

---

## Background work

Leased jobs only. **The lease key names the contended resource** (`src/jobs.ts:9-32`).

| Job | Lease key | Cadence | What two replicas do |
| --- | --- | --- | --- |
| `outbox.relay` | `stream` | 1s | one claims the stream (`src/jobs.ts:81`) |
| `billing.entitlement.expire` | `global` | 60s | nothing breaks, **but two sweeps would emit two `revoked` events for one expiry — and a subscriber that tears down a world on that event would do it twice.** The UPDATE uses `SKIP LOCKED` as a second line of defence (`src/jobs.ts:85`, reasoning at `:16-20`) |
| `billing.subscription.renew` | `subscription:<id>` | on demand | keyed on **the subscription**. Keying on the customer would serialise their subscriptions for no reason; keying globally would make one slow renewal hold up every other; **keying on the period would let a retry after a period advance charge the next period early** (`src/jobs.ts:21-26`) |
| `billing.renewals.scan` | `global` | 5min | enqueues renewal jobs; two scans enqueue each twice, collapsed by the `(kind, key)` uniqueness, but the second scan is pure waste against the same index (`src/jobs.ts:86`) |
| `billing.idempotency.reap` | `global` | 24h | nothing, but two long DELETEs compete for the row locks at the head of every purchase (`src/jobs.ts:87`) |

The expiry sweep runs every **minute**, and the interval is deliberately not load-bearing: **an
expired entitlement already fails every check the moment it expires** — activity is computed against
`expires_at`, not against this sweep — so the interval bounds only how late the `revoked` event is,
never how long access lingers (`src/jobs.ts:82-84`).

---

## The database

`products`, `prices`, `purchases`, `subscriptions`, `entitlements`, `invoices`, `payouts`,
`idempotency_keys`, plus `jobs`/`outbox`/`inbox`. Migration 9 **seeds the catalogue** rather than
leaving it empty, so that a fresh deployment has something to serve and so that **the two products
whose defects this service exists to fix — the season pass, which must end, and the private world,
which must be scoped to its title — exist from the start** (`src/migrations.ts:392-399`).

| Constraint | Refuses | Why it is here rather than in a handler |
| --- | --- | --- |
| `entitlements.scope` CHECK — `'platform'`, `like 'title:%'`, `like 'community:%'` | an unscoped or arbitrarily-scoped grant | **without a scope no service can ask "does this user own X for this title", which is why a purchased private world is never built.** Making it a column with a domain rather than a convention is what stops the next writer omitting it (`src/migrations.ts:267-269`) |
| `entitlements_expiry_after_grant` — `expires_at is null or expires_at > granted_at` | an entitlement that expires before it starts | it also pins the two timestamps into one comparable domain at the storage layer, which is the same invariant the clock-domain note above protects in the application (`src/migrations.ts:293-294`) |
| `entitlements.source` CHECK — `purchase`, `subscription`, `grant`, `reward`, `migration` | a provenance nobody enumerated | "where did this entitlement come from" is the first question in a dispute, and an unenumerated answer is not one (`src/migrations.ts:271-272`) |
| `entitlements.quantity numeric(78,0) check (quantity >= 0)` | a negative holding | `numeric(78,0)` for the same reason every quantity here is: a JSON number cannot carry it (`src/migrations.ts:282`) |
| `entitlements_live_idx`, a **partial** index `where revoked_at is null` | — | the service-readable lookup's access path. **Partial on the live set, because a revoked grant is history and the question is always about now** (`src/migrations.ts:298-301`) |
| `entitlements_expiring_idx`, partial `where revoked_at is null and expires_at is not null` | — | the expiry sweep's access path; perpetual grants are not scanned (`src/migrations.ts:306-308`) |
| `payouts_net_consistent` — `platform_fee <= gross and net = gross - platform_fee` | a payout whose parts do not add up | **this is the arithmetic reconciliation cannot see**: such a payout balances perfectly as a journal entry while paying the wrong amount. It is `isPayoutConsistent` from `contracts-money`, "enforced where a psql session has to obey it too" (`src/migrations.ts:381-382`, reasoning at `:378-380`) |
| `payouts.journal_entry_id` | — | a payout is a ledger movement plus optionally a withdrawal, **never a separate money system**, and this column is what makes that checkable rather than aspirational (`src/migrations.ts:370-372`) |
| `entitlements.journal_entry_id` | — | the entry that paid for the grant. A refund reverses **this** id and revokes the row — one operation with one identifier, rather than a hunt through the journal (`src/migrations.ts:286-288`) |

`entitlements.subject` is an **`AccountSubject`** (`user:<uuid>`, `community:<id>`,
`organisation:<id>`), the same shape the ledger uses, so a grant and the entry that paid for it name
their holder identically (`src/migrations.ts:257-260`).

---

## Configuration

`.env.example` and `src/env.ts` were cross-checked. Every variable `loadEnv` reads is present and
nothing extra is declared — **with one wording disagreement**, recorded under Known gaps: the file
says `OUTBOX_SIGNING_SECRET` needs "at least 32 random characters" and the code enforces **24**.

| Variable | Default | If it is wrong or missing |
| --- | --- | --- |
| `PORT` | `4000` | integer 1–65535 (`src/env.ts:150`) |
| `NODE_ENV` | `development` | labelling only (`src/env.ts:151`) |
| `LOG_LEVEL` | `info` | outside the four levels, boot fails (`src/env.ts:140`) |
| `CLOUDSFORGE_TAG` | `dev` | the reported version is wrong (`src/env.ts:152`) |
| `BILLING_DATABASE_URL` | — | **required** (`src/env.ts:154`). Rule 1 — and note what is deliberately absent: no URL for the ledger's database (`src/env.ts:92-96`) |
| `BILLING_DATABASE_POOL_MAX` | `10` | 1–100. Larger than the database's budget divided by the replica count exhausts Postgres for everything else the moment billing scales (`src/env.ts:157`) |
| `IDENTITY_JWKS_URL` | — | **required**; unreachable → 503, never 401 (`src/env.ts:158`) |
| `IDENTITY_ISSUER` | — | **required**; wrong → universal 401 (`src/env.ts:159`) |
| `OUTBOX_SIGNING_SECRET` | — | **required, ≥24 chars, placeholders refused** (`src/env.ts:160`) |
| `INSTANCE_ID` | hostname | names this replica in `jobs.locked_by` (`src/env.ts:161`) |
| `BILLING_LEDGER_URL` | — | **required, and validated as an absolute `http(s)` URL** at boot rather than at first purchase (`src/env.ts:144-147`) |
| `BILLING_IDENTITY_CREDENTIAL` | — | **≥24 chars, `cfsc_…`.** The long-lived credential exchanged at `POST /service-tokens/exchange` for short-lived tokens. Replaces `BILLING_LEDGER_TOKEN` **and** `BILLING_ADMIN_API_TOKEN`: both were 600-second tokens read once at boot, so ten minutes into every deployment every posting to the ledger failed. One credential, two narrow tokens — the scope set is a request parameter, not a second secret. Technically optional so the image can boot for CI's `/livez` smoke test; `/readyz` fails hard without it |
| `IDENTITY_URL` | `IDENTITY_ISSUER` | where the credential is exchanged. Only set it where the issuer and the dialled address genuinely differ |
| `BILLING_LEDGER_TOKEN`, `BILLING_ADMIN_API_TOKEN` | — | **retired.** 600-second tokens read once at boot. If either is still set, boot logs that it is ignored |
| `BILLING_LEDGER_DEADLINE_MS` | `5000` | 250–30000. **It bounds how long the purchase transaction stays open**, because the posting happens inside it. Too generous and a slow ledger holds a database connection per in-flight purchase; too tight and a healthy retry never completes (`src/env.ts:164`, reasoning at `:115-121`) |
| `BILLING_IDEMPOTENCY_TTL_DAYS` | `30` | 1–3650. **Expiring a key early means the next replay of it buys the thing a second time**, so this must outlive every caller's retry horizon (`src/env.ts:166`) |
| `BILLING_TEST_DATABASE_URL` | — | tests only; the name must contain `test`. Unset, every database-backed test **skips** |

`purchaseAsset` is **not configurable**: it is the literal `'SHARD'` (`src/env.ts:165`).

---

## What it talks to

| Upstream | Routes called | When it is down |
| --- | --- | --- |
| `micro-ledger` | `POST /entries` (`src/ledger.ts:159`) and `POST /entries/:id/reverse` for a refund (`src/ledger.ts:184`), verified against `ledger/src/server.ts:346` and `:394`, reached with a token exchanged from `BILLING_IDENTITY_CREDENTIAL` | **fail closed, and structurally so.** The posting happens *inside* the purchase transaction (`src/purchases.ts:20-25`), so a ledger outage fails the purchase whole: no entitlement is granted, no `granted` event is emitted, and the customer is told. The alternative grants the thing before the money moves |
| `micro-identity` | its JWKS at `IDENTITY_JWKS_URL` | domain routes answer 503, never 401 |
| `event_subscriptions` rows | signed HMAC deliveries from the outbox relay | fail open, per subscriber; the undelivered row is the durable record |

Downstream: **`micro-worlds` subscribes to `billing.entitlement.granted`**
(`src/entitlements.ts:39`) — that topic is what finally provisions the private world that today is
sold and never built (04-domain-model.md §8.1). `billing.entitlement.revoked` is the other half, and
the expiry sweep's lease key exists so it is emitted once.

---

## Running it

```bash
pnpm install
pnpm typecheck

# Migrations are a one-shot job and are NEVER run by the service process.
BILLING_DATABASE_URL=postgres://billing:billing@127.0.0.1:55436/billing pnpm migrate
pnpm start
```

The suite needs a real Postgres whose database name contains `test` — it truncates between cases:

```bash
docker run -d --rm --name billing-pg \
  -e POSTGRES_USER=billing -e POSTGRES_PASSWORD=billing -e POSTGRES_DB=billing_test \
  -p 55436:5432 postgres:17-alpine

BILLING_TEST_DATABASE_URL=postgres://billing:billing@127.0.0.1:55436/billing_test pnpm test
```

`.env.test.example` carries the full set for a local run (`source .env.test`).

**90 `test(` declarations**, `node:test` only. The ledger is faked at the client interface, so what
the suite proves is the purchase state machine, the idempotency pairing and the constraints — not
that `micro-ledger` answers as this service expects. The clock-domain defect above is the standing
argument for running the suite on more than one host.

CI is the estate's reusable `service-ci.yml` and fails the build if the database-backed suite
skipped.

---

## Known gaps

* **`.env.example` and `src/env.ts` disagree on the secret length.** The file says
  `OUTBOX_SIGNING_SECRET` must be "at least 32 random characters" (`.env.example:23-24`);
  `requiredSecret` is called without a length override, so the enforced minimum is the default **24**
  (`src/env.ts:160`, default at `:57`). The comment is the stricter of the two, so nothing insecure
  follows — but a 26-character secret satisfies the code and contradicts the file. **Reported, not
  edited**, per this change's remit. `micro-ledger`'s `.env.example` carries the identical wording
  and the identical mismatch.
* **The example secret would boot.** `OUTBOX_SIGNING_SECRET=CHANGE_ME_TO_32_RANDOM_CHARACTERS` is 33
  characters and is not in the `PLACEHOLDERS` set (`src/env.ts:38-47`), so a deployment that copies
  `.env.example` unchanged starts successfully with a secret that is in the public repository. The
  placeholder guard catches `changeme` and `CHANGE_ME` but not this spelling. `micro-ledger` and
  `micro-billing` both ship it; `micro-indexer` and `micro-mint` ship the variable **empty**, which
  fails closed and is the better pattern.
* **`.env.test` and `.env.test.example` are committed with real-looking values** —
  `OUTBOX_SIGNING_SECRET='K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4'` and a matching
  `BILLING_IDENTITY_CREDENTIAL`. They are test-only and the database they name is a local `_test`, so
  nothing is disclosed; but they are indistinguishable from real credentials to a scanner and to a
  reader.
* **`/metrics` is unauthenticated** (`src/server.ts:356`).
* **No path versioning.** This service serves `/purchases`, not `/v1/purchases`
  (`docs/ecosystem/18-build-status.md` §3.3d, item 3).
* **No OpenAPI description**, estate-wide (§3.3d, item 1).
* **Payouts are modelled and not driven.** `payouts` carries the consistency constraint and the
  `journal_entry_id` seam (`src/migrations.ts:360-383`), and no job moves a row through
  `pending → approved → paid`.

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.
