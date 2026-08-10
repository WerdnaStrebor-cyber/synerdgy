/**
 * Synerdgy — Module 3b: Lookup Table Loader
 * ==========================================
 * Loads, parses, and pre-compiles all lookup tables required by the
 * client-side transformation pipeline.
 *
 * UPDATED 10 Aug 2026 for Exchange: originally fetched from
 * data-compare.com/synerdgy/lookup/ via HTTP Basic Auth — a separate host
 * outside the Exchange stack (not Supabase, not Vercel). Moved to a public
 * Supabase Storage bucket ('lookup-tables') instead, consistent with the
 * rest of the stack and avoiding cross-origin/Basic-Auth complications
 * from a Vercel-hosted app calling out to SiteGround. Public bucket is
 * deliberate — these are generic reference files (word lists, country
 * name maps, postcode patterns), no PII, identical across every match, so
 * there's no real security benefit to gating them behind auth.
 *
 * Tables loaded (uploaded manually to the lookup-tables bucket):
 *   dbo_WORD_HANDLING.txt     — VHC word substitution rules (CSV, quoted)
 *   dbo_CHARACTER_HANDLING.txt — Character substitution rules (CSV, quoted)
 *   dbo_B_CHECK_REPLACE.txt   — Post-VHC correction rules (CSV, quoted)
 *   PS_Ctry_Stand.csv         — Country variation → standard name map
 *   countries_lookup.txt      — Standard name → ISO-2 map (TSV)
 *   zip_patterns.txt          — Postcode prefix patterns (TSV)
 *   free_domains.csv          — Free email domain blocklist (one per line)
 *   nicknames.csv             — 10 Aug 2026: canonical/nickname map for
 *                                the contact_name match level (CSV,
 *                                header `canonical,nickname`). Its
 *                                absence fails the whole load, same as
 *                                any other lookup file — not optional.
 *
 * Usage:
 *   const tables = await LookupLoader.load(supabase);
 *   // tables is a LookupTables instance — pass to downstream modules
 */

'use strict';

// ---------------------------------------------------------------------------
// LookupTables — the compiled output of this module
// Passed as a single object to all downstream transformation modules.
// ---------------------------------------------------------------------------

class LookupTables {
  constructor() {
    // Pre-compiled word handling passes
    // Key: 'CATEGORY|SUB_CATEGORY|ACTION_FLAG'
    // Value: { pattern: RegExp, replDict: Map<string, string> }
    this.compiledPasses = {};

    // B_CHECK_REPLACE compiled as a single pass
    // { pattern: RegExp, replDict: Map<string, string> } | null
    this.bCheckPass = null;

    // Character handling rules — kept as ordered array (not compiled to regex)
    // because character substitution is positional, not word-boundary based.
    // Each entry: { srchFor: string, replaceWith: string, category: string, subCategory: string }
    this.charHandlingRules = [];

    // Country standardisation maps
    // variationToStandard: Map<string(lowercase), string(standard name)>
    // standardToIso2: Map<string(lowercase), string(ISO-2)>
    this.variationToStandard = new Map();
    this.standardToIso2 = new Map();

    // Postcode prefix map
    // sortedPrefixes: string[] — sorted longest-first for greedy matching
    // prefixToIso2: Map<string(uppercase prefix), string(ISO-2)>
    this.sortedPrefixes = [];
    this.prefixToIso2 = new Map();

    // Free domain blocklist
    // freeDomains: Set<string(lowercase domain)>
    this.freeDomains = new Set();

    // Nickname canonicalisation (10 Aug 2026 — synerdgy-firstname-canonicaliser.js)
    // canonicalNames: Set<string(lowercase)> — every name that appears in
    //   the canonical column, checked BEFORE nickname lookup (fixes the
    //   `sandra` case: canonical in its own right AND a nickname of
    //   `alexandra`).
    // nicknameToCanonicals: Map<string(lowercase nickname), string[]> —
    //   candidate canonicals, sorted alphabetically at parse time so
    //   ambiguous nicknames (chris/nicky/nat/katie/kathy/kate) resolve
    //   deterministically without re-sorting on every lookup.
    this.canonicalNames = new Set();
    this.nicknameToCanonicals = new Map();

    // Load diagnostics — available after load() completes
    this.diagnostics = {
      wordHandlingRules: 0,
      charHandlingRules: 0,
      bCheckRules: 0,
      countryVariations: 0,
      countryIso2Mappings: 0,
      postcodePrefixes: 0,
      freeDomains: 0,
      nicknameEntries: 0,
      nicknameCanonicals: 0,
      compiledPasses: 0,
      warnings: [],
    };
  }
}

