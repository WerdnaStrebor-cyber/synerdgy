/**
 * Synerdgy — Module 7: Postcode Normaliser
 * =========================================
 * Ports PostcodeNormaliser (self-contained in dual_file_prep.py) to JavaScript.
 *
 * Takes a raw postal code value and a country ISO-2 code, and returns two
 * standardised forms for hashing:
 *
 *   zipStand   — full standardised postcode (uppercased, prefix stripped,
 *                spaces normalised). Stored as postcode_exact and zip_standardised.
 *
 *   partZip    — first meaningful segment only. UK: outward code (e.g. "SW1A").
 *                All others: everything before first space or hyphen.
 *                Stored as part_zip_standardised.
 *
 * Country prefix stripping:
 *   Some international datasets prefix postcodes with the ISO-2 country code
 *   (e.g. "GB-SW1A 1AA", "DE-10115", "FR-75001"). The prefix map from
 *   zip_patterns.txt is used to strip these before normalisation.
 *   Longest prefix matched first (greedy) — same logic as Python.
 *
 * Dependencies:
 *   LookupTables instance from synerdgy-lookup-loader.js (Module 3b)
 *   tables.sortedPrefixes: string[]          — longest-first sorted prefix list
 *   tables.prefixToIso2:   Map<string,string> — prefix → ISO-2
 *
 * Usage (single value):
 *   const { zipStand, partZip } = normalisePostcode('SW1A 1AA', 'GB', tables);
 *
 * Usage (full column):
 *   const results = normalisePostcodeColumn(records, 'POSTAL_CODE', countryResults, tables);
 *   // countryResults is the parallel array from Module 6
 */

'use strict';

// ---------------------------------------------------------------------------
// Single value entry point
// ---------------------------------------------------------------------------

/**
 * Normalise a single postcode value.
 *
 * @param {string} rawValue      - Raw postal code from source file
 * @param {string} countryIso2   - ISO-2 country code (from Module 6 output)
 * @param {LookupTables} tables  - Compiled lookup tables from Module 3b
 * @returns {{ zipStand: string, partZip: string }}
 */
function normalisePostcode(rawValue, countryIso2, tables) {
  if (!rawValue || !String(rawValue).trim()) {
    return { zipStand: '', partZip: '' };
  }

  const raw = String(rawValue).trim();
  const country = String(countryIso2 ?? '').trim().toUpperCase();

  // Step 1: strip country prefix if present
  const stripped = _stripPrefix(raw, tables);

  // Step 2: derive partZip based on country
  const partZip = _derivePartZip(stripped, country);

  return { zipStand: stripped, partZip };
}

// ---------------------------------------------------------------------------
// Column-level entry point
// ---------------------------------------------------------------------------

/**
 * Normalise a postcode column across an array of records.
 * countryResults is the parallel array returned by Module 6's
 * standardiseCountryColumn() — used to get the ISO-2 per record.
 *
 * Returns a parallel array of { zipStand, partZip }.
 *
 * @param {Object[]} records        - Array of row objects
 * @param {string}   postcodeField  - Key in each record for the postcode value
 * @param {{ iso2: string }[]} countryResults - Parallel country results from Module 6
 * @param {LookupTables} tables     - Compiled lookup tables from Module 3b
 * @returns {{ zipStand: string, partZip: string }[]}
 */
