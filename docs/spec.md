# SyNerdgy Exchange (SX) — Design Spec

Working document capturing the business flow and technical decisions for the
Exchange product, built on the existing SyNerdgy matching engine (see
`README-engine-pack.md` for the reusable engine components this builds on).

Status: design discussion, not yet built. Open items are flagged throughout.

---

## 1. Roles

Two roles per match, fixed by identity — not configurable:

- **Licensor** — has a standing account. Logs in with username + password
  (checked against a hashed password), as with the current engine.
- **Invitee** — no account. Accesses via a one-time magic link sent to the
  email address the licensor supplies at setup.

## 2. Match types

Upload order and match visibility are tied together by one rule, carried
over from ClearCrypt: **whoever uploads second is the party who gets to see
the matches.** This is fixed and does not change.

What *is* configurable is which slot the licensor occupies. The licensor
chooses this at setup:

- **Type 1 — Licensor is party 1.** Licensor uploads first (standard
  login). Invitee uploads second (magic link) and sees the matches.
- **Type 2 — Licensor is party 2.** Invitee uploads first (magic link).
  Licensor uploads second (standard login) and sees the matches.

Both types use the identical underlying flow — only the order of who logs
in which way changes.

## 3. End-to-end flow (Type 2 example — licensor sees the matches)

1. Licensor logs in, starts a new match, names the invitee and supplies
   their email.
2. Licensor picks match type (here, Type 2 — licensor will see matches).
3. A magic link is emailed to the invitee.
4. Invitee loads their file(s), one at a time. Per file:
   a. File parses in-browser.
   b. Fields auto-detected and shown in dropdowns for confirmation.
   c. User confirms/corrects the mapping.
   d. Processing runs: SYN ID assignment, org/country/postcode
      normalisation, hashing.
   e. Consolidated mapping file re-downloads (now including this file's
      rows), alongside the lookup workbook (§5a) — see §5.
   f. User acknowledges they've saved **both** files before continuing —
      makes clear both are equally important, not one canonical file and
      one optional extra.
   The system has no way to know a party is finished by counting files —
   a party may load one file or several. Step (f) is followed by a choice:
   "load another file" or an explicit "Done" action; only the explicit
   "Done" action advances the match.
5. Invitee clicks "Done" → licensor is notified it's their turn. (Not
   triggered by any particular file count — triggered by the explicit
   action.)
6. Licensor loads their file(s) via the same per-file sequence (3a–3f).
7. Licensor clicks "Done" → this explicit action triggers matching
   automatically. (Not "the second upload" — a party may have loaded
   several files by this point.)
8. Matching runs across configured intent levels, producing org and
   contact match records (§6).
9. Aggregate Venn summary becomes available to **both** parties (§7) —
   counts only, no SYN IDs, safe regardless of who's designated to see
   detail.
10. The designated "sees the matches" party (licensor, in this example)
    fetches detailed results: selects their previously-saved mapping file
    from disk, app validates it against the current match session, then
    joins matched SYN IDs against it locally and produces a flagged
    extract (§8).
11. If enrichment is the goal: the party with the flagged extract sends
    the relevant rows to the counterpart, tagged with the counterpart's
    SYN ID, via a secure mechanism outside SX. The counterpart reconciles
    those SYN IDs against their own retained mapping file to identify the
    real records and supply the actual data. Content itself never passes
    through SX — only hashes and SYN IDs do.

## 3a. Concurrent file processing (performance)

Steps 3(a–c) — parse, auto-detect, user confirms mapping — are
human-paced. Step 3(d) — SYN ID assignment, normalisation, hashing — is
compute-paced. These do not need to be strictly serialised per file: a
user can be mapping file 2 while file 1 is still being processed in the
background. This is a deliberate performance design, not an incidental
side effect, and it introduces ordering/locking requirements the naive
one-file-at-a-time flow doesn't need:

