// Generates a 5-character uppercase hex code, used for client_code and
// match_code (spec §4's SYN ID format). Not cryptographically significant
// — these are identifiers baked into SYN IDs, not secrets — so a simple
// random hex string is sufficient.
export function generateHexCode(length = 5) {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes)
    .map((b) => (b % 16).toString(16).toUpperCase())
    .join('')
}
