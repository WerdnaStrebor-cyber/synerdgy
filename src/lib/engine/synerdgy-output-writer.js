/**
 * Synerdgy — Output Writer (Phase 4)
 * =============================================================
 * NEW 10 Aug 2026. Builds the two local-only, never-sent-server-side
 * outputs described in spec §5/§5a: the consolidated mapping CSV and
 * its companion two-sheet lookup workbook. One instance per party per
 * match session — call `addFile()` once per file, when the
 * orchestrator's `onFileReady` fires (spec §3, step 3e comes right
 * after 3d for that file).
 *
 * Ordering (spec §3a): blocks/rows must land in `fileSeq` order
 * regardless of which file finishes *hashing* first — file 2 can
 * finish processing before file 1 without jumping the queue here.
 * `addFile()` queues by fileSeq and only writes a file's block once
 * every lower fileSeq has already been written; each call returns the
 * list of fileSeqs newly flushed (possibly more than one, if an
 * earlier out-of-order file was already held and this one unblocks
 * it) — the caller uses that list to know which files can now surface
 * their re-download/acknowledge prompt (§3f), since a file's own
 * block genuinely isn't in the downloadable CSV until it's flushed.
 *
 * SYN ID generation: deliberately NOT read from the hashed batches the
 * worker posts back (those never carry the plaintext unique_id, by
 * design — spec §9, server never sees original values). Instead this
 * recomputes each row's SYN ID from fileSeq + row position, using the
 * exact same formula as synerdgy-file-worker.js's `_synId` (kept in
 * sync manually — see the comment on `_synId` below if that formula
 * ever changes). This only needs `job.uniqueIds` (the lightweight
 * per-row list the orchestrator now extracts before dropping
 * `rawRecords` — see synerdgy-orchestrator.js `confirmMapping`), not
 * the full raw rows, and doesn't need to wait on hashing to complete.
 *
 * Incremental output (§5a performance note): row/block data is
 * appended to arrays already held in memory — never re-parsed or
 * rebuilt from scratch. Only the final serialisation step (joining the
 * CSV string, calling `XLSX.write`) is redone on each download point,
 * same tradeoff `synerdgy-lookup-loader.js` and others already accept
 * elsewhere in this codebase.
 *
 * Known gap, flagged rather than silently downgraded: spec §5a asks
 * for Sheet 1 to be "formatted as an Excel Table object" so it stays a
 * stable range under sort/filter. The community (free) build of
 * SheetJS used here (`xlsx` on npm) cannot write real OOXML Table
 * parts — that's a SheetJS Pro feature. This implementation instead
 * sets `!autofilter` on the full data range plus a frozen header row,
 * which gives sort/filter dropdowns and range stability under normal
 * use but isn't a true Table object. Worth a decision: accept this as
 * the v1 answer, or take on SheetJS Pro if the "true Table object"
 * behaviour turns out to matter in practice.
 *
 * Usage:
 *   const writer = new OutputWriter({ projectCode, clientCode });
 *   // in the orchestrator's onFileReady handler:
 *   const { flushedFileSeqs } = writer.addFile(job);
 *   if (flushedFileSeqs.includes(job.fileSeq)) {
 *     writer.downloadMappingCsv();
 *     writer.downloadLookupWorkbook();
 *     // show the "confirm you've saved both files" prompt (3f)
 *   }
 */

'use strict';

import * as XLSX from 'xlsx';

// ---------------------------------------------------------------------------
// SYN ID generator — MUST stay identical to synerdgy-file-worker.js's
// _synId. Duplicated rather than imported because the worker module's
// top-level code assumes a Worker global scope; if that formula ever
// changes, update both places (spec §4 is the source of truth for the
// format itself).
// ---------------------------------------------------------------------------

function _synId(projectCode, clientCode, fileSeq, recordSeq) {
  const seqHex = recordSeq.toString(16).toUpperCase().padStart(8, '0');
  return `SYN-${projectCode}-${clientCode}-${fileSeq}-${seqHex}`;
}

// ---------------------------------------------------------------------------
// Friendly labels for the field_mapping header line (spec §5 example:
// "field_mapping: name=Full Name, email=Email, unique_id=SF ID,
// country=Country"). Only mapped fields actually present are included
// — a file with no EMAIL column mapped just omits that entry.
// ---------------------------------------------------------------------------

const FIELD_LABELS = {
  UNIQUE_ID:       'unique_id',
  ORG_NAME:        'name',
  ADDRESS:         'address',
  POSTAL_CODE:     'postcode',
  COUNTRY:         'country',
  WEBSITE:         'website',
  SIC:             'sic',
  SIC_DESCRIPTION: 'sic_description',
  EMAIL:           'email',
  FIRSTNAME:       'firstname',
  SURNAME:         'surname',
  TELEPHONE:       'telephone',
};

