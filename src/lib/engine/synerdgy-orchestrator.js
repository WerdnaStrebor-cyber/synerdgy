/**
 * Synerdgy — Upload Orchestrator (v2)
 * =====================================
 * Coordinates the full client-side pipeline for a single source file upload.
 *
 * Execution sequence:
 *   1. Parse file (CSV or XLSX)
 *   2. Detect fields → present confirmation UI → await user approval
 *      — UNIQUE_ID flagged amber if not detected (non-blocking warning)
 *   3. Process records:
 *        a. Assign sequential SYN ID (SYN_000001 …)
 *        b. Capture client's UNIQUE_ID value for mapping file
 *        c. VHC normalisation          (Module 4)
 *        d. Domain extraction          (Module 3a)
 *        e. Country standardisation    (Module 6)
 *        f. Postcode normalisation     (Module 7)
 *        g. Assemble DerivedRecord
 *   4. Hash + insert to Supabase       (Modules 8 + 9)
 *      — client_record_id (SYN ID) stored alongside hashes
 *   5. Generate mapping CSV → auto-download to browser
 *   6. Trigger mandatory acknowledgement modal
 *   7. On acknowledgement → COMPLETE
 *
 * Mapping file format:
 *   synerdgy_id, unique_id
 *   SYN_000001, XYZ3456DA
 *   SYN_000002, ABC1234FB
 *   Filename: synerdgy_mapping_[source_name]_[YYYYMMDD].csv
 *
 * State machine:
 *   idle → parsing → awaiting_confirmation → processing → inserting
 *        → mapping_download → awaiting_acknowledgement → complete | error
 *
 * Dependencies:
 *   synerdgy-lookup-loader.js         → window.SynerdgyLookup
 *   synerdgy-vhc-normalizer.js        → window.SynerdgyVHC
 *   synerdgy-country-standardiser.js  → window.SynerdgyCountry
 *   synerdgy-postcode-normaliser.js   → window.SynerdgyPostcode
 *   synerdgy-hash-pipeline.js         → window.SynerdgyHashPipeline
 *   PapaParse (CDN)                   → window.Papa
 *   SheetJS (CDN)                     → window.XLSX
 *   Supabase JS client (CDN)          → window.supabase
 *
 * Usage:
 *   const orchestrator = new Orchestrator({
 *     supabase,
 *     tables,           // LookupTables from Module 3b
 *     sourceId,         // project_sources.id for this upload
 *     projectId,        // projects.id
 *     projectCode,      // 5-char hex from projects.project_code e.g. 'A3F7C'
 *     clientCode,       // 5-char hex from clients.client_code e.g. '2A9F1'
 *     sourceName,       // display name for mapping filename e.g. 'Salesforce CRM'
 *     defaultCountry,   // ISO-2 file-level default e.g. 'GB'
 *     onStateChange,    // (state, detail) => void
 *     onProgress,       // (done, total, phase) => void
 *     onMappingReady,   // ({ filename, content, recordCount }) => void
 *                       // — show mandatory modal here
 *   });
 *
 *   // Step 1
 *   const { mapping, columns, rowCount, uniqueIdWarning }
 *     = await orchestrator.parseAndDetect(file);
 *
 *   // Step 2 — show confirmation UI, flag amber if uniqueIdWarning
 *   // User confirms, then:
 *   await orchestrator.run(confirmedMapping);
 *
 *   // Step 3 — onMappingReady fires, show modal
 *   // User clicks "I've saved my mapping file", then:
 *   orchestrator.acknowledgeMapping();
 */

'use strict';

// UPDATED 10 Aug 2026: these were bare globals (window.SynerdgyHashPipeline
// etc.) under the old <script>-tag loading model. Now real ES module
// imports, since the four dependencies were converted alongside this file.
// NOTE: the fileSeq bug described above and the lack of any multi-file
// queue model are NOT fixed in this pass — that's separate, larger design
// work (concurrent processing per spec §3a), deliberately not rushed in
// alongside this mechanical import fix.
import * as SynerdgyHashPipeline from './synerdgy-hash-pipeline.js';
import * as SynerdgyVHC from './synerdgy-vhc-normalizer.js';
import * as SynerdgyCountry from './synerdgy-country-standardiser.js';
import * as SynerdgyPostcode from './synerdgy-postcode-normaliser.js';

