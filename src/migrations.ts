/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * **A released migration is immutable.** `@cloudsforge/db` checksums each one and refuses a run
 * where the text changed after it was applied. The fix for a wrong migration is a new migration.
 * The checksum covers the COMMENTS too, so a released migration cannot even be annotated in
 * place — which is why the two corrections below are recorded here, in the one part of this file
 * no checksum sees, rather than beside the text they correct:
 *
 *   * **Migration 10 names three columns `*_shards`.** They were EMBER wei from the first row and
 *     the values were always right; migration 13 renames them `*_wei` (micro-org#336). Read
 *     migration 10's `gross_shards`/`refunded_shards`/`amount_shards` as the historical spelling
 *     of columns that exist today under the corrected names.
 *   * **Migration 9 seeds a `'SHARD'` price.** Migration 11 retires it in place and adds
 *     `prices_no_new_shard`; `src/testsupport.ts` explains why the fixture replays the seed
 *     through a substitution rather than a rewrite.
 *
 * ---------------------------------------------------------------------------------------------
 * **The entitlements table is the point of this service, and four of its columns are the reason
 * it exists.** 04-domain-model.md §8.1 lists what today's entitlements lack, and every item is a
 * live defect in `repos/forge-pay/services/pay`:
 *
 *   1. `scope`      — a product dimension, so a service can ask "does this user own X *for this
 *                     title*". Today an entitlement is a flat `(userId, sku, kind)` and a world
 *                     rented for one title is indistinguishable from one rented for another.
 *   2. `expires_at` — so a season pass ends. Today `SEASON_PASS` is granted `ownOnce` and never
 *                     expires, so season two cannot be sold to anyone who bought season one.
 *   3. `revoked_at` — so a refund removes what it paid for. Today there is no revocation column
 *                     at all: a refunded purchase leaves the entitlement in place for ever.
 *   4. A service-readable API — not a column, but the reason `subject` is an `AccountSubject`
 *                     rather than a bare `user_id`: a service asks about a subject, and the same
 *                     shape covers a community or an organisation holding a licence.
 *
 * **`journal_entry_id` is the fifth thing, and it is what makes a refund possible at all.** It is
 * the ledger entry that paid for the grant. Reversing it and revoking the grant are then one
 * operation with one identifier, instead of a hunt through a `ledger` table whose `source` column
 * is populated only by some routes.
 * ---------------------------------------------------------------------------------------------
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Taken verbatim from the runtime package so the table the claim query assumes and the table
    // that exists cannot drift. Copying the DDL by hand is how a service ends up with a jobs table
    // missing the (kind, key) unique constraint, which silently turns every recurring enqueue into
    // a duplicate run.
    up: JOBS_SCHEMA_SQL,
  },

  {
    version: 2,
    name: 'outbox',
    up: `
      create table if not exists outbox (
        id             uuid        primary key default gen_random_uuid(),
        topic          text        not null,
        key            text        not null,
        occurred_at    timestamptz not null default now(),
        producer       text        not null,
        version        integer     not null default 1,
        actor          text,
        correlation_id text,
        payload        jsonb       not null default '{}'::jsonb,
        published_at   timestamptz
      );

      -- The relay's access path. Partial on the unpublished set, so the index stays the size of
      -- the backlog rather than the size of history.
      create index if not exists outbox_unpublished_idx
        on outbox (occurred_at)
        where published_at is null;

      create table if not exists event_subscriptions (
        id         uuid        primary key default gen_random_uuid(),
        topic      text        not null,
        url        text        not null,
        active     boolean     not null default true,
        created_at timestamptz not null default now(),
        constraint event_subscriptions_topic_url_uniq unique (topic, url)
      );

      -- Delivery is tracked per (event, subscription) rather than per event. With one flag on the
      -- outbox row, one failing subscriber either blocks every other subscriber or causes the
      -- event to be redelivered to all of them on each retry.
      create table if not exists outbox_deliveries (
        event_id        uuid        not null references outbox (id) on delete cascade,
        subscription_id uuid        not null references event_subscriptions (id) on delete cascade,
        delivered_at    timestamptz,
        attempts        integer     not null default 0,
        last_error      text,
        primary key (event_id, subscription_id)
      );
    `,
  },

  {
    version: 3,
    name: 'inbox',
    up: `
      -- Delivery is at-least-once, so the consumer is what makes it effectively-once. The primary
      -- key is the dedupe: a redelivered event conflicts and the handler is never re-run.
      create table if not exists inbox (
        topic       text        not null,
        event_id    uuid        not null,
        received_at timestamptz not null default now(),
        primary key (topic, event_id)
      );
    `,
  },

  {
    version: 4,
    name: 'catalogue',
    up: `
      create table if not exists products (
        id     uuid not null primary key default gen_random_uuid(),
        sku    text not null unique,
        name   text not null,
        kind   text not null check (kind in ('one_off', 'subscription', 'consumable', 'metered')),
        status text not null default 'active' check (status in ('draft', 'active', 'retired')),

        -- Which dimension a grant of this product is scoped to. A private world is bought FOR a
        -- title, so its entitlement is meaningless without one; a cosmetic is platform-wide. The
        -- column exists so the requirement is data rather than a rule in whichever route
        -- happened to write the grant.
        scope_kind text not null default 'platform'
          check (scope_kind in ('platform', 'title', 'community')),

        -- How long a grant lasts. Null is perpetual. This is what lets a season pass END, and
        -- ending is the whole reason season two can be sold to somebody who bought season one.
        entitlement_days integer check (entitlement_days is null or entitlement_days > 0),

        metadata   jsonb       not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );

      create table if not exists prices (
        id         uuid not null primary key default gen_random_uuid(),
        product_id uuid not null references products (id) on delete cascade,

        asset_code text not null,
        -- Smallest units, NUMERIC, never a float. A price of 4.99 stored as a double is not 4.99,
        -- and every purchase built on it is out by the difference.
        unit_amount numeric(78, 0) not null check (unit_amount >= 0),

        -- Null for a one-off price. Present makes the product recur.
        interval       text    check (interval is null or interval in ('day', 'week', 'month', 'year')),
        interval_count integer not null default 1 check (interval_count > 0),

        status     text        not null default 'active' check (status in ('active', 'retired')),
        created_at timestamptz not null default now()
      );

      -- One active price per product per asset. Without this, "buy the SKU" is ambiguous and the
      -- route would have to pick one, which is how two customers pay two different prices for the
      -- same thing on the same day.
      create unique index if not exists prices_active_per_asset_idx
        on prices (product_id, asset_code)
        where status = 'active';
    `,
  },

  {
    version: 5,
    name: 'purchases',
    up: `
      create table if not exists purchases (
        id         uuid not null primary key default gen_random_uuid(),
        subject    text not null,
        product_id uuid not null references products (id),
        price_id   uuid not null references prices (id),

        quantity   numeric(78, 0) not null check (quantity > 0),
        asset_code text           not null,
        amount     numeric(78, 0) not null check (amount >= 0),
        scope      text           not null default 'platform',

        -- **Billing holds no balance.** This column is the proof: every purchase names the ledger
        -- entry that moved the money, and there is no path that creates a purchase without one.
        -- The estate's equivalent decrements a wallets.shards column in the same service that
        -- records the sale, so nothing can check that the two agree.
        journal_entry_id text not null,

        status          text not null default 'completed' check (status in ('completed', 'refunded')),
        -- Set by a refund. A reversal is a NEW entry, never an edit of the original.
        refund_entry_id text,

        idempotency_key text not null unique,
        correlation_id  text,
        actor           text not null,
        created_at      timestamptz not null default now(),
        refunded_at     timestamptz
      );

      create index if not exists purchases_subject_idx on purchases (subject, created_at desc);

      -- The claim table for POST /purchases. Same shape as the ledger's, because the property
      -- needed is the same: the claim INSERT and the work share one transaction, so a stored
      -- response can never disagree with what committed.
      create table if not exists idempotency_keys (
        key          text not null primary key,
        route        text not null,
        request_hash text not null,
        response     jsonb,
        -- What the key produced, so an operator can join a caller's key to the purchase it made.
        resource_id  text,
        created_at   timestamptz not null default now()
      );

      create index if not exists idempotency_keys_created_idx on idempotency_keys (created_at);
    `,
  },

  {
    version: 6,
    name: 'subscriptions',
    up: `
      create table if not exists subscriptions (
        id         uuid not null primary key default gen_random_uuid(),
        subject    text not null,
        product_id uuid not null references products (id),
        price_id   uuid not null references prices (id),

        status text not null
          check (status in ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
        quantity numeric(78, 0) not null default 1 check (quantity > 0),

        current_period_start timestamptz not null,
        current_period_end   timestamptz not null,
        -- Set when a cancellation is scheduled for the period end rather than taken immediately.
        -- The difference matters to the user: they keep what they paid for until it runs out.
        cancel_at    timestamptz,
        cancelled_at timestamptz,

        -- The subscription_charge entry that paid for the current period.
        latest_entry_id text,
        scope           text        not null default 'platform',
        created_at      timestamptz not null default now(),
        updated_at      timestamptz not null default now(),

        constraint subscriptions_period_ordered check (current_period_end > current_period_start)
      );

      create index if not exists subscriptions_subject_idx on subscriptions (subject, status);
      -- The renewal job's access path: which subscriptions are due, cheaply.
      create index if not exists subscriptions_due_idx
        on subscriptions (current_period_end)
        where status in ('trialing', 'active', 'past_due');
    `,
  },

  {
    version: 7,
    name: 'entitlements',
    up: `
      create table if not exists entitlements (
        id      uuid not null primary key default gen_random_uuid(),

        -- An AccountSubject, not a bare user id: 'user:<uuid>', 'community:<id>' or
        -- 'organisation:<id>'. The same shape the ledger uses, so a grant and the entry that paid
        -- for it name their holder identically.
        subject text not null,

        product_id uuid not null references products (id),
        sku        text not null,

        -- ONE: the product dimension. 'platform', 'title:<id>' or 'community:<id>'. Without it no
        -- service can ask "does this user own X for this title", which is why a purchased private
        -- world is never built.
        scope text not null default 'platform'
          check (scope = 'platform' or scope like 'title:%' or scope like 'community:%'),

        source text not null
          check (source in ('purchase', 'subscription', 'grant', 'reward', 'migration')),

        granted_at timestamptz not null default now(),
        -- TWO: an expiry. Null is perpetual; a season pass is not.
        expires_at timestamptz,
        -- THREE: revocation. A refund removes what it paid for.
        revoked_at timestamptz,
        revoked_reason text,

        -- Seats, uses or copies. NUMERIC for the same reason every other quantity here is.
        quantity numeric(78, 0) not null default 1 check (quantity >= 0),
        metadata jsonb          not null default '{}'::jsonb,

        purchase_id     uuid references purchases (id),
        subscription_id uuid references subscriptions (id),
        -- The ledger entry that paid for this grant. A refund reverses THIS id and revokes the
        -- row, which is one operation with one identifier rather than a hunt through the journal.
        journal_entry_id text,

        created_at timestamptz not null default now(),

        constraint entitlements_expiry_after_grant
          check (expires_at is null or expires_at > granted_at)
      );

      -- The service-readable lookup: "does this subject hold this sku for this scope". Partial on
      -- the live set, because a revoked grant is history and the question is always about now.
      create index if not exists entitlements_live_idx
        on entitlements (subject, scope, sku)
        where revoked_at is null;

      create index if not exists entitlements_subject_idx on entitlements (subject, granted_at desc);

      -- The expiry sweep's access path.
      create index if not exists entitlements_expiring_idx
        on entitlements (expires_at)
        where revoked_at is null and expires_at is not null;
    `,
  },

  {
    version: 8,
    name: 'usage_invoices_payouts',
    up: `
      create table if not exists usage_records (
        id              bigint      generated always as identity primary key,
        subscription_id uuid        references subscriptions (id) on delete cascade,
        subject         text        not null,
        meter           text        not null,
        quantity        numeric(78, 0) not null check (quantity >= 0),
        occurred_at     timestamptz not null default now(),
        -- Metering is at-least-once by nature: the thing being metered reports it, and it retries.
        -- The key is what makes recording it effectively-once, and a null key means the caller
        -- accepted that risk explicitly rather than by omission.
        idempotency_key text unique,
        invoice_id      uuid,
        created_at      timestamptz not null default now()
      );

      create index if not exists usage_records_unbilled_idx
        on usage_records (subscription_id, occurred_at)
        where invoice_id is null;

      create table if not exists invoices (
        id              uuid not null primary key default gen_random_uuid(),
        subject         text not null,
        subscription_id uuid references subscriptions (id),
        period_start    timestamptz not null,
        period_end      timestamptz not null,
        asset_code      text        not null,
        total           numeric(78, 0) not null check (total >= 0),
        status          text        not null check (status in ('draft', 'open', 'paid', 'void')),
        -- An invoice is a statement of what a ledger entry did, never a second record of the money.
        journal_entry_id text,
        created_at       timestamptz not null default now()
      );

      create index if not exists invoices_subject_idx on invoices (subject, created_at desc);

      create table if not exists invoice_lines (
        id          bigint         generated always as identity primary key,
        invoice_id  uuid           not null references invoices (id) on delete cascade,
        description text           not null,
        quantity    numeric(78, 0) not null check (quantity > 0),
        unit_amount numeric(78, 0) not null check (unit_amount >= 0),
        amount      numeric(78, 0) not null check (amount >= 0)
      );

      create table if not exists payouts (
        id           uuid not null primary key default gen_random_uuid(),
        subject      text not null,
        period_start timestamptz not null,
        period_end   timestamptz not null,
        asset_code   text        not null,
        gross        numeric(78, 0) not null check (gross >= 0),
        platform_fee numeric(78, 0) not null check (platform_fee >= 0),
        net          numeric(78, 0) not null,
        status       text not null
          check (status in ('pending', 'approved', 'paid', 'failed', 'cancelled')),
        -- A payout is a ledger movement plus optionally a withdrawal, NEVER a separate money
        -- system. This column is what makes that checkable rather than aspirational.
        journal_entry_id      text,
        destination_wallet_id text,
        created_at            timestamptz not null default now(),
        updated_at            timestamptz not null default now(),

        -- The arithmetic reconciliation cannot see: a payout whose parts do not add up balances
        -- as a journal entry while paying the wrong amount. This is isPayoutConsistent from
        -- contracts-money, enforced where a psql session has to obey it too.
        constraint payouts_net_consistent
          check (platform_fee <= gross and net = gross - platform_fee)
      );

      create index if not exists payouts_subject_idx on payouts (subject, period_end desc);
    `,
  },

  {
    version: 9,
    name: 'seed_catalogue',
    up: `
      -- A catalogue carried forward in shape from the frozen monetization routes: cosmetics,
      -- convenience, a season pass and private-world rentals. Everything here is cosmetic,
      -- convenience or private-worlds only; never pay-to-win.
      --
      -- Seeded rather than left empty so that a fresh deployment has something to serve and so
      -- that the two products whose defects this service exists to fix — the season pass, which
      -- must END, and the private world, which must be scoped to its title — exist from the start.
      insert into products (sku, name, kind, scope_kind, entitlement_days, metadata)
      values
        ('cosmetic.ember-cape',  'Ember Cape',            'one_off',      'platform',  null, '{"category":"cosmetic"}'::jsonb),
        ('convenience.extra-slot', 'Extra Character Slot', 'one_off',      'platform',  null, '{"category":"convenience"}'::jsonb),
        ('season.pass.s1',       'Season Pass: Emberfall', 'one_off',      'platform',  90,   '{"category":"season_pass","season":1}'::jsonb),
        ('world.private.small',  'Private World (small)',  'one_off',      'title',     30,   '{"category":"private_world","maxPlayers":8}'::jsonb),
        ('guild.hall.monthly',   'Guild Hall',             'subscription', 'community', null, '{"category":"community"}'::jsonb)
      on conflict (sku) do nothing;

      -- Prices in Shards. A Shard is one US cent, so 500 is five dollars — and it is an integer,
      -- because a price is never a float in any currency.
      insert into prices (product_id, asset_code, unit_amount, interval, interval_count)
      select p.id, 'SHARD', v.unit_amount, v.interval, 1
        from products p
        join (values
          ('cosmetic.ember-cape',    250::numeric,  null::text),
          ('convenience.extra-slot', 400::numeric,  null::text),
          ('season.pass.s1',        1000::numeric,  null::text),
          ('world.private.small',    750::numeric,  null::text),
          ('guild.hall.monthly',     500::numeric,  'month')
        ) as v (sku, unit_amount, interval) on v.sku = p.sku
      on conflict do nothing;
    `,
  },

  {
    version: 10,
    name: 'engagement_fee_recycle',
    up: `
      -- ════════════════════════════════════════════════════════════════════════════════════════
      -- THE FEE RECYCLE — docs/ecosystem/21 §3, second funding leg.
      --
      -- "A configured percentage of platform fee revenue (billing) posts to the same treasury
      -- account each period, so the engagement budget eventually funds itself from the activity
      -- it seeded. The percentage is an admin-set value with a schema-capped ceiling."
      --
      -- One row per closed period per asset. The row is written BEFORE any money is asked to
      -- move and carries every number the entry is derived from, so "what did the platform
      -- recycle, out of what, at what rate" is a select rather than a reconstruction.
      --
      -- ── THE PERCENTAGE IS NOT CONFIGURED HERE, AND THAT IS THE POINT ────────────────────────
      --
      -- micro-admin-api owns it: 'engagement_fee_recycle.recycle_bps', one platform-wide row,
      -- raise-gated by two operators through 'engagement.policy.set' and capped at 2500 bps by
      -- 'engagement_fee_recycle_within_ceiling' (admin-api/src/migrations.ts:451). Billing READS
      -- it per run and RECORDS what it applied. There is no second copy to drift out of step,
      -- which is why this table has no settings row of its own.
      --
      -- What this schema adds is the half a read cannot give: the CEILING, restated as a CHECK
      -- with the identical number. Two things then hold that neither side holds alone —
      --
      --   1. Billing cannot exceed what admin-api permits even if the read is wrong, the client
      --      is bypassed, or somebody writes this table by hand from psql.
      --   2. The two cannot disagree in the direction that matters. If admin-api's ceiling were
      --      ever raised past 2500 without this constraint being raised with it, the FIRST
      --      period at the higher rate is refused here — loudly, at the constraint — rather than
      --      recycling silently at a percentage this repository was never told about. The client
      --      also compares admin-api's published ceiling against this number before it applies
      --      anything, so the mismatch is reported before the row is even attempted.
      --
      -- ── THE AMOUNT IS THE DATABASE'S ARITHMETIC, NOT A HANDLER'S ────────────────────────────
      --
      -- 'amount_shards' is GENERATED. A handler that computed it could be wrong, could be
      -- changed, and could disagree with the row it wrote it on; a generated column cannot. The
      -- expression floors (div() truncates, and both operands are non-negative), so a recycle is
      -- always at most the configured share and never a Shard over it — the safe direction for a
      -- transfer out of revenue.
      --
      -- The net basis is 'greatest(gross - refunded, 0)'. A period whose refunds exceed its
      -- takings recycles nothing rather than moving money OUT of the treasury: reversing an
      -- engagement transfer is an operator decision with an approval behind it, not something a
      -- background job does because a big refund landed on a quiet day. The expression is
      -- repeated in the amount rather than referenced through a second generated column, which
      -- Postgres does not allow.
      -- ════════════════════════════════════════════════════════════════════════════════════════
      create table if not exists engagement_fee_recycles (
        id           uuid not null primary key default gen_random_uuid(),
        asset_code   text not null,
        -- Half-open [start, end). The job only ever closes periods that have fully elapsed.
        period_start timestamptz not null,
        period_end   timestamptz not null,

        -- Platform fee revenue billing RECOGNISED in this period: purchases (which includes the
        -- first charge of a subscription) plus renewal invoices. Both credit
        -- (platform, <asset>, fees) through 'purchasePostings' — src/ledger.ts:262.
        gross_shards    numeric(78, 0) not null check (gross_shards >= 0),
        -- Refunds that landed in this period, whichever period the purchase was made in. Each
        -- one reversed its entry and debited that same revenue account back.
        refunded_shards numeric(78, 0) not null check (refunded_shards >= 0),

        -- What admin-api's policy said when this period was closed. Recorded, never configured.
        recycle_bps integer not null,

        amount_shards numeric(78, 0)
          generated always as (
            div(greatest(gross_shards - refunded_shards, 0::numeric) * recycle_bps, 10000::numeric)
          ) stored,

        -- 'pending' — the row is claimed and the entry has not been confirmed posted.
        -- 'posted'  — the ledger holds it, under the key derived from this period.
        -- 'skipped' — there was nothing to move. At 0 bps every period is one of these, and
        --             that is the recorded starting state (21's closing open decision).
        status text not null default 'pending' check (status in ('pending', 'posted', 'skipped')),
        journal_entry_id text,

        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),

        constraint engagement_fee_recycles_period_ordered check (period_end > period_start),

        -- THE CEILING. The same 2500 as admin-api's 'engagement_fee_recycle_within_ceiling'
        -- (admin-api/src/migrations.ts:451). 21 §7.5 requires the fee-recycle percentage to be
        -- unable to exceed its schema ceiling; this is that requirement on billing's side of the
        -- wire, where the money is actually computed.
        constraint engagement_fee_recycles_within_ceiling
          check (recycle_bps >= 0 and recycle_bps <= 2500),

        -- 21 §7.4's pairing, for this leg: a posted recycle names its entry and an unposted one
        -- names none. Both halves, so neither an entry id without a posting nor a posting
        -- without an entry id can exist.
        constraint engagement_fee_recycles_posted_names_entry
          check ((status = 'posted') = (journal_entry_id is not null)),

        -- A skipped period moved nothing, so it cannot be a period with money in it. Without
        -- this, a bug that skipped a fundable period would look exactly like a quiet day.
        constraint engagement_fee_recycles_skipped_moves_nothing
          check (status <> 'skipped' or amount_shards = 0)
      );

      -- One row per period per asset, for ever. This is what makes a crashed run resumable
      -- rather than doubling: the second attempt loses the insert and adopts the row it finds.
      create unique index if not exists engagement_fee_recycles_period_uniq
        on engagement_fee_recycles (asset_code, period_start);

      -- The resume path's access path: rows the job still owes the ledger an answer about.
      create index if not exists engagement_fee_recycles_pending_idx
        on engagement_fee_recycles (period_start)
        where status = 'pending';
    `,
  },

  {
    version: 11,
    name: 'retire_shard_prices',
    up: `
      -- ════════════════════════════════════════════════════════════════════════════════════════
      -- SHARDS OUT. The catalogue becomes durable in USD; EMBER is settled at purchase time.
      --
      -- ── WHY USD AND NOT EMBER ───────────────────────────────────────────────────────────────
      --
      -- The owner's decision (docs/ecosystem/15 §3.2, "Pricing basis, decided 2026-08-04") is that
      -- stated USD does not move and the unit changes. A price row denominated in EMBER cannot
      -- honour that, for a measured reason: there is no market price for EMBER. Hearth has no
      -- exchange listing, so micro-pricing carries an ADMINISTERED number for it
      -- (pricing/src/rates.ts:55, seeded at 0.25 USD in pricing/src/migrations.ts:185) — a figure
      -- an operator typed. Store EMBER here and every future edit to that figure silently
      -- restates the whole catalogue's dollar prices, with no migration and no record. The USD
      -- figure is the durable one; how much EMBER it buys is a settlement-time question.
      --
      -- USD is not a new idea in this estate and is not a second internal unit: it is already a
      -- LedgerAssetCode (contracts/packages/money/src/index.ts:66, "administered prices, invoices,
      -- payout statements") and the live ledger already holds 18 USD accounts. It never appears in
      -- a posting from this service — see the settlement note below.
      --
      -- ── WHY THE INTEGER DOES NOT MOVE, AND WHY THAT IS THE WHOLE SAFETY ARGUMENT ─────────────
      --
      -- SHARD has decimals 0; USD is held as cents, decimals 2; the documented peg is 100 Shards
      -- to the dollar. 100 Shards = 100 cents, so ONE SHARD IS EXACTLY ONE CENT and the
      -- re-denomination is the identity on the stored number: 250 Shards was $2.50 and 250 cents
      -- is $2.50. Nothing is multiplied, divided or rounded, so there is no scale change to get
      -- wrong.
      --
      -- Contrast the alternative that was rejected: relabelling these rows 'EMBER' would leave the
      -- integer 250 to be read at 18 decimals, i.e. 250 wei = 0.00000000000000025 EMBER — a price
      -- moved by eighteen orders of magnitude by an UPDATE that touched only a text column. That
      -- is the silent scale change this migration exists to not be.
      --
      -- ── SUPERSEDED, NOT CONVERTED, NOT DELETED ──────────────────────────────────────────────
      --
      -- The SHARD rows are retired in place rather than updated or removed. purchases.price_id
      -- and subscriptions.price_id are foreign keys into this table, so a row records what a
      -- past purchase actually cost; rewriting its asset_code would retroactively restate history
      -- and deleting it would break the reference. status='retired' is the table's own existing
      -- vocabulary for this (prices_status_check), and the partial unique index
      -- prices_active_per_asset_idx only covers status='active', so the new USD rows insert
      -- alongside them without collision.
      --
      -- No money is destroyed here because none is held here: this table holds prices, not
      -- balances. The 132,000 units of real SHARD liability live in micro-ledger and are NOT
      -- touched by this migration — they are drained separately, and until they are, SHARD stays
      -- in contracts-chain's AssetCode so reconciliation can keep supervising them.
      -- ════════════════════════════════════════════════════════════════════════════════════════

      update prices set status = 'retired' where asset_code = 'SHARD' and status = 'active';

      insert into prices (product_id, asset_code, unit_amount, interval, interval_count, status)
      select p.product_id, 'USD', p.unit_amount, p.interval, p.interval_count, 'active'
        from prices p
       where p.asset_code = 'SHARD'
         and p.status = 'retired'
         -- Idempotent, and re-runnable against a deployment that already has a USD price for the
         -- product: never a second active row for the same product.
         and not exists (
           select 1 from prices q
            where q.product_id = p.product_id and q.asset_code = 'USD' and q.status = 'active'
         );

      -- ── THE GUARD ───────────────────────────────────────────────────────────────────────────
      -- A comment does not stop an INSERT. This does: no NEW active Shard price can exist, ever,
      -- in any deployment, whatever the application code believes. Retired rows are still
      -- permitted because history must remain readable.
      alter table prices
        add constraint prices_no_new_shard
        check (asset_code <> 'SHARD' or status = 'retired');

      -- ── WHAT A PURCHASE RECORDS ─────────────────────────────────────────────────────────────
      --
      -- Two amounts now, because there are two: the price (USD cents, durable, what the customer
      -- was quoted) and the charge (EMBER wei, what actually left their balance). Recording only
      -- one loses something a refund needs — a refund must return the EMBER that was TAKEN, not
      -- whatever today's administered rate says $2.50 is worth, or a customer refunded during a
      -- rate change is refunded the wrong amount.
      --
      -- rate_usd_scaled is the third column for the same reason: it makes the arithmetic
      -- auditable after the fact. Without it, amount and price_amount are two numbers with no
      -- stated relationship, and nobody can tell a rate change from a bug.
      alter table purchases
        add column if not exists price_asset_code text,
        add column if not exists price_amount     numeric(78, 0),
        add column if not exists rate_usd_scaled  numeric(78, 0);

      -- Backfill. Every purchase that already exists was charged in the same asset it was priced
      -- in, at no conversion — that is what a Shard price and a Shard debit MEANT. Recording it as
      -- a 1:1 conversion is therefore the truth about those rows rather than a convenient default.
      update purchases
         set price_asset_code = asset_code,
             price_amount     = amount,
             rate_usd_scaled  = null
       where price_asset_code is null;

      alter table purchases
        alter column price_asset_code set not null,
        alter column price_amount     set not null;

      alter table purchases add constraint purchases_price_amount_check check (price_amount >= 0);

      -- A positive price must never have been charged as nothing. This is the BigInt('') = 0n
      -- hazard given a home in the schema: the application refuses a zero conversion
      -- (contracts-chain's coinAmountForUsdCents), and so does the database, because the
      -- application is one deploy away from being wrong and the row outlives the deploy.
      alter table purchases
        add constraint purchases_no_free_lunch
        check (price_amount = 0 or amount > 0);
    `,
  },

  {
    version: 12,
    name: 'erasure',
    up: `
      -- ════════════════════════════════════════════════════════════════════════════════════════
      -- RIGHT TO ERASURE — THE HALF THAT BELONGS IN THE SCHEMA.
      --
      -- 03 §2 rule 6: every service storing a user reference subscribes to 'identity.user.deleted'
      -- and erases. The handler is 'src/erasure.ts' and its header is the table-by-table reasoning
      -- and the lawful basis for each row that survives. What is HERE is only the part a handler
      -- cannot be trusted with, because a handler is one deploy away from being wrong and these
      -- rows outlive the deploy:
      --
      --   1. An erased row is STRUCTURALLY DISTINGUISHABLE. 'erased_at' is not decoration — a
      --      subject reading 'erased:user' with no timestamp beside it, or a timestamp with a real
      --      subject still on the row, is a half-finished erasure, and each biconditional CHECK
      --      below makes that state unrepresentable rather than merely unlikely.
      --
      --   2. An erased row CANNOT BE RE-ATTRIBUTED. A CHECK cannot express that, because it sees
      --      one row and not the transition — so the trigger does. Once 'erased_at' is set, the
      --      subject is frozen and the timestamp cannot be cleared, by anything, including a psql
      --      session. Erasure that a later UPDATE can undo is not erasure.
      --
      --   3. An erased row CANNOT STILL BE OWED SOMETHING. A cancelled subscription that the
      --      renewal job can still pick up would charge a deleted person every month; a pending
      --      payout still naming a wallet would try to pay an account that no longer exists. Both
      --      are stated as constraints so the erasure and the lifecycle cannot drift apart.
      --
      -- WHY 'erased:user' AND NOT A PER-USER PLACEHOLDER. A hash or a per-user token would keep
      -- every row of one person linked to every other, and a linked sequence of timestamped
      -- amounts is a re-identifying fingerprint however unreadable its key is — that is
      -- pseudonymisation, which is still personal data, not anonymisation. One shared placeholder
      -- MERGES erased people into each other, which is the property that makes what remains
      -- genuinely no longer about anybody. It costs the ability to answer "what did this deleted
      -- person buy", which is exactly the ability being given up on purpose.
      --
      -- It is also not a valid AccountSubject: 'user:', 'community:' and 'organisation:' are the
      -- three kinds ('src/entitlements.ts' parseScope, contracts-money userSubject), so no live
      -- subject can ever collide with it and no lookup can accidentally return an erased row.
      -- ════════════════════════════════════════════════════════════════════════════════════════

      alter table purchases     add column if not exists erased_at timestamptz;
      alter table subscriptions add column if not exists erased_at timestamptz;
      alter table invoices      add column if not exists erased_at timestamptz;
      alter table payouts       add column if not exists erased_at timestamptz;

      -- The biconditional, in the same shape as engagement_fee_recycles_posted_names_entry: both
      -- halves, so neither a placeholder without the timestamp nor a timestamp without the
      -- placeholder can exist. Existing rows satisfy it trivially (false = false).
      alter table purchases
        add constraint purchases_erased_names_placeholder
        check ((subject = 'erased:user') = (erased_at is not null));

      -- 'actor' is the SECOND identifier on this table and it was not in the issue's list. It is
      -- written as 'user:<uuid>' for a user-initiated purchase (src/server.ts actorOf), so a
      -- subject-only erasure would leave the same person named in the column beside it. A
      -- service-initiated purchase carries 'service:<name>', which is not personal data — but it
      -- is overwritten too, because an erased row must not disclose who acted on it either way and
      -- a conditional rule here is a rule somebody gets wrong.
      alter table purchases
        add constraint purchases_erased_names_no_actor
        check (erased_at is null or actor = 'erased:user');

      alter table subscriptions
        add constraint subscriptions_erased_names_placeholder
        check ((subject = 'erased:user') = (erased_at is not null));

      -- THE ONE THAT STOPS A DELETED PERSON BEING CHARGED. subscriptions_due_idx is the renewal
      -- job's access path and it selects 'trialing', 'active' and 'past_due'; this constraint makes
      -- an erased row incapable of being in any of them.
      alter table subscriptions
        add constraint subscriptions_erased_is_terminal
        check (erased_at is null or status in ('cancelled', 'expired'));

      alter table invoices
        add constraint invoices_erased_names_placeholder
        check ((subject = 'erased:user') = (erased_at is not null));

      alter table payouts
        add constraint payouts_erased_names_placeholder
        check ((subject = 'erased:user') = (erased_at is not null));

      -- A payout is money leaving the platform towards a person. 'pending' and 'approved' are the
      -- states in which it has not left yet, and there is nobody left to pay: the destination
      -- wallet belongs to an account being deleted. Erasure therefore has to settle the payout's
      -- lifecycle, not just its identity, and this refuses the state in which it would not have.
      alter table payouts
        add constraint payouts_erased_is_settled
        check (erased_at is null or status in ('paid', 'failed', 'cancelled'));

      -- The wallet id is a live pointer at the person's account in another service. An erased
      -- payout keeps its arithmetic and gives up its destination.
      alter table payouts
        add constraint payouts_erased_names_no_wallet
        check (erased_at is null or destination_wallet_id is null);

      -- ── THE TRANSITION, WHICH NO CHECK CAN SEE ──────────────────────────────────────────────
      --
      -- One function for four tables: each of them has exactly 'subject' and 'erased_at', so the
      -- rule is the same rule and writing it four times is four places for it to drift. Raised as
      -- an exception rather than silently discarded, because a caller trying to re-attribute an
      -- erased row is a bug that must be seen, not absorbed.
      create or replace function billing_erasure_is_final() returns trigger as $$
      begin
        if old.erased_at is null then return new; end if;
        if new.erased_at is null then
          raise exception 'an erased row cannot be un-erased (%.%)', tg_table_name, old.id;
        end if;
        if new.subject is distinct from old.subject then
          raise exception 'an erased row cannot be re-attributed (%.%)', tg_table_name, old.id;
        end if;
        return new;
      end;
      $$ language plpgsql;

      drop trigger if exists purchases_erasure_final on purchases;
      create trigger purchases_erasure_final
        before update on purchases
        for each row execute function billing_erasure_is_final();

      drop trigger if exists subscriptions_erasure_final on subscriptions;
      create trigger subscriptions_erasure_final
        before update on subscriptions
        for each row execute function billing_erasure_is_final();

      drop trigger if exists invoices_erasure_final on invoices;
      create trigger invoices_erasure_final
        before update on invoices
        for each row execute function billing_erasure_is_final();

      drop trigger if exists payouts_erasure_final on payouts;
      create trigger payouts_erasure_final
        before update on payouts
        for each row execute function billing_erasure_is_final();
    `,
  },

  {
    version: 13,
    name: 'fee_recycle_in_ember_wei',
    up: `
      -- ════════════════════════════════════════════════════════════════════════════════════════
      -- THE FEE RECYCLE COUNTS EMBER WEI. MIGRATION 10 CALLED THEM SHARDS. micro-org#336.
      --
      -- ── NO FIGURE MOVES, AND THAT IS THE WHOLE SAFETY ARGUMENT ──────────────────────────────
      --
      -- These columns have always held the fee asset's minor units, and the fee asset is
      -- 'env.settlementAsset' — EMBER, typed IssuableAssetCode, i.e. Exclude<AssetCode, 'SHARD'>,
      -- so the retired spelling does not even compile at the only call site. The numbers were
      -- always wei and were always right. The NAMES were wrong, and wrong by eighteen orders of
      -- magnitude: a reader who takes 'gross_shards = 40000000000000000' at its word reads 4e16
      -- Shards where the row means one Shard's worth of EMBER.
      --
      -- So this is a RENAME and not a conversion, and the two neighbouring migrations are the
      -- proof that the distinction is load-bearing rather than pedantic:
      --
      --   * Migration 11 REFUSED to relabel a Shard price 'EMBER', at length, because those rows
      --     really were Shard counts and an UPDATE touching only the text column would have moved
      --     every price by eighteen orders of magnitude.
      --   * micro-admin-api's migration 13 ('engagement-in-ember-wei', micro-org#226, merged
      --     2026-08-10) renamed 'transfer_cap_shards'/'amount_shards' to '*_wei' AND multiplied
      --     by 4e16, for the same reason: its numbers were Shard counts.
      --
      -- Ours are not. Applying either treatment here would be the scale change this migration
      -- exists to not be.
      --
      -- ── ALTER ... RENAME, NOT A NEW COLUMN ──────────────────────────────────────────────────
      --
      -- Postgres stores the generated expression, the two column CHECKs and
      -- 'engagement_fee_recycles_skipped_moves_nothing' as parse trees over attribute numbers, so
      -- all four follow the rename with no DDL of their own. Dropping and re-adding a generated
      -- column would instead RECOMPUTE every row's amount from a freshly written expression — and
      -- a recomputed amount that differed by one wei from what the ledger was already told is
      -- exactly the class of error 21 §7.4's pairing exists to make impossible. A rename cannot
      -- produce it, because it touches no value.
      --
      -- ── AND NO HISTORICAL LEDGER METADATA IS REWRITTEN, BECAUSE NONE EXISTS ─────────────────
      --
      -- 'src/recycle.ts' writes 'grossShards'/'refundedShards' into the durable metadata of the
      -- entry it posts, so the bad names could have reached the audit of record. Measured on the
      -- live estate 2026-08-10, before this migration:
      --
      --   mainnet  billing.engagement_fee_recycles  0 rows (0 posted, 0 pending, 0 skipped)
      --   testnet  billing.engagement_fee_recycles  0 rows
      --   mainnet  ledger.journal_entries           70 entries, 0 with any metadata key matching
      --                                             '%shard%', 0 with correlation_id like
      --                                             'engagement-recycle%'
      --   testnet  ledger.journal_entries            1 entry,  same, zero
      --   mainnet  admin_api.engagement_fee_recycle  recycle_bps = 0, unchanged since seeding
      --
      -- Nothing to convert here and nothing to reconcile there. Had there been posted rows, the
      -- disposition would still be the same for the METADATA: a journal entry is settled
      -- append-only history and its metadata is part of what was recorded at the time, so it gets
      -- corrected forwards by a new entry, never edited. See the note above the 'metadata' block
      -- in 'src/recycle.ts'. This migration only ever touches billing's own working table.
      -- ════════════════════════════════════════════════════════════════════════════════════════

      alter table engagement_fee_recycles rename column gross_shards    to gross_wei;
      alter table engagement_fee_recycles rename column refunded_shards to refunded_wei;
      alter table engagement_fee_recycles rename column amount_shards   to amount_wei;
    `,
  },
]

/**
 * The version this build of the service requires. `index.ts` asserts it at boot and refuses to
 * serve below it, which is what stops a replica of the new code answering requests against the old
 * schema when a deploy runs ahead of its migrator.
 */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/**
 * How an existing hand-built schema is adopted. A new service leaves this at 0.
 *
 * The estate's `entitlements` table is not adopted by baselining: it has no scope, no expiry and
 * no revocation, so there is no version here whose DDL matches it. Its rows arrive through a
 * migration with `source = 'migration'` instead, which records honestly that they were granted
 * under the old rules.
 */
export const BASELINE_VERSION = 0
