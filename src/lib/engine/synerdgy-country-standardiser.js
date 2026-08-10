/**
 * Synerdgy — Module 6: Country Standardiser
 * ==========================================
 * Ports CountryStandardizer (country_adapter.py) to JavaScript.
 *
 * Converts raw country values from source files to ISO-2 codes,
 * which are then used as the country_standardised hash input and
 * as the country anchor for postcode normalisation (Module 7).
 *
 * Lookup chain (mirrors Python exactly):
 *   1. PS_Ctry_Stand  — variation (any form) → standard country name
 *   2. countries_lookup — standard name → ISO-2 code
 *   3. Already ISO-2 passthrough — 2-letter alpha value returned as-is
 *   4. Default fallback — file-level default ISO-2 (e.g. 'GB') or 'UNKNOWN'
 *
 * Also stores the human-readable country display name (clear text, not hashed)
 * for use in the country_display column in Supabase.
 *
 * Dependencies:
 *   LookupTables instance from synerdgy-lookup-loader.js (Module 3b)
 *   variationToStandard: Map<string, string>  — loaded in Module 3b
 *   standardToIso2:      Map<string, string>  — loaded in Module 3b
 *
 * Usage:
 *   const { iso2, displayName } = standardiseCountry('UK', tables, 'GB');
 *   // iso2: 'GB', displayName: 'United Kingdom'
 *
 *   const results = standardiseCountryColumn(records, 'COUNTRY', tables, 'GB');
 *   // results: parallel array of { iso2, displayName }
 */

'use strict';

// ---------------------------------------------------------------------------
// Single value entry point
// ---------------------------------------------------------------------------

/**
 * Standardise a single country value to ISO-2 and display name.
 *
 * @param {string} value         - Raw country value from source file
 * @param {LookupTables} tables  - Compiled lookup tables from Module 3b
 * @param {string} defaultIso2   - Fallback ISO-2 when value cannot be mapped
 *                                 (typically the file-level default, e.g. 'GB')
 * @returns {{ iso2: string, displayName: string }}
 */
function standardiseCountry(value, tables, defaultIso2 = 'UNKNOWN') {
  const fallback = defaultIso2.trim().toUpperCase() || 'UNKNOWN';

  // Null / empty guard
  if (!value || !String(value).trim()) {
    return {
      iso2: fallback,
      displayName: _iso2ToDisplay(fallback, tables),
    };
  }

  // Pre-normalise camelCase run-together variants before lookup
  // e.g. 'UnitedKingdom' → 'United Kingdom', 'UnitedStates' → 'United States'
  // Mirrors dual_file_prep.py country_normalised step
  let clean = String(value).trim();
  clean = clean.replace(/(?<=[a-z])(?=[A-Z])/g, ' ');
  const cleanLower = clean.toLowerCase().trim();

  // Step 1: PS_Ctry_Stand variation lookup
  const standardName = tables.variationToStandard.get(cleanLower);

  if (standardName) {
    // Step 2a: standard name → ISO-2
    const iso2 = tables.standardToIso2.get(standardName.toLowerCase());
    if (iso2) {
      return { iso2, displayName: standardName };
    }
  }

  // Step 2b: try raw value directly against countries_lookup
  // (handles values that are already in standard name form)
  const directIso2 = tables.standardToIso2.get(cleanLower);
  if (directIso2) {
    return {
      iso2: directIso2,
      displayName: _canonicalDisplayName(cleanLower, tables),
    };
  }

  // Step 3: already an ISO-2 code?
  const raw = String(value).trim();
  if (raw.length === 2 && /^[a-zA-Z]+$/.test(raw)) {
    const iso2 = raw.toUpperCase();
    return {
      iso2,
      displayName: _iso2ToDisplay(iso2, tables),
    };
  }

  // Step 4: fallback
  return {
    iso2: fallback,
    displayName: _iso2ToDisplay(fallback, tables),
  };
}

// ---------------------------------------------------------------------------
// Column-level entry point — processes a full array of records
// ---------------------------------------------------------------------------

/**
 * Standardise a country column across an array of records.
 * Returns a parallel array of { iso2, displayName } objects.
 *
 * @param {Object[]} records      - Array of row objects
 * @param {string}   countryField - Key in each record for the country value
 * @param {LookupTables} tables   - Compiled lookup tables from Module 3b
 * @param {string}   defaultIso2  - File-level default ISO-2 fallback
 * @returns {{ iso2: string, displayName: string }[]}
 */
