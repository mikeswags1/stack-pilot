// Claude-powered eBay description rewriter.
//
// Mirrors lib/ai-title-generator.ts pattern. The current description builder pulls
// Amazon's feature bullets straight through and wraps them in a template. That produces
// listings that look generic + repeat boilerplate language. This module asks Claude
// (Haiku) to rewrite the OVERVIEW + FEATURE BULLETS into eBay buyer-focused copy that:
//   - Leads with benefits and use cases (not specs)
//   - Drops marketing fluff ("premium", "high-quality", "world-class")
//   - Highlights features that drive eBay buyer clicks
//   - Stays consistent in voice across listings
//
// Results cached per-ASIN. The list-product endpoint uses the AI bullets in place of
// raw Amazon feature bullets but keeps the existing template wrapper (shipping/returns/
// contact sections stay).

import { queryRows, sql } from '@/lib/db'

const CACHE_TTL_DAYS = 30
const MIN_BULLETS = 3
const MAX_BULLETS = 6

const SYSTEM_PROMPT = `You write eBay listing descriptions. You receive the Amazon product details and produce:
1. A short OVERVIEW paragraph (1-2 sentences, 80-180 chars total) — explains the product in buyer-friendly terms
2. 4-6 FEATURE BULLETS — each starts with a short BOLD LABEL followed by a colon and 1 short benefit-focused sentence

Rules:
- Output STRICT JSON only — no markdown fences, no commentary. Shape: {"overview":"...","bullets":["LABEL: benefit","LABEL: benefit",...]}
- Each bullet must start with a 2-4 word capitalized label followed by ": " (e.g. "FAST CHARGING: Reaches full power in 30 minutes.")
- Bullets must focus on what the BUYER GETS, not the seller. Avoid "Made with", "Featuring", "Designed to". Prefer "Charges your devices fast", "Keeps food cold for 24 hours".
- Maximum 220 chars per bullet INCLUDING the LABEL: prefix.
- No marketing fluff: never use "premium", "world-class", "high-quality", "best-in-class", "state-of-the-art".
- Never mention: Amazon, amazon.com, "as seen on", Amazon's Choice, Best Seller.
- Never repeat what the title says verbatim. Add new info.
- Keep it factual. Don't invent specifications you weren't given.
- Use US English.`

function buildUserPrompt(input: {
  title: string
  niche?: string | null
  amazonFeatures?: string[]
  amazonDescription?: string
  specs?: Array<[string, string]>
}) {
  const lines: string[] = [`Product title: ${input.title}`]
  if (input.niche) lines.push(`Category: ${input.niche}`)
  if (input.amazonFeatures && input.amazonFeatures.length > 0) {
    lines.push(`Amazon feature bullets (raw input — rewrite, don't copy):`)
    for (const f of input.amazonFeatures.slice(0, 8)) lines.push(`  - ${f.slice(0, 280)}`)
  }
  if (input.amazonDescription && input.amazonDescription.length > 30) {
    lines.push(`Amazon description excerpt: ${input.amazonDescription.slice(0, 600)}`)
  }
  if (input.specs && input.specs.length > 0) {
    lines.push(`Key specs:`)
    for (const [k, v] of input.specs.slice(0, 8)) lines.push(`  - ${k}: ${String(v).slice(0, 80)}`)
  }
  lines.push('')
  lines.push('Return ONLY the JSON object.')
  return lines.join('\n')
}

async function callClaude(userPrompt: string) {
  const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim()
  if (!apiKey) return null
  const model = String(process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5').trim()

  const { recordApiCall } = await import('@/lib/quota-tracker')
  const startedAt = Date.now()

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000, // descriptions need more room than titles
      temperature: 0.3,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) {
    recordApiCall({ provider: 'anthropic', callName: 'description-rewrite', success: false, durationMs: Date.now() - startedAt, errorCode: `HTTP_${res.status}`, errorMessage: (await res.text().catch(() => '')).slice(0, 200) }).catch(() => {})
    return null
  }
  const data = await res.json() as { content?: Array<{ text?: string }> }
  const text = Array.isArray(data.content)
    ? data.content.map((part) => part?.text || '').join('').trim()
    : ''
  recordApiCall({ provider: 'anthropic', callName: 'description-rewrite', success: true, durationMs: Date.now() - startedAt }).catch(() => {})
  return text || null
}

function extractJsonObject(text: string): string {
  const trimmed = (text || '').trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenced?.[1]) {
    const inside = fenced[1].trim()
    if (inside.startsWith('{') && inside.endsWith('}')) return inside
  }
  const greedy = trimmed.match(/\{[\s\S]*\}/)
  return greedy?.[0] || '{}'
}

