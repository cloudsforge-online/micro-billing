/**
 * `identity.user.deleted` — right to erasure, billing's half.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SERVICE HELD, AND WHAT HAPPENS TO EACH OF IT
 *
 * Erasure is not "delete the rows". Two of these tables are the platform's accounting record, one
 * of them is summed by a job that has already published its answer, and one carries a foreign key
 * that other rows depend on. Deleting them would be a different fault wearing the shape of
 * compliance. Where a row survives, the row is DE-IDENTIFIED and the basis for keeping the rest of
 * it is named — not asserted.
 *
 * | table              | action                | reasoning + lawful basis if retained                |
 * |--------------------|-----------------------|-----------------------------------------------------|
 * | purchases          | retain, de-identified | The sale record. A one-off purchase produces NO      |
 * |                    |                       | invoice row here (invoices are written only for      |
 * |                    |                       | subscription periods — src/subscriptions.ts), so     |
 * |                    |                       | this table IS the accounting record of the sale.     |
 * |                    |                       | Retention basis: **Art 17(3)(b)** — processing       |
 * |                    |                       | necessary for compliance with a legal obligation,    |
 * |                    |                       | namely statutory tax and accounting record-keeping   |
 * |                    |                       | on sales. That obligation is about the TRANSACTION   |
 * |                    |                       | — date, sku, amount, asset, the journal entry that   |
 * |                    |                       | moved the money — and not about the identity of a    |
 * |                    |                       | consumer buyer, so the transaction survives and the  |
 * |                    |                       | identity does not. `subject` AND `actor` both go;    |
 * |                    |                       | see the note on `actor` in migration 12.             |
 * |                    |                       | It is also SUMMED: `recycle.ts` reads            |
 * |                    |                       | `sum(amount) from purchases` as the fee recycle's    |
 * |                    |                       | gross, and `recycle.ts` reads `min(created_at)`  |
 * |                    |                       | as the first period's boundary. Recycle rows for     |
 * |                    |                       | closed periods have already posted to the ledger, so |
 * |                    |                       | deleting a purchase would silently restate a period  |
 * |                    |                       | whose money has already moved — and deleting the     |
 * |                    |                       | oldest would move where the periods begin.           |
 * |--------------------|-----------------------|-----------------------------------------------------|
 * | invoices           | retain, de-identified | Same basis, more plainly: an invoice is the document |
 * |                    |                       | the record-keeping obligation is actually ABOUT.     |
 * |                    |                       | Same summing argument — `recycle.ts` reads       |
 * |                    |                       | `sum(total) from invoices` into the same gross.      |
 * |                    |                       | `invoice_lines` cascade from it and carry no subject |
 * |                    |                       | of their own, so they are left exactly as they are.  |
 * |--------------------|-----------------------|-----------------------------------------------------|
 * | payouts            | retain, de-identified,| Money the platform paid OUT to this person: the      |
 * |                    | lifecycle settled     | other side of the same accounting obligation, and    |
 * |                    |                       | `payouts_net_consistent` is a CHECK that a partial   |
 * |                    |                       | deletion would leave nothing to verify.              |
 * |                    |                       | `destination_wallet_id` is nulled — it is a live     |
 * |                    |                       | pointer at the person's account in another service,  |
 * |                    |                       | and no record-keeping obligation reaches it.         |
 * |                    |                       | A payout still `pending` or `approved` is CANCELLED: |
 * |                    |                       | it has moved no money (`journal_entry_id` is null in |
 * |                    |                       | those states) and there is no longer an account to   |
 * |                    |                       | pay it into. A balance genuinely owed must be        |
 * |                    |                       | settled inside identity's grace window — that is     |
 * |                    |                       | what `tombstoneAt` on this event exists to bound —   |
 * |                    |                       | and the cancellation is counted and logged so a      |
 * |                    |                       | non-zero count is visible rather than quiet.         |
 * |--------------------|-----------------------|-----------------------------------------------------|
 * | subscriptions      | retain, de-identified,| Cannot be deleted: `invoices.subscription_id`        |
 * |                    | forced terminal       | references it with no ON DELETE action, so a DELETE  |
 * |                    |                       | either fails against the invoices being retained     |
 * |                    |                       | above or would have to take them with it. This is    |
 * |                    |                       | the foreign-key case, not a legal one — a            |
 * |                    |                       | subscription is not itself a financial record, its   |
 * |                    |                       | charges are.                                         |
 * |                    |                       | Forced to `cancelled` because a de-identified row    |
 * |                    |                       | left `active` is worse than no erasure at all: the   |
 * |                    |                       | renewal job would keep charging a deleted person     |
 * |                    |                       | every period, for ever, against a subject nobody can |
 * |                    |                       | trace back to a complaint.                           |
 * |--------------------|-----------------------|-----------------------------------------------------|
 * | entitlements       | DELETE                | What the person owned. No legal obligation reaches   |
 * |                    |                       | it — the money is recorded in `purchases`, and a     |
 * |                    |                       | grant is an access right, not an accounting record.  |
 * |                    |                       | Nothing references it. And a deleted account that    |
 * |                    |                       | still satisfies an entitlement check is a live       |
 * |                    |                       | authorisation belonging to nobody, which is a        |
 * |                    |                       | security defect on top of a privacy one.             |
 * |--------------------|-----------------------|-----------------------------------------------------|
 * | usage_records      | DELETE                | Raw metering: what this person did, when, how often. |
 * |                    |                       | Behavioural data, and the highest-resolution         |
 * |                    |                       | personal data in the service. The billed conclusion  |
 * |                    |                       | survives in `invoice_lines`, which is what the       |
 * |                    |                       | record-keeping obligation needs; the trail that led  |
 * |                    |                       | to it is not required and has no other basis.        |
 * |                    |                       | `invoice_id` is a bare column, not a foreign key, so |
 * |                    |                       | no invoice breaks. Unbilled usage goes with it —     |
 * |                    |                       | there is nobody left to bill.                        |
 * |--------------------|-----------------------|-----------------------------------------------------|
 * | idempotency_keys   | DELETE (the person's) | THE ONE THAT LOOKS LIKE IT HOLDS NOTHING. There is   |
 * |                    |                       | no subject column, so it does not appear in any      |
 * |                    |                       | survey of "tables storing a user reference" — but    |
 * |                    |                       | `response` is a verbatim copy of the purchase reply, |
 * |                    |                       | `subject` included (src/purchases.ts), so a full |
 * |                    |                       | second copy of the personal data sits in jsonb.      |
 * |                    |                       | De-identifying the purchase and leaving this would   |
 * |                    |                       | be a compliance report that is false in its own      |
 * |                    |                       | database. Rows are found through `resource_id`,      |
 * |                    |                       | which names the purchase (src/purchases.ts).     |
 * |                    |                       | Deleting a claim makes a future retry of that key    |
 * |                    |                       | re-execute — harmless here, because the only client  |
 * |                    |                       | that could retry it is the account being deleted.    |
 * |--------------------|-----------------------|-----------------------------------------------------|
 * | products, prices,  | untouched             | Catalogue and platform aggregates. No user reference |
 * | engagement_fee_    |                       | at all: `engagement_fee_recycles` is per period per  |
 * | recycles           |                       | asset. Named here so that "we checked" is on the     |
 * |                    |                       | record rather than inferred from their absence.      |
 *
 * ── WHAT REMAINS, HONESTLY ─────────────────────────────────────────────────────────────────────
 *
 * The retained rows are ANONYMOUS ONLY BECAUSE THE PLACEHOLDER IS SHARED. Every erased person's
 * purchases collapse onto the same `subject`, so what is left is a heap of timestamped amounts
 * that cannot be resegmented into people. Had this used a per-user hash instead, each person's
 * rows would still be linked to each other, and a linked timestamped amount sequence is a
 * fingerprint — pseudonymised data is still personal data. Migration 12 states the same thing
 * beside the constraint that enforces it.
 *
 * Two links out of this service survive by construction and are named so nobody believes
 * otherwise: `journal_entry_id` points into micro-ledger, which holds its own account subject and
 * runs its own erasure; and `purchases.idempotency_key` is a caller-chosen string this service
 * cannot interpret, kept because it is the unique key the accounting row is identified by.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Tx } from './outbox.ts'

/** The topic. Registered in `@cloudsforge/contracts-events` as keyed by `user_id`. */
export const IDENTITY_USER_DELETED = 'identity.user.deleted'