function _csvField(value) {
  const v = String(value ?? '');
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// ---------------------------------------------------------------------------
// OutputWriter
// ---------------------------------------------------------------------------

class OutputWriter {

  constructor({ projectCode, clientCode }) {
    this.projectCode = String(projectCode).toUpperCase();
    this.clientCode  = String(clientCode).toUpperCase();

    this._pendingFiles     = new Map(); // seqNum -> file data, held until its turn
    this._nextExpectedSeq  = 1;         // next seqNum allowed to flush
    this._writtenFileSeqs  = [];        // fileSeq strings, in flush order

    this._csvBlocks   = [];  // one string per flushed file (header + rows)
    this._tableRows    = []; // Sheet 1 — synerdgy_id | unique_id | source_filename | file_seq
    this._auditRows    = []; // Sheet 2 — fileSeq | filename | uploaded | field_mapping
  }

  // -------------------------------------------------------------------------
  // addFile — call once per file when it reaches 'ready' (orchestrator's
  // onFileReady). Queues by fileSeq, flushes everything now unblocked.
  //
  // @param {Object} job - orchestrator job shape: { fileSeq, filename,
  //   mapping, uniqueIds, uploadedAt }
  // @returns {{ flushedFileSeqs: string[] }}
  // -------------------------------------------------------------------------
  addFile({ fileSeq, filename, mapping, uniqueIds, uploadedAt }) {
    const seqNum = parseInt(fileSeq, 16);
    if (!Number.isFinite(seqNum)) {
      throw new Error(`OutputWriter: invalid fileSeq "${fileSeq}"`);
    }
    if (this._pendingFiles.has(seqNum) || this._writtenFileSeqs.includes(fileSeq)) {
      throw new Error(`OutputWriter: fileSeq "${fileSeq}" already added`);
    }

    const rows = uniqueIds.map((uniqueId, i) => ({
      synerdgyId: _synId(this.projectCode, this.clientCode, fileSeq, i + 1),
      uniqueId,
      filename,
      fileSeq,
    }));

    this._pendingFiles.set(seqNum, { fileSeq, filename, mapping, uploadedAt, rows });

    return { flushedFileSeqs: this._tryFlush() };
  }

  _tryFlush() {
    const flushed = [];
    while (this._pendingFiles.has(this._nextExpectedSeq)) {
      const file = this._pendingFiles.get(this._nextExpectedSeq);
      this._pendingFiles.delete(this._nextExpectedSeq);

      this._writeBlock(file);
      flushed.push(file.fileSeq);
      this._writtenFileSeqs.push(file.fileSeq);
      this._nextExpectedSeq++;
    }
    return flushed;
  }

  _writeBlock(file) {
    const fieldMapping = Object.entries(FIELD_LABELS)
      .filter(([std]) => file.mapping?.[std])
      .map(([std, label]) => `${label}=${file.mapping[std]}`)
      .join(', ');

    const header = [
      `# fileSeq: ${file.fileSeq}`,
      `# filename: ${file.filename}`,
      `# uploaded: ${file.uploadedAt}`,
      `# field_mapping: ${fieldMapping}`,
      'synerdgy_id, unique_id, source_filename, fileSeq',
    ].join('\n');

    const rows = file.rows
      .map(r => [
        _csvField(r.synerdgyId),
        _csvField(r.uniqueId),
        _csvField(r.filename),
        _csvField(r.fileSeq),
      ].join(', '))
      .join('\n');

    this._csvBlocks.push(rows ? `${header}\n${rows}` : header);

    for (const r of file.rows) {
      this._tableRows.push({
        synerdgy_id:     r.synerdgyId,
        unique_id:       r.uniqueId,
        source_filename: r.filename,
        fileSeq:         r.fileSeq,
      });
    }

    this._auditRows.push({
      fileSeq:       file.fileSeq,
      filename:      file.filename,
      uploaded:      file.uploadedAt,
      field_mapping: fieldMapping,
    });
  }

  // -------------------------------------------------------------------------
  // Output generation — cheap: joins/serialises what's already been
  // appended, does not re-derive anything from source files.
  // -------------------------------------------------------------------------

  /** @returns {Blob} the full consolidated mapping CSV, all blocks so far. */
  generateMappingCsv() {
    return new Blob([this._csvBlocks.join('\n\n')], { type: 'text/csv;charset=utf-8' });
  }

  /** @returns {Blob} the two-sheet lookup workbook, all rows so far. */
  generateLookupWorkbook() {
    const wb = XLSX.utils.book_new();

    const dataSheet = XLSX.utils.json_to_sheet(this._tableRows, {
      header: ['synerdgy_id', 'unique_id', 'source_filename', 'fileSeq'],
    });
    // Community SheetJS can't write a true OOXML Table object (see
    // module header comment) — autofilter + frozen header row is the
    // closest available proxy for "stays a stable range when sorted."
    if (this._tableRows.length > 0) {
      const lastRow = this._tableRows.length + 1;
      dataSheet['!autofilter'] = { ref: `A1:D${lastRow}` };
    }
    dataSheet['!freeze'] = { xSplit: 0, ySplit: 1 };
    XLSX.utils.book_append_sheet(wb, dataSheet, 'Data');

    const auditSheet = XLSX.utils.json_to_sheet(this._auditRows, {
      header: ['fileSeq', 'filename', 'uploaded', 'field_mapping'],
    });
    XLSX.utils.book_append_sheet(wb, auditSheet, 'Audit');

    const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // -------------------------------------------------------------------------
  // Browser download helpers. Not called from a test/Node context —
  // require `document`/`URL.createObjectURL`, real-browser only.
  // -------------------------------------------------------------------------

  _download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  downloadMappingCsv(filename = `${this.clientCode}_synerdgy_mapping.csv`) {
    this._download(this.generateMappingCsv(), filename);
  }

  downloadLookupWorkbook(filename = `${this.clientCode}_synerdgy_lookup.xlsx`) {
    this._download(this.generateLookupWorkbook(), filename);
  }
}

export { OutputWriter };
