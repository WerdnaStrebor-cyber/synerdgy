# SyNerdgy Exchange (SX) — Technical Build Plan

Companion to `synerdgy-exchange-spec.md`. This is the "how we get from
here to a working system" plan — top level, phased, dependency-ordered.

**Starting point, explicitly:** nothing is live. No Supabase project, no
hosting, no domain, no repo. What exists is: the reusable engine scripts
(`README-engine-pack.md`), a draft v2 schema (`.sql` file, never applied
to a live database), and the design spec from this conversation. Every
phase below assumes zero existing infrastructure.

---

## Phase 0 — Infrastructure foundations

Nothing else can start until this exists.

- Create the Supabase project (this becomes the live database + auth +
  storage backend — none of that exists yet, only the schema file).
- Set up a code repository and decide hosting for the front end (where
  the licensor/invitee-facing app will actually live).
- Domain + basic hosting/deploy pipeline (even a bare-bones one) — needed
  before magic links can be tested, since a magic link has to point
  somewhere real.
- Environment separation (dev vs. live) — worth having from day one given
  this handles hashed contact/company data; retrofitting environments
  later is painful.

**Output of this phase:** an empty but real Supabase project and a
deployable (if blank) front end.

## Phase 1 — Schema build-out

- Apply `synerdgy-schema-v2.sql` as a starting migration.
- Add the tables/columns identified as missing during design:
  - `sessions`/`parties` table for the session-per-match model (README
    item 1) — this is the foundation the rest of the app hangs off, so
    it needs to exist before any upload logic is wired up.
  - `match_scope` (`organisation | contact`) and `site_match`
    (`none | partial | full`) columns on `match_records`.
  - Any column needed to carry the embedded `session_id` check described
    in the spec (§8) — likely just referencing the existing session/party
    row rather than a new column.
- Set up RLS policies for the new tables, consistent with the existing
  ones in the v2 schema.

**Output:** a live database matching the design spec, not just the
original engine pack.

## Phase 2 — Auth: two login paths

- Standard login (licensor) — username + hashed password check. This is
  ordinary auth work, lowest risk in the whole plan.
- Magic link (invitee) — passwordless, single-use, tied to a specific
  match/session rather than a persistent account. Needs to be scoped so
  a magic link only grants access to *that* match, nothing else.
- Match-type selection (Type 1 / Type 2, per spec §2) needs to exist
  before either login path is meaningful, since it determines who gets
  which.

**Output:** a licensor can log in; an invited party can access their
match via a magic link; the system knows which type of match this is.

## Phase 3 — Adapt the reusable engine scripts

The README already flags this: the engine pack is a "strong starting
point, not a drop-in." Concretely:

- Wire `lookup-loader`, `vhc-normalizer`, `country-standardiser`,
  `postcode-normaliser`, `hash-pipeline` into the new front end largely
  as-is — these are product-agnostic per the README and shouldn't need
  redesigning.
- Rebuild `orchestrator.js`'s coordination logic around the session/party
  model rather than the old one-token-one-source model, fixing the known
  SYN ID sequence bug in the process (§4 of the spec — bake `fileSeq`
  into the ID rather than resetting the counter per upload).
- Build the "load another file" vs. explicit "Done" action distinction
  (per this session's earlier discussion) — this doesn't exist in the
  current orchestrator at all.

**Progress (9 Aug 2026):** all six engine files (`lookup-loader`,
`vhc-normalizer`, `country-standardiser`, `postcode-normaliser`,
`hash-pipeline`, `orchestrator.js`) converted from the old `<script>`-tag
loading model to real ES modules, verified loading cleanly with no
broken imports, full project build passing. `lookup-loader` moved to
read from Supabase Storage. Deliberately **not** touched in this pass:
the fileSeq bug and the multi-file queue/concurrency model — flagged as
next session's starting point.

**Orchestrator design — fileSeq/queue/RPC model (decided 10 Aug 2026):**

- **Per-file status, four values:** `queued | processing | ready |
  acknowledged` (spec §3a) — `ready` added to distinguish "processing
  finished, waiting on user ack" from "user has acknowledged," since a
  file can sit in `ready` while the user maps a later one.
- **`fileSeq`** assigned atomically at the `queued` transition (mapping
  confirmed, before processing starts) — a Postgres sequence or
  row-locked increment per party per match, so two files confirmed in
  quick succession can't race for the same number.
- **Worker pool: fixed at 3**, not one-per-file. Driven by the alpha
  client's real volume (11 files per party, not the 2-3 originally
  assumed) — spawning 11 simultaneous workers has no speed benefit past
  available CPU cores. Configurable constant, tunable after alpha
  testing shows real hashing times.
