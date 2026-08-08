# Auth

Corresponds to **Phase 2** of the build plan.

Two login paths:
- Licensor: standard username + password (Supabase Auth).
- Invitee: magic link, scoped to a single match/session only.

Also owns: match-type selection (Type 1 / Type 2, spec §2), since that
determines which login path a given user goes through.

Nothing here yet — Phase 0/1 (infrastructure, schema) come first.