function normalisePostcodeColumn(records, postcodeField, countryResults, tables) {
  // Deduplicate on (rawPostcode, iso2) — many records share postcodes
  const cache = new Map();

  return records.map((record, idx) => {
    const raw    = String(record[postcodeField] ?? '').trim();
    const iso2   = countryResults[idx]?.iso2 ?? '';
    const cacheKey = `${raw}||${iso2}`;

    if (!cache.has(cacheKey)) {
      cache.set(cacheKey, normalisePostcode(raw, iso2, tables));
    }
    return cache.get(cacheKey);
  });
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Strip country prefix from a raw postcode value.
 * Tries longest prefix first (greedy) — mirrors Python PostcodeNormaliser._strip_prefix().
 *
 * e.g. "GB-SW1A 1AA" → "SW1A 1AA"
 *      "DE-10115"     → "10115"
 *      "SW1A 1AA"     → "SW1A 1AA"  (no prefix match — returned as-is uppercased)
 */
function _stripPrefix(raw, tables) {
  const upper = raw.toUpperCase().trim();

  for (const prefix of tables.sortedPrefixes) {
    if (upper.startsWith(prefix)) {
      // Strip prefix and any leading separator characters (-, –, space)
      const remainder = upper.slice(prefix.length).replace(/^[-–\s]+/, '').trim();
      if (remainder) return remainder;
      // If stripping leaves nothing, the prefix was the whole value — return as-is
    }
  }

  return upper;
}

/**
 * Derive the partial postcode (first meaningful segment).
 *
 * UK (GB):
 *   Outward code only — everything before the inward code.
 *   UK postcodes are formatted as "OUTWARD INWARD" (e.g. "SW1A 1AA").
 *   The outward code is always the first space-delimited token.
 *   e.g. "SW1A 1AA" → "SW1A"
 *        "EC1A 1BB" → "EC1A"
 *        "M1 1AE"   → "M1"
 *
 * All others:
 *   Everything before the first space or hyphen.
 *   e.g. "10115"        → "10115"   (Germany, no separator)
 *        "75001"        → "75001"   (France)
 *        "1000 Brussels"→ "1000"    (Belgium)
 *        "2000-001"     → "2000"    (Portugal)
 */
function _derivePartZip(stripped, countryIso2) {
  if (!stripped) return '';

  if (countryIso2 === 'GB' || countryIso2 === 'UK') {
    // UK: first space-separated token is the outward code
    return stripped.split(/\s+/)[0];
  }

  // Generic: split on first space or hyphen
  return stripped.split(/[\s\-]/)[0];
}

// ---------------------------------------------------------------------------
// Built-in test suite
// ---------------------------------------------------------------------------

function runTests(tables) {
  console.group('Synerdgy Postcode Normaliser — Self-Tests');

  const cases = [
    // UK — outward code extraction
    { raw: 'SW1A 1AA', iso2: 'GB',
      expectZip: 'SW1A 1AA', expectPart: 'SW1A',
      note: 'UK standard postcode' },
    { raw: 'EC1A 1BB', iso2: 'GB',
      expectZip: 'EC1A 1BB', expectPart: 'EC1A',
      note: 'UK EC area postcode' },
    { raw: 'M1 1AE', iso2: 'GB',
      expectZip: 'M1 1AE', expectPart: 'M1',
      note: 'UK short outward code' },
    { raw: 'sw1a 1aa', iso2: 'GB',
      expectZip: 'SW1A 1AA', expectPart: 'SW1A',
      note: 'UK lowercase → uppercased' },

    // UK with country prefix
    { raw: 'GB-SW1A 1AA', iso2: 'GB',
      expectZip: 'SW1A 1AA', expectPart: 'SW1A',
      note: 'UK with GB- prefix stripped' },

    // Germany
    { raw: '10115', iso2: 'DE',
      expectZip: '10115', expectPart: '10115',
      note: 'Germany — no separator' },
    { raw: 'DE-10115', iso2: 'DE',
      expectZip: '10115', expectPart: '10115',
      note: 'Germany with DE- prefix stripped' },

    // France
    { raw: '75001', iso2: 'FR',
      expectZip: '75001', expectPart: '75001',
      note: 'France — no separator' },

    // Belgium — space separator
    { raw: '1000 Brussels', iso2: 'BE',
      expectZip: '1000 BRUSSELS', expectPart: '1000',
      note: 'Belgium — space separator, part is numeric code' },

    // Portugal — hyphen separator
    { raw: '2000-001', iso2: 'PT',
      expectZip: '2000-001', expectPart: '2000',
      note: 'Portugal — hyphen separator' },

    // US ZIP
    { raw: '90210', iso2: 'US',
      expectZip: '90210', expectPart: '90210',
      note: 'US ZIP — no separator' },
    { raw: '90210-1234', iso2: 'US',
      expectZip: '90210-1234', expectPart: '90210',
      note: 'US ZIP+4 — hyphen separator' },

    // Empty / null guard
    { raw: '',   iso2: 'GB', expectZip: '', expectPart: '', note: 'Empty string' },
    { raw: null, iso2: 'GB', expectZip: '', expectPart: '', note: 'Null value' },
    { raw: '   ', iso2: 'GB', expectZip: '', expectPart: '', note: 'Whitespace only' },
  ];

  let passed = 0;
  let failed = 0;

  for (const tc of cases) {
    const result = normalisePostcode(tc.raw, tc.iso2, tables);
    const failures = [];

    if (result.zipStand !== tc.expectZip) {
      failures.push(`zipStand: got "${result.zipStand}", expected "${tc.expectZip}"`);
    }
    if (result.partZip !== tc.expectPart) {
      failures.push(`partZip: got "${result.partZip}", expected "${tc.expectPart}"`);
    }

    if (failures.length === 0) {
      console.log(`✅ ${tc.note}`);
      console.log(`   raw: "${tc.raw}" (${tc.iso2}) → zip: "${result.zipStand}", part: "${result.partZip}"`);
      passed++;
    } else {
      console.warn(`❌ ${tc.note}`);
      console.warn(`   raw: "${tc.raw}" (${tc.iso2})`);
      for (const f of failures) console.warn(`   FAIL: ${f}`);
      failed++;
    }
  }

  // Deduplication check
  const mockRecords = [
    { POSTAL_CODE: 'SW1A 1AA' },
    { POSTAL_CODE: 'SW1A 1AA' },
    { POSTAL_CODE: 'EC1A 1BB' },
    { POSTAL_CODE: 'SW1A 1AA' },
  ];
  const mockCountry = [
    { iso2: 'GB' }, { iso2: 'GB' }, { iso2: 'GB' }, { iso2: 'GB' },
  ];
  const colResults = normalisePostcodeColumn(mockRecords, 'POSTAL_CODE', mockCountry, tables);
  if (colResults[0] === colResults[1] && colResults[1] === colResults[3]) {
    console.log('✅ Deduplication: repeated postcodes return same cached object');
    passed++;
  } else {
    console.warn('❌ Deduplication: cache not working correctly');
    failed++;
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  console.groupEnd();

  return { passed, failed };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { normalisePostcode, normalisePostcodeColumn, runTests };
