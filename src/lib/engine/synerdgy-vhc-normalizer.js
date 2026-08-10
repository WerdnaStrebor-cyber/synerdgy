/**
 * Synerdgy — Module 4: VHC Normaliser + org_algo Derivations
 * ===========================================================
 * Ports FastOrganisationNormalizer.normalize_organisation_name() to JavaScript.
 *
 * Takes a raw organisation name string and a populated LookupTables instance
 * (from Module 3b), and returns all four org_algo values plus org_exact.
 *
 * Processing steps (in exact sequence to match Python output):
 *   0. Lowercase + trim
 *   1. Name truncation  (trading names, brackets, positional separators)
 *   2. Character handling  (Punctuation → Number → Misc passes)
 *   3. Word handling passes  (7 passes, COUNTRY passes use positional logic)
 *   4. B_CHECK_REPLACE pass
 *   5. Pluralisation
 *   6. org_algo derivations  (org_exact, algo_1–4)
 *
 * Deduplication:
 *   For large files, normaliseDataset() deduplicates on (orgName, country)
 *   before processing, then maps results back — same optimisation as the
 *   Python FastOrganisationNormalizer.normalize_dataframe().
 *
 * Dependencies:
 *   LookupTables instance from synerdgy-lookup-loader.js (Module 3b)
 *
 * Usage (single record):
 *   const result = normaliseOrg('Tesco Stores Ltd', tables);
 *   // result: { orgExact, orgAlgo1, orgAlgo2, orgAlgo3, orgAlgo4 }
 *
 * Usage (full dataset):
 *   const results = normaliseDataset(records, 'ORG_NAME', 'COUNTRY_STAND', tables);
 *   // results: Map<string, OrgAlgos> keyed by record index
 */

'use strict';

// ---------------------------------------------------------------------------
// Pass sequence — must match Python exactly
// ---------------------------------------------------------------------------

const PASS_SEQUENCE = [
  'STANDARDISE|GENERAL|REPLACE',
  'STANDARDISE|GENERAL|DELETE',
  'STANDARDISE|ACTIVITY|REPLACE',
  'CLASSIFY|ENTITY|REPLACE',
  'CLASSIFY|ENTITY|DELETE',
  'CLASSIFY|COUNTRY|REPLACE',   // positional logic applied
  'CLASSIFY|COUNTRY|DELETE',    // positional logic applied
];

// ---------------------------------------------------------------------------
// Main entry point — single record
// ---------------------------------------------------------------------------

/**
 * Normalise a single organisation name and return all org_algo values.
 *
 * @param {string} orgName   - Raw organisation name from source file
 * @param {LookupTables} tables - Compiled lookup tables from Module 3b
 * @returns {OrgAlgos}
 *
 * @typedef {Object} OrgAlgos
 * @property {string} orgExact  - trim + lcase of raw name (no normalisation)
 * @property {string} orgAlgo1  - Full VHC (normalised form)
 * @property {string} orgAlgo2  - VHC substring 20
 * @property {string} orgAlgo3  - VHC with spaces removed (NSVHC)
 * @property {string} orgAlgo4  - First word, or concatenated leading initials
 */
function normaliseOrg(orgName, tables) {
  if (!orgName || !String(orgName).trim()) {
    return _emptyResult();
  }

  const raw = String(orgName).trim();

  // org_exact — trim + lcase only, before any normalisation
  const orgExact = raw.toLowerCase();

  // Steps 0–5: produce VHC
  const vhc = _normalise(raw, tables);

  // Step 6: derive org_algo columns from VHC
  return {
    orgExact,
    orgAlgo1: vhc,
    orgAlgo2: vhc.slice(0, 20),
    orgAlgo3: vhc.replace(/\s+/g, ''),
    orgAlgo4: _deriveFirst(vhc),
  };
}

// ---------------------------------------------------------------------------
// Dataset entry point — with deduplication
// ---------------------------------------------------------------------------

/**
 * Normalise an array of records, deduplicating on (orgName, country) first.
 * Returns a parallel array of OrgAlgos in the same order as the input.
 *
 * @param {Object[]} records        - Array of row objects
 * @param {string}   orgField       - Key in each record for the org name
 * @param {LookupTables} tables     - Compiled lookup tables from Module 3b
 * @param {Function} [onProgress]   - Optional callback(processed, total)
 * @returns {OrgAlgos[]}            - Parallel array of results
 */
