// Licensor login — standard email + password against Supabase Auth.
// There's no self-serve signup form here deliberately: licensor accounts
// are created manually (Supabase Dashboard > Authentication > Users >
// Add user) rather than open registration, since licensors are onboarded
// customers, not anonymous signups.
import { useState } from 'react'
import { supabase } from '../../lib/supabaseClient'

export function LoginForm({ onLoggedIn }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    const { data, error } = await supabase.auth.signInWithPassword({ email, password })

    setSubmitting(false)

    if (error) {
      // Supabase's own error message is usually clear enough to show
      // directly ("Invalid login credentials" etc.) rather than
      // translating it into something custom.
      setError(error.message)
      return
    }

    onLoggedIn?.(data.session)
  }

  return (
    <form onSubmit={handleSubmit} style={{ maxWidth: 320 }}>
      <h2>Licensor Login</h2>

      <label style={{ display: 'block', marginBottom: 8 }}>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ display: 'block', width: '100%' }}
        />
      </label>

      <label style={{ display: 'block', marginBottom: 8 }}>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={{ display: 'block', width: '100%' }}
        />
      </label>

      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      <button type="submit" disabled={submitting}>
        {submitting ? 'Logging in...' : 'Log in'}
      </button>
    </form>
  )
}
