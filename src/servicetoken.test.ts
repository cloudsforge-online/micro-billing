/**
 * **The ten-minute cliff, end to end, through the wiring this service actually uses.**
 *
 * `@cloudsforge/auth` proves the provider in isolation. This file proves the ADOPTION, which is a
 * different claim and the one that was wrong here.
 *
 *     const token = () => env.serviceToken        // src/index.ts, before this change
 *
 * A string read once at boot, from a token that expires in 600 seconds
 * (identity/src/tokens.ts), which nothing could re-mint because minting required the `admin`
 * role. Every peer call in this service began failing ten minutes into every deployment.
 *
 * WHY THIS SUITE COULD NOT SEE IT, AND WHY THIS FILE IS SHAPED AS IT IS. Every other test here
 * builds a client against a fake peer and calls it immediately. A token minted at the top of such
 * a test is seconds old when it is used, so it is never asked to survive its own lifetime. **A
 * test that mints a token and immediately uses it proves nothing about this defect.** The test
 * below moves a simulated clock eleven minutes past a token it already holds, asserts that token
 * is now REFUSED BY A REAL `Verifier`, and only then asserts the client still works.
 *
 * It goes through the real `buildUpstreams` — not a hand-rolled provider — because "the provider
 * is correct" and "the provider is wired in" are separate failures, and only the second one was
 * ever the bug here.
 *
 * THE CLOCK IS SIMULATED, NOT WAITED ON. `mock.timers` moves `Date` only; jose decides expiry from
 * `Date.now()`, so an eleven-minute jump is indistinguishable to it from eleven real minutes.
 * `setTimeout` is deliberately NOT mocked — the provider awaits promises that real timers settle.
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { SignJWT, generateKeyPair } from 'jose'
import { AUDIENCE, Verifier, serviceTokenProbe } from '@cloudsforge/auth'
import { buildUpstreams, type Upstreams, type UpstreamEnv } from './upstreams.ts'

/**
 * One ledger posting, which is the only outbound call this service makes on the money path.
 *
 * A fresh idempotency key per call: `@cloudsforge/http` attempts a POST exactly once WITHOUT one,
 * and this test needs the request to actually be made. Reusing a key across calls would also make
 * a real ledger collapse them, which would hide the very thing being counted here.
 */
let posting = 0
const postOnce = (upstreams: Upstreams) =>
  upstreams.ledger.postEntry({
    kind: 'purchase',
    actor: 'service:billing',
    correlationId: `test-${++posting}`,
    idempotencyKey: `test-${posting}`,
    postings: [],
  })

const ISSUER = 'https://identity.test'
const IDENTITY = 'http://identity:4000'
const PEER = 'http://ledger:4000'
const CREDENTIAL = 'cfsc_a-long-lived-credential-that-does-not-expire'

/** identity/src/tokens.ts. Unchanged by this fix, and it must stay unchanged. */
const SERVICE_TTL_SECONDS = 600

const T0 = Date.UTC(2026, 7, 3, 12, 0, 0)

/** Move the whole world — the provider's clock and jose's expiry check — to `T0 + ms`. */
function clockAt(ms: number): void {
  mock.timers.reset()
  mock.timers.enable({ apis: ['Date'], now: new Date(T0 + ms) })
}

interface World {
  readonly fetch: typeof globalThis.fetch
  exchanges: number
  peerCalls: Array<{ token: string | null; status: number }>
  identityDown: boolean
}

/**
 * A real identity and a real peer, in the sense that matters: identity signs RS256 tokens with a
 * 600-second expiry against the simulated clock, and the peer hands whatever it is given to a real
 * `Verifier` and answers 401 when jose says the token is bad. Nothing here decides expiry by hand
 * — deciding it by hand is how a test comes to agree with the code it is meant to be checking.
 */
