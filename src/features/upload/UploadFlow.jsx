// Upload UI — spec §3 steps 4(a-f) per file, §3a concurrency, §5/§5a
// outputs. Works for both parties: pass `inviteeToken` for the invitee
// (magic-link) path, omit it for the licensor (Supabase Auth session)
// path — everything downstream (Orchestrator, the three orchestrator
// RPCs, salt fetch) branches on its presence. See the
// invitee_token_based_auth migration (10 Aug 2026) for why this can't
// just be an ambient session value: magic-link sessions have no
// mechanism to persist a session GUC across separate stateless
// requests, so the token has to be threaded through explicitly end to
// end, from this component down to each RPC call.
//
// One file at a time in the UI (spec §3, step 4: "loads their file(s),
// one at a time"), but §3a's concurrent processing still applies
// underneath — a user can be mapping file 2 while file 1 is still
// hashing in the background. The output writer's fileSeq-ordered flush
// queue (synerdgy-output-writer.js) is what keeps the downloaded CSV/
// workbook correct regardless of which file's Web Worker finishes
// first; this component just reacts to whichever fileSeqs it reports
// as newly flushed.
//
// Styling deliberately matches the existing auth components (plain
// inline styles, no framework) rather than introducing a different
// visual language — see LoginForm.jsx/CreateMatchForm.jsx for the
// established pattern this follows.
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { LookupLoader } from '../../lib/engine/synerdgy-lookup-loader'
import { Orchestrator, STATES } from '../../lib/engine/synerdgy-orchestrator'
import { OutputWriter } from '../../lib/engine/synerdgy-output-writer'

// Standard field keys the mapping UI offers a dropdown for, in display
// order. Matches synerdgy-orchestrator.js's _detectFields exactly —
// keep these in sync if that list ever changes.
const MAPPING_FIELDS = [
  { key: 'ORG_NAME', label: 'Organisation name', required: true },
  { key: 'UNIQUE_ID', label: 'Unique ID (your own record ID)', required: false },
  { key: 'ADDRESS', label: 'Address', required: false },
  { key: 'POSTAL_CODE', label: 'Postcode', required: false },
  { key: 'COUNTRY', label: 'Country', required: false },
  { key: 'WEBSITE', label: 'Website', required: false },
  { key: 'SIC', label: 'SIC / NACE code', required: false },
  { key: 'SIC_DESCRIPTION', label: 'Industry description', required: false },
  { key: 'EMAIL', label: 'Email', required: false },
  { key: 'FIRSTNAME', label: 'First name', required: false },
  { key: 'SURNAME', label: 'Surname', required: false },
  { key: 'TELEPHONE', label: 'Telephone', required: false },
]

const STATUS_LABEL = {
  [STATES.QUEUED]: 'Queued',
  [STATES.PROCESSING]: 'Processing…',
  [STATES.READY]: 'Ready — confirm below',
  [STATES.ACKNOWLEDGED]: 'Saved',
  [STATES.ERROR]: 'Error',
}