// ---------------------------------------------------------------------------
// State constants
// ---------------------------------------------------------------------------

const STATES = {
  IDLE:                     'idle',
  PARSING:                  'parsing',
  AWAITING_CONFIRMATION:    'awaiting_confirmation',
  PROCESSING:               'processing',
  INSERTING:                'inserting',
  MAPPING_DOWNLOAD:         'mapping_download',
  AWAITING_ACKNOWLEDGEMENT: 'awaiting_acknowledgement',
  COMPLETE:                 'complete',
  ERROR:                    'error',
};

// ---------------------------------------------------------------------------
// SYN ID generator
// Format: SYN-[5 hex project]-[5 hex client]-[8 hex sequence]
// Example: SYN-A3F7C-2A9F1-0000A3B4
// Total length: 24 chars (char(24) in schema)
//
// project_code: 5-char hex, derived from sequential project integer → hex
// client_code:  5-char hex, derived from sequential client integer → hex
// sequence:     8-char hex, zero-padded record position within this upload
//
// Max records per project: 16^8 = 4,294,967,296
// Max projects:            16^5 = 1,048,576
// Max clients:             16^5 = 1,048,576
// ---------------------------------------------------------------------------

function _synId(projectCode, clientCode, sequence) {
  const seqHex = sequence.toString(16).toUpperCase().padStart(8, '0');
  return `SYN-${projectCode}-${clientCode}-${seqHex}`;
}

/**
 * Derive a 5-char uppercase hex code from a sequential integer.
 * Used for both project_code and client_code.
 * e.g. 1 → '00001', 42 → '0002A', 1048575 → 'FFFFF'
 *
 * @param {number} n - Sequential integer from database
 * @returns {string} - 5-char uppercase hex string
 */
function deriveHexCode(n) {
  return Math.max(0, Math.floor(n)).toString(16).toUpperCase().padStart(5, '0');
}

// ---------------------------------------------------------------------------
// Orchestrator class
// ---------------------------------------------------------------------------

class Orchestrator {

  constructor({
    supabase,
    tables,
    sourceId,
    projectId,
    projectCode,        // 5-char hex — from projects.project_code, fetched at session start
    clientCode,         // 5-char hex — from clients.client_code, fetched at session start
    sourceName     = 'source',
    defaultCountry = 'GB',
    onStateChange  = () => {},
    onProgress     = () => {},
    onMappingReady = () => {},
  }) {
    this.supabase       = supabase;
    this.tables         = tables;
    this.sourceId       = sourceId;
    this.projectId      = projectId;
    this.projectCode    = String(projectCode).toUpperCase();
    this.clientCode     = String(clientCode).toUpperCase();
    this.sourceName     = sourceName;
    this.defaultCountry = defaultCountry.trim().toUpperCase();
    this.onStateChange  = onStateChange;
    this.onProgress     = onProgress;
    this.onMappingReady = onMappingReady;

    this._state         = STATES.IDLE;
    this._rawRecords    = [];
    this._mappingRows   = [];   // [{ synId, uniqueId }] — cleared after acknowledgement
    this._insertResult  = null;
  }

  // -------------------------------------------------------------------------
  // Phase 1: Parse file + detect fields
  // -------------------------------------------------------------------------

  /**
   * @param {File} file
   * @returns {Promise<{
   *   mapping: FieldMapping,
   *   columns: string[],
   *   rowCount: number,
   *   uniqueIdWarning: boolean
   * }>}
   */
  async parseAndDetect(file) {
    this._setState(STATES.PARSING, { fileName: file.name });
    this._rawRecords = [];

    try {
      this._rawRecords = await this._parseFile(file);
    } catch (err) {
      this._setState(STATES.ERROR, { message: `Could not parse file: ${err.message}` });
      throw err;
    }

    if (this._rawRecords.length === 0) {
      this._setState(STATES.ERROR, { message: 'File appears to be empty.' });
      throw new Error('Empty file');
    }

    const columns         = Object.keys(this._rawRecords[0]);
    const mapping         = this._detectFields(columns);
    const uniqueIdWarning = !mapping.UNIQUE_ID;

    if (uniqueIdWarning) {
      console.warn(
        'Orchestrator: UNIQUE_ID not detected. ' +
        'Mapping file will use row numbers as unique_id. ' +
        'For best results, ensure your file contains your source system ' +
        'record ID (e.g. Salesforce Account ID) and map it to Unique ID.'
      );
    }

    this._setState(STATES.AWAITING_CONFIRMATION, {
      mapping,
      columns,
      rowCount: this._rawRecords.length,
      uniqueIdWarning,
    });

    return { mapping, columns, rowCount: this._rawRecords.length, uniqueIdWarning };
  }

