// The page an invitee lands on after clicking their magic link
// (/invite/:token). No login, no password — just the token in the URL.
// Calls invitee_get_match to validate it and show who invited them and
// what match they're joining. Upload flow itself is Phase 3/4, not built
// here — this page's job is purely "confirm the link is valid and show
// the invitee what they're about to do."
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'

export function InviteLanding() {
  const { token } = useParams()
  const [match, setMatch] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

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

  return (
    <div style={{ maxWidth: 480 }}>
      <h2>You've been invited to a SyNerdgy Exchange match</h2>
      <p>
        <strong>Match:</strong> {match.match_name}
      </p>
      <p>
        <strong>Your role:</strong> Party {match.party_slot} of 2
      </p>
      <p>
        File upload isn't built yet (Phase 3/4) — this page confirms your
        invite link works.
      </p>
    </div>
  )
}