async function world(): Promise<World> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  // A local key set standing in for the remote JWKS: jose's remote set is a function of the
  // protected header, so a local resolver has the same shape.
  const keySet = (async () => publicKey) as never
  const verifier = new Verifier({ jwksUrl: 'http://unused', issuer: ISSUER, keySet })

  // RS256 is deterministic, so two tokens signed from the same payload at the same simulated
  // instant are the same string. identity mints a uuidv7 jti per token; the counter restores that.
  let jti = 0

  const self: World = {
    exchanges: 0,
    peerCalls: [],
    identityDown: false,
    fetch: (async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

      if (url.startsWith(IDENTITY)) {
        if (self.identityDown) throw new TypeError('fetch failed: ECONNREFUSED')
        if (new Headers(init?.headers).get('authorization') !== `Bearer ${CREDENTIAL}`) {
          return new Response('{"error":"unauthenticated"}', { status: 401 })
        }
        self.exchanges += 1
        const token = await new SignJWT({ typ: 'service', scopes: ['ledger:read', 'ledger:post', 'ledger:reserve'], jti: `t-${++jti}` })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuedAt()
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setSubject('service:billing')
          .setExpirationTime(Math.floor(Date.now() / 1000) + SERVICE_TTL_SECONDS)
          .sign(privateKey)
        return new Response(
          JSON.stringify({ token, service: 'billing', scopes: ['ledger:read', 'ledger:post', 'ledger:reserve'], expiresIn: SERVICE_TTL_SECONDS }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }

      // A cap, so the one regression that would otherwise HANG — replaying through
      // `authorizedFetch` rather than the bare fetch, re-minting for ever — fails as an assertion
      // instead. A guard whose failure mode is a six-hour CI timeout is a guard nobody reads.
      if (self.peerCalls.length > 32) throw new Error('the 401 replay is looping')
      const presented =
        new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? null
      if (presented === null) {
        self.peerCalls.push({ token: null, status: 401 })
        return new Response('{"error":"unauthenticated"}', { status: 401 })
      }
      try {
        await verifier.principal(presented)
        self.peerCalls.push({ token: presented, status: 200 })
        return new Response(JSON.stringify({ entry: { id: `entry-${self.peerCalls.length}` } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      } catch {
        self.peerCalls.push({ token: presented, status: 401 })
        return new Response('{"error":"unauthenticated"}', { status: 401 })
      }
    }) as typeof globalThis.fetch,
  }
  return self
}

/**
 * **`buildUpstreams`, not a hand-rolled client.** This is the whole point of the file.
 *
 * A test that constructs its own `ServiceTokenProvider` and its own client proves the provider
 * works, which is `@cloudsforge/auth`'s job. It proves nothing about whether THIS service uses it,
 * and "this service does not use it" was the defect. Going through the real factory means
 * reverting `upstreams.ts` to `const token = () => env.serviceToken` turns the tests below red.
 */
function upstreamsFor(w: World, options: { credential: string | null; onMinted?: () => void }) {
  const env: UpstreamEnv = {
    identityUrl: IDENTITY,
    identityCredential: options.credential,
    ledgerBaseUrl: PEER,
    ledgerDeadlineMs: 5_000,
    adminApiBaseUrl: null,
    adminApiDeadlineMs: 5_000,
  }
  return buildUpstreams(env, {
    originatingService: 'billing',
    fetch: w.fetch,
    onEvent: (event) => {
      if (event.kind === 'minted') options.onMinted?.()
    },
  })
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE REGRESSION TEST.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

test('this service still authenticates ELEVEN MINUTES after boot — the ten-minute cliff', async (t) => {
  const w = await world()
  t.after(() => mock.timers.reset())

  clockAt(0)
  const upstreams = upstreamsFor(w, { credential: CREDENTIAL })
  assert.ok(upstreams.identityTokens, 'a credential must produce a provider')

  // T+0. Every existing test in this repository stops looking here, and everything is fine.
  await postOnce(upstreams)
  const atBoot = w.peerCalls.at(-1)?.token
  assert.equal(w.peerCalls.at(-1)?.status, 200)
  assert.ok(atBoot)

  // T+11min — past the TTL, and the moment the estate used to fall over.
  clockAt((SERVICE_TTL_SECONDS + 60) * 1000)

  // FIRST — the cliff itself, reproduced against a real verifier, which is also the OLD SEAM
  // modelled exactly: a supplier that returns the same string for ever, behind an ordinary fetch.
  // If this ever stops being 401 the TTL has been lengthened, which is the wrong fix.
  const stale = await w.fetch(PEER, { headers: { authorization: `Bearer ${atBoot}` } })
  assert.equal(stale.status, 401, 'the token held at boot MUST be dead by now')

  // SECOND — the fix, through the wiring `src/index.ts` uses. A 200 here can only mean the service
  // obtained a live token for itself: no operator, no restart, no redeploy.
  const before = w.exchanges
  await postOnce(upstreams)
  assert.equal(w.peerCalls.at(-1)?.status, 200, 'the service must still authenticate past expiry')
  assert.notEqual(w.peerCalls.at(-1)?.token, atBoot, 'and with a genuinely new token')
  assert.equal(w.exchanges, before + 1, 'which it minted from the credential')
})

test('a token is refreshed BEFORE it expires, and the caller never waits for the mint', async (t) => {
  const w = await world()
  t.after(() => mock.timers.reset())

  clockAt(0)
  let minted = 0
  const upstreams = upstreamsFor(w, { credential: CREDENTIAL, onMinted: () => (minted += 1) })
  await postOnce(upstreams)
  const first = w.peerCalls.at(-1)?.token

  // 90% through: past the TOP of the provider's [75%, 85%] jitter band, so the refresh is due
  // whatever fraction this process drew. Not 80% — that is the CENTRE of the band, and a test
  // pinned there refreshes only about half the time. 540s of 600s is still comfortably alive.
  clockAt(SERVICE_TTL_SECONDS * 1000 * 0.9)
  await postOnce(upstreams)
  assert.equal(w.peerCalls.at(-1)?.token, first, 'the caller did not wait for the mint')
  assert.equal(w.peerCalls.at(-1)?.status, 200, 'and the old token was still good')

  // Wait on the provider's own completion signal, not on a tick count: `exchanges` counts requests
  // that have ARRIVED and signing is asynchronous, so a counter resumes mid-mint and a fixed
  // number of ticks is a flake on a slower machine.
  for (let tick = 0; tick < 2_000 && minted < 2; tick++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(minted, 2, 'the background refresh never ran')

  await postOnce(upstreams)
  assert.notEqual(w.peerCalls.at(-1)?.token, first, 'and the next call is on the new token')
  assert.equal(w.peerCalls.at(-1)?.status, 200)
})

test('an unreachable identity is a 503 to the caller, never an unauthenticated peer call', async (t) => {
  const w = await world()
  t.after(() => mock.timers.reset())

  clockAt(0)
  const upstreams = upstreamsFor(w, { credential: CREDENTIAL })
  await postOnce(upstreams)

  w.identityDown = true
  clockAt((SERVICE_TTL_SECONDS + 60) * 1000)
  const callsBefore = w.peerCalls.length

  await assert.rejects(() => postOnce(upstreams))
  // The peer was never dialled. Sending the expired token, or sending none, would have produced a
  // 401 from a perfectly healthy peer — pointing an operator at the wrong service entirely.
  assert.equal(w.peerCalls.length, callsBefore, 'nothing stale or unauthenticated was sent')
})

test('an unreachable identity does NOT retract a token we already hold', async (t) => {
  const w = await world()
  t.after(() => mock.timers.reset())

  clockAt(0)
  const upstreams = upstreamsFor(w, { credential: CREDENTIAL })
  await postOnce(upstreams)
  const held = w.peerCalls.at(-1)?.token

  // Past the refresh point with identity down: the background exchange fails and the caller must
  // not notice. An identity outage does not invalidate a token identity already signed, and
  // failing here would take the estate down for the fault it is designed to ride out.
  w.identityDown = true
  clockAt(SERVICE_TTL_SECONDS * 1000 * 0.9)
  await postOnce(upstreams)
  assert.equal(w.peerCalls.at(-1)?.token, held, 'the still-valid token is still served')
  assert.equal(w.peerCalls.at(-1)?.status, 200)
})

test('with no credential configured the service is NOT ready, and calls fail closed', async (t) => {
  const w = await world()
  t.after(() => mock.timers.reset())
  clockAt(0)

  // `buildUpstreams` builds no provider without a credential. The image can boot in that state so
  // CI can smoke-test /livez; /readyz is where the absence is enforced.
  const probe = serviceTokenProbe(null)
  assert.equal(probe.kind, 'hard')
  assert.equal((await probe.check()).state, 'fail', 'an unconfigured replica must not take traffic')

  const upstreams = upstreamsFor(w, { credential: null })
  assert.equal(upstreams.identityTokens, null)
  await assert.rejects(() => postOnce(upstreams))
  assert.equal(w.peerCalls.length, 0, 'and nothing was sent unauthenticated')
})

/* ── the second scope set, from the SAME credential ──────────────────────────────────────────── */

test('the admin-api client gets its OWN narrow token, from the one credential', async (t) => {
  const w = await world()
  t.after(() => mock.timers.reset())
  clockAt(0)

  // BILLING_ADMIN_API_TOKEN was a second long-lived secret because admin-api exact-matches
  // `admin:read` while the ledger needs `ledger:post` (adminapi.ts). Keeping the scopes apart is
  // AD-05 and is worth keeping. Keeping two SECRETS apart is not: identity reads the service off
  // the credential row and never off the request, so one credential mints both and the scope set
  // is a request parameter.
  const scopeRequests: string[] = []
  const env: UpstreamEnv = {
    identityUrl: IDENTITY,
    identityCredential: CREDENTIAL,
    ledgerBaseUrl: PEER,
    ledgerDeadlineMs: 5_000,
    adminApiBaseUrl: 'http://admin-api:4000',
    adminApiDeadlineMs: 5_000,
  }
  const upstreams = buildUpstreams(env, {
    originatingService: 'billing',
    fetch: (async (input, init) => {
      if (String(input).endsWith('/service-tokens/exchange')) {
        scopeRequests.push(String(init?.body ?? ''))
      }
      return w.fetch(input as never, init as never)
    }) as typeof globalThis.fetch,
  })

  assert.ok(upstreams.adminApi, 'a configured ADMIN_API_URL must produce a client')
  await postOnce(upstreams)
  // The ledger provider asks for the whole allowlist: at boot it cannot know which call sites will
  // be reached.
  assert.deepEqual(scopeRequests, ['{}'])

  // And the admin-api provider asks for exactly `admin:read` and nothing else. If billing's entry
  // in IDENTITY_SERVICE_TOKEN_GRANTS lacks it, identity answers ScopeNotGrantedError NAMING the
  // missing scope — which is the point, and is better than the 403 with no explanation that the
  // static token produced.
  await upstreams.adminApi.feeRecycleRate('test-corr').catch(() => {})
  assert.equal(scopeRequests.length, 2, 'the two clients must not share one token')
  assert.equal(scopeRequests[1], JSON.stringify({ scopes: ['admin:read'] }))
})

test('no credential means no admin-api token either, and nothing sent unauthenticated', async (t) => {
  const w = await world()
  t.after(() => mock.timers.reset())
  clockAt(0)

  const upstreams = buildUpstreams(
    {
      identityUrl: IDENTITY,
      identityCredential: null,
      ledgerBaseUrl: PEER,
      ledgerDeadlineMs: 5_000,
      adminApiBaseUrl: 'http://admin-api:4000',
      adminApiDeadlineMs: 5_000,
    },
    { originatingService: 'billing', fetch: w.fetch },
  )
  assert.ok(upstreams.adminApi)
  await assert.rejects(() => upstreams.adminApi!.feeRecycleRate('test-corr'))
  assert.equal(w.peerCalls.length, 0)
})
