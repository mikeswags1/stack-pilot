export function getRapidApiKey() {
  // ── EMERGENCY KILL SWITCH (2026-06-29) ──────────────────────────────────────
  // RapidAPI's usage-based billing charged the user $1,550. Every app call costs money,
  // and the crons (sourcing, availability, reprice, enrichment) hammer it 24/7. This
  // HARD-DISABLES all RapidAPI calls regardless of the old ENABLE_RAPIDAPI_FALLBACK flag,
  // so no further charges accrue. The app falls back to the free scraper / cached data.
  // To re-enable LATER — only after capping spend in the RapidAPI dashboard AND adding a
  // hard daily call limit — set BOTH env vars: RAPIDAPI_REENABLED=1 and
  // ENABLE_RAPIDAPI_FALLBACK=1.
  if (process.env.RAPIDAPI_REENABLED !== '1') return ''
  if (process.env.ENABLE_RAPIDAPI_FALLBACK !== '1') return ''
  return process.env.RAPIDAPI_KEY || ''
}

export function isRapidApiFallbackEnabled() {
  return Boolean(getRapidApiKey())
}