// ---------------------------------------------------------------------------
// LookupLoader — static loader class
// ---------------------------------------------------------------------------

class LookupLoader {

  /**
   * Load all lookup tables from the Supabase 'lookup-tables' storage bucket.
   *
   * @param {SupabaseClient} supabase - Shared client, already configured
   *                                    with the project URL/anon key
   * @returns {Promise<LookupTables>}
   */
  static async load(supabase) {
    const tables = new LookupTables();

    const FILES = [
      ['dbo_WORD_HANDLING.txt',      'WORD_HANDLING'],
      ['dbo_CHARACTER_HANDLING.txt', 'CHAR_HANDLING'],
      ['dbo_B_CHECK_REPLACE.txt',    'B_CHECK_REPLACE'],
      ['PS_Ctry_Stand.csv',          'PS_CTRY_STAND'],
      ['countries_lookup.txt',       'COUNTRIES_LOOKUP'],
      ['zip_patterns.txt',           'ZIP_PATTERNS'],
      ['free_domains.csv',           'FREE_DOMAINS'],
      ['nicknames.csv',              'NICKNAMES'],
    ];

    // Fetch all files in parallel
    let rawFiles;
    try {
      rawFiles = await Promise.all(
        FILES.map(([filename, label]) => LookupLoader._fetch(supabase, filename, label))
      );
    } catch (err) {
      throw new Error(`LookupLoader: failed to fetch one or more lookup tables. ${err.message}`);
    }

    const [
      wordHandlingRaw,
      charHandlingRaw,
      bCheckRaw,
      psCtrystRaw,
      countriesRaw,
      zipPatternsRaw,
      freeDomainsRaw,
      nicknamesRaw,
    ] = rawFiles;

    // Parse each file
    LookupLoader._parseWordHandling(wordHandlingRaw, tables);
    LookupLoader._parseCharHandling(charHandlingRaw, tables);
    LookupLoader._parseBCheckReplace(bCheckRaw, tables);
    LookupLoader._parsePsCtrySstand(psCtrystRaw, tables);
    LookupLoader._parseCountriesLookup(countriesRaw, tables);
    LookupLoader._parseZipPatterns(zipPatternsRaw, tables);
    LookupLoader._parseFreeDomains(freeDomainsRaw, tables);
    LookupLoader._parseNicknames(nicknamesRaw, tables);

    // Pre-compile word handling passes (pay cost once)
    LookupLoader._compilePasses(tables);

    return tables;
  }

  // -------------------------------------------------------------------------
  // Supabase Storage fetch helper
  // -------------------------------------------------------------------------

  static async _fetch(supabase, filename, label) {
    const { data, error } = await supabase.storage
      .from('lookup-tables')
      .download(filename);

    if (error) {
      throw new Error(`${label}: failed to download ${filename} from Supabase Storage — ${error.message}`);
    }

    return data.text();
  }

  // -------------------------------------------------------------------------
  // dbo_WORD_HANDLING.txt parser
  //
  // Format: CSV with quoted fields, first row is header.
  // Header: "WD_UID","SRCH_WORD","REPLACE_WITH","CATEGORY","SUB_CATEGORY",
  //         ...,"ACTION_FLAG",...,"USE_REC"
  // Column indices (0-based): 1=srch_word, 2=replace_with, 3=category,
  //   4=sub_category, 9=action_flag, 18=use_rec
  //
  // Only rows where USE_REC starts with 'Y' (case-insensitive) are loaded.
  // Rules are sorted longest-first within each pass to replicate Python behaviour.
  // -------------------------------------------------------------------------

