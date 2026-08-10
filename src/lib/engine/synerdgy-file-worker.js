/**
 * Synerdgy — File Processing Worker
 * =============================================================
 * NEW 10 Aug 2026. Runs step 3(d) of the upload flow (SYN ID assignment,
 * org/country/postcode normalisation, hashing — spec §3) off the main
 * thread, per the §4 performance requirement and the §3a concurrent
 * processing design. One of these is spawned per worker-pool slot
 * (fixed at 3, per the 10 Aug 2026 sizing decision); each is
 * initialised once and reused across every file the orchestrator
 * dispatches to it, rather than being spawned fresh per file.
 *
 * Message protocol (all messages are plain objects with a `type` field):
 *
 *   Main thread → worker:
 *     { type: 'init', tables, salt, projectCode, clientCode, defaultCountry }
 *       — sent once, immediately after the worker is created. `tables`
 *         is a LookupTables instance; it survives structured clone as a
 *         plain object (Map/Set/RegExp all clone natively) — only its
 *         prototype is lost, which doesn't matter since nothing here
 *         calls a method on it, only reads properties.
 *     { type: 'process', jobId, sourceId, fileSeq, mapping, rawRecords }
 *       — one per file. rawRecords is the already-parsed array (parsing
 *         happens on the main thread per spec §3a/b, before queuing —
 *         this worker never touches File objects or PapaParse/SheetJS).
 *
 *   Worker → main thread:
 *     { type: 'progress', jobId, done, total }
 *     { type: 'batch', jobId, companyBatch, contactBatch, isFinal }
 *       — main thread calls mark_source_processed(sourceId, companyBatch,
 *         contactBatch, isFinal) on receipt of each one (spec: batched
 *         RPC calls, only the final batch flips status to 'ready').
 *     { type: 'error', jobId, message }
 *     { type: 'done', jobId }
 *
 * Contact-side standardisation (new — the previous engine pack only
 * normalised organisation fields):
 *   - firstNameStandardised / surnameStandardised: trimmed, passed
 *     through as-is — hashContactRecord's sha256() call already
 *     lowercases before hashing, so no separate case-folding needed here.
 *   - firstNameInitial: first character of the trimmed first name,
 *     uppercased.
 *   - telephoneStandardised: digits only, leading '+' preserved if
 *     present, leading '00' collapsed to '+'. No further validation —
 *     malformed numbers just hash to a value nothing else matches,
 *     which is the correct failure mode (no match) rather than an error.
 *   Deeper contact matching logic (nickname normalisation, consonant
 *   skeletons for contact_fuzzy) lives entirely in the M2 SQL per spec
 *   §6 — not duplicated here.
 */

import * as SynerdgyVHC from './synerdgy-vhc-normalizer.js';
import * as SynerdgyCountry from './synerdgy-country-standardiser.js';
import * as SynerdgyPostcode from './synerdgy-postcode-normaliser.js';
import * as SynerdgyHashPipeline from './synerdgy-hash-pipeline.js';

const HASH_BATCH_SIZE = 500;

let _tables         = null;
let _salt           = null;
let _projectCode    = null;
let _clientCode     = null;
let _defaultCountry = null;

// ---------------------------------------------------------------------------
// SYN ID generator — fileSeq segment added 10 Aug 2026 to fix the
// cross-file collision bug (spec §4): previously the record sequence
// reset to 1 on every upload with no way to tell which file a given SYN
// ID came from. fileSeq is assigned once, server-side, by
// queue_source_upload at queue-entry — this worker only ever receives
// an already-assigned fileSeq, never generates one.
// Format: SYN-[5hex project]-[5hex client]-[4hex fileSeq]-[8hex recordSeq]
// ---------------------------------------------------------------------------

function _synId(projectCode, clientCode, fileSeq, recordSeq) {
  const seqHex = recordSeq.toString(16).toUpperCase().padStart(8, '0');
  return `SYN-${projectCode}-${clientCode}-${fileSeq}-${seqHex}`;
}

// ---------------------------------------------------------------------------
// Domain extraction (Module 3a — carried over unchanged)
// ---------------------------------------------------------------------------

function _extractDomain(websiteValue) {
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

  return _tables.freeDomains.has(domain) ? '' : domain;
}

// ---------------------------------------------------------------------------
// Contact-side standardisation (new — see module comment above)
// ---------------------------------------------------------------------------

function _standardiseTelephone(raw) {
  if (!raw?.trim()) return '';
  let v = raw.trim();
  const hasPlus = v.startsWith('+');
  v = v.replace(/\D/g, ''); // digits only
  if (hasPlus) return '+' + v;
  if (v.startsWith('00')) return '+' + v.slice(2);
  return v;
}