const FORBIDDEN_WORDS = /\b(amazon\.?com?|amazon's\s+choice|best\s+seller|premium\s+quality|world.class|state.of.the.art|highly.rated)\b/gi

function sanitizeBullet(raw: string): string {
  return String(raw || '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[<>"]/g, '')
    .replace(FORBIDDEN_WORDS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
}

function sanitizeOverview(raw: string): string {
  return String(raw || '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[<>"]/g, '')
    .replace(FORBIDDEN_WORDS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280)
}

export interface AiDescription {
  overview: string
  bullets: string[]
}

export async function ensureEbayDescriptionCacheTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS ebay_description_cache (
      asin TEXT PRIMARY KEY,
      overview TEXT NOT NULL,
      bullets JSONB NOT NULL,
      source_title TEXT,
      niche TEXT,
      model TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
    )
  `.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS ebay_description_cache_expires_idx ON ebay_description_cache (expires_at)`.catch(() => {})
}

export async function getCachedAiDescription(asin: string): Promise<AiDescription | null> {
  if (!asin) return null
  await ensureEbayDescriptionCacheTable()
  const key = String(asin).toUpperCase().slice(0, 12)
  const rows = await queryRows<{ overview: string; bullets: unknown }>`
    SELECT overview, bullets FROM ebay_description_cache
    WHERE asin = ${key} AND expires_at > NOW()
    LIMIT 1
  `.catch(() => [])
  const row = rows[0]
  if (!row) return null
  const bullets = Array.isArray(row.bullets) ? (row.bullets as string[]) : []
  return { overview: row.overview, bullets }
}

async function setCachedAiDescription(asin: string, data: {
  overview: string
  bullets: string[]
  sourceTitle: string
  niche?: string | null
  model: string
}) {
  if (!asin) return
  await ensureEbayDescriptionCacheTable()
  const key = String(asin).toUpperCase().slice(0, 12)
  await sql`
    INSERT INTO ebay_description_cache (asin, overview, bullets, source_title, niche, model, expires_at)
    VALUES (
      ${key},
      ${data.overview},
      ${JSON.stringify(data.bullets)}::jsonb,
      ${data.sourceTitle.slice(0, 500)},
      ${data.niche || null},
      ${data.model},
      NOW() + (${CACHE_TTL_DAYS} || ' days')::interval
    )
    ON CONFLICT (asin) DO UPDATE SET
      overview = EXCLUDED.overview,
      bullets = EXCLUDED.bullets,
      source_title = EXCLUDED.source_title,
      niche = EXCLUDED.niche,
      model = EXCLUDED.model,
      updated_at = NOW(),
      expires_at = NOW() + (${CACHE_TTL_DAYS} || ' days')::interval
  `.catch(() => {})
}

/**
 * Returns AI-rewritten { overview, bullets } for this ASIN.
 * - Cache hit: returns cached.
 * - Cache miss: calls Claude, validates output, caches.
 * - Validation failure or no key: returns null (caller falls back to rule-based bullets).
 */
export async function getOrGenerateAiDescription(input: {
  asin: string
  title: string
  niche?: string | null
  amazonFeatures?: string[]
  amazonDescription?: string
  specs?: Array<[string, string]>
}): Promise<AiDescription | null> {
  if (!input.asin || !input.title) return null

  const cached = await getCachedAiDescription(input.asin)
  if (cached) return cached

  const prompt = buildUserPrompt({
    title: input.title,
    niche: input.niche,
    amazonFeatures: input.amazonFeatures,
    amazonDescription: input.amazonDescription,
    specs: input.specs,
  })

  let raw: string | null = null
  try {
    raw = await callClaude(prompt)
  } catch { return null }
  if (!raw) return null

  let parsed: { overview?: unknown; bullets?: unknown }
  try {
    parsed = JSON.parse(extractJsonObject(raw))
  } catch {
    return null
  }

  const overview = sanitizeOverview(String(parsed.overview || ''))
  const bulletsRaw = Array.isArray(parsed.bullets) ? parsed.bullets : []
  const bullets = bulletsRaw
    .map((b) => sanitizeBullet(String(b || '')))
    .filter((b) => b.length > 15 && /^[A-Z][A-Z0-9 &/'().-]{2,30}:/i.test(b))
    .slice(0, MAX_BULLETS)

  // Validation: must have overview + at least MIN_BULLETS valid bullets
  if (overview.length < 30 || bullets.length < MIN_BULLETS) return null

  await setCachedAiDescription(input.asin, {
    overview,
    bullets,
    sourceTitle: input.title,
    niche: input.niche,
    model: String(process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5').trim(),
  }).catch(() => {})

  return { overview, bullets }
}

export async function getAiDescriptionCacheStats() {
  await ensureEbayDescriptionCacheTable()
  const rows = await queryRows<{ total: string | number; active: string | number; avg_bullets: string | number }>`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE expires_at > NOW())::int AS active,
      ROUND(AVG(jsonb_array_length(bullets)), 1) AS avg_bullets
    FROM ebay_description_cache
  `.catch(() => [])
  return rows[0] || { total: 0, active: 0, avg_bullets: 0 }
}