- **`fileSeq` is assigned at queue-entry, not at processing-completion.**
  A file gets its `fileSeq` the moment it enters the processing pipeline
  (i.e. as soon as its mapping is confirmed in 3c), regardless of how
  long its hashing takes relative to other in-flight files. This
  preserves the guarantee in §4 that `fileSeq` reflects upload order and
  that any SYN ID is traceable to its source file — a file processing
  faster than one queued ahead of it must never receive an earlier
  `fileSeq`.
- **Consolidated mapping file writes are serialised by `fileSeq`, not by
  completion order.** The append-per-file writer (§5) must queue
  completed files and write their header blocks in `fileSeq` order, even
  if a later file finishes hashing first. The mapping file is the audit
  record of record; its block order must match upload order regardless
  of processing speed.
- **The download/acknowledge gate (§3f) must define behaviour for
  in-flight background processing.** If file 1 is still hashing when the
  user finishes mapping file 2, the re-download/acknowledge prompt for
  file 1 must not force-interrupt active mapping of file 2 — it should
  surface as soon as the user is between files (i.e. at the "load
  another file" / "Done" choice point), not mid-mapping.
- **"Done" blocks on all in-flight processing, not just the last
  confirmed mapping.** The explicit "Done" action (§3 steps 4–5, 7)
  cannot advance the match while any queued file is still being
  processed or its output not yet acknowledged — "no more files queued"
  is not sufficient; "all queued files fully processed and
  acknowledged" is the actual gate.

None of this changes the sequential, per-file *user-facing* flow
described in §3 — it changes what's allowed to happen concurrently
behind it.

## 4. SYN ID format

```
SYN-[projectCode]-[clientCode]-[fileSeq]-[recordSeq]
```

- `projectCode` — 5-char hex, per project.
- `clientCode` — 5-char hex, per client.
- `fileSeq` — index of the file within this party's session (4-char hex),
  baked into the ID itself so any SYN ID is traceable to its source file
  without a lookup.
- `recordSeq` — position of the record within that file (8-char hex).

**Note on the current engine pack:** `synerdgy-orchestrator.js` currently
resets its sequence counter to 1 on every upload run, meaning two
different files can produce colliding SYN IDs. This is fixed by the
`fileSeq` segment above — needs implementing, not present in the pack as
shipped.

**Performance requirements for step 3(d) processing (new):** the README
and engine pack don't currently specify execution model, batching
strategy, or hash algorithm for the normalisation/hashing pipeline. For
files in the low tens-of-thousands of records, these decisions matter
for UI responsiveness and need to be fixed deliberately rather than left
to whatever's simplest to port from the engine pack:

- **Off main thread.** Normalisation and hashing run in a Web Worker
  (or equivalent), not on the main JS thread, so the UI (dropdown
  confirmation for the next file, "Done" button, etc.) stays responsive
  while a file is processing. Progress is reported back to the main
  thread rather than blocking it.
- **Batched, not row-by-row synchronous.** The pipeline processes rows
  in chunks (e.g. a few hundred at a time), yielding between chunks,
  rather than looping through every record in a single blocking pass —
  this matters most once §3a's concurrent processing means more than
  one file's worth of rows may be in flight at once.
- **Hash algorithm chosen explicitly.** Use a fast, standard primitive
  (e.g. WebCrypto's native SHA-256) rather than a heavier custom scheme,
  so hashing 15k+ rows client-side stays sub-second-per-thousand rather
  than becoming the bottleneck.

## 5. Consolidated mapping file

One file per party per match (not one per upload). Downloaded and
re-acknowledged after **every** file load (chosen over "download once at
the end" — more clicks, but no in-progress state ever exists only in
browser memory).

Each file's upload appends a header block plus its rows to the same file:

```
# fileSeq: 0001
# filename: salesforce_export.csv
# uploaded: 2026-08-06T14:32:07Z
# field_mapping: name=Full Name, email=Email, unique_id=SF ID, country=Country
synerdgy_id, unique_id, source_filename, fileSeq
SYN-A3F7C-2A9F1-0001-00000001, XYZ3456DA, salesforce_export.csv, 0001
SYN-A3F7C-2A9F1-0001-00000002, DEF7891GH, salesforce_export.csv, 0001

# fileSeq: 0002
# filename: hubspot_contacts.xlsx
# uploaded: 2026-08-06T14:41:52Z
# field_mapping: name=Full Name, email=Email Address, unique_id=Contact ID, country=Country
synerdgy_id, unique_id, source_filename, fileSeq
SYN-A3F7C-2A9F1-0002-00000001, ABC1234FB, hubspot_contacts.xlsx, 0002
```

Contains: field mapping (which column meant what, per file), row-level
SYN ID ↔ Unique ID mapping, filename, fileSeq, timestamp. Local only —
never sent server-side. Server side only ever receives the standardised
hash outputs, regardless of what the source fields were originally
called.

A separate small local log of "fileSeq / filename / date" was considered
and folded into this file's header blocks instead of being a standalone
file — no need to keep two files in sync. This CSV remains the audit
record of record for the session.

### 5a. Lookup workbook (additional output, alongside the mapping file)

The CSV above interleaves `#` header comment lines between each file's
data block, which breaks a contiguous range for XLOOKUP if opened
directly in Excel. So a second file is generated at the same
download/acknowledge point — a two-sheet `.xlsx` workbook, purely for
easy lookups:

- **Sheet 1 — data table.** `synerdgy_id | unique_id | source_filename |
  fileSeq`, one row per record, no gaps or comment rows, formatted as an
  Excel Table object so it stays a stable range if sorted or filtered.
- **Sheet 2 — audit metadata.** Field mappings, timestamps, fileSeq
  list — the same content as the CSV's header blocks, just laid out as
  a normal table instead of comment lines.

Both files are produced together on every download; the CSV stays the
canonical audit record, the workbook is the convenience copy for lookups.
Applies to both parties equally — not a second-party-only output, since
party 1 needs the same lookup capability when reconciling incoming SYN
IDs at the end of the flow (§3 step 11).

**Performance note (new):** both outputs regenerate on every file load
(§3e), and a party may load several files in one session. The writer
should append the new file's block/rows to the existing outputs rather
than rebuilding the CSV and re-generating the full two-sheet workbook
from scratch each time — full regeneration cost grows with session size
and is unnecessary work once a session has several files in it. See §3a
for how this interacts with concurrent processing (writes are queued and
applied in `fileSeq` order regardless of which file finishes processing
first).

## 6. Match-level flagging

`match_records` currently has no field distinguishing match entity type.
Needs:

- **`match_scope`**: `organisation | contact`.
- **`site_match`** (organisation rows only, null for contact rows):
  `none | partial | full` — full = postcode matched exactly, partial =
  part-postcode matched, none = org matched but location didn't. This is
  a refinement of an org match, not a separate hash table or entity —
  genuine site-as-entity matching is parked (see §10).

`match_key` records the specific key(s) that produced a match (e.g.
`org_algo_1+domain_standardised`). `match_level` records the strength
tier — but its vocabulary depends on `match_scope`:

- **Organisation rows:** `match_level` = intent tier — `strict | standard
  | broad | loose`.
- **Contact rows:** `match_level` = contact strength level, a different
  vocabulary entirely — `contact_exact | contact_email_name |
  contact_name | contact_fuzzy | contact_telephone`, checked in that
  strength order with no double-counting (a contact matched at
  `contact_exact` doesn't also get logged at weaker levels).

Same column, two different sets of values depending on scope — correct
per the recovered M1/M2 SQL, but worth documenting explicitly since
querying `match_records` without checking `match_scope` first would be
misleading.

**Org intent → key mapping (corrected against recovered SQL, this
supersedes the earlier draft table which had `org_algo_2`/`org_algo_4`
for standard/broad — that version was wrong):**

| Intent | Keys used | Logic |
|---|---|---|
| Strict | `org_exact` | — |
| Standard | `org_algo_1` + `domain_standardised` | AND |
| Broad | `org_algo_2` OR `org_algo_3` | OR |
| Loose | `org_algo_3` OR `org_algo_4` | OR |
| Baseline (always computed) | `org_algo_3` + `country_standardised` | AND |

Org-level "fuzzy" isn't a separate query — it's M1 run against the
looser VHC tiers (`org_algo_3`/`org_algo_4`). The actual fuzzy-matching
*logic* (consonant skeletons, nickname normalisation) lives entirely in
M2 at the contact level.

**Contact matching (M2) is strictly anchored to an org match** — a
contact can only match if its parent org pair already has a
`match_records` row from M1. Confirmed present in the recovered SQL as a
strict anchor CTE, not just a config toggle.

## 7. Aggregate Venn (both parties, always visible)

Simple two-circle Venn per match, **aggregate counts only** — no SYN IDs,
no PII, safe to show both parties regardless of who's designated to see
detailed matches. Visible to **both party 1 and party 2**, regardless of
match type — this is what gives party 1 visibility into the outcome even
though they never get the SYN-ID-level detail (§10).

- Each circle shows a party's **full total** (not exclusive-of-overlap).
- Overlap number shown in the shared middle, as a subset already included
  in both totals — no addition needed to read either party's total.
- Two separate small Venns — one for organisation-level, one for
  contact-level — rather than merged into one, since an org overlap and a
  contact overlap don't mean the same thing and mixing them would muddle
  the numbers.

## 8. Session/match validation on results fetch

To stop a mismatched or accidental file being used at results time:

- A `session_id` (= the match's own ID) is embedded in the header of the
  consolidated mapping file at generation time.
- When a party fetches detailed results, they're prompted to re-select
  their saved mapping file (no persistent file-system handle exists
  across browser sessions — this is a hard technical constraint, not a
  design choice).
- App parses the file, extracts `session_id`, compares to the current
  match's session ID.
- Match → proceed with local join, produce flagged extract.
- Mismatch → clear error, no partial/silent join.
- File tampering (hand-edited session_id) — not defended against beyond
  basic parsing; worst case is zero matches shown, not exposure of
  anyone else's data.

## 9. Privacy model summary

- Only hashes and SYN IDs ever reach the SX server — no PII, no raw
  field values.
- Match results are joined against the real Unique ID **locally, in the
  browser**, using a file the party already holds. SX itself never holds
  the SYN ID ↔ Unique ID linkage.
- Only the designated "sees the matches" party can produce a flagged
  extract — enforced by them being the only one who possesses the
  correct local mapping file for their own session.
- Any downstream enrichment content transfer happens outside SX, via a
  secure mechanism the parties arrange themselves — SX's job ends at
  producing SYN ID-only match records.

## 10. Open / parked items

- **Site-as-a-genuine-entity matching** (its own hash table, hierarchy
  under organisation) — parked. Current decision (§6) treats site as a
  postcode-match flag on organisation rows, not a separate entity.
- **SYN ID ↔ Unique ID ↔ filename lookup tool** — parked until it's
  shown to be a real problem in practice. The consolidated mapping file
  (§5) already contains everything needed to do this by hand if it comes
  up.
- ~~**Party 1's own visibility.**~~ Resolved — the aggregate Venn (§7)
  is visible to both parties regardless of match type, so party 1 always
  sees the overview of what happened even though they never get the
  detailed, SYN-ID-level results.
- **Server-side field mapping storage** — explicitly decided against;
  server only ever stores standardised hash outputs, not source field
  names.

---

*Derived from the "SyNerdgy Engine Reference Pack" (README-engine-pack.md,
6 August 2026) and the design discussion that followed.*
