# Workers

Web Worker code for the compute-paced part of file processing (spec §4
performance requirements, and §3a concurrent processing):

- Normalisation (org/country/postcode standardisation) and hashing run
  here, off the main thread, so the UI stays responsive while a file is
  processing.
- Rows are processed in batches, not one at a time.
- Hashing uses WebCrypto's native SHA-256.

This is what lets a user confirm the mapping for file 2 while file 1 is
still hashing in the background (spec §3a) without the browser tab
freezing.

Nothing here yet — built as part of Phase 3.