/**
 * Split a raw email into local part and domain, both trimmed. Neither
 * is case-folded here — hashContactRecord's sha256() call already
 * lowercases before hashing, consistent with every other hashed field.
 * Malformed input (no '@', or more than one) returns both parts empty
 * — that hashes to null (sha256() treats empty as null-in, null-out),
 * which is the correct "no match possible" outcome rather than an error.
 *
 * 10 Aug 2026: added to support M2's contact_exact (email_name AND
 * email_domain both equal) vs contact_email_name (email_name equal,
 * domain ignored) — these need the two parts hashed independently,
 * which a single whole-email hash can't support.
 */
function _splitEmail(raw) {
  if (!raw?.trim()) return { name: '', domain: '' };
  const v = raw.trim();
  const parts = v.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { name: '', domain: '' };
  return { name: parts[0], domain: parts[1] };
}

// ---------------------------------------------------------------------------
// Field extraction — one input row → one company-derived + one
// contact-derived record, sharing a SYN ID.
// ---------------------------------------------------------------------------

function _deriveFromRow(record, mapping, fileSeq, recordSeq) {
  const synId = _synId(_projectCode, _clientCode, fileSeq, recordSeq);

  // Organisation side (unchanged from previous engine pack)
  const orgName  = String(record[mapping.ORG_NAME]    ?? '').trim();
  const country  = String(record[mapping.COUNTRY]     ?? '').trim();
  const postcode = String(record[mapping.POSTAL_CODE] ?? '').trim();
  const website  = String(record[mapping.WEBSITE]     ?? '').trim();

  const vhc = SynerdgyVHC.normaliseOrg(orgName, _tables);
  const domain = _extractDomain(website);
  const ctry = SynerdgyCountry.standardiseCountry(country || _defaultCountry, _tables, _defaultCountry);
  const pc = SynerdgyPostcode.normalisePostcode(postcode, ctry.iso2, _tables);

  const companyDerived = {
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
  };

  // Contact side (new)
  const email     = String(record[mapping.EMAIL]     ?? '').trim();
  const firstName = String(record[mapping.FIRSTNAME]  ?? '').trim();
  const surname   = String(record[mapping.SURNAME]    ?? '').trim();
  const telephone = String(record[mapping.TELEPHONE]  ?? '').trim();
  const { name: emailName, domain: emailDomain } = _splitEmail(email);

  const contactDerived = {
    clientRecordId:         synId,
    emailName,
    emailDomain,
    firstNameStandardised:  firstName,
    firstNameInitial:       firstName ? firstName.charAt(0).toUpperCase() : '',
    surnameStandardised:    surname,
    telephoneStandardised:  _standardiseTelephone(telephone),
  };

  return { companyDerived, contactDerived };
}

// ---------------------------------------------------------------------------
// Per-file processing — chunked, yields progress + batches
// ---------------------------------------------------------------------------

async function _processFile({ jobId, sourceId, fileSeq, mapping, rawRecords }) {
  const total = rawRecords.length;
  let recordSeq = 0;
  let companyChunk = [];
  let contactChunk = [];

  for (const record of rawRecords) {
    recordSeq++;
    const { companyDerived, contactDerived } = _deriveFromRow(record, mapping, fileSeq, recordSeq);
    companyChunk.push(companyDerived);
    contactChunk.push(contactDerived);

    if (companyChunk.length >= HASH_BATCH_SIZE || recordSeq === total) {
      const [hashedCompany, hashedContact] = await Promise.all([
        SynerdgyHashPipeline.hashBatch(companyChunk, _salt),
        SynerdgyHashPipeline.hashContactBatch(contactChunk, _salt),
      ]);

      const isFinal = recordSeq === total;
      self.postMessage({
        type: 'batch',
        jobId,
        sourceId,
        companyBatch: hashedCompany,
        contactBatch: hashedContact,
        isFinal,
      });

      companyChunk = [];
      contactChunk = [];

      self.postMessage({ type: 'progress', jobId, done: recordSeq, total });
    }
  }

  self.postMessage({ type: 'done', jobId });
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

self.onmessage = async (event) => {
  const msg = event.data;

  if (msg.type === 'init') {
    _tables         = msg.tables;
    _salt           = msg.salt;
    _projectCode    = msg.projectCode;
    _clientCode     = msg.clientCode;
    _defaultCountry = msg.defaultCountry;
    return;
  }

  if (msg.type === 'process') {
    if (!_tables || !_salt) {
      self.postMessage({ type: 'error', jobId: msg.jobId, message: 'Worker not initialised — init message not received or incomplete.' });
      return;
    }
    try {
      await _processFile(msg);
    } catch (err) {
      self.postMessage({ type: 'error', jobId: msg.jobId, message: err.message });
    }
    return;
  }
};
