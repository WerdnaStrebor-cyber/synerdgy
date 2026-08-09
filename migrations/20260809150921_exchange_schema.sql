-- =============================================================================
-- SyNerdgy Exchange — Supabase Schema (Phase 1)
-- =============================================================================
-- Restructures the SyNerdgy v2 engine schema for Exchange's fixed two-party
-- model. See docs/spec.md and docs/build-plan.md (Phase 1, 8 Aug 2026 update)
-- for the design decisions behind this file.
--
-- What changed from v2, and why:
--   projects        → matches   (one row per Exchange session, not per client
--                                 project with multiple sources)
--   (new)           → parties   (exactly two rows per match — licensor +
--                                 invitee — didn't exist in v2's single-token
--                                 model)
--   project_sources → sources   (scoped to a party, not a project; adds
--                                 file_seq + status for concurrent upload
--                                 handling per spec §3a)
--   client_record_id: char(24) → text, format now includes a fileSeq segment
--                                 (spec §4) — breaking change, not additive
--   match_records:    adds match_scope, site_match (spec §6)
--   source_pairs, pair_results: dropped — Exchange has no configurable
--                                 N-source pairing, just one fixed match
--                                 between exactly two parties
--
-- RLS strategy:
--   Licensor auth = standard Supabase Auth (auth.uid()).
--   Invitee auth = magic-link token, no account. A validated invitee gets
--   two session-scoped settings (app.party_id, app.match_id) set via the
--   validate_invitee_access() function below — same current_setting()
--   pattern v2 used for its single access_token, extended to two parties.
--   Exactly how that setting gets applied per-request (custom claim vs.
--   edge function) is a Phase 2 (auth) implementation detail, not decided
--   here — this migration only defines the database-side contract.
--
-- Platform: Supabase (PostgreSQL), eu-west-2 (London)
-- RLS: enabled on all tables
-- All hash columns: char(64), indexed WHERE NOT NULL
-- =============================================================================

-- ---------------------------------------------------------------------------
-- clients
-- Unchanged from v2 — still the top-level licensor account record.
-- ---------------------------------------------------------------------------

create table if not exists clients (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  client_code  char(5) not null,                  -- 5-char uppercase hex,
                                                    -- used in SYN IDs across
                                                    -- all matches for this client
  created_at   timestamptz not null default now()
);

alter table clients enable row level security;

create unique index if not exists clients_code_idx on clients(client_code);

-- ---------------------------------------------------------------------------
-- matches
-- Replaces v2's "projects". One row per Exchange session.
-- ---------------------------------------------------------------------------

