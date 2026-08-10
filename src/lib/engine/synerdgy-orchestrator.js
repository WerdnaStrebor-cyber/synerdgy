/**
 * Synerdgy — Upload Orchestrator (v3 — Exchange multi-file rewrite)
 * =====================================================================
 * REWRITTEN 10 Aug 2026. The previous version coordinated exactly one
 * file at a time, wrote directly to company_hashes via a Supabase
 * client insert (licensor-only — no invitee path), used a SYN ID format
 * with no fileSeq segment (the collision bug spec §4 documents), and
 * had no contact-side processing at all. None of that carries over
 * structurally; this is a new class built around the session/party
 * model and the queue/RPC design from this session.
 *
 * Responsibilities:
 *   - Parse + field-detect each file as the user loads it (human-paced,
 *     steps 3a-3c — stays on the main thread, unchanged in character
 *     from before, extended with contact field aliases).
 *   - On mapping confirmation, call queue_source_upload (assigns
 *     fileSeq server-side), enqueue the file, dispatch to the worker
 *     pool.
 *   - Own a fixed pool of 3 persistent Web Workers (synerdgy-file-
 *     worker.js does the actual normalisation/hashing — spec §4 off-
 *     main-thread requirement). Dispatcher always pulls the oldest
 *     queued file (lowest fileSeq) when a slot frees — see spec §3a.
 *   - Relay each hashed batch a worker posts back into
 *     mark_source_processed (batched, only the final batch flips
 *     status to 'ready' — spec §3a ordering notes).
 *   - Track per-file status locally (queued | processing | ready |
 *     acknowledged) so the UI can gate "load another" vs "Done", and
 *     so canFinish() reflects the real spec §3a rule: all files
 *     acknowledged, not just queue-empty.
 *
 * Explicitly NOT in scope here:
 *   - Consolidated mapping CSV / lookup workbook generation (spec §5,
 *     §5a) — that's synerdgy-output-writer.js (Phase 4, 10 Aug 2026).
 *     onFileReady fires with everything it needs (fileSeq, filename,
 *     mapping, uniqueIds, uploadedAt, rowCount) — call
 *     `outputWriter.addFile(job)` from your onFileReady handler.
 *
 * Usage:
 *   const session = new Orchestrator({
 *     supabase, matchId, tables, projectCode, clientCode,
 *     defaultCountry: 'GB',
 *     onQueueChange:  (queueSnapshot) => {},
 *     onFileProgress: (sourceId, done, total) => {},
 *     onFileReady:    (job) => {},   // show "load another / Done" prompt
 *     onError:        (sourceId, message) => {},
 *   });
 *   await session.init();  // loads salt, spawns worker pool
 *
 *   const { mapping, columns, rowCount, uniqueIdWarning }
 *     = await session.parseAndDetect(file);
 *   // ... user confirms mapping in UI ...
 *   await session.confirmMapping(file, confirmedMapping);
 *
 *   // later, when user clicks "I've saved my files" for a ready file:
 *   await session.acknowledgeFile(sourceId);
 *
 *   // gates the "Done" button:
 *   if (session.canFinish()) { ... }
 *
 *   session.destroy();  // terminate workers, call on session end
 */

'use strict';

import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import * as SynerdgyHashPipeline from './synerdgy-hash-pipeline.js';
// 10 Aug 2026 (Phase 4 session): Papa/XLSX were referenced as bare
// globals below with no import and no package.json entry — would have
// thrown ReferenceError at runtime. Both added as real dependencies.

const WORKER_POOL_SIZE = 3; // 10 Aug 2026 decision — see spec §3a. Tunable.

const STATES = {
  QUEUED:       'queued',
  PROCESSING:   'processing',
  READY:        'ready',
  ACKNOWLEDGED: 'acknowledged',
  ERROR:        'error',
};

// ---------------------------------------------------------------------------
// Orchestrator class
// ---------------------------------------------------------------------------

class Orchestrator {