- **Dispatcher:** on a worker slot freeing, pulls the oldest `queued`
  file (lowest `fileSeq`) next, not the most recently mapped one. No
  preemption. This is what keeps the ordered mapping-file-write
  guarantee (§5) holding without extra bookkeeping.
- **`ready`-state UI prompt** surfaces only at the "load another file" /
  "Done" choice point — never interrupts active mapping of a later file.

**Invitee-upload RPCs — three, not one, each mapped to a distinct
lifecycle event:**

1. **`queue_source_upload`** — called client-side the instant mapping is
   confirmed (3c), before hashing starts. Params: `match_id`,
   `party_auth` (Supabase session for licensor, magic-link token for
   invitee), `filename`, `field_mapping` (jsonb). Validates party access
   to `match_id`, atomically assigns `fileSeq`, inserts `sources` row
   with `status = 'queued'`. Returns `source_id`, `fileSeq`.
2. **`mark_source_processed`** — called after the worker finishes
   hashing. Params: `source_id`, `party_auth`, batched hash payload.
   Validates ownership, bulk-inserts `company_hashes`/`contact_hashes`
   rows tied to `source_id`, flips status to `ready`.
3. **`acknowledge_source`** — called when the user confirms both output
   files saved (3f). Trivial status flip (`ready → acknowledged`), but
   a separate RPC since it's triggered by a UI action rather than a
   processing event and needs its own ownership check.

A combined single-RPC design was considered and rejected — the
two-phase timing (fileSeq assigned before processing, status updated
after) doesn't fit one call without either blocking the connection open
for the duration of hashing or calling it twice under one name anyway.

**RPCs implemented and tested (10 Aug 2026):** all three are live in
Supabase (migration `phase3_orchestrator_rpcs`), tested end to end
directly against the database before any client code was written
against them.

- **Correction against spec §9 caught during implementation:** the
  original `queue_source_upload` sketch included a `field_mapping`
  param for server-side storage. This contradicted the already-committed
  spec §9 decision (no server-side field-mapping storage) and the actual
  `sources` table has no column for it. Dropped — field mapping stays
  entirely local, written only into the client-side mapping CSV header
  block (§5).
- **`current_party_id(match_id)`** added as a new helper alongside the
  existing `has_match_access`/`is_own_party` — resolves the calling
  party (licensor via `auth.uid()`, invitee via the session-local
  `app.party_id` setting) so the three RPCs below don't have to assume
  which role is calling.
- **`sources.status` check constraint updated** to add `ready` as a
  fourth value (`queued | processing | ready | acknowledged`), per the
  earlier §3a addendum.
- **`queue_source_upload(match_id, filename, source_type)`** — assigns
  `file_seq` atomically via `pg_advisory_xact_lock` scoped to the party
  id (serialises concurrent calls, prevents two files racing for the
  same sequence number), inserts the `sources` row as `queued`. Tested:
  correctly returned `file_seq = '0001'` on first call.
- **`mark_source_processed(source_id, company_records, contact_records)`**
  — bulk-inserts via `jsonb_to_recordset`, correlates contact rows to
  their parent company row by `client_record_id` (unique per record
  within a match) rather than requiring the client to know
  `company_hashes.id` in advance, flips status to `ready`. **Real bug
  caught in testing:** the `jsonb_to_recordset` column-type list used
  bare `char` instead of `text` for the hash/standardised fields —
  `char` defaults to `char(1)`, which was silently truncating every
  multi-character value to its first character. Fixed before this ever
  reached client code.
- **`acknowledge_source(source_id)`** — flips `ready → acknowledged`,
  own ownership check via `is_own_party`. Tested: correctly rejects a
  call from a party belonging to a different match (`not authorized for
  this source`).

**Output:** a party can load one or more files, get correct
non-colliding SYN IDs, and see field-mapping confirmation UI — this is
the biggest chunk of genuinely new engineering, even though it's built
on old code.

## Phase 4 — Output files

- Consolidated mapping CSV (spec §5) — header-per-file, appended across
  the session.
