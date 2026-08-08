# Upload

Corresponds to **Phase 3** (engine adaptation) and **Phase 4** (output
files) of the build plan.

Owns:
- Per-file flow: parse → field-mapping confirmation → process → download
  mapping file + lookup workbook → dual acknowledge (spec §3, steps a–f).
- The "load another file" vs. explicit "Done" distinction.
- Concurrent processing rules (spec §3a) — `fileSeq` assigned at
  queue-entry, writes serialised by `fileSeq` not completion order,
  "Done" blocked until all queued files are processed *and*
  acknowledged.
- Consolidated mapping CSV + lookup workbook generation (spec §5, §5a),
  appended incrementally rather than regenerated from scratch each time.

The actual hashing/normalisation work happens in a Web Worker — see
`src/workers/` — not in this folder, so the UI thread stays responsive
while a file processes (spec §4 performance requirements).

Nothing here yet — Phase 0/1/2 come first.