  constructor({
    supabase,
    matchId,
    tables,
    projectCode,
    clientCode,
    defaultCountry  = 'GB',
    workerPoolSize  = WORKER_POOL_SIZE,
    onQueueChange   = () => {},
    onFileProgress  = () => {},
    onFileReady     = () => {},
    onError         = () => {},
  }) {
    this.supabase        = supabase;
    this.matchId          = matchId;
    this.tables           = tables;
    this.projectCode      = String(projectCode).toUpperCase();
    this.clientCode       = String(clientCode).toUpperCase();
    this.defaultCountry   = defaultCountry.trim().toUpperCase();
    this.workerPoolSize   = workerPoolSize;
    this.onQueueChange    = onQueueChange;
    this.onFileProgress   = onFileProgress;
    this.onFileReady       = onFileReady;
    this.onError           = onError;

    this._salt        = null;
    this._workers      = [];  // [{ worker, busy: bool }]
    this._queue         = [];  // job objects, see _enqueue()
    this._pendingUploads = new Map(); // uploadKey -> { rawRecords, columns }
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  async init() {
    this._salt = await SynerdgyHashPipeline.loadSalt(this.supabase, this.matchId);

    for (let i = 0; i < this.workerPoolSize; i++) {
      const worker = new Worker(new URL('./synerdgy-file-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (event) => this._handleWorkerMessage(i, event.data);
      worker.onerror = (event) => {
        console.error('Orchestrator: worker error', event);
      };
      worker.postMessage({
        type: 'init',
        tables: this.tables,
        salt: this._salt,
        projectCode: this.projectCode,
        clientCode: this.clientCode,
        defaultCountry: this.defaultCountry,
      });
      this._workers.push({ worker, busy: false, currentSourceId: null });
    }
  }

  destroy() {
    for (const w of this._workers) w.worker.terminate();
    this._workers = [];
  }

  // -------------------------------------------------------------------------
  // Phase 1 (per file): Parse + detect fields — human-paced, main thread.
  // Unchanged in character from the previous version, extended with
  // contact field aliases.
  // -------------------------------------------------------------------------

  /**
   * @param {File} file
   * @returns {Promise<{ mapping, columns, rowCount, uniqueIdWarning, uploadKey }>}
   */
  async parseAndDetect(file) {
    const rawRecords = await this._parseFile(file);

    if (rawRecords.length === 0) {
      throw new Error(`File "${file.name}" appears to be empty.`);
    }

    const columns         = Object.keys(rawRecords[0]);
    const mapping          = this._detectFields(columns);
    const uniqueIdWarning = !mapping.UNIQUE_ID;

    // Keyed by file name + size + lastModified — good enough to
    // disambiguate concurrent in-flight files without a server round
    // trip; the real identity (source_id) is assigned once mapping is
    // confirmed and queue_source_upload runs.
    const uploadKey = `${file.name}::${file.size}::${file.lastModified}`;
    this._pendingUploads.set(uploadKey, { file, rawRecords, columns });

    return { mapping, columns, rowCount: rawRecords.length, uniqueIdWarning, uploadKey };
  }

  // -------------------------------------------------------------------------
  // Phase 2 (per file): mapping confirmed → queue_source_upload → enqueue
  // -------------------------------------------------------------------------

  /**
   * @param {string} uploadKey - from parseAndDetect()
   * @param {FieldMapping} confirmedMapping
   */
  async confirmMapping(uploadKey, confirmedMapping) {
    const pending = this._pendingUploads.get(uploadKey);
    if (!pending) {
      throw new Error(`Orchestrator: no pending upload for key "${uploadKey}" — call parseAndDetect() first.`);
    }
    if (!confirmedMapping?.ORG_NAME) {
      throw new Error('Orchestrator: ORG_NAME must be mapped before processing can start.');
    }

    const ext = pending.file.name.split('.').pop().toLowerCase();
    const { data, error } = await this.supabase.rpc('queue_source_upload', {
      p_match_id: this.matchId,
      p_filename: pending.file.name,
      p_source_type: ext,
    });
    if (error) throw new Error(`queue_source_upload failed: ${error.message}`);

    // RPC returns a single-row table result
    const { source_id: sourceId, file_seq: fileSeq } = Array.isArray(data) ? data[0] : data;

    const job = {
      sourceId,
      fileSeq,
      filename: pending.file.name,
      mapping: confirmedMapping,
      rawRecords: pending.rawRecords,
      // Lightweight per-row unique_id list, extracted now while
      // rawRecords is still available — this is ALL Phase 4's output
      // writer (spec §5/§5a) needs per row, paired positionally with
      // the deterministic SYN ID (fileSeq + row position, same formula
      // as synerdgy-file-worker.js's _synId — no need to wait on
      // hashing or carry the full raw row past dispatch). Kept on the
      // job even after rawRecords is dropped below, so onFileReady
      // still has what it needs once processing finishes.
      uniqueIds: pending.rawRecords.map(
        r => String(r[confirmedMapping.UNIQUE_ID] ?? '').trim()
      ),
      uploadedAt: new Date().toISOString(),
      rowCount: pending.rawRecords.length,
      status: STATES.QUEUED,
    };

    this._queue.push(job);
    this._pendingUploads.delete(uploadKey);
    this.onQueueChange(this._snapshotQueue());
    this._dispatch();

    return { sourceId, fileSeq };
  }

  // -------------------------------------------------------------------------
  // Dispatcher — pulls the oldest queued job (lowest fileSeq) into any
  // free worker slot. No preemption. Called whenever a job is enqueued
  // or a worker slot frees up.
  // -------------------------------------------------------------------------

  _dispatch() {
    const freeSlot = this._workers.findIndex(w => !w.busy);
    if (freeSlot === -1) return; // pool fully busy — next free slot will re-trigger

    const nextJob = this._queue
      .filter(j => j.status === STATES.QUEUED)
      .sort((a, b) => a.fileSeq.localeCompare(b.fileSeq))[0];

    if (!nextJob) return; // nothing waiting

    nextJob.status = STATES.PROCESSING;
    this._workers[freeSlot].busy = true;
    this._workers[freeSlot].currentSourceId = nextJob.sourceId;
    this.onQueueChange(this._snapshotQueue());

    this._workers[freeSlot].worker.postMessage({
      type: 'process',
      jobId: nextJob.sourceId,
      sourceId: nextJob.sourceId,
      fileSeq: nextJob.fileSeq,
      mapping: nextJob.mapping,
      rawRecords: nextJob.rawRecords,
    });

    // Raw records now live in the worker's copy (structured clone) —
    // drop the main-thread reference so a large file's rows aren't held
    // twice in memory for the duration of processing. uniqueIds (above)
    // is NOT dropped — it's the one thing Phase 4's output writer needs
    // once this job reaches 'ready', and it's a fraction of the size of
    // the full raw rows.
    nextJob.rawRecords = null;
  }

  // -------------------------------------------------------------------------
  // Worker message handling
  // -------------------------------------------------------------------------

  async _handleWorkerMessage(workerIndex, msg) {
    const job = this._queue.find(j => j.sourceId === msg.sourceId || j.sourceId === msg.jobId);

    if (msg.type === 'progress') {
      this.onFileProgress(msg.jobId, msg.done, msg.total);
      return;
    }

    if (msg.type === 'batch') {
      try {
        const { error } = await this.supabase.rpc('mark_source_processed', {
          p_source_id: msg.sourceId,
          p_company_records: msg.companyBatch,
          p_contact_records: msg.contactBatch,
          p_final: msg.isFinal,
        });
        if (error) throw new Error(error.message);
      } catch (err) {
        this._failJob(workerIndex, job, err.message);
      }
      return;
    }

    if (msg.type === 'done') {
      if (job) job.status = STATES.READY;
      this._workers[workerIndex].busy = false;
      this._workers[workerIndex].currentSourceId = null;
      this.onQueueChange(this._snapshotQueue());
      if (job) this.onFileReady(job);
      this._dispatch(); // pull next queued job into this now-free slot
      return;
    }

    if (msg.type === 'error') {
      this._failJob(workerIndex, job, msg.message);
      return;
    }
  }

  _failJob(workerIndex, job, message) {
    if (job) job.status = STATES.ERROR;
    this._workers[workerIndex].busy = false;
    this._workers[workerIndex].currentSourceId = null;
    this.onQueueChange(this._snapshotQueue());
    this.onError(job?.sourceId, message);
    this._dispatch();
  }

  // -------------------------------------------------------------------------
  // Phase 3: acknowledge — user confirms both output files saved (3f)
  // -------------------------------------------------------------------------

  async acknowledgeFile(sourceId) {
    const job = this._queue.find(j => j.sourceId === sourceId);
    if (!job) throw new Error(`Orchestrator: no queued job for source ${sourceId}`);
    if (job.status !== STATES.READY) {
      throw new Error(`Orchestrator: source ${sourceId} is not ready (status: ${job.status})`);
    }

    const { error } = await this.supabase.rpc('acknowledge_source', { p_source_id: sourceId });
    if (error) throw new Error(`acknowledge_source failed: ${error.message}`);

    job.status = STATES.ACKNOWLEDGED;
    this.onQueueChange(this._snapshotQueue());
  }

  // -------------------------------------------------------------------------
  // "Done" gate — spec §3a: blocks on all in-flight processing, not just
  // an empty queue. Every job must be acknowledged.
  // -------------------------------------------------------------------------

  canFinish() {
    return this._queue.length > 0
      && this._queue.every(j => j.status === STATES.ACKNOWLEDGED);
  }

  _snapshotQueue() {
    return this._queue.map(j => ({
      sourceId: j.sourceId,
      fileSeq: j.fileSeq,
      filename: j.filename,
      rowCount: j.rowCount,
      status: j.status,
    }));
  }

  // -------------------------------------------------------------------------
  // File parsing (unchanged from previous version)
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

      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        encoding: 'UTF-8',
        step: (result) => {
          if (result.errors.length > 0) {
            result.errors.forEach(e => console.warn(`Parse warning: ${e.message}`));
          }
          records.push(result.data);
        },
        complete: () => resolve(records),
        error: (err) => reject(new Error(err.message)),
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
  // Field detection (three-pass) — extended 10 Aug 2026 with contact
  // field aliases (EMAIL, FIRSTNAME, SURNAME, TELEPHONE). The previous
  // version only detected organisation fields; contact processing did
  // not exist.
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
      'email':                  'EMAIL',
      'emailaddress':           'EMAIL',
      'email address':          'EMAIL', // 10 Aug 2026: explicit entry —
      // without this, pass 3's loose substring match let ADDRESS's
      // 'address' alias claim this column ahead of EMAIL, since
      // 'address' is legitimately a whole word inside 'email address'.
      // Pass 1 exact-match resolves it deterministically instead of
      // relying on pass 3 to guess correctly.
      'firstname':               'FIRSTNAME',
      'first name':              'FIRSTNAME',
      'surname':                 'SURNAME',
      'lastname':                'SURNAME',
      'last name':               'SURNAME',
      'telephone':               'TELEPHONE',
      'phone':                   'TELEPHONE',
      'phonenumber':             'TELEPHONE',
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
      EMAIL:           ['email', 'email_address', 'emailaddress', 'e_mail',
                        'work_email', 'business_email'],
      FIRSTNAME:       ['firstname', 'first_name', 'fname', 'given_name',
                        'forename'],
      SURNAME:         ['surname', 'lastname', 'last_name', 'lname',
                        'family_name'],
      TELEPHONE:       ['telephone', 'phone', 'phone_number', 'phonenumber',
                        'tel', 'mobile', 'contact_number', 'direct_dial'],
    };

    const colLower = {};
    for (const col of columns) colLower[col.toLowerCase().trim()] = col;

    const mapping = {};
    // 10 Aug 2026 fix: track which original columns are already claimed,
    // across ALL standard fields — not just per-field. Previously each
    // std field ran its own independent search and could claim a column
    // another field had already claimed (e.g. 'Email Address' matched
    // both ADDRESS and EMAIL via the pass-3 substring check, since
    // 'address' is a substring of 'email address'). One physical column
    // must map to at most one standard field.
    const claimedColumns = new Set();

    // Pass 1: exact known column names
    for (const [lowerKey, orig] of Object.entries(colLower)) {
      const std = KNOWN_COLUMNS[lowerKey];
      if (std && !mapping[std] && !claimedColumns.has(orig)) {
        mapping[std] = orig;
        claimedColumns.add(orig);
      }
    }

    // Pass 2: alias scan (exact alias match against full column name)
    for (const [std, aliases] of Object.entries(FIELD_ALIASES)) {
      if (mapping[std]) continue;
      for (const alias of aliases) {
        const orig = colLower[alias];
        if (orig && !claimedColumns.has(orig)) {
          mapping[std] = orig;
          claimedColumns.add(orig);
          break;
        }
      }
    }

    // Pass 3: partial match — loosest pass, runs last, only considers
    // columns not already claimed by a tighter match above.
    for (const [std, aliases] of Object.entries(FIELD_ALIASES)) {
      if (mapping[std]) continue;
      outer: for (const [lowerKey, orig] of Object.entries(colLower)) {
        if (claimedColumns.has(orig)) continue;
        for (const alias of aliases) {
          if (lowerKey.includes(alias) || alias.includes(lowerKey)) {
            mapping[std] = orig;
            claimedColumns.add(orig);
            break outer;
          }
        }
      }
    }

    return mapping;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { Orchestrator, STATES, WORKER_POOL_SIZE };
