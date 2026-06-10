// Claude-powered eBay title optimizer.
//
// Amazon titles are descriptor-heavy and brand-first (Amazon's algorithm prefers that).
// eBay's Cassini algorithm and buyer search behavior are different: buyers search by
// product type + key features ("pool pipe holder", not "SHAPON pool"). Obscure Amazon
// brand prefixes (SHAPON, SLOOSH, XY-WQ) eat into the 80-char title budget without
// helping SEO.
//
// This module asks Claude (Haiku) to rewrite a product title into an eBay-optimized
// version under 80 chars, demoting obscure brands and promoting search-friendly
// keywords. Results are cached per-ASIN so we pay ~$0.0002 once per product.

import { queryRows, sql } from '@/lib/db'
import { isGenericFallbackListingTitle } from '@/lib/listing-quality'

const CACHE_TTL_DAYS = 30
const TITLE_PROMPT_VERSION = 'competitor-v2'
const FORBIDDEN_PATTERNS = [
  /amazon[''']?s?\s+choice/i,
  /best\s+seller/i,
  /overall\s+pick/i,
  /sponsored/i,
  /climate\s+pledge/i,
  /limited\s+time\s+deal/i,
  /deal\s+of\s+the\s+day/i,
]

const SYSTEM_PROMPT = `You optimize Amazon product titles into eBay search-friendly listing titles.

Rules:
1. Output ONLY the optimized title text. No quotes, no explanation, no leading/trailing whitespace.
2. Maximum 80 characters. Aim for 70-79 chars to maximize keyword density.
3. Lead with the product TYPE and key features (e.g. "Pool Pipe Holder Above Ground"). Buyers search by product type, not brand.
4. If the brand is well-known to consumers (Nike, Sony, Apple, KitchenAid, etc.), keep it. If it looks obscure or like a model number (4-8 random uppercase letters, e.g. SHAPON, XY-WQ, HAPIKAY), DROP it.
5. Include 2-4 high-value search keywords buyers actually type.
6. Use Title Case consistently.
7. Never include: Amazon's Choice, Best Seller, Sponsored, Overall Pick, Climate Pledge, Limited Time Deal, Deal of the Day, or any Amazon badges.
8. Never include the words "Amazon" or "amazon.com".
9. Keep numeric quantities (2-Pack, 12 Pcs) when meaningful.
10. Use competitor title signals when provided, but do not copy a competitor title exactly.
11. Prioritize exact buyer-search nouns, quantity/count, size, compatibility, material, gender/use case, and "Travel" or "Portable" only when accurate.
12. End on a complete word/phrase. Never mid-sentence cut-offs.`

function buildUserPrompt(input: {
  amazonTitle: string
  niche?: string | null
  specs?: Array<[string, string]>
  competitorTitles?: string[]
  competitorKeywords?: string[]
}) {
  const lines: string[] = []
  lines.push(`Amazon title: ${input.amazonTitle}`)
  if (input.niche) lines.push(`Category: ${input.niche}`)
  if (input.specs && input.specs.length > 0) {
    const top = input.specs.slice(0, 6).map(([k, v]) => `${k}: ${v}`)
    lines.push(`Key specs: ${top.join('; ')}`)
  }
  if (input.competitorKeywords && input.competitorKeywords.length > 0) {
    lines.push(`High-performing eBay keywords to consider: ${input.competitorKeywords.slice(0, 12).join(', ')}`)
  }
  if (input.competitorTitles && input.competitorTitles.length > 0) {
    lines.push('Comparable eBay titles:')
    for (const competitorTitle of input.competitorTitles.slice(0, 5)) {
      lines.push(`- ${competitorTitle}`)
    }
  }
  lines.push('')
  lines.push('Return ONLY the optimized eBay title (≤80 chars).')
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
      max_tokens: 120,  // 80 chars ≈ ~25 tokens; 120 gives slack for early-stop
      temperature: 0.2, // low so titles are deterministic & consistent
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    recordApiCall({ provider: 'anthropic', callName: 'title-rewrite', success: false, durationMs: Date.now() - startedAt, errorCode: `HTTP_${res.status}`, errorMessage: (await res.text().catch(() => '')).slice(0, 200) }).catch(() => {})
    return null
  }
  const data = await res.json() as { content?: Array<{ text?: string }> }
  const text = Array.isArray(data.content)
    ? data.content.map((part) => part?.text || '').join('').trim()
    : ''
  recordApiCall({ provider: 'anthropic', callName: 'title-rewrite', success: true, durationMs: Date.now() - startedAt }).catch(() => {})
  return text || null
}

function extractOpenAiText(data: {
  output_text?: string
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>
}) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim()
  }
  return (data.output || [])
    .flatMap((item) => item.content || [])
    .map((part) => part.text || '')
    .join('')
    .trim()
}

async function callOpenAi(userPrompt: string) {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim()
  if (!apiKey) return null
  const model = String(process.env.OPENAI_TITLE_MODEL || 'gpt-5-nano').trim()

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      instructions: SYSTEM_PROMPT,
      input: userPrompt,
      max_output_tokens: 120,
      store: false,
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) return null

  const data = await res.json() as {
    output_text?: string
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>
  }
  return extractOpenAiText(data) || null
}

function sanitizeAiTitle(raw: string): string {
  if (!raw) return ''
  let title = raw
    .replace(/^["'`]+|["'`]+$/g, '') // strip wrapping quotes
    .replace(/^title:\s*/i, '')      // strip "Title: " prefix if Claude added it
    .replace(/[<>"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // Remove any forbidden Amazon-badge fragments
  for (const pattern of FORBIDDEN_PATTERNS) {
    title = title.replace(pattern, '')
  }
  title = title.replace(/\b(amazon\.?com?|amazon)\b/gi, '').replace(/\s{2,}/g, ' ').trim()
  // Hard truncate to 80 chars, ending on a word
  if (title.length > 80) {
    title = title.slice(0, 80).replace(/\s+\S*$/, '').trim()
  }
  return title
}

export async function ensureEbayTitleCacheTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS ebay_title_cache (
      asin TEXT PRIMARY KEY,
      ai_title TEXT NOT NULL,
      source_title TEXT,
      niche TEXT,
      model TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
    )
  `.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS ebay_title_cache_expires_idx ON ebay_title_cache (expires_at)`.catch(() => {})
}

export async function getCachedAiTitle(asin: string): Promise<string | null> {
  if (!asin) return null
  await ensureEbayTitleCacheTable()
  const key = String(asin).toUpperCase().slice(0, 12)
  const rows = await queryRows<{ ai_title: string }>`
    SELECT ai_title FROM ebay_title_cache
    WHERE asin = ${key}
      AND expires_at > NOW()
      AND model LIKE ${`%:${TITLE_PROMPT_VERSION}`}
    LIMIT 1
  `.catch(() => [])
  const title = rows[0]?.ai_title || null
  if (title && isGenericFallbackListingTitle(title)) return null
  return title
}

async function setCachedAiTitle(asin: string, data: { aiTitle: string; sourceTitle: string; niche?: string | null; model: string }) {
  if (!asin || !data.aiTitle) return
  await ensureEbayTitleCacheTable()
  const key = String(asin).toUpperCase().slice(0, 12)
  await sql`
    INSERT INTO ebay_title_cache (asin, ai_title, source_title, niche, model, expires_at)
    VALUES (
      ${key},
      ${data.aiTitle.slice(0, 200)},
      ${data.sourceTitle.slice(0, 500)},
      ${data.niche || null},
      ${data.model},
      NOW() + (${CACHE_TTL_DAYS} || ' days')::interval
    )
    ON CONFLICT (asin) DO UPDATE SET
      ai_title = EXCLUDED.ai_title,
      source_title = EXCLUDED.source_title,
      niche = EXCLUDED.niche,
      model = EXCLUDED.model,
      updated_at = NOW(),
      expires_at = NOW() + (${CACHE_TTL_DAYS} || ' days')::interval
  `.catch(() => {})
}

/**
 * Returns an AI-optimized eBay title for this ASIN.
 * - Returns cached entry if present and unexpired.
 * - Otherwise calls Claude, validates the output, caches it, and returns it.
 * - Returns null if Claude is unavailable or output fails validation —
 *   callers MUST fall back to their own title-building logic.
 */
export async function getOrGenerateAiTitle(input: {
  asin: string
  amazonTitle: string
  niche?: string | null
  specs?: Array<[string, string]>
  competitorTitles?: string[]
  competitorKeywords?: string[]
}): Promise<string | null> {
  if (!input.asin || !input.amazonTitle) return null

  const cached = await getCachedAiTitle(input.asin)
  if (cached) return cached

  const prompt = buildUserPrompt({
    amazonTitle: input.amazonTitle,
    niche: input.niche,
    specs: input.specs,
    competitorTitles: input.competitorTitles,
    competitorKeywords: input.competitorKeywords,
  })

  let raw: string | null = null
  let providerModel = ''
  try {
    raw = await callClaude(prompt)
    if (raw) providerModel = String(process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5').trim()
    if (!raw) {
      raw = await callOpenAi(prompt)
      if (raw) providerModel = `openai:${String(process.env.OPENAI_TITLE_MODEL || 'gpt-5-nano').trim()}`
    }
  } catch { return null }
  if (!raw) return null

  const cleaned = sanitizeAiTitle(raw)
  // Validation: must be 20-80 chars and contain at least 3 words. Anything weird → reject.
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length
  if (cleaned.length < 20 || cleaned.length > 80 || wordCount < 3 || isGenericFallbackListingTitle(cleaned)) return null

  await setCachedAiTitle(input.asin, {
    aiTitle: cleaned,
    sourceTitle: input.amazonTitle,
    niche: input.niche,
    model: `${providerModel || 'unknown'}:${TITLE_PROMPT_VERSION}`,
  }).catch(() => {})

  return cleaned
}

/** Diagnostic stats for admin. */
export async function getAiTitleCacheStats() {
  await ensureEbayTitleCacheTable()
  const rows = await queryRows<{ total: string | number; active: string | number; avg_len: string | number }>`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE expires_at > NOW())::int AS active,
      ROUND(AVG(LENGTH(ai_title)), 1) AS avg_len
    FROM ebay_title_cache
  `.catch(() => [])
  return rows[0] || { total: 0, active: 0, avg_len: 0 }
}