  // -------------------------------------------------------------------------
  // Phase 2: Process + insert
  // -------------------------------------------------------------------------

  /**
   * @param {FieldMapping} confirmedMapping — user-confirmed from UI
   * @returns {Promise<{ inserted: number, errors: number }>}
   */
  async run(confirmedMapping) {
    if (this._state !== STATES.AWAITING_CONFIRMATION) {
      throw new Error('Orchestrator: call parseAndDetect() before run().');
    }
    if (!confirmedMapping?.ORG_NAME) {
      throw new Error('Orchestrator: ORG_NAME must be mapped before processing can start.');
    }

    this._setState(STATES.PROCESSING, { total: this._rawRecords.length });

    let derivedRecords;
    try {
      derivedRecords = await this._processRecords(confirmedMapping);
    } catch (err) {
      this._setState(STATES.ERROR, { message: `Processing failed: ${err.message}` });
      throw err;
    }

    this._setState(STATES.INSERTING, { total: derivedRecords.length });

    try {
      this._insertResult = await SynerdgyHashPipeline.processAndInsert(
        this.supabase,
        this.sourceId,
        this.projectId,
        derivedRecords,
        (done, total) => this.onProgress(done, total, 'inserting'),
      );
    } catch (err) {
      this._setState(STATES.ERROR, { message: `Insert failed: ${err.message}` });
      throw err;
    }

    // Raw records no longer needed
    this._rawRecords = [];

    // Generate mapping file and trigger download
    this._setState(STATES.MAPPING_DOWNLOAD, {});
    const mappingFile = this._generateMappingCsv();
    _triggerDownload(mappingFile.content, mappingFile.filename);

    // Move to awaiting acknowledgement — UI must show mandatory modal
    this._setState(STATES.AWAITING_ACKNOWLEDGEMENT, {
      filename:    mappingFile.filename,
      recordCount: this._mappingRows.length,
      inserted:    this._insertResult.inserted,
      errors:      this._insertResult.errors,
    });

    // Fire callback so UI can render the modal
    this.onMappingReady({
      filename:    mappingFile.filename,
      content:     mappingFile.content,
      recordCount: this._mappingRows.length,
    });

    return this._insertResult;
  }

  // -------------------------------------------------------------------------
  // Phase 3: User acknowledges mapping modal
  // Called by UI when user clicks "I've saved my mapping file"
  // -------------------------------------------------------------------------

  acknowledgeMapping() {
    if (this._state !== STATES.AWAITING_ACKNOWLEDGEMENT) {
      console.warn('Orchestrator: acknowledgeMapping() called in wrong state:', this._state);
      return;
    }
    // Clear mapping rows — no longer needed in memory
    this._mappingRows = [];
    this._setState(STATES.COMPLETE, this._insertResult);
  }

  // -------------------------------------------------------------------------
  // File parsing
  // -------------------------------------------------------------------------

