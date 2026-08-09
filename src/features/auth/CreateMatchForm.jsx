// Licensor starts a new match (spec §3 steps 1-3): names it, picks match
// type (which slot the licensor occupies), and supplies the invitee's
// name/email. On submit, this creates the client/match/parties rows and
// surfaces the magic link for the licensor to send manually.
//
// KNOWN GAP, flagged deliberately rather than hidden: this creates a new
// `clients` row on every single match, rather than reusing one client
// record across a licensor's repeat matches. There's no clean way yet for
// the app to look up "this licensor's existing client row" — clients
// isn't linked to auth.uid() directly, only indirectly through an
// existing match's party row, which doesn't exist yet on a licensor's
// very first match. Fine for testing Phase 2 end-to-end; worth a proper
// fix (e.g. a clients.owner_user_id column) before this handles repeat
// real licensors.
import { useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { generateHexCode } from '../../lib/generateCode'

export function CreateMatchForm({ session }) {
  const [matchName, setMatchName] = useState('')
  const [matchType, setMatchType] = useState(1)
  const [inviteeName, setInviteeName] = useState('')
  const [inviteeEmail, setInviteeEmail] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [magicLink, setMagicLink] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    try {
      // 1. Client record — see the KNOWN GAP note above.
      const { data: client, error: clientError } = await supabase
        .from('clients')
        .insert({ name: matchName, client_code: generateHexCode() })
        .select()
        .single()
      if (clientError) throw clientError

      // 2. The match itself.
      const { data: match, error: matchError } = await supabase
        .from('matches')
        .insert({
          client_id: client.id,
          name: matchName,
          match_code: generateHexCode(),
          match_type: matchType,
          status: 'invited',
        })
        .select()
        .single()
      if (matchError) throw matchError

      // 3. Both party rows. Licensor's slot depends on match_type (spec §2):
      // type 1 = licensor is party 1, type 2 = licensor is party 2.
      const licensorSlot = matchType === 1 ? 1 : 2
      const inviteeSlot = matchType === 1 ? 2 : 1

      const { error: licensorPartyError } = await supabase.from('parties').insert({
        match_id: match.id,
        role: 'licensor',
        slot: licensorSlot,
        user_id: session.user.id,
        email: session.user.email,
      })
      if (licensorPartyError) throw licensorPartyError

      // Select the invitee row back so we get the DB-generated
      // magic_link_token to build the link from.
      const { data: inviteeParty, error: inviteePartyError } = await supabase
        .from('parties')
        .insert({
          match_id: match.id,
          role: 'invitee',
          slot: inviteeSlot,
          email: inviteeEmail,
          invitee_name: inviteeName,
        })
        .select()
        .single()
      if (inviteePartyError) throw inviteePartyError

      setMagicLink(`${window.location.origin}/invite/${inviteeParty.magic_link_token}`)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (magicLink) {
    return (
      <div style={{ maxWidth: 480 }}>
        <h3>Match created</h3>
        <p>
          Send this link to your invitee — Phase 7 (notifications) will
          eventually email it automatically; for now, copy and send it
          yourself.
        </p>
        <input readOnly value={magicLink} style={{ width: '100%' }} onFocus={(e) => e.target.select()} />
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} style={{ maxWidth: 400 }}>
      <h2>Start a new match</h2>

      <label style={{ display: 'block', marginBottom: 8 }}>
        Match name
        <input value={matchName} onChange={(e) => setMatchName(e.target.value)} required style={{ display: 'block', width: '100%' }} />
      </label>

      <fieldset style={{ marginBottom: 8 }}>
        <legend>Match type (spec §2)</legend>
        <label style={{ display: 'block' }}>
          <input type="radio" checked={matchType === 1} onChange={() => setMatchType(1)} />
          Type 1 — I upload first, invitee sees the matches
        </label>
        <label style={{ display: 'block' }}>
          <input type="radio" checked={matchType === 2} onChange={() => setMatchType(2)} />
          Type 2 — Invitee uploads first, I see the matches
        </label>
      </fieldset>

      <label style={{ display: 'block', marginBottom: 8 }}>
        Invitee name
        <input value={inviteeName} onChange={(e) => setInviteeName(e.target.value)} required style={{ display: 'block', width: '100%' }} />
      </label>

      <label style={{ display: 'block', marginBottom: 8 }}>
        Invitee email
        <input type="email" value={inviteeEmail} onChange={(e) => setInviteeEmail(e.target.value)} required style={{ display: 'block', width: '100%' }} />
      </label>

      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      <button type="submit" disabled={submitting}>
        {submitting ? 'Creating...' : 'Create match'}
      </button>
    </form>
  )
}