function standardiseCountryColumn(records, countryField, tables, defaultIso2 = 'UNKNOWN') {
  // Deduplicate — country columns often have very few unique values
  const cache = new Map();

  return records.map(record => {
    const raw = String(record[countryField] ?? '').trim();
    if (!cache.has(raw)) {
      cache.set(raw, standardiseCountry(raw, tables, defaultIso2));
    }
    return cache.get(raw);
  });
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Attempt reverse lookup: ISO-2 → display name.
 * Scans variationToStandard for a match, falls back to the ISO-2 code itself.
 * Used when we have an ISO-2 passthrough and need the display name.
 */
function _iso2ToDisplay(iso2, tables) {
  if (!iso2 || iso2 === 'UNKNOWN') return iso2;

  // Build a reverse map from standardToIso2 on first call
  // (cached on tables object to avoid rebuilding each time)
  if (!tables._iso2ToDisplayCache) {
    tables._iso2ToDisplayCache = new Map();
    for (const [name, code] of tables.standardToIso2.entries()) {
      if (!tables._iso2ToDisplayCache.has(code)) {
        // Store capitalised form — entries in standardToIso2 are lowercase keys
        // but we want the display name, so we use the variationToStandard values
        tables._iso2ToDisplayCache.set(code, name);
      }
    }
    // Override with proper-case names from variationToStandard values
    for (const [, standardName] of tables.variationToStandard.entries()) {
      const code = tables.standardToIso2.get(standardName.toLowerCase());
      if (code) tables._iso2ToDisplayCache.set(code, standardName);
    }
  }

  return tables._iso2ToDisplayCache.get(iso2) ?? iso2;
}

/**
 * Given a lowercase country name that matched directly in standardToIso2,
 * find its proper-case display name from the variationToStandard values.
 */
function _canonicalDisplayName(lowerName, tables) {
  // variationToStandard values are proper-case standard names
  // Find an entry whose value matches (case-insensitive)
  for (const [, standardName] of tables.variationToStandard.entries()) {
    if (standardName.toLowerCase() === lowerName) return standardName;
  }
  // Fallback — title-case the input
  return lowerName.replace(/\b\w/g, c => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Built-in test suite
// Call runTests(tables) after loading lookup tables to verify port accuracy.
// ---------------------------------------------------------------------------

function runTests(tables) {
  console.group('Synerdgy Country Standardiser — Self-Tests');

  const cases = [
    // Standard variations
    { input: 'UK',             defaultIso2: 'GB', expectIso2: 'GB', note: 'UK → GB' },
    { input: 'United Kingdom', defaultIso2: 'GB', expectIso2: 'GB', note: 'United Kingdom → GB' },
    { input: 'britain',        defaultIso2: 'GB', expectIso2: 'GB', note: 'britain (lowercase) → GB' },
    { input: 'GB',             defaultIso2: 'GB', expectIso2: 'GB', note: 'GB passthrough' },
    { input: 'USA',            defaultIso2: 'GB', expectIso2: 'US', note: 'USA → US' },
    { input: 'United States',  defaultIso2: 'GB', expectIso2: 'US', note: 'United States → US' },
    { input: 'US',             defaultIso2: 'GB', expectIso2: 'US', note: 'US passthrough' },
    { input: 'Deutschland',    defaultIso2: 'GB', expectIso2: 'DE', note: 'Deutschland → DE' },
    { input: 'Germany',        defaultIso2: 'GB', expectIso2: 'DE', note: 'Germany → DE' },
    { input: 'DE',             defaultIso2: 'GB', expectIso2: 'DE', note: 'DE passthrough' },

    // CamelCase normalisation
    { input: 'UnitedKingdom',  defaultIso2: 'GB', expectIso2: 'GB', note: 'CamelCase UnitedKingdom → GB' },
    { input: 'UnitedStates',   defaultIso2: 'GB', expectIso2: 'US', note: 'CamelCase UnitedStates → US' },

    // Default fallback
    { input: '',               defaultIso2: 'GB', expectIso2: 'GB', note: 'Empty → file default GB' },
    { input: null,             defaultIso2: 'GB', expectIso2: 'GB', note: 'Null → file default GB' },
    { input: 'Narnia',         defaultIso2: 'GB', expectIso2: 'GB', note: 'Unknown → file default GB' },
    { input: 'Narnia',         defaultIso2: '',   expectIso2: 'UNKNOWN', note: 'Unknown, no default → UNKNOWN' },
  ];

  let passed = 0;
  let failed = 0;

  for (const tc of cases) {
    const result = standardiseCountry(tc.input, tables, tc.defaultIso2);

    // iso2 check
    if (result.iso2 !== tc.expectIso2) {
      console.warn(`❌ ${tc.note}`);
      console.warn(`   input:   "${tc.input}"  default: "${tc.defaultIso2}"`);
      console.warn(`   iso2:    got "${result.iso2}", expected "${tc.expectIso2}"`);
      console.warn(`   display: "${result.displayName}"`);
      failed++;
    } else {
      console.log(`✅ ${tc.note}`);
      console.log(`   input: "${tc.input}" → iso2: "${result.iso2}", display: "${result.displayName}"`);
      passed++;
    }
  }

  // Deduplication check — same input should return same object reference from column method
  const mockRecords = [
    { COUNTRY: 'UK' }, { COUNTRY: 'UK' }, { COUNTRY: 'Germany' }, { COUNTRY: 'UK' },
  ];
  const colResults = standardiseCountryColumn(mockRecords, 'COUNTRY', tables, 'GB');
  const deduped = colResults[0] === colResults[1] && colResults[1] === colResults[3];
  if (deduped) {
    console.log('✅ Deduplication: same country returns same cached object');
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

export { standardiseCountry, standardiseCountryColumn, runTests };
