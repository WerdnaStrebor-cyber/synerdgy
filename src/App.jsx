import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useSession } from './features/auth/useSession'
import { LoginForm } from './features/auth/LoginForm'
import { CreateMatchForm } from './features/auth/CreateMatchForm'
import { InviteLanding } from './features/auth/InviteLanding'
import { supabase } from './lib/supabaseClient'

function LicensorArea() {
  const { session, loading } = useSession()

  if (loading) return <p>Loading...</p>

  if (!session) {
    return <LoginForm />
  }

  return (
    <div>
      <p>
        Logged in as {session.user.email}{' '}
        <button onClick={() => supabase.auth.signOut()}>Log out</button>
      </p>
      <CreateMatchForm session={session} />
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      <div style={{ fontFamily: 'sans-serif', maxWidth: 640, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>SyNerdgy Exchange</h1>
        <Routes>
          <Route path="/" element={<LicensorArea />} />
          <Route path="/invite/:token" element={<InviteLanding />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}

export default App