create table if not exists matches (
  id                          uuid primary key default gen_random_uuid(),
  client_id                   uuid not null references clients(id) on delete cascade,
  name                        text not null,
  match_code                  char(5) not null,    -- 5-char uppercase hex,
                                                    -- the "projectCode" segment
                                                    -- of the SYN ID format (spec §4)
  match_type                  smallint not null check (match_type in (1, 2)),
                                                    -- 1 = licensor is party 1
                                                    -- 2 = licensor is party 2
                                                    -- (spec §2)

  -- Set once matching completes (Phase 5) — references parties(id), added as
  -- a deferred FK below since parties doesn't exist yet at this point in the
  -- file.
  designated_viewer_party_id  uuid,

  status                      text not null default 'created'
                              check (status in (
                                'created',        -- match row exists, invite not yet sent
                                'invited',         -- magic link sent, awaiting party 1 upload
                                'party1_active',   -- party 1 currently uploading
                                'party1_done',     -- party 1 clicked "Done" (spec §3 step 5)
                                'party2_active',   -- party 2 currently uploading
                                'party2_done',     -- party 2 clicked "Done" — triggers matching
                                'matching',        -- M1/M2 RPCs running (Phase 5)
                                'complete'         -- results available
                              )),

  salt                        uuid not null default gen_random_uuid(),
                                                    -- match-specific hash salt,
                                                    -- fetched client-side at
                                                    -- session start, never
                                                    -- exposed in the magic link URL
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

alter table matches enable row level security;

create unique index if not exists matches_code_idx on matches(match_code);

-- ---------------------------------------------------------------------------
-- parties
-- New table — didn't exist in v2. Exactly two rows per match.
-- ---------------------------------------------------------------------------

create table if not exists parties (
  id                uuid primary key default gen_random_uuid(),
  match_id          uuid not null references matches(id) on delete cascade,
  role              text not null check (role in ('licensor', 'invitee')),
  slot              smallint not null check (slot in (1, 2)),

  -- Licensor: standard Supabase Auth. Invitee: magic-link token, no account.
  -- Exactly one of these two is set, enforced by the check constraint below.
  user_id           uuid references auth.users(id),
  magic_link_token  uuid unique default gen_random_uuid(),

  email             text not null,
  invitee_name      text,             -- supplied by licensor at setup (spec §3 step 1)
  done_at           timestamptz,      -- set by the explicit "Done" action (spec §3)
  created_at        timestamptz not null default now(),

  constraint parties_match_slot_unique unique (match_id, slot),
  constraint parties_auth_matches_role check (
    (role = 'licensor' and user_id is not null and magic_link_token is null)
    or
    (role = 'invitee' and magic_link_token is not null and user_id is null)
  )
);

alter table parties enable row level security;

-- Now that parties exists, wire up the deferred FK from matches.
alter table matches
  add constraint matches_designated_viewer_fk
  foreign key (designated_viewer_party_id) references parties(id);

-- ---------------------------------------------------------------------------
-- sources
-- Replaces v2's "project_sources". Scoped to a party, not a project.
-- ---------------------------------------------------------------------------

create table if not exists sources (
  id            uuid primary key default gen_random_uuid(),
  party_id      uuid not null references parties(id) on delete cascade,
  match_id      uuid not null references matches(id) on delete cascade,
                                        -- denormalised for RLS + query performance,
                                        -- same pattern v2 used on company_hashes
  file_seq      char(4) not null,      -- 4-char hex, assigned at queue-entry
                                        -- (spec §3a) — not at processing completion
  display_name  text not null,
  source_type   text,
  status        text not null default 'queued'
                check (status in ('queued', 'processing', 'acknowledged')),
  company_count integer,
  contact_count integer,
  loaded_at     timestamptz,
  created_at    timestamptz not null default now(),

  constraint sources_party_fileseq_unique unique (party_id, file_seq)
);

alter table sources enable row level security;

-- ---------------------------------------------------------------------------
-- company_hashes
-- Same hash columns as v2. client_record_id widened to fit the new fileSeq
-- segment (spec §4) — this is the breaking format change from v2's
-- char(24) SYN-A3F7C-2A9F1-0000A3B4 shape.
-- ---------------------------------------------------------------------------

create table if not exists company_hashes (
  id                    uuid primary key default gen_random_uuid(),
  source_id             uuid not null references sources(id) on delete cascade,
  party_id              uuid not null references parties(id) on delete cascade,
  match_id              uuid not null references matches(id) on delete cascade,

  -- SYN-[5 hex match]-[5 hex client]-[4 hex fileSeq]-[8 hex record], e.g.
  -- SYN-A3F7C-2A9F1-0001-00000001 (29 chars). text rather than a fixed
  -- char(29) so the format can flex without another migration if it changes
  -- again — the check constraint still enforces the shape.
  client_record_id      text not null
    check (client_record_id ~ '^SYN-[0-9A-F]{5}-[0-9A-F]{5}-[0-9A-F]{4}-[0-9A-F]{8}$'),

  country_display       text,

  org_exact             char(64),
  org_algo_1            char(64),
  org_algo_2            char(64),
  org_algo_3            char(64),
  org_algo_4            char(64),
  domain_standardised   char(64),
  country_standardised  char(64),
  postcode_exact        char(64),
  zip_standardised      char(64),
  part_zip_standardised char(64)
);

alter table company_hashes enable row level security;

create index if not exists ch_org_exact_idx on company_hashes(org_exact) where org_exact is not null;
create index if not exists ch_org_algo_1_idx on company_hashes(org_algo_1) where org_algo_1 is not null;
create index if not exists ch_org_algo_2_idx on company_hashes(org_algo_2) where org_algo_2 is not null;
create index if not exists ch_org_algo_3_idx on company_hashes(org_algo_3) where org_algo_3 is not null;
create index if not exists ch_org_algo_4_idx on company_hashes(org_algo_4) where org_algo_4 is not null;
create index if not exists ch_domain_idx on company_hashes(domain_standardised) where domain_standardised is not null;
create index if not exists ch_country_idx on company_hashes(country_standardised) where country_standardised is not null;
create index if not exists ch_postcode_idx on company_hashes(postcode_exact) where postcode_exact is not null;
create index if not exists ch_zip_idx on company_hashes(zip_standardised) where zip_standardised is not null;
create index if not exists ch_part_zip_idx on company_hashes(part_zip_standardised) where part_zip_standardised is not null;
create index if not exists ch_match_party_idx on company_hashes(match_id, party_id);

-- ---------------------------------------------------------------------------
-- contact_hashes
-- Same structure as v2's Phase 2 stub, same client_record_id widening.
-- ---------------------------------------------------------------------------

create table if not exists contact_hashes (
  id                      uuid primary key default gen_random_uuid(),
  source_id               uuid not null references sources(id) on delete cascade,
  party_id                uuid not null references parties(id) on delete cascade,
  match_id                uuid not null references matches(id) on delete cascade,
  company_hash_id         uuid references company_hashes(id),
  client_record_id        text not null
    check (client_record_id ~ '^SYN-[0-9A-F]{5}-[0-9A-F]{5}-[0-9A-F]{4}-[0-9A-F]{8}$'),

  email                   char(64),
  firstname_standardised  char(64),
  firstname_initial       char(64),
  surname_standardised    char(64),
  telephone_standardised  char(64)
);

alter table contact_hashes enable row level security;

create index if not exists cth_match_party_idx on contact_hashes(match_id, party_id);

-- ---------------------------------------------------------------------------
-- match_records
-- Keyed directly by match_id — no source_pairs indirection needed for a
-- fixed two-party model. Adds match_scope + site_match (spec §6).
-- ---------------------------------------------------------------------------

create table if not exists match_records (
  id            uuid primary key default gen_random_uuid(),
  match_id      uuid not null references matches(id) on delete cascade,

  record_id_a   text not null,        -- client_record_id from party 1
  record_id_b   text not null,        -- client_record_id from party 2

  match_scope   text not null check (match_scope in ('organisation', 'contact')),

  -- null for contact rows, only meaningful on organisation rows (spec §6)
  site_match    text check (site_match in ('none', 'partial', 'full')),
  constraint match_records_site_match_scope check (
    (match_scope = 'organisation') or (site_match is null)
  ),

  match_key     text not null,        -- e.g. 'org_algo_1+domain_standardised'
  match_level   text not null,        -- vocabulary depends on match_scope — see spec §6
  computed_at   timestamptz not null default now()
);

alter table match_records enable row level security;

create index if not exists mr_match_idx on match_records(match_id);
create index if not exists mr_scope_idx on match_records(match_id, match_scope);
create index if not exists mr_record_a_idx on match_records(record_id_a);
create index if not exists mr_record_b_idx on match_records(record_id_b);

-- ---------------------------------------------------------------------------
-- Access-control helper functions
-- ---------------------------------------------------------------------------

-- True if the current request is authenticated as EITHER party on this match
-- — licensor via auth.uid(), invitee via the app.party_id session setting
-- established by validate_invitee_access() below.
create or replace function has_match_access(target_match_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from parties
    where parties.match_id = target_match_id
    and (
      (parties.role = 'licensor' and parties.user_id = auth.uid())
      or
      (parties.role = 'invitee' and parties.id = nullif(current_setting('app.party_id', true), '')::uuid)
    )
  );
$$;

-- True if the current request IS the specific party row given — used to
-- restrict writes (e.g. a party setting their own done_at) to that party
-- only, not their counterpart.
create or replace function is_own_party(target_party_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from parties
    where parties.id = target_party_id
    and (
      (parties.role = 'licensor' and parties.user_id = auth.uid())
      or
      (parties.role = 'invitee' and parties.id = nullif(current_setting('app.party_id', true), '')::uuid)
    )
  );
$$;

-- Validates an invitee's magic-link token and returns their match/party IDs.
-- The caller (app code, Phase 2) is responsible for propagating these into
-- app.match_id / app.party_id for the rest of that request — exact mechanism
-- (custom JWT claim vs. per-request GUC) is a Phase 2 decision, not fixed here.
create or replace function validate_invitee_access(token uuid)
returns table (match_id uuid, party_id uuid)
language sql
security definer
set search_path = public
as $$
  select parties.match_id, parties.id
  from parties
  where parties.magic_link_token = token
  and parties.role = 'invitee';
$$;

-- ---------------------------------------------------------------------------
-- RLS policies
-- ---------------------------------------------------------------------------

-- clients: not directly party-scoped (a client can have many matches over
-- time) — licensor can see their own client record via a matches join.
create policy "clients_owner_access" on clients
  for select
  using (
    exists (
      select 1 from matches
      join parties on parties.match_id = matches.id
      where matches.client_id = clients.id
      and parties.role = 'licensor'
      and parties.user_id = auth.uid()
    )
  );

-- matches: both parties can see the match row itself.
create policy "matches_party_access" on matches
  for select
  using (has_match_access(id));

-- parties: both parties can see both party rows for their match (licensor
-- already knows the invitee's email — they supplied it at setup).
create policy "parties_match_access" on parties
  for select
  using (has_match_access(match_id));

-- parties: a party can only update their OWN row (e.g. setting done_at).
create policy "parties_update_own" on parties
  for update
  using (is_own_party(id))
  with check (is_own_party(id));

-- sources: full CRUD for the uploading party. This one genuinely needs
-- reading back — the app queries file_seq/status/counts to render the
-- per-file upload list and to gate the "Done" action on all files being
-- processed + acknowledged (spec §3a).
create policy "sources_own_party_access" on sources
  for all
  using (is_own_party(party_id))
  with check (is_own_party(party_id));

-- company_hashes, contact_hashes: INSERT ONLY, no select/update/delete for
-- either party. The client generates hashes in-browser and writes them —
-- it never has a legitimate reason to read them back (progress/counts come
-- from sources.company_count/contact_count, plain integers, not hash
-- values). The only code path that ever reads raw hash rows is the
-- matching RPCs (Phase 5), which run as SECURITY DEFINER functions and
-- bypass RLS entirely. Deliberately no update/delete either — the spec
-- doesn't describe correcting a hash row after upload; a re-upload would
-- be a new source/file, not an edit to an existing one.
create policy "company_hashes_insert_own_party" on company_hashes
  for insert
  with check (is_own_party(party_id));

create policy "contact_hashes_insert_own_party" on contact_hashes
  for insert
  with check (is_own_party(party_id));

-- match_records: RAW rows restricted to the designated viewer only (spec
-- §9/§10 — only the designated "sees the matches" party gets SYN-ID-level
-- detail). The aggregate Venn (spec §7, both parties) is a separate
-- counts-only function to be added in Phase 6 — it will run as SECURITY
-- DEFINER to read match_records regardless of this policy, then return
-- only counts, never raw rows.
create policy "match_records_designated_viewer_only" on match_records
  for select
  using (
    exists (
      select 1 from matches
      where matches.id = match_records.match_id
      and matches.designated_viewer_party_id is not null
      and is_own_party(matches.designated_viewer_party_id)
    )
  );

-- ---------------------------------------------------------------------------
-- updated_at trigger for matches
-- ---------------------------------------------------------------------------

create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger matches_updated_at
  before update on matches
  for each row execute function update_updated_at();

-- ---------------------------------------------------------------------------
-- Data API grants
-- Supabase requires explicit grants for new public-schema tables (May 2025+)
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on table public.clients to anon, authenticated;
grant select, insert, update, delete on table public.matches to anon, authenticated;
grant select, insert, update, delete on table public.parties to anon, authenticated;
grant select, insert, update, delete on table public.sources to anon, authenticated;

-- Insert-only — see the policy comment above for why select/update/delete
-- are deliberately absent, not just filtered by RLS.
grant insert on table public.company_hashes to anon, authenticated;
grant insert on table public.contact_hashes to anon, authenticated;

grant select, insert, update, delete on table public.match_records to anon, authenticated;
