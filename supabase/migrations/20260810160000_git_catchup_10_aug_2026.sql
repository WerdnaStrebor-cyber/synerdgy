-- =============================================================
-- Git catch-up — 10 Aug 2026
-- =============================================================
-- Context: 12 migrations were applied directly to the live Supabase
-- project between 09 Aug and 10 Aug 2026 (pin_function_search_paths
-- through drop_stale_mark_source_processed_overload) that were never
-- committed to this repo. Supabase's migration history table does not
-- retain each migration's original SQL text, so this is NOT a
-- byte-for-byte replay of those 12 files — it's a schema-equivalent
-- snapshot generated from the live database on 10 Aug 2026, written as
-- one idempotent migration so `git` and the live project agree from
-- here on. Everything below is either CREATE OR REPLACE, IF NOT
-- EXISTS, or a DROP-then-CREATE for policies — safe to apply against
-- either a fresh Phase 1 schema or the already-live project.
--
-- Covers, in the order the live history applied them:
--   1. clients.created_by column + ownership policies
--   2. matches ownership SELECT policy (client-owner path)
--   3. RLS helper functions (current_party_id, has_match_access,
--      is_own_party) — recursion-safe versions
--   4. lookup-tables public Storage bucket
--   5. Orchestrator RPCs: queue_source_upload, mark_source_processed,
--      acknowledge_source
--   6. sources.status CHECK constraint — 'ready' added
--   7. contact_hashes: email -> email_name/email_domain split,
--      firstname_canonical added
--   8. Stale 3-arg mark_source_processed overload dropped (this
--      session, 10 Aug 2026 — see build-plan.md)
-- =============================================================

-- ---------------------------------------------------------------
-- 1. clients ownership
-- ---------------------------------------------------------------

alter table clients add column if not exists created_by uuid default auth.uid();

drop policy if exists "clients_owner_access" on clients;
drop policy if exists "clients_owner_select" on clients;
drop policy if exists "clients_owner_insert" on clients;

create policy "clients_owner_select" on clients
  for select using (created_by = auth.uid());

create policy "clients_owner_insert" on clients
  for insert with check (created_by = auth.uid());

-- ---------------------------------------------------------------
-- 2. matches — client-owner SELECT path (licensor viewing their own
--    matches via clients.created_by, alongside the existing
--    party-access path)
-- ---------------------------------------------------------------

drop policy if exists "matches_client_owner_select" on matches;

create policy "matches_client_owner_select" on matches
  for select using (
    exists (
      select 1 from clients
      where clients.id = matches.client_id
      and clients.created_by = auth.uid()
    )
  );

-- ---------------------------------------------------------------
-- 3. RLS helper functions — recursion-safe versions
--    (fix_rls_helper_recursion, 09 Aug 2026)
-- ---------------------------------------------------------------

create or replace function public.current_party_id(target_match_id uuid)
returns uuid
language sql stable security definer
set search_path to 'public'
as $$
  select parties.id
  from parties
  where parties.match_id = target_match_id
  and (
    (parties.role = 'licensor' and parties.user_id = auth.uid())
    or
    (parties.role = 'invitee' and parties.id = nullif(current_setting('app.party_id', true), '')::uuid)
  );
$$;

create or replace function public.has_match_access(target_match_id uuid)
returns boolean
language sql stable security definer
set search_path to 'public'
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

create or replace function public.is_own_party(target_party_id uuid)
returns boolean
language sql stable security definer
set search_path to 'public'
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

-- ---------------------------------------------------------------
-- 4. lookup-tables Storage bucket (public — generic reference data,
--    no PII, identical across every match; see synerdgy-lookup-
--    loader.js header comment for the rationale)
-- ---------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('lookup-tables', 'lookup-tables', true)
on conflict (id) do nothing;

drop policy if exists "lookup_tables_public_read" on storage.objects;

create policy "lookup_tables_public_read" on storage.objects
  for select using (bucket_id = 'lookup-tables');

-- ---------------------------------------------------------------
-- 5. sources.status — add 'ready' between 'processing' and
--    'acknowledged' (spec §3a: processing-finished vs user-acked
--    are genuinely different states the UI must distinguish)
-- ---------------------------------------------------------------

alter table sources drop constraint if exists sources_status_check;

alter table sources add constraint sources_status_check
  check (status in ('queued', 'processing', 'ready', 'acknowledged'));

-- ---------------------------------------------------------------
-- 6. contact_hashes — email split into email_name/email_domain
--    (M2's contact_exact needs both matching; contact_email_name
--    needs email_name alone — a single opaque hash can't support
--    both), plus firstname_canonical for the contact_name level
--    (nickname resolution — synerdgy-firstname-canonicaliser.js)
-- ---------------------------------------------------------------