  _parseFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    return (ext === 'xlsx' || ext === 'xls')
      ? this._parseXlsx(file)
      : this._parseCsv(file);
  }

  _parseCsv(file) {
    return new Promise((resolve, reject) => {
      const records = [];
      let rowCount  = 0;

      Papa.parse(file, {
        header:         true,
        skipEmptyLines: true,
        encoding:       'UTF-8',

        step: (result) => {
          if (result.errors.length > 0) {
            result.errors.forEach(e =>
              console.warn(`Row ${rowCount + 1} parse warning: ${e.message}`)
            );
          }
          records.push(result.data);
          rowCount++;
          if (rowCount % 500 === 0) this.onProgress(rowCount, null, 'parsing');
        },

        complete: () => resolve(records),
        error:    (err) => reject(new Error(err.message)),
      });
    });
  }

  async _parseXlsx(file) {
    const buffer   = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  }

  // -------------------------------------------------------------------------
  // Field detection (three-pass — mirrors SimpleFieldMapper in Python)
  // -------------------------------------------------------------------------

  _detectFields(columns) {
    const KNOWN_COLUMNS = {
      'uniqueid':               'UNIQUE_ID',
      'unique id':              'UNIQUE_ID',
      'companyname':            'ORG_NAME',
      'customer name':          'ORG_NAME',
      'address1':               'ADDRESS',
      'address 1':              'ADDRESS',
      'postcode':               'POSTAL_CODE',
      'post code':              'POSTAL_CODE',
      'country':                'COUNTRY',
      'internationalnacecode':  'SIC',
      'internationalnaceLabel': 'SIC_DESCRIPTION',
      'website':                'WEBSITE',
      'webaddress':             'WEBSITE',
      'url':                    'WEBSITE',
    };

    const FIELD_ALIASES = {
      UNIQUE_ID:       ['id', 'uid', 'unique_id', 'record_id', 'account_id',
                        'accountid', 'contact_id', 'contactid', 'pid'],
      ORG_NAME:        ['organisation', 'organization', 'org_name', 'company',
                        'company_name', 'companyname', 'account', 'account_name',
                        'firm', 'employer', 'business'],
      ADDRESS:         ['address', 'address1', 'address_1', 'street', 'addr',
                        'mailing_address'],
      POSTAL_CODE:     ['postcode', 'postal_code', 'zip', 'zip_code', 'zipcode',
                        'post_code', 'postalcode', 'plz', 'cap'],
      COUNTRY:         ['country', 'country_name', 'ctry', 'nation'],
      WEBSITE:         ['website', 'web', 'url', 'web_address', 'domain',
                        'domain1', 'internetaddress', 'internet_address'],
      SIC:             ['sic', 'sic_code', 'nace', 'nace_code',
                        'internationalnacecode'],
      SIC_DESCRIPTION: ['sic_description', 'industry', 'nace_description',
                        'nace_label', 'lineofbusiness'],
    };

    const colLower = {};
    for (const col of columns) colLower[col.toLowerCase().trim()] = col;

    const mapping = {};

    // Pass 1: exact known column names
    for (const [lowerKey, orig] of Object.entries(colLower)) {
      const std = KNOWN_COLUMNS[lowerKey];
      if (std && !mapping[std]) mapping[std] = orig;
    }

    // Pass 2: alias scan
    for (const [std, aliases] of Object.entries(FIELD_ALIASES)) {
      if (mapping[std]) continue;
      for (const alias of aliases) {
        if (colLower[alias]) { mapping[std] = colLower[alias]; break; }
      }
    }

    // Pass 3: partial match
    for (const [std, aliases] of Object.entries(FIELD_ALIASES)) {
      if (mapping[std]) continue;
      outer: for (const [lowerKey, orig] of Object.entries(colLower)) {
        for (const alias of aliases) {
          if (lowerKey.includes(alias) || alias.includes(lowerKey)) {
            mapping[std] = orig;
            break outer;
          }
        }
      }
    }

    return mapping;
  }

  // -------------------------------------------------------------------------
  // Record processing — full transformation pipeline
  // -------------------------------------------------------------------------

  async _processRecords(mapping) {
    const total   = this._rawRecords.length;
    const derived = [];
    this._mappingRows = [];
    let processed = 0;

    for (const record of this._rawRecords) {
      processed++;

      // a. Assign SYN ID — SYN-[projectCode]-[clientCode]-[8 hex sequence]
      const synId = _synId(this.projectCode, this.clientCode, processed);

      // b. Capture client UNIQUE_ID — fallback to row number if not mapped
      const clientUniqueId = mapping.UNIQUE_ID
        ? String(record[mapping.UNIQUE_ID] ?? '').trim() || String(processed)
        : String(processed);

      // Store for mapping file — held in memory until modal acknowledged
      this._mappingRows.push({ synId, uniqueId: clientUniqueId });

      // c. Raw field extraction
      const orgName  = String(record[mapping.ORG_NAME]    ?? '').trim();
      const country  = String(record[mapping.COUNTRY]     ?? '').trim();
      const postcode = String(record[mapping.POSTAL_CODE] ?? '').trim();
      const website  = String(record[mapping.WEBSITE]     ?? '').trim();

      // d. VHC normalisation (Module 4)
      const vhc = SynerdgyVHC.normaliseOrg(orgName, this.tables);

      // e. Domain extraction (Module 3a)
      const domain = this._extractDomain(website);

      // f. Country standardisation (Module 6)
      const ctry = SynerdgyCountry.standardiseCountry(
        country || this.defaultCountry,
        this.tables,
        this.defaultCountry,
      );

      // g. Postcode normalisation (Module 7)
      const pc = SynerdgyPostcode.normalisePostcode(postcode, ctry.iso2, this.tables);

      // h. Assemble DerivedRecord
      derived.push({
        clientRecordId: synId,
        orgExact:       vhc.orgExact,
        orgAlgo1:       vhc.orgAlgo1,
        orgAlgo2:       vhc.orgAlgo2,
        orgAlgo3:       vhc.orgAlgo3,
        orgAlgo4:       vhc.orgAlgo4,
        domain,
        countryIso2:    ctry.iso2,
        countryDisplay: ctry.displayName,
        zipStand:       pc.zipStand,
        partZip:        pc.partZip,
      });

      if (processed % 500 === 0) {
        this.onProgress(processed, total, 'processing');
        await _yield();
      }
    }

    this.onProgress(total, total, 'processing');
    return derived;
  }

  // -------------------------------------------------------------------------
  // Mapping CSV generation
  // -------------------------------------------------------------------------

  _generateMappingCsv() {
    const date     = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const safeName = this.sourceName
      .replace(/[^a-zA-Z0-9_\- ]/g, '')
      .trim()
      .replace(/\s+/g, '_');
    const filename = `synerdgy_mapping_${safeName}_${date}.csv`;

    const lines = ['synerdgy_id,unique_id'];
    for (const { synId, uniqueId } of this._mappingRows) {
      const safeUniqueId = String(uniqueId).includes(',')
        ? `"${String(uniqueId).replace(/"/g, '""')}"`
        : String(uniqueId);
      lines.push(`${synId},${safeUniqueId}`);
    }

    return { filename, content: lines.join('\r\n') };
  }

  // -------------------------------------------------------------------------
  // Domain extraction (Module 3a — inlined)
  // -------------------------------------------------------------------------

  _extractDomain(websiteValue) {
    if (!websiteValue?.trim()) return '';

    let raw = websiteValue.trim().toLowerCase();
    raw = raw.replace(/^https?:\/\//, '');
    raw = raw.split('/')[0].split('?')[0].split('#')[0].split(':')[0];

    const parts = raw.split('.');
    let domain;
    if (parts.length <= 2) {
      domain = parts.join('.');
    } else {
      const secondLevel = parts[parts.length - 2];
      const SECOND_LEVEL_TLDS = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'me']);
      domain = (SECOND_LEVEL_TLDS.has(secondLevel) && parts.length >= 3)
        ? parts.slice(-3).join('.')
        : parts.slice(-2).join('.');
    }

    return this.tables.freeDomains.has(domain) ? '' : domain;
  }

  // -------------------------------------------------------------------------
  // State management
  // -------------------------------------------------------------------------

  _setState(state, detail = {}) {
    this._state = state;
    console.log(`Orchestrator [${state}]`, detail);
    this.onStateChange(state, detail);
  }

  get state() { return this._state; }
}

// ---------------------------------------------------------------------------
// Browser download trigger
// ---------------------------------------------------------------------------

function _triggerDownload(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href        = url;
  a.download    = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

// ---------------------------------------------------------------------------
// Yield to browser event loop
// ---------------------------------------------------------------------------

function _yield() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { Orchestrator, STATES };