/** Every topic this service consumes. Anything else is acknowledged and ignored — never 4xx'd. */
export const SUBSCRIBED_TOPICS: ReadonlySet<string> = new Set([IDENTITY_USER_DELETED])

/**
 * The subject an erased row carries.
 *
 * Shared across every erased person on purpose — see the header. Not a valid AccountSubject, so it
 * can never collide with a live one, and migration 12 makes a row carrying it structurally
 * distinguishable from one that merely looks unfamiliar.
 */
export const ERASED_SUBJECT = 'erased:user'

export interface ErasureCounts {
  readonly purchases: number
  readonly subscriptions: number
  readonly invoices: number
  readonly payouts: number
  readonly payoutsCancelled: number
  readonly entitlements: number
  readonly usageRecords: number
  readonly idempotencyKeys: number
}

/**
 * The two spellings of one person, and why both are matched.
 *
 * The event payload carries a BARE UUID (`identity/src/deletion.ts`). This service stores
 * the LEDGER SPELLING — `user:<uuid>`, built by `userSubject` from `@cloudsforge/contracts-money`
 * so that a grant and the ledger entry that paid for it name their holder identically
 * (`src/server.ts` POST /purchases). Matching only the ledger spelling would be right today and
 * silently wrong the first time any row is written from a path that does not go through
 * `userSubject`; matching only the bare uuid would erase nothing at all. So both forms are matched
 * explicitly, here, once, rather than being assumed anywhere downstream.
 */