  static _parseWordHandling(raw, tables) {
    const lines = raw.split(/\r?\n/);
    let skippedHeader = false;
    const rules = [];

    for (const line of lines) {
      if (!line.trim()) continue;

      // Skip header row
      if (!skippedHeader) {
        skippedHeader = true;
        continue;
      }

      const parts = LookupLoader._parseCsvLine(line);
      if (parts.length < 10) continue;

      const useRec     = (parts[18] ?? '').replace(/^"|"$/g, '').trim().toUpperCase();
      const srchWord   = (parts[1]  ?? '').replace(/^"|"$/g, '').trim().toLowerCase();
      const replaceWith = (parts[2] ?? '').replace(/^"|"$/g, '').trim().toLowerCase();
      const category   = (parts[3]  ?? '').replace(/^"|"$/g, '').trim();
      const subCat     = (parts[4]  ?? '').replace(/^"|"$/g, '').trim();
      const actionFlag = (parts[9]  ?? '').replace(/^"|"$/g, '').trim().toUpperCase();

      if (!useRec.startsWith('Y')) continue;
      if (!srchWord) continue;

      rules.push({ srchWord, replaceWith, category, subCat, actionFlag });
    }

    // Store sorted longest-first (mirrors Python sort)
    rules.sort((a, b) => b.srchWord.length - a.srchWord.length);
    tables._wordHandlingRules = rules;
    tables.diagnostics.wordHandlingRules = rules.length;
  }

  // -------------------------------------------------------------------------
  // dbo_CHARACTER_HANDLING.txt parser
  //
  // Format: CSV with quoted fields, first row is descriptive header.
  // Column indices (0-based): 1=srch_for (char or decimal code),
  //   2=replace_with ('1SP' means space), 3=category, 4=sub_category
  //
  // Stored as ordered array — applied sequentially, not as regex.
  // -------------------------------------------------------------------------

  static _parseCharHandling(raw, tables) {
    const lines = raw.split(/\r?\n/);
    let skippedHeader = false;

    for (const line of lines) {
      if (!line.trim()) continue;

      if (!skippedHeader) {
        skippedHeader = true;
        continue;
      }

      const parts = LookupLoader._parseCsvLine(line);
      if (parts.length < 5) continue;

      let srchFor     = (parts[1] ?? '').replace(/^"|"$/g, '');
      let replaceWith = (parts[2] ?? '').replace(/^"|"$/g, '');
      const category  = (parts[3] ?? '').replace(/^"|"$/g, '').trim();
      const subCat    = (parts[4] ?? '').replace(/^"|"$/g, '').trim();

      // Decimal character codes (e.g. "65" → 'A')
      if (/^\d+$/.test(srchFor.trim())) {
        srchFor = String.fromCharCode(parseInt(srchFor.trim(), 10));
      }

      // '1SP' sentinel → single space
      if (replaceWith.trim() === '1SP') replaceWith = ' ';

      if (!srchFor) continue;

      tables.charHandlingRules.push({ srchFor, replaceWith, category, subCat });
    }

    tables.diagnostics.charHandlingRules = tables.charHandlingRules.length;
  }

  // -------------------------------------------------------------------------
  // dbo_B_CHECK_REPLACE.txt parser
  //
  // Format: CSV with quoted fields, first row is header.
  // Column indices: 1=srch_word, 2=replacewith
  // -------------------------------------------------------------------------

