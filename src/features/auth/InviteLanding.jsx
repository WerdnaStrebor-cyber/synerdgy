// The page an invitee lands on after clicking their magic link
// (/invite/:token). No login, no password — just the token in the URL.
// Calls invitee_get_match to validate it and show who invited them and
// what match they're joining, then hands off into UploadFlow — the
// token itself becomes UploadFlow's inviteeToken prop, which threads
// down through Orchestrator to every RPC call it makes (see the
// invitee_token_based_auth migration, 10 Aug 2026, for why an explicit
// token rather than an ambient session value).
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { UploadFlow } from '../upload/UploadFlow'

export function InviteLanding() {
  const { token } = useParams()
  const [match, setMatch] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    async function loadMatch() {
      const { data, error } = await supabase.rpc('invitee_get_match', { token })

      if (error) {
        setError(error.message)
      } else if (!data || data.length === 0) {
        // A wrong/expired/tampered token returns zero rows, not a thrown
        // error — matches spec §8's "clear error, no partial/silent join"
        // principle for the mapping-file check, applied the same way here.
        setError('This invite link is invalid or has expired.')
      } else {
        setMatch(data[0])
      }
      setLoading(false)
    }

    loadMatch()
  }, [token])

  if (loading) return <p>Checking your invite...</p>
  if (error) return <p style={{ color: 'crimson' }}>{error}</p>

  if (uploading) {
    return (
      <UploadFlow
        matchId={match.match_id}
        projectCode={match.match_code}
        clientCode={match.client_code}
        inviteeToken={token}
      />
    )
  }

  return (
    <div style={{ maxWidth: 480 }}>
      <h2>You've been invited to a SyNerdgy Exchange match</h2>
      <p>
        <strong>Match:</strong> {match.match_name}
      </p>
      <p>
        <strong>Your role:</strong> Party {match.party_slot} of 2
      </p>
      <button onClick={() => setUploading(true)}>Start uploading your files</button>
    </div>
  )
}