export function UploadFlow({ matchId, projectCode, clientCode, inviteeToken = null, onDone }) {
  const [setupError, setSetupError] = useState(null)
  const [ready, setReady] = useState(false)

  const [queue, setQueue] = useState([])
  const [progress, setProgress] = useState({}) // sourceId -> { done, total }
  const [errors, setErrors] = useState({}) // sourceId -> message

  const [pending, setPending] = useState(null) // { uploadKey, filename, mapping, columns, rowCount, uniqueIdWarning }
  const [mappingDraft, setMappingDraft] = useState({})
  const [confirming, setConfirming] = useState(false)
  const [pickError, setPickError] = useState(null)

  const [ackQueue, setAckQueue] = useState([]) // jobs waiting on "I've saved both files"
  const [acknowledging, setAcknowledging] = useState(false)

  const [finishing, setFinishing] = useState(false)
  const [finished, setFinished] = useState(false)

  const sessionRef = useRef(null)
  const writerRef = useRef(null)
  const readyJobsByFileSeq = useRef({}) // fileSeq -> job, cached so a later
                                          // cascading flush can still find
                                          // an earlier file's data (see
                                          // module comment above)

  useEffect(() => {
    let cancelled = false

    async function setup() {
      try {
        const tables = await LookupLoader.load(supabase)
        if (cancelled) return

        writerRef.current = new OutputWriter({ projectCode, clientCode })

        const session = new Orchestrator({
          supabase,
          matchId,
          tables,
          projectCode,
          clientCode,
          inviteeToken,
          onQueueChange: (snapshot) => setQueue(snapshot),
          onFileProgress: (sourceId, done, total) =>
            setProgress((p) => ({ ...p, [sourceId]: { done, total } })),
          onFileReady: (job) => {
            readyJobsByFileSeq.current[job.fileSeq] = job
            const { flushedFileSeqs } = writerRef.current.addFile(job)
            if (flushedFileSeqs.length === 0) return // held — an earlier
                                                        // fileSeq hasn't
                                                        // flushed yet

            // One download covers everything newly flushed, including
            // any earlier files that were held and just cascaded.
            writerRef.current.downloadMappingCsv()
            writerRef.current.downloadLookupWorkbook()

            const newlyReady = flushedFileSeqs
              .map((seq) => readyJobsByFileSeq.current[seq])
              .filter(Boolean)
            setAckQueue((q) => [...q, ...newlyReady])
          },
          onError: (sourceId, message) =>
            setErrors((e) => ({ ...e, [sourceId]: message })),
        })

        await session.init()
        if (cancelled) {
          session.destroy()
          return
        }

        sessionRef.current = session
        setReady(true)
      } catch (err) {
        if (!cancelled) setSetupError(err.message)
      }
    }

    setup()

    return () => {
      cancelled = true
      sessionRef.current?.destroy()
    }
    // matchId/projectCode/clientCode/inviteeToken are fixed for the
    // lifetime of one upload session — not expected to change under this
    // component, so intentionally not re-running setup if they did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow picking the same filename again later
    if (!file) return

    setPickError(null)
    try {
      const result = await sessionRef.current.parseAndDetect(file)
      setPending({ ...result, filename: file.name })
      setMappingDraft(result.mapping)
    } catch (err) {
      setPickError(err.message)
    }
  }

  async function handleConfirmMapping(e) {
    e.preventDefault()
    setConfirming(true)
    try {
      await sessionRef.current.confirmMapping(pending.uploadKey, mappingDraft)
      setPending(null)
      setMappingDraft({})
    } catch (err) {
      setPickError(err.message)
    } finally {
      setConfirming(false)
    }
  }

  async function handleAcknowledge() {
    const job = ackQueue[0]
    if (!job) return
    setAcknowledging(true)
    try {
      await sessionRef.current.acknowledgeFile(job.sourceId)
      setAckQueue((q) => q.slice(1))
    } catch (err) {
      setErrors((e) => ({ ...e, [job.sourceId]: err.message }))
    } finally {
      setAcknowledging(false)
    }
  }

  async function handleDone() {
    setFinishing(true)
    try {
      // "Done" itself has no dedicated RPC yet (Phase 5 wires this to
      // the matching run) — for now this just marks the local UI state
      // and hands off to the parent.
      setFinished(true)
      onDone?.()
    } finally {
      setFinishing(false)
    }
  }

  if (setupError) {
    return <p style={{ color: 'crimson' }}>Couldn't start the upload session: {setupError}</p>
  }
  if (!ready) {
    return <p>Preparing upload…</p>
  }
  if (finished) {
    return <p>All files saved and acknowledged. Matching runs next (not built yet — Phase 5).</p>
  }

  const currentAck = ackQueue[0]
  const canPickFile = !pending && !currentAck
  const canFinish = sessionRef.current?.canFinish() ?? false

  return (
    <div style={{ maxWidth: 560 }}>
      <h2>Upload your files</h2>

      {queue.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, marginBottom: 16 }}>
          {queue.map((job) => {
            const p = progress[job.sourceId]
            const err = errors[job.sourceId]
            return (
              <li
                key={job.sourceId}
                style={{ border: '1px solid #e5e4e7', borderRadius: 4, padding: 8, marginBottom: 8 }}
              >
                <strong>{job.filename}</strong> — fileSeq {job.fileSeq}, {job.rowCount} rows
                <br />
                {err ? (
                  <span style={{ color: 'crimson' }}>Error: {err}</span>
                ) : (
                  <span>
                    {STATUS_LABEL[job.status] ?? job.status}
                    {job.status === STATES.PROCESSING && p && ` (${p.done}/${p.total})`}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {currentAck && (
        <div style={{ border: '1px solid var(--accent-border, #aa3bff)', borderRadius: 4, padding: 12, marginBottom: 16 }}>
          <p>
            <strong>{currentAck.filename}</strong> is processed. The mapping CSV and lookup
            workbook have just downloaded — confirm you've saved both before continuing.
          </p>
          <button onClick={handleAcknowledge} disabled={acknowledging}>
            {acknowledging ? 'Confirming…' : "I've saved both files"}
          </button>
        </div>
      )}

      {pending && (
        <form onSubmit={handleConfirmMapping} style={{ marginBottom: 16 }}>
          <h3>Confirm field mapping — {pending.filename}</h3>
          <p>{pending.rowCount} rows detected.</p>
          {pending.uniqueIdWarning && (
            <p style={{ color: '#b45309' }}>
              No Unique ID column detected — you can still proceed, but the mapping file's
              synerdgy_id/unique_id pairing for this file will have blank unique_id values.
            </p>
          )}

          {MAPPING_FIELDS.map(({ key, label, required }) => (
            <label key={key} style={{ display: 'block', marginBottom: 8 }}>
              {label}
              {required ? ' *' : ''}
              <select
                value={mappingDraft[key] ?? ''}
                onChange={(e) =>
                  setMappingDraft((m) => ({ ...m, [key]: e.target.value || undefined }))
                }
                required={required}
                style={{ display: 'block', width: '100%' }}
              >
                <option value="">— not mapped —</option>
                {pending.columns.map((col) => (
                  <option key={col} value={col}>
                    {col}
                  </option>
                ))}
              </select>
            </label>
          ))}

          {pickError && <p style={{ color: 'crimson' }}>{pickError}</p>}

          <button type="submit" disabled={confirming}>
            {confirming ? 'Starting…' : 'Confirm mapping and process'}
          </button>
        </form>
      )}

      {canPickFile && (
        <div style={{ marginBottom: 16 }}>
          <label>
            Load a file (.csv or .xlsx)
            <input type="file" accept=".csv,.xlsx,.xls" onChange={handleFileChange} style={{ display: 'block' }} />
          </label>
          {pickError && <p style={{ color: 'crimson' }}>{pickError}</p>}
        </div>
      )}

      <button onClick={handleDone} disabled={!canFinish || finishing}>
        {finishing ? 'Finishing…' : 'Done'}
      </button>
      {!canFinish && queue.length > 0 && (
        <p style={{ fontSize: 14, color: 'var(--text, #6b6375)' }}>
          "Done" unlocks once every loaded file is processed and acknowledged.
        </p>
      )}
    </div>
  )
}
