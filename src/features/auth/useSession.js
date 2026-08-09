// Tracks the current Supabase Auth session (licensor login state) and
// keeps it updated as the user signs in/out. Every component that needs
// to know "is a licensor logged in right now" uses this, rather than
// each one separately querying Supabase.
import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabaseClient'

export function useSession() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Check for an existing session on first load (e.g. page refresh).
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
    })

    // Stay updated if the user signs in or out while this page is open.
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  return { session, loading }
}