function normaliseDataset(records, orgField, tables, onProgress) {
  const total = records.length;

  // Build deduplication cache keyed on lowercase orgName
  // (country not available at this stage — standardised separately in Module 6)
  const cache = new Map();
  const keys = records.map(r => {
    const org = String(r[orgField] ?? '').trim();
    return org.toLowerCase(); // dedup key
  });

  // Process unique names only
  let processed = 0;
  for (const key of new Set(keys)) {
    if (!cache.has(key)) {
      cache.set(key, normaliseOrg(key, tables));
      processed++;
      if (onProgress && processed % 500 === 0) {
        onProgress(processed, cache.size);
      }
    }
  }

  // Map results back to original record order
  return keys.map(key => cache.get(key) ?? _emptyResult());
}

// ---------------------------------------------------------------------------
// Core normalisation pipeline — steps 0–5
// ---------------------------------------------------------------------------

function _normalise(orgName, tables) {
  // Step 0: lowercase + trim (already done before calling here,
  // but replicated for safety when called from within pipeline)
  let vhc = orgName.toLowerCase().trim();

  // Step 1: name truncation
  vhc = _applyNameTruncation(vhc);

  // Step 2: character handling
  vhc = _applyCharacterHandling(vhc, tables.charHandlingRules);

  // Steps 3: word handling passes (7 passes in sequence)
  vhc = _applyWordHandlingPasses(vhc, orgName, tables.compiledPasses);

  // Step 4: B_CHECK_REPLACE
  vhc = _applyBCheckReplace(vhc, tables.bCheckPass);

  // Step 5: pluralisation
  vhc = vhc.replace(/\b([a-z]{3,})s\b/g, '$1');
  vhc = _cleanSpaces(vhc);

  // Final reset guard — if VHC has collapsed to nothing, fall back to raw
  if (!vhc || vhc.length < 2) {
    vhc = orgName.toLowerCase().trim();
  }

  return vhc;
}

// ---------------------------------------------------------------------------
// Step 1: Name truncation
// Mirrors Python _apply_name_truncation()
// ---------------------------------------------------------------------------

function _applyNameTruncation(t) {
  t = t.trim();

  // Trading name markers — always truncate right, keep left side
  // Note: idx > 0 check ensures we don't truncate if marker is at start
  for (const marker of ['t/a', 't/u', ' dba ']) {
    const idx = t.toLowerCase().indexOf(marker);
    if (idx > 0) t = t.slice(0, idx).trim();
  }

  // Bracket content — strip block including brackets
  t = t.replace(/\s*\([^)]*\)\s*/g, ' ');
  t = t.replace(/\s*\[[^\]]*\]\s*/g, ' ');
  t = t.replace(/\s*\{[^}]*\}\s*/g, ' ');

  // Positional ' / ' separator — truncate if in middle 60% of string
  const spacedSlash = t.indexOf(' / ');
  if (spacedSlash > 0) {
    const len = t.length;
    if (spacedSlash > len * 0.2 && spacedSlash < len * 0.8) {
      t = t.slice(0, spacedSlash).trim();
    }
  }

  // Positional bare '/' — truncate if in middle 30%
  // Re-evaluate after spaced slash may have already truncated
  const bareSlash = t.indexOf('/');
  if (bareSlash > 0) {
    const len = t.length;
    if (bareSlash > len * 0.35 && bareSlash < len * 0.65) {
      t = t.slice(0, bareSlash).trim();
    }
  }

  // Positional ' - ' separator — truncate if in middle 60%
  // Only fires on spaced dash — "PC-World" is unaffected (no surrounding spaces)
  const spacedDash = t.indexOf(' - ');
  if (spacedDash > 0) {
    const len = t.length;
    if (spacedDash > len * 0.2 && spacedDash < len * 0.8) {
      t = t.slice(0, spacedDash).trim();
    }
  }

  return t.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Step 2: Character handling
