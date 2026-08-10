/**
 * Synerdgy — Module 8: Hashing
 * =============================================================
 * SHA-256 hashing of all derived fields using the Web Crypto API.
 *
 * REWRITTEN 10 Aug 2026 — two changes from the previous version:
 *
 * 1. Salt is now an explicit parameter, not module-scoped state loaded
 *    via a Supabase call. The previous version's `loadSalt(supabase,
 *    matchId)` set a module-scoped `_sessionSalt` read implicitly by
 *    every hash call, with cleanup wired to `window.addEventListener
 *    ('pagehide', ...)`. That breaks inside a Web Worker — no `window`,
 *    no `pagehide` event, no shared module state with the main thread.
 *    Since §4 requires hashing to run off the main thread (spec §3a/§4
 *    concurrent processing), these functions are now pure: pass the
 *    salt in, get a result out, nothing implicit. `loadSalt` is kept as
 *    a main-thread convenience for fetching the salt value once per
 *    session — the orchestrator calls this once, then passes the
 *    resolved salt string into each worker job explicitly.
 *
 * 2. Contact-side hashing added (`hashContactRecord`/`hashContactBatch`)
 *    — the previous version only hashed organisation fields; the
 *    contact_hashes insert was an unimplemented stub. This was a real
 *    gap: match_records can never have match_scope='contact' rows
 *    without this.
 *
 * Direct-insert logic (`processAndInsert`, `_insertCompanyBatch`,
 * `_updateSourceCounts`) has been removed entirely — insertion now goes
 * through the `mark_source_processed` RPC (handles both licensor and
 * invitee auth, not just licensor via RLS), called by the orchestrator's
 * dispatcher on the main thread after a worker posts back a hashed
 * batch. This module now only hashes; it never touches Supabase.
 *
 * Hashing rules (unchanged):
 *   - Salt is prepended to value before hashing: SHA-256(salt + value)
 *   - All values are lowercased and trimmed before hashing
 *   - Empty / null values produce null in the output (not hashed)
 *   - country_display is stored as clear text — never hashed
 *   - postcode_exact and zip_standardised are both derived from zipStand
 *     (same source value, same hash — two columns for query flexibility)
 *
 * Usage (main thread):
 *   const salt = await HashPipeline.loadSalt(supabase, matchId);
 *   // ... pass `salt` into each worker job message ...
 *
 * Usage (inside a worker, or synchronously on main thread for small jobs):
 *   const hashedCompany = await HashPipeline.hashBatch(derivedBatch, salt);
 *   const hashedContact = await HashPipeline.hashContactBatch(contactBatch, salt);
 */

'use strict';

// ---------------------------------------------------------------------------
// Salt fetch (main-thread only — uses the Supabase client)
// ---------------------------------------------------------------------------

/**
 * Fetch the match salt from Supabase. Called once per session on the
 * main thread; the returned value is passed explicitly into worker jobs
 * from there on. Not stored in module state — the caller owns it.
 *
 * @param {SupabaseClient} supabase
 * @param {string} matchId
 * @returns {Promise<string>} the salt UUID
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

  return data.salt;
}

// ---------------------------------------------------------------------------
// Module 8: SHA-256 hashing — pure functions, salt passed explicitly
// ---------------------------------------------------------------------------

/**
 * Hash a single value with the given salt.
 * Returns null for empty/null values — these map to NULL in Supabase,
 * preserving the ability to distinguish "not provided" from a hash.
 *
 * @param {string} value
 * @param {string} salt
 * @returns {Promise<string|null>}
 */
