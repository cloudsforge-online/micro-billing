/**
 * What this relay puts on the wire.
 *
 * No database — `buildEnvelope` is a pure function of a stored row, exported for exactly that
 * reason. The version defect below survived because every test of this outbox looked at the
 * INSERT and at the signature, both of which were right, and none looked inside the bytes.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyEnvelope, type EventVersion } from '@cloudsforge/contracts-events'
import { buildEnvelope, type OutboxRow } from './outbox.ts'

/* ------------------------------------------------------------------ what goes on the wire */

/**
 * An INVENTED row, and it says so — micro-org#366.
 *
 * Measured on the mainnet estate on 2026-08-11: this service's outbox is empty and so is
 * `entitlements`, so there is no real row to read. That is the only reason nothing has been lost.
 * The emit sites are live in `entitlements.ts`, BOTH topics are in the contract's registry and
 * `admin-api` subscribes to each, so the shape below is exactly what the first real grant will
 * put on the wire — which is why it is asserted before there is a first real grant.
 */
const STORED_ROW: OutboxRow = {
  id: '2f1b6ad4-8e2e-4a7c-9f36-6c9a1e2b7d40',
  topic: 'billing.entitlement.granted',
  key: '019fcd54-dbd5-7000-8786-e1e9258e9956',
  occurred_at: new Date('2026-08-11T00:00:00.000Z'),
  producer: 'billing',
  version: 1,
  actor: null,
  correlation_id: null,
  payload: { userId: '019fcd54-dbd5-7000-8786-e1e9258e9956', sku: 'season-pass' },
}

/**
 * **THE SIGNATURE WAS RIGHT AND THE ENVELOPE WAS NOT.**
 *
 * `@cloudsforge/contracts-events` types the wire version as "major.minor" — a STRING — and this
 * relay stamped the stored INTEGER. A delivery that verified was still discarded at the envelope
 * before any consumer read a payload. Eight relays did this at once and every suite in the estate
 * stayed green, because each one declared its OWN `EventEnvelope` and no compiler ever compared
 * the two.
 *
 * Measured with the contract's own `classifyEnvelope` against `STORED_ROW` on 2026-08-11:
 *
 *      as shipped -> malformed: version: missing, actor: missing, correlationId: missing
 *     fixed      -> valid
 *
 * The verdict is taken from the CONTRACT'S OWN classifier, never from a shape restated here. A
 * local copy of the rule agrees with a wrong implementation instead of catching it, which is the
 * mistake that produced the defect in the first place.
 *
 * MUTATIONS THIS KILLS — each one applied to `buildEnvelope` and each one confirmed red:
 *   - `version: row.version`, the stored integer, which is what shipped: `classifyEnvelope`
 *     answers `version: missing` and the defect assertion fails.
 *   - `version: String(row.version)` — a string, but "1" rather than "1.0": the shape assertion
 *     fails, so widening the fix to "any string" does not survive either.
 *   - `actor: row.actor` / `correlationId: row.correlation_id`, the nullable columns passed
 *     straight through, which is the other half of what the estate measured above.
 */
test('the envelope this relay puts on the wire is one the contract accepts', () => {
  const envelope = buildEnvelope(STORED_ROW)

  assert.equal(typeof envelope.version, 'string', 'an integer version is refused as "version: missing"')
  assert.match(envelope.version, /^\d+\.\d+$/, 'the contract types the wire version as "major.minor"')
  assert.equal(envelope.version, '1.0', 'major 1 as stored, minor 0 — storage records the major')
  // The nullable columns never reach the wire. `system` is the contract's own value for "no
  // principal did this"; the correlation id falls back to the event id so it is never absent.
  // This row has actor and correlationId null in storage, which is two of the defects measured above.
  assert.equal(envelope.actor, 'system')
  assert.equal(envelope.correlationId, STORED_ROW.id)

  const verdict = classifyEnvelope(envelope)
  assert.equal(verdict.ok, true, `the contract must accept it, got: ${JSON.stringify(verdict)}`)
})

/**
 * The teeth of the test above. Without this, every assertion there would still pass against a
 * classifier that accepted anything at all, and "the contract accepts it" would be a claim about
 * this file rather than about the estate.
 */
test('the shape this relay used to send is REFUSED by the same classifier', () => {
  const asShipped = { ...buildEnvelope(STORED_ROW), version: STORED_ROW.version as unknown as EventVersion }

  const verdict = classifyEnvelope(asShipped)
  assert.equal(verdict.ok, false, 'an integer version must be refused at the envelope')
  assert.equal(verdict.reason, 'malformed', 'refused as malformed, not merely shelved as unregistered')
  assert.ok(
    verdict.defects.some((d) => d.startsWith('version')),
    `refused FOR THE VERSION, not incidentally: ${JSON.stringify(verdict)}`,
  )
})
