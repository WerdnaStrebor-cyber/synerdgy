# Results

Corresponds to **Phase 6** of the build plan.

Owns:
- Aggregate Venn (spec §7) — counts-only, visible to both parties
  regardless of match type.
- Detailed results fetch for the designated viewing party: re-select
  saved mapping file, validate `session_id` (spec §8), join locally in
  the browser, produce flagged extract. This join never touches the
  server — it happens entirely client-side against the party's own
  locally-held mapping file.

Nothing here yet — Phase 0–5 come first.
