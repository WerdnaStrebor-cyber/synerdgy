/**
 * Synerdgy — Modules 8 & 9: Hashing + Supabase Insert Pipeline
 * =============================================================
 * Module 8: SHA-256 hashing of all derived fields using the Web Crypto API.
 * Module 9: Batch insert of hashed records into Supabase company_hashes table.
 *
 * These two modules are combined because they are always used together —
 * hashed records are never held in memory longer than necessary before insert.
 *
 * Hashing rules:
 *   - Salt is prepended to value before hashing: SHA-256(salt + value)
 *   - All values are lowercased and trimmed before hashing
 *   - Empty / null values produce null in the output (not hashed)
 *   - country_display is stored as clear text — never hashed
 *   - postcode_exact and zip_standardised are both derived from zipStand
 *     (same source value, same hash — two columns for query flexibility)
 *
 * Salt handling:
 *   - Salt is a project-specific UUID fetched from Supabase at session start
 *   - Never stored in localStorage, sessionStorage, or any persistent browser store
 *   - Held only in the active JS session (module-scoped variable)
 *   - Cleared on session end / page unload
 *
 * Insert strategy:
 *   - Records processed and hashed in batches of HASH_BATCH_SIZE (500)
 *   - Each hash batch inserted immediately — minimises peak memory usage
 *   - Insert batches of INSERT_BATCH_SIZE (1000) rows per Supabase request
 *   - Progress callback fired after each insert batch
 *   - On error: logs failing batch, throws — caller decides retry strategy
 *   - contact_hashes insert stubbed for Phase 2
 *
 * Dependencies:
 *   Supabase JS client (loaded from CDN in host HTML file)
 *   Derived record shape from upstream modules:
 *     { orgExact, orgAlgo1, orgAlgo2, orgAlgo3, orgAlgo4 }  — Module 4
 *     { domain }                                             — Module 3a
 *     { iso2, displayName }                                  — Module 6
 *     { zipStand, partZip }                                  — Module 7
 *
 * Usage:
 *   // 1. Fetch salt at session start
 *   await HashPipeline.loadSalt(supabase, projectId);
 *
 *   // 2. Process and insert a source file
 *   await HashPipeline.processAndInsert(
 *     supabase, sourceId, projectId, derivedRecords, onProgress
 *   );
 */

'use strict';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HASH_BATCH_SIZE   = 500;   // records hashed per batch before insert
const INSERT_BATCH_SIZE = 1000;  // rows per Supabase insert request

// ---------------------------------------------------------------------------
// Salt management
// Module-scoped — never persisted beyond the active page session
// ---------------------------------------------------------------------------

let _sessionSalt = null;

/**
 * Fetch the match salt from Supabase and store in module scope.
 * Must be called once before processAndInsert().
 *
 * The salt is stored in the matches table as a UUID column (renamed from
 * v2's projects.salt — same column, new table name).
 * It is not returned to the caller — only held internally for this session.
 *
 * @param {SupabaseClient} supabase
 * @param {string} matchId
 */
async function loadSalt(supabase, matchId) {
  const { data, error } = await supabase
    .from('matches')
    .select('salt')
    .eq('id', matchId)
    .single();

  if (error || !data?.salt) {
    throw new Error(`HashPipeline: failed to load match salt. ${error?.message ?? 'No salt found.'}`);
  }

  _sessionSalt = data.salt;
}

/**
 * Clear the session salt — call on logout or page unload.
 */
function clearSalt() {
  _sessionSalt = null;
}

// Register automatic clear on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', clearSalt);
}

// ---------------------------------------------------------------------------
// Module 8: SHA-256 hashing
// ---------------------------------------------------------------------------

/**
 * Hash a single value with the session salt.
 * Returns null for empty/null values — these map to NULL in Supabase,
 * preserving the ability to distinguish "not provided" from a hash.
 *
 * @param {string} value
 * @returns {Promise<string|null>}
 */