alter table contact_hashes drop column if exists email;
alter table contact_hashes add column if not exists email_name char(64);
alter table contact_hashes add column if not exists email_domain char(64);
alter table contact_hashes add column if not exists firstname_canonical char(64);

-- ---------------------------------------------------------------
-- 7. Orchestrator RPCs — queue_source_upload, mark_source_processed,
--    acknowledge_source. Only the final, batching-aware, email-split
--    version of mark_source_processed is created here; the earlier
--    3-arg version that briefly existed live has already been
--    dropped (this session, 10 Aug 2026) and is not recreated.
-- ---------------------------------------------------------------

create or replace function public.queue_source_upload(
  p_match_id uuid,
  p_filename text,
  p_source_type text default null
)
returns table(source_id uuid, file_seq text)
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_party_id uuid;
  v_next_seq int;
  v_file_seq text;
  v_new_id uuid;
begin
  v_party_id := current_party_id(p_match_id);
  if v_party_id is null then
    raise exception 'not authorized for this match';
  end if;

  -- Serialise fileSeq assignment per party — two files confirmed in
  -- quick succession must not race for the same number.
  perform pg_advisory_xact_lock(hashtext(v_party_id::text));

  select count(*) + 1 into v_next_seq
  from sources
  where party_id = v_party_id;

  v_file_seq := upper(lpad(to_hex(v_next_seq), 4, '0'));

  insert into sources (party_id, match_id, file_seq, display_name, source_type, status)
  values (v_party_id, p_match_id, v_file_seq, p_filename, p_source_type, 'queued')
  returning id into v_new_id;

  return query select v_new_id, v_file_seq;
end;
$$;

create or replace function public.mark_source_processed(
  p_source_id uuid,
  p_company_records jsonb,
  p_contact_records jsonb,
  p_final boolean default true
)
returns void
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_party_id uuid;
  v_match_id uuid;
begin
  select party_id, match_id into v_party_id, v_match_id
  from sources where id = p_source_id;

  if v_party_id is null then
    raise exception 'source not found';
  end if;
  if not is_own_party(v_party_id) then
    raise exception 'not authorized for this source';
  end if;

  with ins_company as (
    insert into company_hashes (
      source_id, party_id, match_id, client_record_id, country_display,
      org_exact, org_algo_1, org_algo_2, org_algo_3, org_algo_4,
      domain_standardised, country_standardised, postcode_exact,
      zip_standardised, part_zip_standardised
    )
    select
      p_source_id, v_party_id, v_match_id,
      r.client_record_id, r.country_display,
      r.org_exact, r.org_algo_1, r.org_algo_2, r.org_algo_3, r.org_algo_4,
      r.domain_standardised, r.country_standardised, r.postcode_exact,
      r.zip_standardised, r.part_zip_standardised
    from jsonb_to_recordset(p_company_records) as r(
      client_record_id text, country_display text,
      org_exact text, org_algo_1 text, org_algo_2 text, org_algo_3 text, org_algo_4 text,
      domain_standardised text, country_standardised text, postcode_exact text,
      zip_standardised text, part_zip_standardised text
    )
    returning id, client_record_id
  )
  insert into contact_hashes (
    source_id, party_id, match_id, company_hash_id, client_record_id,
    email_name, email_domain, firstname_standardised, firstname_canonical,
    firstname_initial, surname_standardised, telephone_standardised
  )
  select
    p_source_id, v_party_id, v_match_id, ins_company.id,
    r.client_record_id, r.email_name, r.email_domain, r.firstname_standardised,
    r.firstname_canonical, r.firstname_initial, r.surname_standardised,
    r.telephone_standardised
  from jsonb_to_recordset(p_contact_records) as r(
    client_record_id text, email_name text, email_domain text,
    firstname_standardised text, firstname_canonical text, firstname_initial text,
    surname_standardised text, telephone_standardised text
  )
  join ins_company on ins_company.client_record_id = r.client_record_id;

  update sources
  set company_count = coalesce(company_count, 0) + jsonb_array_length(p_company_records),
      contact_count = coalesce(contact_count, 0) + jsonb_array_length(p_contact_records),
      status = case when p_final then 'ready' else status end,
      loaded_at = case when p_final then now() else loaded_at end
  where id = p_source_id;
end;
$$;

create or replace function public.acknowledge_source(p_source_id uuid)
returns void
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_party_id uuid;
begin
  select party_id into v_party_id from sources where id = p_source_id;

  if v_party_id is null then
    raise exception 'source not found';
  end if;
  if not is_own_party(v_party_id) then
    raise exception 'not authorized for this source';
  end if;

  update sources set status = 'acknowledged'
  where id = p_source_id and status = 'ready';

  if not found then
    raise exception 'source not in ready state';
  end if;
end;
$$;