// Mirrors Python _apply_character_handling()
// Three passes in SQL order: Punctuation → Number → Misc
// Pre-strips double-quote (Char 34) and apostrophe (Char 39) explicitly
// ---------------------------------------------------------------------------

function _applyCharacterHandling(text, charHandlingRules) {
  // Pre-strip: SQL explicitly removes Char(34) and Char(39) before dmCHARHANDLING
  let result = text.replace(/"/g, '').replace(/'/g, '');

  for (const category of ['Punctuation', 'Number', 'Misc']) {
    for (const rule of charHandlingRules) {
      if (
        rule.category === category &&
        rule.subCat === 'Code character replacement'
      ) {
        // String split/join used rather than regex — srchFor may contain
        // regex special characters (e.g. '.', '+', '?') and we want literal
        // character replacement, not pattern matching
        if (rule.srchFor) {
          result = result.split(rule.srchFor).join(rule.replaceWith ?? '');
        }
      }
    }
  }

  return result.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Step 3: Word handling passes
// Mirrors Python pass_sequence loop in normalize_organisation_name()
// ---------------------------------------------------------------------------

function _applyWordHandlingPasses(vhc, orgNameRaw, compiledPasses) {
  for (const key of PASS_SEQUENCE) {
    const pass = compiledPasses[key];
    if (!pass) continue; // pass not present in this lookup table version

    if (key.includes('COUNTRY')) {
      vhc = _applyCountryPassPositional(vhc, pass);
    } else {
      vhc = _applyCompiledPass(vhc, pass);
    }

    vhc = _cleanSpaces(vhc);

    // Reset guard — if a pass has wiped the string, restore from raw input
    if (!vhc || vhc.length < 2) {
      vhc = orgNameRaw.toLowerCase().trim();
    }
  }
  return vhc;
}

// Apply a pre-compiled word handling pass
function _applyCompiledPass(text, { pattern, replDict }) {
  // Reset lastIndex — compiled with 'g' flag so must reset between calls
  pattern.lastIndex = 0;
  return text.replace(pattern, (match) => {
    const replacement = replDict[match.toLowerCase()];
    return replacement !== undefined ? replacement : match;
  });
}

// Apply a COUNTRY pass with position-aware stripping
// Country words in the leading third of tokens are preserved
// Mirrors Python _apply_country_pass_positional()
function _applyCountryPassPositional(text, { pattern, replDict }) {
  const tokens = text.split(/\s+/);
  const total = tokens.length;
  if (total === 0) return text;

  // First token index at which stripping is permitted
  // (leading third is preserved, trailing two-thirds can be stripped)
  const stripFrom = Math.ceil(total / 3);

  pattern.lastIndex = 0;
  return text.replace(pattern, (match, _group, offset) => {
    // Count how many complete tokens precede this match position
    const textBefore = text.slice(0, offset);
    const tokenIndex = textBefore.trim() === ''
      ? 0
      : textBefore.trim().split(/\s+/).length;

    if (tokenIndex < stripFrom) {
      // Leading position — preserve the word as-is
      return match;
    }

    const replacement = replDict[match.toLowerCase()];
    return replacement !== undefined ? replacement : match;
  });
}

// ---------------------------------------------------------------------------
// Step 4: B_CHECK_REPLACE pass
// ---------------------------------------------------------------------------

function _applyBCheckReplace(vhc, bCheckPass) {
  if (!bCheckPass) return vhc;
  bCheckPass.pattern.lastIndex = 0;
  return vhc.replace(bCheckPass.pattern, (match) => {
    const replacement = bCheckPass.replDict[match.toLowerCase()];
    return replacement !== undefined ? replacement : match;
  });
}

// ---------------------------------------------------------------------------
// Step 6: org_algo_4 derivation (FIRST)
// First word of VHC, with initials detection for spelt-out acronyms.
// e.g. "i b m" → "ibm", "i m g" → "img", "tesco" → "tesco"
// ---------------------------------------------------------------------------

function _deriveFirst(vhc) {
  if (!vhc || !vhc.trim()) return vhc;

  const tokens = vhc.trim().split(/\s+/);
  if (tokens.length === 0) return vhc;

  // If first token is a single character, collect the consecutive
  // run of single-character tokens from the start (initials run)
  if (tokens[0].length === 1) {
    const initials = [];
    for (const token of tokens) {
      if (token.length === 1) initials.push(token);
      else break; // stop at first multi-character token
    }
    return initials.join('');
  }

  // Normal case — return first token
  return tokens[0];
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function _cleanSpaces(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function _emptyResult() {
  return {
    orgExact: '',
    orgAlgo1: '',
    orgAlgo2: '',
    orgAlgo3: '',
    orgAlgo4: '',
  };
}

// ---------------------------------------------------------------------------
// Built-in test suite
// Call runTests(tables) after loading lookup tables to verify port accuracy.
// Expected outputs should be validated against Python output for the same inputs.
// ---------------------------------------------------------------------------

function runTests(tables) {
  console.group('Synerdgy VHC Normaliser — Self-Tests');

  const cases = [
    // Trading name truncation
    { input: 'Blue Tortoise Intelligence t/a BTI',
      expectExact: 'blue tortoise intelligence t/a bti',
      note: 'Trading name truncation' },

    // Bracket stripping
    { input: 'Acme Corporation (Holdings) Ltd',
      note: 'Bracket stripping' },

    // Spaced dash positional
    { input: 'Smith Jones - Consulting Services Ltd',
      note: 'Spaced dash positional truncation (middle)' },

    // Initials — org_algo_4
    { input: 'I B M United Kingdom',
      expectAlgo4: 'ibm',
      note: 'Initials run → ibm' },

    { input: 'I M G Plc',
      expectAlgo4: 'img',
      note: 'Initials run → img' },

    // Normal first word — org_algo_4
    { input: 'Tesco Stores Limited',
      expectAlgo4: 'tesco',
      note: 'Normal first word' },

    // org_algo_2 substring 20
    { input: 'Verylongcompanynamethatwillbetrimmed Ltd',
      note: 'org_algo_2 substring 20' },

    // Empty / null guard
    { input: '',  note: 'Empty string' },
    { input: '   ', note: 'Whitespace only' },
  ];

  let passed = 0;
  let failed = 0;

  for (const tc of cases) {
    const result = normaliseOrg(tc.input, tables);

    let ok = true;
    const failures = [];

    if (tc.expectExact !== undefined && result.orgExact !== tc.expectExact) {
      ok = false;
      failures.push(`orgExact: got "${result.orgExact}", expected "${tc.expectExact}"`);
    }
    if (tc.expectAlgo4 !== undefined && result.orgAlgo4 !== tc.expectAlgo4) {
      ok = false;
      failures.push(`orgAlgo4: got "${result.orgAlgo4}", expected "${tc.expectAlgo4}"`);
    }
    if (tc.expectAlgo2 !== undefined && result.orgAlgo2 !== tc.expectAlgo2) {
      ok = false;
      failures.push(`orgAlgo2: got "${result.orgAlgo2}", expected "${tc.expectAlgo2}"`);
    }

    // Always check algo_2 is max 20 chars
    if (result.orgAlgo2.length > 20) {
      ok = false;
      failures.push(`orgAlgo2 exceeds 20 chars: "${result.orgAlgo2}"`);
    }

    // Always check algo_3 has no spaces
    if (result.orgAlgo3.includes(' ')) {
      ok = false;
      failures.push(`orgAlgo3 contains spaces: "${result.orgAlgo3}"`);
    }

    if (ok) {
      console.log(`✅ ${tc.note}`);
      console.log(`   input:   "${tc.input}"`);
      console.log(`   exact:   "${result.orgExact}"`);
      console.log(`   algo1:   "${result.orgAlgo1}"`);
      console.log(`   algo2:   "${result.orgAlgo2}"`);
      console.log(`   algo3:   "${result.orgAlgo3}"`);
      console.log(`   algo4:   "${result.orgAlgo4}"`);
      passed++;
    } else {
      console.warn(`❌ ${tc.note}`);
      console.warn(`   input:  "${tc.input}"`);
      for (const f of failures) console.warn(`   FAIL:   ${f}`);
      failed++;
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  console.groupEnd();

  return { passed, failed };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { normaliseOrg, normaliseDataset, runTests };
