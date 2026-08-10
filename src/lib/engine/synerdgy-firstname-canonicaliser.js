/**
 * Synerdgy — First-Name Canonicaliser
 * =============================================================
 * NEW 10 Aug 2026. Resolves a raw first name to a canonical form for
 * the `contact_name` match level (spec §6), so "Bob"/"Robert"/"Bobby"
 * hash identically while `firstname_standardised` (the raw, un-resolved
 * value) stays distinct — `contact_name` sits below `contact_exact`/
 * `contact_email_name` in the match hierarchy as a fallback-tier signal.
 *
 * Data source: `nicknames.csv` in the `lookup-tables` Storage bucket
 * (270 rows, `canonical,nickname`), loaded and parsed by
 * `synerdgy-lookup-loader.js` into `tables.canonicalNames` (Set) and
 * `tables.nicknameToCanonicals` (Map<nickname, string[]>, candidates
 * pre-sorted alphabetically at parse time).
 *
 * Two real data ambiguities in the source data, handled deliberately:
 *
 * 1. `sandra` is both its own canonical name AND a listed nickname of
 *    `alexandra`. Resolution order matters: check "is this literally a
 *    canonical name" BEFORE "is this someone's nickname" — so `Sandra`
 *    always resolves to `sandra`, never `alexandra`.
 *
 * 2. Six nicknames (`chris`, `nicky`, `nat`, `katie`, `kathy`, `kate`)
 *    map to 2–4 different canonicals each — genuinely ambiguous, no way
 *    to disambiguate from the nickname alone (`chris` spans
 *    christian/christina/christine/christopher). Decision: resolve
 *    deterministically to the alphabetically-first candidate, accepting
 *    some missed matches on these specific cases. Multi-candidate
 *    hashing (trying all candidates at match time) was considered and
 *    explicitly deferred as unwarranted complexity for a fallback-tier
 *    signal.
 *
 * Names with no nickname-table entry at all pass through unresolved
 * (lowercased/trimmed) — same "no match possible" failure mode used
 * everywhere else in the pipeline, not an error.
 *
 * Usage:
 *   const canonical = FirstnameCanonicaliser.canonicalise(firstName, tables);
 */

'use strict';

class FirstnameCanonicaliser {

  /**
   * @param {string} rawFirstName - Already-trimmed first name value
   *                                 (e.g. `record[mapping.FIRSTNAME]`,
   *                                 pre-trim not required, done here).
   * @param {LookupTables} tables - Must have `canonicalNames` (Set) and
   *                                 `nicknameToCanonicals` (Map) populated
   *                                 by LookupLoader.
   * @returns {string} Lowercased canonical form, or the lowercased/
   *                    trimmed input unchanged if no resolution applies.
   */
  static canonicalise(rawFirstName, tables) {
    const name = String(rawFirstName ?? '').trim().toLowerCase();
    if (!name) return '';

    // Rule 1: literal canonical name always wins over nickname lookup —
    // fixes the `sandra` case (both canonical and a nickname of `alexandra`).
    if (tables?.canonicalNames?.has(name)) return name;

    // Rule 2: nickname → candidates, pre-sorted alphabetically at parse
    // time — deterministic tiebreak for genuinely ambiguous nicknames
    // (chris/nicky/nat/katie/kathy/kate).
    const candidates = tables?.nicknameToCanonicals?.get(name);
    if (candidates && candidates.length > 0) return candidates[0];

    // No table entry — pass through unresolved.
    return name;
  }
}

export { FirstnameCanonicaliser };