async function sha256(value) {
  if (!_sessionSalt) {
    throw new Error('HashPipeline: salt not loaded. Call loadSalt() first.');
  }
  if (!value || !String(value).trim()) return null;

  // Normalise before hashing — mirrors Python: salt + value.strip().lower()
  const input   = _sessionSalt + String(value).trim().toLowerCase();
  const encoded = new TextEncoder().encode(input);
  const buffer  = await crypto.subtle.digest('SHA-256', encoded);
  const bytes   = new Uint8Array(buffer);

  // Convert to 64-char lowercase hex string — matches Python hashlib output
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Hash all fields for a single derived record.
 * Returns a Supabase-ready row object (column names match company_hashes schema).
 *
 * @param {DerivedRecord} derived
 * @returns {Promise<HashedRecord>}
 *
 * @typedef {Object} DerivedRecord
 * @property {string} clientRecordId - SYN ID e.g. SYN-A3F7C-2A9F1-0000A3B4
 *                                     Format: SYN-[5 hex project]-[5 hex client]-[8 hex sequence]
 *                                     Assigned by orchestrator, stored in company_hashes.
 *                                     Client retains local mapping file linking this to their source ID.
 * @property {string} orgExact       - From Module 4
 * @property {string} orgAlgo1       - From Module 4
 * @property {string} orgAlgo2       - From Module 4
 * @property {string} orgAlgo3       - From Module 4
 * @property {string} orgAlgo4       - From Module 4
 * @property {string} domain         - From Module 3a
 * @property {string} countryIso2    - From Module 6 (.iso2)
 * @property {string} countryDisplay - From Module 6 (.displayName) — not hashed
 * @property {string} zipStand       - From Module 7
 * @property {string} partZip        - From Module 7
 *
 * @typedef {Object} HashedRecord
 * @property {string}      client_record_id       — SYN ID, char(24), not hashed — stored as-is
 * @property {string|null} org_exact
 * @property {string|null} org_algo_1
 * @property {string|null} org_algo_2
 * @property {string|null} org_algo_3
 * @property {string|null} org_algo_4
 * @property {string|null} domain_standardised
 * @property {string|null} country_standardised
 * @property {string|null} postcode_exact
 * @property {string|null} zip_standardised
 * @property {string|null} part_zip_standardised
 * @property {string}      country_display        — clear text, never hashed
 */
async function hashRecord(derived) {
  // Hash all fields in parallel — Web Crypto is async but non-blocking
  const [
    org_exact,
    org_algo_1,
    org_algo_2,
    org_algo_3,
    org_algo_4,
    domain_standardised,
    country_standardised,
    postcode_exact,
    part_zip_standardised,
  ] = await Promise.all([
    sha256(derived.orgExact),
    sha256(derived.orgAlgo1),
    sha256(derived.orgAlgo2),
    sha256(derived.orgAlgo3),
    sha256(derived.orgAlgo4),
    sha256(derived.domain),
    sha256(derived.countryIso2),
    sha256(derived.zipStand),
    sha256(derived.partZip),
  ]);

  return {
    client_record_id:      derived.clientRecordId,  // SYN ID — stored as-is, not hashed
    org_exact,
    org_algo_1,
    org_algo_2,
    org_algo_3,
    org_algo_4,
    domain_standardised,
    country_standardised,
    postcode_exact,
    zip_standardised:      postcode_exact,  // same source value, same hash
    part_zip_standardised,
    country_display:       derived.countryDisplay ?? '', // clear text — not hashed
  };
}

/**
 * Hash a batch of derived records in parallel.
 *
 * @param {DerivedRecord[]} derivedBatch
 * @returns {Promise<HashedRecord[]>}
 */
async function hashBatch(derivedBatch) {
  return Promise.all(derivedBatch.map(hashRecord));
}

// ---------------------------------------------------------------------------
// Module 9: Supabase insert pipeline
// ---------------------------------------------------------------------------

/**
 * Insert a batch of hashed records into company_hashes.
 * Adds source_id, party_id, and match_id to each row — the new schema
 * denormalises match_id onto company_hashes directly (v2 only had
 * source_id + project_id), and party_id replaces v2's implicit
 * single-party-per-project assumption.
 *
 * NOT YET WIRED FOR INVITEE UPLOADS: this does a direct table insert,
 * which relies on standard RLS — fine for the licensor (real auth.uid()),
 * but per the 10 Aug 2026 decision, invitee writes need to route through
 * a SECURITY DEFINER RPC instead (token passed explicitly, no session
 * state). That RPC doesn't exist yet — build it alongside the
 * orchestrator's queue/fileSeq rework, not here.
 *
 * @param {SupabaseClient} supabase
 * @param {string} sourceId
 * @param {string} partyId
 * @param {string} matchId
 * @param {HashedRecord[]} hashedRecords
 */
async function _insertCompanyBatch(supabase, sourceId, partyId, matchId, hashedRecords) {
  const rows = hashedRecords.map(r => ({
    source_id: sourceId,
    party_id:  partyId,
    match_id:  matchId,
    ...r,
  }));

  const { error } = await supabase
    .from('company_hashes')
    .insert(rows);

  if (error) {
    console.error('HashPipeline: insert error', error);
    throw new Error(`Insert failed: ${error.message}`);
  }
}

/**
 * Update the sources record with final record counts once all inserts
 * are complete. Renamed from v2's project_sources.
 *
 * @param {SupabaseClient} supabase
 * @param {string} sourceId
 * @param {number} companyCount
 */
async function _updateSourceCounts(supabase, sourceId, companyCount) {
  const { error } = await supabase
    .from('sources')
    .update({
      company_count: companyCount,
      loaded_at:     new Date().toISOString(),
    })
    .eq('id', sourceId);

  if (error) {
    console.warn(`HashPipeline: failed to update source counts. ${error.message}`);
    // Non-fatal — counts can be recomputed
  }
}

// ---------------------------------------------------------------------------
// Main pipeline entry point
// ---------------------------------------------------------------------------

/**
 * Process an array of derived records: hash all fields and insert into Supabase.
 *
 * Records are processed in batches to keep memory usage flat regardless of
 * file size. Each hash batch is inserted before the next is hashed.
 *
 * @param {SupabaseClient} supabase
 * @param {string}         sourceId        - sources.id for this upload
 * @param {string}         partyId         - parties.id for the uploading party
 * @param {string}         matchId         - matches.id
 * @param {DerivedRecord[]} derivedRecords - Full array from upstream modules
 * @param {Function}       [onProgress]    - Callback(inserted, total) — called after each insert batch
 * @returns {Promise<{ inserted: number, errors: number }>}
 */
async function processAndInsert(supabase, sourceId, partyId, matchId, derivedRecords, onProgress) {
  if (!_sessionSalt) {
    throw new Error('HashPipeline: salt not loaded. Call loadSalt() first.');
  }

  const total    = derivedRecords.length;
  let inserted   = 0;
  let errors     = 0;

  // Process in HASH_BATCH_SIZE chunks
  for (let i = 0; i < total; i += HASH_BATCH_SIZE) {
    const derivedBatch = derivedRecords.slice(i, i + HASH_BATCH_SIZE);

    // Hash the batch
    let hashedBatch;
    try {
      hashedBatch = await hashBatch(derivedBatch);
    } catch (err) {
      console.error(`HashPipeline: hashing failed at record ${i}`, err);
      errors += derivedBatch.length;
      continue; // skip this batch, keep going
    }

    // Insert in sub-batches if hash batch > INSERT_BATCH_SIZE
    for (let j = 0; j < hashedBatch.length; j += INSERT_BATCH_SIZE) {
      const insertBatch = hashedBatch.slice(j, j + INSERT_BATCH_SIZE);
      try {
        await _insertCompanyBatch(supabase, sourceId, partyId, matchId, insertBatch);
        inserted += insertBatch.length;
        if (onProgress) onProgress(inserted, total);
      } catch (err) {
        console.error(`HashPipeline: insert failed at record ${i + j}`, err);
        errors += insertBatch.length;
        // Continue — partial inserts are better than total failure
        // Caller can check the returned error count and prompt user
      }
    }
  }

  // Update sources with final count
  await _updateSourceCounts(supabase, sourceId, inserted);

  // Phase 2 stub — contact_hashes insert would go here
  // await _insertContactBatch(supabase, sourceId, partyId, matchId, contactRecords);

  console.log(`HashPipeline: complete. ${inserted} inserted, ${errors} errors from ${total} records.`);
  return { inserted, errors };
}

// ---------------------------------------------------------------------------
// Built-in test suite
// Tests hashing behaviour without a live Supabase connection.
// Call runTests() after loading a salt (or inject a test salt directly).
// ---------------------------------------------------------------------------

async function runTests() {
  console.group('Synerdgy Hash Pipeline — Self-Tests');

  // Inject a known test salt so outputs are deterministic
  const savedSalt = _sessionSalt;
  _sessionSalt = 'test-salt-synerdgy-2024';

  let passed = 0;
  let failed = 0;

  // Test 1: known hash output
  // SHA-256('test-salt-synerdgy-2024' + 'tesco') should be deterministic
  const hash1 = await sha256('tesco');
  if (hash1 && hash1.length === 64 && /^[0-9a-f]+$/.test(hash1)) {
    console.log(`✅ sha256 produces 64-char hex string`);
    console.log(`   sha256('tesco') = ${hash1}`);
    passed++;
  } else {
    console.warn(`❌ sha256 output malformed: "${hash1}"`);
    failed++;
  }

  // Test 2: same input → same hash (deterministic)
  const hash2 = await sha256('tesco');
  if (hash1 === hash2) {
    console.log(`✅ Deterministic: same input produces same hash`);
    passed++;
  } else {
    console.warn(`❌ Non-deterministic: same input produced different hashes`);
    failed++;
  }

  // Test 3: different input → different hash
  const hash3 = await sha256('sainsburys');
  if (hash1 !== hash3) {
    console.log(`✅ Different inputs produce different hashes`);
    passed++;
  } else {
    console.warn(`❌ Collision: different inputs produced same hash`);
    failed++;
  }

  // Test 4: case insensitivity — 'Tesco' and 'tesco' should hash identically
  const hash4 = await sha256('Tesco');
  if (hash1 === hash4) {
    console.log(`✅ Case-insensitive: 'Tesco' === sha256('tesco')`);
    passed++;
  } else {
    console.warn(`❌ Case-sensitive mismatch: 'Tesco' hashed differently from 'tesco'`);
    failed++;
  }

  // Test 5: empty / null → null (not hashed)
  const hash5 = await sha256('');
  const hash6 = await sha256(null);
  const hash7 = await sha256('   ');
  if (hash5 === null && hash6 === null && hash7 === null) {
    console.log(`✅ Empty/null values return null (not hashed)`);
    passed++;
  } else {
    console.warn(`❌ Empty/null values not returning null: "${hash5}", "${hash6}", "${hash7}"`);
    failed++;
  }

  // Test 6: hashRecord produces correct column structure
  const mockDerived = {
    orgExact:       'tesco stores limited',
    orgAlgo1:       'tesco store',
    orgAlgo2:       'tesco store',
    orgAlgo3:       'tescostore',
    orgAlgo4:       'tesco',
    domain:         'tesco.com',
    countryIso2:    'GB',
    countryDisplay: 'United Kingdom',
    zipStand:       'SW1A 1AA',
    partZip:        'SW1A',
  };
  const hashed = await hashRecord(mockDerived);

  const expectedColumns = [
    'org_exact', 'org_algo_1', 'org_algo_2', 'org_algo_3', 'org_algo_4',
    'domain_standardised', 'country_standardised',
    'postcode_exact', 'zip_standardised', 'part_zip_standardised',
    'country_display',
  ];
  const missingCols = expectedColumns.filter(c => !(c in hashed));
  if (missingCols.length === 0) {
    console.log(`✅ hashRecord produces all expected Supabase columns`);
    passed++;
  } else {
    console.warn(`❌ hashRecord missing columns: ${missingCols.join(', ')}`);
    failed++;
  }

  // Test 7: postcode_exact and zip_standardised are the same hash
  if (hashed.postcode_exact === hashed.zip_standardised) {
    console.log(`✅ postcode_exact === zip_standardised (same source, same hash)`);
    passed++;
  } else {
    console.warn(`❌ postcode_exact !== zip_standardised`);
    failed++;
  }

  // Test 8: country_display is clear text, not a hash
  if (hashed.country_display === 'United Kingdom') {
    console.log(`✅ country_display stored as clear text (not hashed)`);
    passed++;
  } else {
    console.warn(`❌ country_display wrong: "${hashed.country_display}"`);
    failed++;
  }

  // Test 9: null fields in derived produce null hashes (not empty string)
  const mockSparse = {
    orgExact: 'acme corp', orgAlgo1: 'acme', orgAlgo2: 'acme',
    orgAlgo3: 'acme', orgAlgo4: 'acme',
    domain: '',          // no website
    countryIso2: '',     // no country
    countryDisplay: '',
    zipStand: '',        // no postcode
    partZip: '',
  };
  const hashedSparse = await hashRecord(mockSparse);
  if (
    hashedSparse.domain_standardised    === null &&
    hashedSparse.country_standardised   === null &&
    hashedSparse.postcode_exact         === null &&
    hashedSparse.zip_standardised       === null &&
    hashedSparse.part_zip_standardised  === null
  ) {
    console.log(`✅ Empty derived fields produce NULL hashes (not empty string)`);
    passed++;
  } else {
    console.warn(`❌ Empty fields not producing NULL:`);
    console.warn(`   domain: ${hashedSparse.domain_standardised}`);
    console.warn(`   country: ${hashedSparse.country_standardised}`);
    console.warn(`   postcode: ${hashedSparse.postcode_exact}`);
    failed++;
  }

  // Restore original salt
  _sessionSalt = savedSalt;

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  console.groupEnd();

  return { passed, failed };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  loadSalt,
  clearSalt,
  sha256,
  hashRecord,
  hashBatch,
  processAndInsert,
  runTests,
};
