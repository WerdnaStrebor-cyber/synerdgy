// Central Supabase client. Every part of the app imports from here rather
// than creating its own client, so there's exactly one connection config.
//
// The two values below come from environment variables — set them in a
// local .env file (see .env.example) and, separately, in Vercel's project
// settings for the deployed site. Never commit real keys to the repo.
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  // Fails loudly at startup rather than silently breaking every DB call —
  // easier to diagnose "forgot to set .env" than a wall of failed requests.
  console.error(
    'Missing Supabase environment variables. Copy .env.example to .env ' +
    'and fill in your project URL and anon key from the Supabase dashboard.'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
