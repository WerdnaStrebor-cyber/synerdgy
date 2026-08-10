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

**Update (8 Aug 2026):** `synerdgy-schema-v2.sql` was reviewed against
the Exchange spec. It's the right starting point (hash columns, index
strategy, and RLS pattern all carry over) but its core structure is
built for v2's actual use case — one client, one project, multiple of
their own sources compared pairwise against each other via
`source_pairs`/`pair_results`. Exchange is a fixed two-party model, not
a configurable N-source one, so this needs real restructuring, not just
additive columns. Decided shape:

- **`matches`** replaces `projects` — one row per Exchange session.
  Columns: `id`, `match_type` (1 | 2, spec §2), `designated_viewer_party_id`,
  `status`, `created_at`.
- **`parties`** — new table, exactly two rows per match. Columns: `id`,
  `match_id`, `role` (`licensor` | `invitee`), `slot` (1 | 2), `user_id`
  (licensor — standard Supabase Auth) or `magic_link_token` (invitee —
  single-use, scoped to this match only), `email`, `done_at` (set by the
  explicit "Done" action, spec §3 steps 4–5/7).
- **`sources`** replaces `project_sources` — scoped to a `party_id`
  rather than a `project_id`. Adds `file_seq` (assigned at queue-entry
  per spec §3a, not at processing-completion) and `status`
  (`queued | processing | acknowledged`) to support concurrent
  per-file processing.
- **`company_hashes` / `contact_hashes`** — same hash columns as v2.
  `client_record_id` widens from `char(24)` to fit the new `fileSeq`
  segment in the SYN ID format (spec §4: `SYN-[project]-[client]-
  [fileSeq]-[recordSeq]`) — this is a breaking format change from v2's
  `SYN-A3F7C-2A9F1-0000A3B4` shape, not an additive one. Links to
  `source_id` (and `party_id`) instead of `project_id`.
- **`match_records`** — keyed directly by `match_id` (no `source_pairs`
  indirection needed for a fixed two-party model). Adds `match_scope`
  (`organisation | contact`) and `site_match` (`none | partial | full`,
  organisation rows only, null for contact rows) per spec §6.
- **Dropped from v2:** `source_pairs` and `pair_results` — that
  configurability (multiple sources per client, user-selected pairing)
  doesn't apply to Exchange's fixed two-party flow. Their aggregate-count
  role is replaced by a simpler per-match Venn query (spec §7) computed
  directly off `match_records`.
- **`session_id` validation** (spec §8) — no new column needed; the
  match's own `id` serves as the session ID embedded in the mapping
  file header.

RLS moves from v2's token-only pattern (`current_setting('app.access_token')`)
to a role-aware model distinguishing licensor auth (standard Supabase
Auth session) from invitee auth (magic-link token scoped to exactly one
`match_id`) — v2's policies assumed a single access path per project,
which doesn't hold once two independently-authenticated parties share
one match row.

**Update (9 Aug 2026):** migration applied to the live Supabase project
(`supabase/migrations/20260809150921_exchange_schema.sql`). All 7 tables
live with RLS enabled. One refinement made during review, not in the
original plan above: `company_hashes`/`contact_hashes` are **insert-only**
for both parties — no client-side read/update/delete use case exists,
since the app never needs to read raw hash values back (upload progress
comes from `sources.company_count`/`contact_count`, plain integers). Only
the Phase 5 matching RPCs (running as `SECURITY DEFINER`) ever read these
tables. Ran Supabase's security advisor post-migration — caught mutable
`search_path` on the three helper functions (a schema-shadowing privilege
escalation vector), fixed by pinning `set search_path = public` on each.
Advisor is clean now bar two expected warnings on `validate_invitee_access`
being publicly callable, which is correct by design — it has to be
callable by an unauthenticated invitee holding only a magic-link token.

**Output:** a live database matching the design spec, not just the
original engine pack.

## Phase 2 — Auth: two login paths

**Update (9 Aug 2026):** built and working — `LoginForm.jsx` (licensor,
standard Supabase Auth email/password), `CreateMatchForm.jsx` (licensor
creates a match, picks type, invites by name/email, gets back a magic
link to send manually), `InviteLanding.jsx` (invitee's landing page at
`/invite/:token`, validates the token via the new `invitee_get_match`
RPC and shows match name + their party slot). Routing added via
react-router-dom.

Two gaps found and fixed along the way that Phase 1 had missed:
- **No INSERT policies existed** on `matches`, `parties`, or `clients` —
  Phase 1 only wrote SELECT/UPDATE, so no one could actually create a
  match. Fixed with `clients_insert_own`, `matches_insert_authenticated`,
  `parties_insert_own_match_setup` (the latter ownership-checked so a
  licensor can only insert a party row as themselves).
- **`invitee_get_match(token)` RPC added** — read-only, `SECURITY
  DEFINER`, returns only match name/type/status and the invitee's own
  party details. No hash tables touched.

**Known gap, deliberately not fixed today:** `CreateMatchForm` creates a
brand-new `clients` row on every single match rather than reusing one
client record per licensor across repeat matches — there's no column
linking `clients` to `auth.uid()` yet, and no clean way to look one up
before a licensor's first match exists. Fine for testing the flow
end-to-end; needs a real fix (likely a `clients.owner_user_id` column)
before this handles repeat real licensors.

**Update (9 Aug 2026, post-build testing):** three real bugs surfaced
testing the create-match flow end to end, all fixed and confirmed
working:

1. **`clients` RLS chicken-and-egg.** The original SELECT policy proved
   ownership only via an existing `parties` row — didn't exist yet on a
   licensor's first-ever client row, so the insert's `.select()` failed.
   Fixed with a direct `clients.created_by` column and ownership-based
   policy — this also closed the "new clients row on every match"
   duplication gap noted below, since `CreateMatchForm` now looks up an
   existing client by `created_by` before creating a new one.
2. **Same chicken-and-egg one step further down, on `matches`.** Fixed by
   adding a second SELECT policy allowing access via `clients` ownership,
   not just via an existing `parties` row.
3. **Infinite recursion in `has_match_access`/`is_own_party`.** Both
   functions query the `parties` table internally, but were also used
   inside `parties`' own RLS policy — the internal query re-triggered the
   same policy, calling the function again, forever, until Postgres hit
   "stack depth limit exceeded". Fixed by marking both `SECURITY DEFINER`
   so the internal lookup bypasses RLS — same pattern already used
   correctly on `validate_invitee_access`. This bug existed since Phase 1
   but wasn't exercised until Phase 2 actually read a `parties` row back
   after insert.

Also fixed: the `magic_link_token` column's `default gen_random_uuid()`
was firing on the licensor's party insert too, not just the invitee's —
violated the `parties_auth_matches_role` check constraint. Fixed by
explicitly passing `magic_link_token: null` on the licensor insert.

**Decided (10 Aug 2026):** invitee identity in Phase 3/4 will be carried
via `SECURITY DEFINER` RPC functions — the token passed as an explicit
parameter on every call (`invitee_create_source(token, ...)`,
`invitee_upload_hashes(token, batch)`, `invitee_mark_done(token)`, etc.),
not via `current_setting()` session state. Chosen over two alternatives
(anonymous Supabase Auth + custom JWT claims; a PostgREST pre-request
header hook) because both of those need Supabase dashboard/Management
API configuration outside what's scriptable via migration — the RPC
pattern needs nothing beyond what's already proven working
(`invitee_get_match`). Cost: Phase 3/4 needs one function per invitee
action rather than reusing generic table calls — but this fits spec §4's
"batched, not row-by-row" hashing requirement naturally, since a batch
upload is one function call either way.

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