async function sha256(value, salt) {
  if (!salt) {
    throw new Error('HashPipeline: sha256() called without a salt.');
  }
  if (!value || !String(value).trim()) return null;

  // Normalise before hashing — mirrors Python: salt + value.strip().lower()
  const input   = salt + String(value).trim().toLowerCase();
  const encoded = new TextEncoder().encode(input);
  const buffer  = await crypto.subtle.digest('SHA-256', encoded);
  const bytes   = new Uint8Array(buffer);

  // Convert to 64-char lowercase hex string — matches Python hashlib output
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Hash all organisation fields for a single derived record.
 * Returns a row object shaped to match company_hashes columns.
 *
 * @param {DerivedRecord} derived
 * @param {string} salt
 * @returns {Promise<HashedCompanyRecord>}
 *
 * @typedef {Object} DerivedRecord
 * @property {string} clientRecordId - SYN ID e.g. SYN-A3F7C-2A9F1-0001-00000001
 *                                     Format: SYN-[5hex project]-[5hex client]-[4hex fileSeq]-[8hex recordSeq]
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
 */
async function hashRecord(derived, salt) {
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
    sha256(derived.orgExact, salt),
    sha256(derived.orgAlgo1, salt),
    sha256(derived.orgAlgo2, salt),
    sha256(derived.orgAlgo3, salt),
    sha256(derived.orgAlgo4, salt),
    sha256(derived.domain, salt),
    sha256(derived.countryIso2, salt),
    sha256(derived.zipStand, salt),
    sha256(derived.partZip, salt),
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
 * Hash a batch of derived organisation records in parallel.
 *
 * @param {DerivedRecord[]} derivedBatch
 * @param {string} salt
 * @returns {Promise<HashedCompanyRecord[]>}
 */
async function hashBatch(derivedBatch, salt) {
  return Promise.all(derivedBatch.map(d => hashRecord(d, salt)));
}

/**
 * Hash all contact fields for a single derived contact record.
 * Returns a row object shaped to match contact_hashes columns (minus
 * company_hash_id, which is assigned server-side by mark_source_processed
 * via the client_record_id join — see that function's comments).
 *
 * REWRITTEN 10 Aug 2026: email is now split into emailName/emailDomain
 * before hashing, hashed as two separate columns, instead of one whole-
 * email hash. The M2 SQL's contact_exact level joins on email_name AND
 * email_domain both matching (equivalent to a full email match), and
 * contact_email_name joins on email_name alone with domain ignored — a
 * single opaque whole-email hash can't support that second level at
 * all, since the local part is never separable from a hash after the
 * fact. Splitting has to happen client-side, before hashing.
 *
 * @param {DerivedContactRecord} derived
 * @param {string} salt
 * @returns {Promise<HashedContactRecord>}
 *
 * @typedef {Object} DerivedContactRecord
 * @property {string} clientRecordId      - Same SYN ID as the paired company record
 *                                          for this row (one input row produces one
 *                                          company_hashes row and one contact_hashes
 *                                          row, linked by this shared id).
 * @property {string} emailName            - Local part of the email, before '@'
 * @property {string} emailDomain          - Domain part of the email, after '@'
 * @property {string} firstNameStandardised
 * @property {string} firstNameInitial
 * @property {string} surnameStandardised
 * @property {string} telephoneStandardised
 */
async function hashContactRecord(derived, salt) {
  const [
    email_name,
    email_domain,
    firstname_standardised,
    firstname_initial,
    surname_standardised,
    telephone_standardised,
  ] = await Promise.all([
    sha256(derived.emailName, salt),
    sha256(derived.emailDomain, salt),
    sha256(derived.firstNameStandardised, salt),
    sha256(derived.firstNameInitial, salt),
    sha256(derived.surnameStandardised, salt),
    sha256(derived.telephoneStandardised, salt),
  ]);

  return {
    client_record_id: derived.clientRecordId,
    email_name,
    email_domain,
    firstname_standardised,
    firstname_initial,
    surname_standardised,
    telephone_standardised,
  };
}

/**
 * Hash a batch of derived contact records in parallel.
 *
 * @param {DerivedContactRecord[]} derivedBatch
 * @param {string} salt
 * @returns {Promise<HashedContactRecord[]>}
 */
async function hashContactBatch(derivedBatch, salt) {
  return Promise.all(derivedBatch.map(d => hashContactRecord(d, salt)));
}

// ---------------------------------------------------------------------------
// Built-in test suite
// Tests hashing behaviour without a live Supabase connection.
// ---------------------------------------------------------------------------

async function runTests() {
  console.group('Synerdgy Hash Pipeline — Self-Tests');

  const TEST_SALT = 'test-salt-synerdgy-2024';
  let passed = 0;
  let failed = 0;

  const hash1 = await sha256('tesco', TEST_SALT);
  if (hash1 && hash1.length === 64 && /^[0-9a-f]+$/.test(hash1)) {
    console.log(`✅ sha256 produces 64-char hex string`);
    passed++;
  } else {
    console.warn(`❌ sha256 output malformed: "${hash1}"`);
    failed++;
  }

  const hash2 = await sha256('tesco', TEST_SALT);
  if (hash1 === hash2) {
    console.log(`✅ Deterministic: same input produces same hash`);
    passed++;
  } else {
    console.warn(`❌ Non-deterministic: same input produced different hashes`);
    failed++;
  }

  const hash3 = await sha256('sainsburys', TEST_SALT);
  if (hash1 !== hash3) {
    console.log(`✅ Different inputs produce different hashes`);
    passed++;
  } else {
    console.warn(`❌ Collision: different inputs produced same hash`);
    failed++;
  }

  const hash4 = await sha256('Tesco', TEST_SALT);
  if (hash1 === hash4) {
    console.log(`✅ Case-insensitive: 'Tesco' === sha256('tesco')`);
    passed++;
  } else {
    console.warn(`❌ Case-sensitive mismatch`);
    failed++;
  }

  const hash5 = await sha256('', TEST_SALT);
  const hash6 = await sha256(null, TEST_SALT);
  const hash7 = await sha256('   ', TEST_SALT);
  if (hash5 === null && hash6 === null && hash7 === null) {
    console.log(`✅ Empty/null values return null (not hashed)`);
    passed++;
  } else {
    console.warn(`❌ Empty/null values not returning null`);
    failed++;
  }

  // Different salts must produce different hashes for the same value —
  // this is the whole point of per-match salting.
  const hashSaltA = await sha256('tesco', 'salt-a');
  const hashSaltB = await sha256('tesco', 'salt-b');
  if (hashSaltA !== hashSaltB) {
    console.log(`✅ Different salts produce different hashes for same value`);
    passed++;
  } else {
    console.warn(`❌ Salt not affecting hash output`);
    failed++;
  }

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
  const hashed = await hashRecord(mockDerived, TEST_SALT);
  const expectedColumns = [
    'org_exact', 'org_algo_1', 'org_algo_2', 'org_algo_3', 'org_algo_4',
    'domain_standardised', 'country_standardised',
    'postcode_exact', 'zip_standardised', 'part_zip_standardised',
    'country_display',
  ];
  const missingCols = expectedColumns.filter(c => !(c in hashed));
  if (missingCols.length === 0) {
    console.log(`✅ hashRecord produces all expected columns`);
    passed++;
  } else {
    console.warn(`❌ hashRecord missing columns: ${missingCols.join(', ')}`);
    failed++;
  }

  if (hashed.postcode_exact === hashed.zip_standardised) {
    console.log(`✅ postcode_exact === zip_standardised (same source, same hash)`);
    passed++;
  } else {
    console.warn(`❌ postcode_exact !== zip_standardised`);
    failed++;
  }

  if (hashed.country_display === 'United Kingdom') {
    console.log(`✅ country_display stored as clear text (not hashed)`);
    passed++;
  } else {
    console.warn(`❌ country_display wrong: "${hashed.country_display}"`);
    failed++;
  }

  // Contact hashing
  const mockContact = {
    clientRecordId:         'SYN-A3F7C-2A9F1-0001-00000001',
    emailName:               'john.smith',
    emailDomain:              'example.com',
    firstNameStandardised:  'JOHN',
    firstNameInitial:       'J',
    surnameStandardised:    'SMITH',
    telephoneStandardised:  '441234567890',
  };
  const hashedContact = await hashContactRecord(mockContact, TEST_SALT);
  const expectedContactCols = [
    'client_record_id', 'email_name', 'email_domain', 'firstname_standardised',
    'firstname_initial', 'surname_standardised', 'telephone_standardised',
  ];
  const missingContactCols = expectedContactCols.filter(c => !(c in hashedContact));
  if (missingContactCols.length === 0 && hashedContact.client_record_id === mockContact.clientRecordId) {
    console.log(`✅ hashContactRecord produces all expected columns, preserves client_record_id`);
    passed++;
  } else {
    console.warn(`❌ hashContactRecord malformed: missing ${missingContactCols.join(', ')}`);
    failed++;
  }

  const hashedContactAgain = await hashContactRecord(mockContact, TEST_SALT);
  if (hashedContact.email_name === hashedContactAgain.email_name) {
    console.log(`✅ Contact hashing deterministic`);
    passed++;
  } else {
    console.warn(`❌ Contact hashing non-deterministic`);
    failed++;
  }

  // Email splitting must be able to distinguish contact_exact
  // (name+domain both match) from contact_email_name (name matches,
  // domain doesn't) — verify the two hash independently.
  const sameNameDiffDomain = await hashContactRecord(
    { ...mockContact, emailDomain: 'other.com' }, TEST_SALT
  );
  if (
    sameNameDiffDomain.email_name === hashedContact.email_name &&
    sameNameDiffDomain.email_domain !== hashedContact.email_domain
  ) {
    console.log(`✅ email_name and email_domain hash independently (supports contact_email_name level)`);
    passed++;
  } else {
    console.warn(`❌ email_name/email_domain not independent`);
    failed++;
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  console.groupEnd();

  return { passed, failed };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  loadSalt,
  sha256,
  hashRecord,
  hashBatch,
  hashContactRecord,
  hashContactBatch,
  runTests,
};