  static _parseBCheckReplace(raw, tables) {
    const lines = raw.split(/\r?\n/);
    let skippedHeader = false;
    const rules = [];

    for (const line of lines) {
      if (!line.trim()) continue;

      if (!skippedHeader) {
        skippedHeader = true;
        continue;
      }

      const parts = LookupLoader._parseCsvLine(line);
      if (parts.length < 2) continue;

      const srchWord   = (parts[1] ?? '').replace(/^"|"$/g, '').trim().toLowerCase();
      const replaceWith = (parts[2] ?? '').replace(/^"|"$/g, '').trim().toLowerCase();

      if (!srchWord) continue;
      rules.push({ srchWord, replaceWith });
    }

    tables.diagnostics.bCheckRules = rules.length;
    tables._bCheckRules = rules; // stored for compilation
  }

  // -------------------------------------------------------------------------
  // PS_Ctry_Stand.csv parser
  //
  // Format: CSV with header row.
  // Columns: SRCH_STRING, COUNTRY_NAME
  // Maps country name variations (lowercase) → standard country name.
  // -------------------------------------------------------------------------

  static _parsePsCtrySstand(raw, tables) {
    const lines = raw.split(/\r?\n/);
    let headerParsed = false;
    let srchIdx = 0, nameIdx = 1;

    for (const line of lines) {
      if (!line.trim()) continue;

      const parts = LookupLoader._parseCsvLine(line);

      if (!headerParsed) {
        // Locate column indices from header
        const headers = parts.map(h => h.replace(/^"|"$/g, '').trim().toUpperCase());
        srchIdx = headers.indexOf('SRCH_STRING');
        nameIdx = headers.indexOf('COUNTRY_NAME');
        if (srchIdx === -1) srchIdx = 0;
        if (nameIdx === -1) nameIdx = 1;
        headerParsed = true;
        continue;
      }

      const srch = (parts[srchIdx] ?? '').replace(/^"|"$/g, '').trim().toLowerCase();
      const name = (parts[nameIdx] ?? '').replace(/^"|"$/g, '').trim();

      if (srch && name) {
        tables.variationToStandard.set(srch, name);
      }
    }

    tables.diagnostics.countryVariations = tables.variationToStandard.size;
  }

  // -------------------------------------------------------------------------
  // countries_lookup.txt parser
  //
  // Format: TSV with header row.
  // Columns: Country, ISO2
  // Maps standard country name (lowercase) → ISO-2 code.
  // -------------------------------------------------------------------------

  static _parseCountriesLookup(raw, tables) {
    const lines = raw.split(/\r?\n/);
    let headerParsed = false;
    let countryIdx = 0, iso2Idx = 1;

    for (const line of lines) {
      if (!line.trim()) continue;

      const parts = line.split('\t');

      if (!headerParsed) {
        const headers = parts.map(h => h.trim().toUpperCase());
        countryIdx = headers.indexOf('COUNTRY');
        iso2Idx    = headers.indexOf('ISO2');
        if (countryIdx === -1) countryIdx = 0;
        if (iso2Idx    === -1) iso2Idx    = 1;
        headerParsed = true;
        continue;
      }

      const country = (parts[countryIdx] ?? '').trim();
      const iso2    = (parts[iso2Idx]    ?? '').trim().toUpperCase();

      if (country && iso2) {
        tables.standardToIso2.set(country.toLowerCase(), iso2);
      }
    }

    tables.diagnostics.countryIso2Mappings = tables.standardToIso2.size;
  }

  // -------------------------------------------------------------------------
  // zip_patterns.txt parser
  //
  // Format: TSV with header row.
  // Columns: Prefix, COUNTRY_ISO_2, Separator Format (and others)
  // Builds prefix map for postcode prefix stripping.
  // Stored sorted longest-first for greedy matching.
  // -------------------------------------------------------------------------

