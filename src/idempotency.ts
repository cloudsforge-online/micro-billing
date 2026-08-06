/**
 * Run a purchase at most once per key.
 *
 * **The shape is the ledger's, which took it from `repos/forge-pay/services/pay/src/store.ts`
 * — the best code in the existing estate.** What it gets right, and what is preserved here:
 *
 *   1. **The claim INSERT and the work share ONE transaction.** The stored response can therefore
 *      never disagree with what actually committed. A design that claims the key in its own
 *      transaction and then does the work has a window in which the key exists and the purchase
 *      does not — and a retry arriving in that window is answered "already done" for something
 *      that never happened.
 *   2. **A concurrent duplicate blocks rather than races.** The second INSERT waits on the first
 *      transaction's uncommitted row; when that commits, the duplicate reads the stored response
 *      and replays it. Ten parallel calls with one key therefore produce one purchase, one ledger
 *      entry and one entitlement.
 *   3. **A reused key with a different body is refused, not replayed.** Returning the first
 *      request's answer to a second, different request is worse than an error: the caller believes
 *      the thing it asked for happened.
 *   4. **A claim with no response yet is "in flight", not "done".** If the original transaction
 *      rolled back between the insert and this read, nothing committed, so the honest answer is
 *      "retry" rather than a guess.
 *
 * The key is namespaced by the calling service, because keys are chosen by callers and two
 * services independently choosing `black-friday-1` must not collide.
 */

import { createHash } from 'node:crypto'
import type { Db, Tx } from './outbox.ts'

/** The claim exists but its transaction has not committed a response yet. The caller retries. */
export class IdempotencyInFlightError extends Error {
  constructor() {
    super('a request with this idempotency key is still in flight; retry shortly')
    this.name = 'IdempotencyInFlightError'
  }
}

/** The same key was presented with a different body. 409, always. */
export class IdempotencyKeyReuseError extends Error {
  constructor() {
    super('this idempotency key was already used with a different request body')
    this.name = 'IdempotencyKeyReuseError'
  }
}

/**
 * A stable fingerprint of a request body, so a reused key with a changed payload is caught.
 *
 * Keys are sorted at every depth before hashing. `JSON.stringify` preserves insertion order, so
 * two semantically identical bodies that serialised their fields in a different order would
 * fingerprint differently and a legitimate retry would be rejected as reuse.
 */
export function requestFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalise(value)).digest('hex')
}

function canonicalise(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'bigint') return `"${value.toString()}"`
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`
}

/**
 * The stored key, namespaced by the caller.
 *
 * Exported because the same value is written to `purchases.idempotency_key`, where it is unique:
 * the constraint there and the primary key here must describe the same thing, or the two could
 * disagree about whether a key has been used.
 */
export function namespacedKey(caller: string, route: string, clientKey: string): string {
  return `${caller}:${route}:${clientKey}`
}

export interface IdempotentOutcome<T> {
  readonly result: T
  readonly replayed: boolean
}

export interface IdempotencyInput<T> {
  readonly caller: string
  readonly route: string
  readonly clientKey: string
  readonly requestHash: string
  /** The work. Returns the response to store and the resource it created, if any. */
  readonly run: (tx: Tx, storedKey: string) => Promise<{ response: T; resourceId: string | null }>
}

export async function withIdempotency<T>(sql: Db, input: IdempotencyInput<T>): Promise<IdempotentOutcome<T>> {
  const key = namespacedKey(input.caller, input.route, input.clientKey)

  const outcome = await sql.begin(async (tx) => {
    const claimed = await tx<{ key: string }[]>`
      insert into idempotency_keys (key, route, request_hash)
      values (${key}, ${input.route}, ${input.requestHash})
      on conflict (key) do nothing
      returning key
    `

    if (claimed.length === 0) {
      // Someone else holds the key. By the time this read runs, their transaction has either
      // committed (so the response is here) or rolled back (so the row is gone).
      const rows = await tx<{ request_hash: string; response: unknown }[]>`
        select request_hash, response from idempotency_keys where key = ${key}
      `
      const existing = rows[0]
      if (!existing) throw new IdempotencyInFlightError()
      if (existing.request_hash !== input.requestHash) throw new IdempotencyKeyReuseError()
      if (existing.response === null || existing.response === undefined) {
        throw new IdempotencyInFlightError()
      }
      return { value: { result: existing.response as T, replayed: true } }
    }

    const { response, resourceId } = await input.run(tx, key)

    await tx`
      update idempotency_keys
         set response = ${tx.json(response as Record<string, never>)},
             resource_id = ${resourceId}
       where key = ${key}
    `

    return { value: { result: response, replayed: false } }
  })

  // Wrapped in an object above so postgres.js does not treat an array-shaped result as a list of
  // promises to unwrap, which would rewrite the caller's return type.
  return outcome.value
}

/** How many keys one DELETE claims. Short statements let autovacuum keep up. */
const REAP_BATCH = 5_000

/**
 * Delete idempotency keys past their TTL. Returns how many rows went.
 *
 * The cutoff is the entire safety argument: expiring a key EARLY means the next replay of it buys
 * the thing a second time, so the TTL has to outlive every caller's retry horizon rather than be
 * as short as the table would like. A key whose purchase still exists is kept regardless of age,
 * because the row is the only link between a caller's key and what it bought.
 */
export async function reapIdempotencyKeys(sql: Db, ttlDays: number): Promise<number> {
  // An ISO string with an explicit cast, not a Date: inside a subquery postgres.js does not
  // resolve the timestamptz serialiser from the server's ParameterDescription, and a raw Date is
  // then handed to the text encoder and throws. The cast removes the question.
  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString()
  let total = 0
  for (;;) {
    const result = await sql`
      delete from idempotency_keys
       where key in (
         select key from idempotency_keys
          where created_at < ${cutoff}::timestamptz
            and resource_id is null
          limit ${REAP_BATCH}
       )
    `
    total += result.count
    if (result.count < REAP_BATCH) return total
  }
}