export function subjectForms(userId: string): readonly string[] {
  return [`user:${userId}`, userId]
}

/**
 * A uuid, and nothing else. The one shape identity keys this topic by.
 *
 * ── THE VERSION NIBBLE IS NOT CONSTRAINED, AND THAT IS THE WHOLE POINT ────────
 *
 * This pattern read `[1-5]` for the version and `[89ab]` for the variant — the
 * RFC 4122 shape for versions 1 to 5. **Every user id in this estate is a
 * UUIDv7.** 04-domain-model section 0 requires it ("All ids are UUIDv7,
 * time-ordered, so they index well and sort"), and `identity/src/ids.ts`
 * mints them.
 *
 * So this regex rejected every real erasure event. The handler answered 400, the
 * relay treated that as a delivery failure and retried it for ever, and the
 * person's data stayed exactly where it was — while the account service reported
 * the deletion as done.
 *
 * **The unit tests passed throughout**, because their fixtures were v4 uuids
 * from `gen_random_uuid()` and `crypto.randomUUID()`. Both sides of the test
 * agreed with each other and neither agreed with the producer. It was caught by
 * `deploy/scripts/erasure-drill.sh` driving a real deletion through the real
 * bus — the seam, not the mock — and it is the reason that drill exists.
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Erase one user, inside the caller's transaction.
 *
 * Ordering is deliberate. The rows that are DELETED go first, so that a failure part-way through
 * rolls back having changed nothing rather than leaving a de-identified purchase whose idempotency
 * claim still names the person. `withInbox` gives that transaction, and the same transaction is
 * what makes the redelivery of a failed attempt process rather than be swallowed.
 */
export async function eraseUser(tx: Tx, userId: string): Promise<ErasureCounts> {
  const subjects = subjectForms(userId)

  // The claims first, and through the purchases they name: `idempotency_keys` has no subject of
  // its own, so this is the only join back to a person. Written as a subselect rather than two
  // round trips because the purchase rows are de-identified further down in the same transaction
  // and a two-step version would depend on which ran first.
  const idempotencyKeys = await tx`
    delete from idempotency_keys
     where resource_id in (select id::text from purchases where subject = any(${subjects}))
    returning key
  `
  const usageRecords = await tx`
    delete from usage_records where subject = any(${subjects}) returning id
  `
  const entitlements = await tx`
    delete from entitlements where subject = any(${subjects}) returning id
  `

  const purchases = await tx`
    update purchases
       set subject   = ${ERASED_SUBJECT},
           actor     = ${ERASED_SUBJECT},
           erased_at = now()
     where subject = any(${subjects})
    returning id
  `

  // `cancel_at` is cleared with the rest: a scheduled cancellation on a row that is already
  // cancelled is a date describing something that will never happen, and `updated_at` moves so an
  // operator reading the row can see when it changed.
  const subscriptions = await tx`
    update subscriptions
       set subject      = ${ERASED_SUBJECT},
           status       = case when status in ('cancelled', 'expired') then status else 'cancelled' end,
           cancelled_at = coalesce(cancelled_at, now()),
           cancel_at    = null,
           erased_at    = now(),
           updated_at   = now()
     where subject = any(${subjects})
    returning id
  `

  const invoices = await tx`
    update invoices
       set subject = ${ERASED_SUBJECT}, erased_at = now()
     where subject = any(${subjects})
    returning id
  `

  // Counted separately BEFORE the update, because after it the state has already moved and the
  // number of payments that were still owed when the person left would be unrecoverable. It is the
  // one figure in this handler an operator may need to act on.
  const owed = await tx<{ n: number }[]>`
    select count(*)::int as n
      from payouts
     where subject = any(${subjects}) and status in ('pending', 'approved')
  `
  const payouts = await tx`
    update payouts
       set subject               = ${ERASED_SUBJECT},
           status                = case when status in ('pending', 'approved') then 'cancelled' else status end,
           destination_wallet_id = null,
           erased_at             = now(),
           updated_at            = now()
     where subject = any(${subjects})
    returning id
  `

  return {
    purchases: purchases.length,
    subscriptions: subscriptions.length,
    invoices: invoices.length,
    payouts: payouts.length,
    payoutsCancelled: owed[0]?.n ?? 0,
    entitlements: entitlements.length,
    usageRecords: usageRecords.length,
    idempotencyKeys: idempotencyKeys.length,
  }
}