  static _parseZipPatterns(raw, tables) {
    const lines = raw.split(/\r?\n/);
    let headerParsed = false;
    let prefixIdx = 0, iso2Idx = 1, sepIdx = -1;
    const prefixMap = new Map();

    for (const line of lines) {
      if (!line.trim()) continue;

      const parts = line.split('\t');

      if (!headerParsed) {
        const headers = parts.map(h => h.trim().toUpperCase());
        prefixIdx = headers.indexOf('PREFIX');
        iso2Idx   = headers.indexOf('COUNTRY_ISO_2');
        sepIdx    = headers.indexOf('SEPARATOR FORMAT');
        if (prefixIdx === -1) prefixIdx = 0;
        if (iso2Idx   === -1) iso2Idx   = 1;
        headerParsed = true;
        continue;
      }

      const prefix = (parts[prefixIdx] ?? '').trim().toUpperCase();
      const iso2   = (parts[iso2Idx]   ?? '').trim().toUpperCase();
      const sep    = sepIdx >= 0 ? (parts[sepIdx] ?? '').trim() : '';

      if (prefix && iso2) {
        prefixMap.set(prefix, iso2);
        if (sep) prefixMap.set(`${prefix}${sep}`, iso2);
      }
    }

    // Sort longest-first and store
    tables.prefixToIso2 = prefixMap;
    tables.sortedPrefixes = [...prefixMap.keys()].sort((a, b) => b.length - a.length);
    tables.diagnostics.postcodePrefixes = prefixMap.size;
  }

  // -------------------------------------------------------------------------
  // free_domains.csv parser
  //
  // Format: one domain per line, no header.
  // -------------------------------------------------------------------------

