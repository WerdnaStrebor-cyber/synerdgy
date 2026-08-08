# Matching

Corresponds to **Phase 5** of the build plan.

Owns:
- Triggering the M1 (org) and M2 (contact) match RPCs on the explicit
  "Done" action — not on any file-count heuristic.
- `match_scope` / `site_match` flagging (spec §6) — new columns not
  present in the recovered SQL, so this is genuinely new logic layered
  on top of adapted RPC calls.

The actual matching logic (`run_org_match`, `run_contact_match`, etc.)
lives in Supabase as SQL RPCs, not in this folder — this folder is the
client-side code that calls them and handles the results.

Nothing here yet — Phase 0–4 come first.