- Lookup workbook (spec §5a) — two-sheet `.xlsx`, clean table + audit
  metadata, generated alongside the CSV at every download point.
- Dual acknowledgement gate — both files must be confirmed saved before
  the party can proceed.

**Output:** the local file outputs described in the spec, generated
correctly at every per-file step.

## Phase 5 — Matching logic

**Update:** the match RPCs have since been recovered in full — M1 (org,
`synerdgy-match-org.sql`) and M2 (contact, `synerdgy-match-contact.sql`),
plus their JS wrappers. This phase is substantially de-risked from a
"rebuild from a description" job to an "adapt working, previously-applied
code" job — the same category as Phase 3.

One correction the recovery surfaced: the org intent-to-key mapping in
the original design draft was wrong (had `org_algo_2`/`org_algo_4` for
standard/broad). The recovered SQL is ground truth — see spec §6 for the
corrected table. Worth a final sanity check against the SQL before this
becomes load-bearing for the new build, but the two independent recovery
passes now agree with each other, which is a reasonable confidence
signal.

- Adapt `synerdgy-match-org.sql` (`run_org_match`, `run_org_match_all`)
  and its runner largely as-is.
- Adapt `synerdgy-match-contact.sql` (`run_contact_match`,
  `run_contact_match_all`) and its runner largely as-is — this is where
  the five-level fuzzy contact logic lives, strictly anchored to a prior
  org match.
- Add the new `match_scope` and `site_match` flagging (spec §6) — this
  **is** genuinely new, not in the recovered SQL, since site matching
  wasn't a concept in the original engine.
- Wire the explicit "Done" action (Phase 3) as the actual trigger for
  running these RPCs — not file-count-based (per this session's earlier
  correction).

**Output:** matching actually runs and produces flagged `match_records`
rows.

**Still genuinely missing, not just deferred:** M3 (dedupe/self-match)
was not recovered — reconstructed once already from the M1 pattern in a
past session, but that reconstruction wasn't captured. Not needed for
Exchange's core two-party flow (a two-party pipe doesn't need internal
dedupe), so leave it out of this build unless a future requirement
surfaces.

## Phase 6 — Results delivery

- Aggregate Venn (spec §7) — counts-only query, shown to both parties
  regardless of match type. Lowest-risk part of this phase; no PII
  exposure to worry about.
- Detailed results fetch for the designated viewing party — file-picker
  re-selection of their saved mapping file/workbook, session_id
  validation (spec §8), local join, flagged extract generation.

**Output:** both parties see the overview; the designated party can pull
detailed, locally-joined results.

## Phase 7 — Notifications

None of this exists yet — the README explicitly notes the original
Edge Function stubs (`send-loader-invite`, `notify-admin-load-complete`)
were never built, only planned.

- Invite email (licensor → invitee, with magic link).
- "Your turn" email (party 1 done → party 2).
- "Results ready" notification to whichever party is designated to view.
- Resend capability for all of the above — flagged in the README as a
  requirement, not optional.

**Output:** the flow runs without a human manually pinging people at
each step.

## Phase 8 — Hardening and edge cases

- File-tampering behaviour (accepted risk per spec §8 — worth a
  deliberate test, not just an assumption).
- What happens if a party abandons a session mid-upload — does a stale
  session block a new one, expire, or allow restart?
- Confirm the dual-file acknowledgement (Phase 4) and the "Done"
  confirmation step (this session's discussion) actually stop premature
  or accidental submissions in practice, not just in design.

---

## Suggested build order and dependency notes

Phases 0–2 are strictly sequential — nothing else can be tested without
them. From Phase 3 onward, the **engine adaptation (3–4)** and **matching
logic (5)** could run in parallel workstreams once Phase 1's schema is
settled, since they touch different parts of the system. Phase 7
(notifications) is the easiest to defer or stub with manual sends early
on, if the goal is to get a working end-to-end test of the core flow
before investing in the polish layer.

**Single biggest source of schedule risk, updated:** with M1/M2 now
recovered, no phase is a from-scratch rebuild anymore — everything is
either adapting working, previously-applied code or building
well-specified new logic (session model, `match_scope`/`site_match`,
notifications, the two output files). The residual risk shifts to the
mundane kind: reconciling the recovered SQL against the live schema once
Phase 1 is built, and general integration risk of wiring several
previously-separate scripts into one coherent flow for the first time.