  static _parseFreeDomains(raw, tables) {
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const domain = line.trim().toLowerCase();
      if (domain && !domain.startsWith('#')) {
        tables.freeDomains.add(domain);
      }
    }
    tables.diagnostics.freeDomains = tables.freeDomains.size;
  }

  // -------------------------------------------------------------------------
  // nicknames.csv parser (10 Aug 2026)
  //
  // Format: CSV with header row, columns `canonical,nickname` (order
  // located from header, same defensive pattern as PS_Ctry_Stand/
  // countries_lookup — falls back to columns 0,1 if headers don't match
  // exactly). One canonical can have many nickname rows; one nickname
  // can map to several canonicals (the genuinely ambiguous case) — all
  // candidates are collected, then sorted alphabetically once here so
  // FirstnameCanonicaliser never has to re-sort on every lookup.
  //
  // `canonicalNames` collects every distinct value seen in the
  // canonical column — checked first by the canonicaliser so a name
  // that is both canonical and someone else's nickname (e.g. `sandra`)
  // always resolves to itself.
  // -------------------------------------------------------------------------

  static _parseNicknames(raw, tables) {
    const lines = raw.split(/\r?\n/);
    let headerParsed = false;
    let canonicalIdx = 0, nicknameIdx = 1;
    const pending = new Map(); // nickname -> Set<canonical>, deduped before sort

    for (const line of lines) {
      if (!line.trim()) continue;

      const parts = LookupLoader._parseCsvLine(line);

      if (!headerParsed) {
        const headers = parts.map(h => h.replace(/^"|"$/g, '').trim().toUpperCase());
        canonicalIdx = headers.indexOf('CANONICAL');
        nicknameIdx  = headers.indexOf('NICKNAME');
        if (canonicalIdx === -1) canonicalIdx = 0;
        if (nicknameIdx  === -1) nicknameIdx  = 1;
        headerParsed = true;
        continue;
      }

      const canonical = (parts[canonicalIdx] ?? '').replace(/^"|"$/g, '').trim().toLowerCase();
      const nickname  = (parts[nicknameIdx]  ?? '').replace(/^"|"$/g, '').trim().toLowerCase();

      if (!canonical || !nickname) continue;

      tables.canonicalNames.add(canonical);

      if (!pending.has(nickname)) pending.set(nickname, new Set());
      pending.get(nickname).add(canonical);
    }

    for (const [nickname, canonicalSet] of pending) {
      tables.nicknameToCanonicals.set(nickname, [...canonicalSet].sort());
    }

    tables.diagnostics.nicknameCanonicals = tables.canonicalNames.size;
    tables.diagnostics.nicknameEntries    = tables.nicknameToCanonicals.size;
  }

  // -------------------------------------------------------------------------
  // Pass pre-compilation
  //
  // Mirrors Python FastOrganisationNormalizer._compile_passes().
  // Groups word handling rules by (category, sub_category, action_flag),
  // builds a combined alternation regex per group, and stores a
  // replacement dict alongside it.
  //
  // Also compiles B_CHECK_REPLACE as a single pass.
  // -------------------------------------------------------------------------

  static _compilePasses(tables) {
    const passMap = {};

    for (const rule of tables._wordHandlingRules) {
      const key = `${rule.category}|${rule.subCat}|${rule.actionFlag}`;
      if (!passMap[key]) passMap[key] = { srchWords: [], replDict: {} };
      passMap[key].srchWords.push(rule.srchWord);
      passMap[key].replDict[rule.srchWord] =
        rule.actionFlag === 'REPLACE' ? rule.replaceWith : '';
    }

    for (const [key, { srchWords, replDict }] of Object.entries(passMap)) {
      // Already sorted longest-first from parse step
      const pattern = new RegExp(
        `\\b(${srchWords.map(LookupLoader._escapeRegex).join('|')})\\b`,
        'gi'
      );
      tables.compiledPasses[key] = { pattern, replDict };
    }

    tables.diagnostics.compiledPasses = Object.keys(tables.compiledPasses).length;

    // B_CHECK_REPLACE pass
    if (tables._bCheckRules.length > 0) {
      const bchkDict = {};
      const bchkWords = [];
      for (const rule of tables._bCheckRules) {
        bchkDict[rule.srchWord] = rule.replaceWith;
        bchkWords.push(rule.srchWord);
      }
      // Sort longest-first
      bchkWords.sort((a, b) => b.length - a.length);
      tables.bCheckPass = {
        pattern: new RegExp(
          `\\b(${bchkWords.map(LookupLoader._escapeRegex).join('|')})\\b`,
          'gi'
        ),
        replDict: bchkDict,
      };
    }

    // Clean up raw rule arrays — not needed after compilation
    delete tables._wordHandlingRules;
    delete tables._bCheckRules;
  }

  // -------------------------------------------------------------------------
  // CSV line parser
  //
  // Handles quoted fields with embedded commas.
  // Mirrors Python's csv.reader behaviour used in the original normalizer.
  // -------------------------------------------------------------------------

  static _parseCsvLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          // Escaped quote ("")
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result;
  }

  // -------------------------------------------------------------------------
  // Regex escape helper
  // -------------------------------------------------------------------------

  static _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

// ---------------------------------------------------------------------------
// Diagnostics helper — call after load() to confirm table health
// ---------------------------------------------------------------------------

function logLookupDiagnostics(tables) {
  const d = tables.diagnostics;
  console.group('Synerdgy Lookup Tables — Load Diagnostics');
  console.log(`Word handling rules loaded:  ${d.wordHandlingRules}`);
  console.log(`Char handling rules loaded:  ${d.charHandlingRules}`);
  console.log(`B_CHECK rules loaded:        ${d.bCheckRules}`);
  console.log(`Country variations loaded:   ${d.countryVariations}`);
  console.log(`ISO-2 mappings loaded:       ${d.countryIso2Mappings}`);
  console.log(`Postcode prefixes loaded:    ${d.postcodePrefixes}`);
  console.log(`Free domains loaded:         ${d.freeDomains}`);
  console.log(`Canonical names loaded:      ${d.nicknameCanonicals}`);
  console.log(`Nickname entries loaded:     ${d.nicknameEntries}`);
  console.log(`Compiled passes:             ${d.compiledPasses}`);
  if (d.warnings.length > 0) {
    console.warn('Warnings:', d.warnings);
  }
  console.groupEnd();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { LookupLoader, LookupTables, logLookupDiagnostics };
