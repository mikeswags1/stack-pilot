import { queryRows, sql } from '@/lib/db'
import { ensureProductSourceTables } from '@/lib/product-source-engine'
import {
  ensureSourceIntelligenceTables,
  getSourceEngineIntelligenceSummary,
  getWeakSourceNiches,
  refreshSourceIntelligenceState,
} from '@/lib/source-intelligence'
import {
  loadCustomSourceNicheRows,
  upsertCustomSourceNiche,
} from '@/lib/source-niches'

type AgentNiche = {
  name: string
  queries: string[]
  reason?: string
}

type AgentPlan = {
  newNiches?: AgentNiche[]
  repairNiches?: string[]
  notes?: string[]
}

type AgentRunInput = {
  origin: string
  cronSecret?: string
  trigger?: string
  dryRun?: boolean
}

const BLOCKED_NICHE_TERMS = [
  'supplement', 'vitamin', 'medicine', 'medical', 'prescription', 'apparel',
  'shoe', 'cosmetic', 'makeup', 'perfume', 'designer', 'louis vuitton',
  'gucci', 'chanel', 'rolex', 'lego', 'weapon', 'knife', 'gun',
]
const BLOCKED_SOURCE_REGEX = '(supplement|vitamin|medicine|medical|prescription|cosmetic|makeup|perfume|designer|louis vuitton|gucci|chanel|rolex|lego|weapon|gun)'

function toNumber(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeText(value: unknown, max = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function unique(values: string[], limit: number) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const clean = normalizeText(value, 90)
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) continue
    seen.add(key)
    out.push(clean)
    if (out.length >= limit) break
  }
  return out
}

function isAllowedNiche(name: string, queries: string[]) {
  const text = `${name} ${queries.join(' ')}`.toLowerCase()
  return !BLOCKED_NICHE_TERMS.some((term) => text.includes(term))
}

function defaultRepairQueries(niche: string) {
  return unique([
    `${niche} accessories`,
    `${niche} under 50`,
    `trending ${niche}`,
    `${niche} best seller`,
    `${niche} replacement parts`,
    `${niche} organizer`,
    `${niche} gift`,
    `${niche} essentials`,
  ], 12)
}

function extractJsonObject(text: string) {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  const match = trimmed.match(/\{[\s\S]*\}/)
  return match ? match[0] : '{}'
}

function sanitizePlan(input: unknown): AgentPlan {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const newNiches = Array.isArray(raw.newNiches)
    ? raw.newNiches
        .map((entry) => {
          const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
          const name = normalizeText(item.name, 70)
          const queries = unique(Array.isArray(item.queries) ? item.queries.map(String) : [], 18)
          return { name, queries, reason: normalizeText(item.reason, 240) }
        })
        .filter((item) => item.name && item.queries.length >= 4 && isAllowedNiche(item.name, item.queries))
        .slice(0, 3)
    : []
  const repairNiches = Array.isArray(raw.repairNiches)
    ? unique(raw.repairNiches.map(String), 8).filter((niche) => isAllowedNiche(niche, [])).slice(0, 5)
    : []
  const notes = Array.isArray(raw.notes)
    ? raw.notes.map((note) => normalizeText(note, 240)).filter(Boolean).slice(0, 8)
    : []
  return { newNiches, repairNiches, notes }
}

async function callAnthropic(system: string, prompt: string) {
  const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim()
  if (!apiKey) return null
  const model = String(process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest').trim()
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      temperature: 0.25,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`Anthropic request failed (${res.status})`)
  const data = await res.json()
  const text = Array.isArray(data?.content)
    ? data.content.map((part: { text?: string }) => part?.text || '').join('\n')
    : ''
  return text || null
}

async function callOpenRouter(system: string, prompt: string) {
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim()
  if (!apiKey) return null
  const model = String(process.env.SOURCE_AGENT_OPENROUTER_MODEL || process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-haiku').trim()
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.25,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`OpenRouter request failed (${res.status})`)
  const data = await res.json()
  return data?.choices?.[0]?.message?.content || null
}

async function getAgentContext() {
  await ensureSourceIntelligenceTables()
  const [summary, weakNiches, customNiches, topSold, sourceLeaders, weakProducts] = await Promise.all([
    getSourceEngineIntelligenceSummary().catch(() => null),
    getWeakSourceNiches(8).catch(() => []),
    loadCustomSourceNicheRows().catch(() => []),
    queryRows`
      SELECT COALESCE(NULLIF(niche, ''), 'Unassigned') AS niche,
             COUNT(*)::int AS sold,
             ROUND(AVG(profit), 2) AS avg_profit,
             ROUND(AVG(roi), 2) AS avg_roi
      FROM listed_asins
      WHERE listed_at > NOW() - INTERVAL '30 days'
      GROUP BY COALESCE(NULLIF(niche, ''), 'Unassigned')
      ORDER BY sold DESC, avg_profit DESC
      LIMIT 12
    `.catch(() => []),
    queryRows`
      SELECT COALESCE(NULLIF(source_niche, ''), 'Unassigned') AS niche,
             COUNT(*)::int AS active,
             ROUND(AVG(profit), 2) AS avg_profit,
             ROUND(AVG(roi), 2) AS avg_roi,
             ROUND(AVG(total_score), 2) AS avg_score
      FROM product_source_items
      WHERE active = TRUE
      GROUP BY COALESCE(NULLIF(source_niche, ''), 'Unassigned')
      ORDER BY avg_score DESC, active DESC
      LIMIT 18
    `.catch(() => []),
    queryRows`
      SELECT COALESCE(NULLIF(source_niche, ''), 'Unassigned') AS niche,
             COUNT(*)::int AS bad_rows
      FROM product_source_items psi
      LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
      WHERE psi.active = TRUE
        AND (
          psi.risk = 'HIGH'
          OR psi.profit < 3
          OR psi.roi < 25
          OR psi.image_url IS NULL
          OR psi.image_url = ''
          OR psi.last_seen_at < NOW() - INTERVAL '60 days'
          OR apc.available = FALSE
        )
      GROUP BY COALESCE(NULLIF(source_niche, ''), 'Unassigned')
      ORDER BY bad_rows DESC
      LIMIT 12
    `.catch(() => []),
  ])
  return { summary, weakNiches, customNiches, topSold, sourceLeaders, weakProducts }
}

async function buildAgentPlan() {
  const context = await getAgentContext()
  const system = [
    'You are StackPilot Source Agent.',
    'Your job is product sourcing only: find promising eBay resale niches, improve search queries, and recommend source-pool cleanup.',
    'You are not allowed to list products, publish to eBay, change user billing, or bypass product safety gates.',
    'Prefer lightweight, low-return-risk, non-branded, non-medical products under $60 with strong resale margin.',
    'Avoid supplements, medical products, cosmetics, apparel sizing, designer brands, weapons, fragile/bulky items, and counterfeit-risk items.',
    'Return JSON only with keys: newNiches, repairNiches, notes.',
  ].join(' ')
  const prompt = JSON.stringify({
    goal: 'Create or refine source niches from what is selling and what has good source signals. Choose repair niches that need fresh product stock.',
    context,
    outputShape: {
      newNiches: [{ name: 'Short niche name', queries: ['6-18 Amazon search phrases'], reason: 'why this niche is promising' }],
      repairNiches: ['existing niche names to refresh'],
      notes: ['short sourcing observations'],
    },
  })

  const provider = String(process.env.ANTHROPIC_API_KEY || '').trim()
    ? 'anthropic'
    : String(process.env.OPENROUTER_API_KEY || '').trim()
      ? 'openrouter'
      : 'deterministic'

  let plan: AgentPlan = {
    newNiches: [],
    repairNiches: context.weakNiches.filter((niche) => isAllowedNiche(niche, [])).slice(0, 3),
    notes: ['No AI provider configured; ran deterministic source cleanup and weak-niche repair selection.'],
  }
  if (provider !== 'deterministic') {
    const text = provider === 'anthropic'
      ? await callAnthropic(system, prompt)
      : await callOpenRouter(system, prompt)
    const parsed = JSON.parse(extractJsonObject(text || '{}'))
    plan = sanitizePlan(parsed)
    if (!plan.repairNiches?.length) plan.repairNiches = context.weakNiches.filter((niche) => isAllowedNiche(niche, [])).slice(0, 3)
  }

  return { provider, plan, context }
}

async function cleanupWeakSourceRows() {
  await ensureProductSourceTables()
  const rows = await queryRows<{ asin: string }>`
    WITH bad AS (
      SELECT psi.asin
      FROM product_source_items psi
      LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
      WHERE psi.active = TRUE
        AND (
          psi.risk = 'HIGH'
          OR psi.profit < 3
          OR psi.roi < 25
          OR psi.image_url IS NULL
          OR psi.image_url = ''
          OR psi.last_seen_at < NOW() - INTERVAL '60 days'
          OR apc.available = FALSE
          OR LOWER(COALESCE(psi.source_niche, '') || ' ' || psi.title) ~ ${BLOCKED_SOURCE_REGEX}
        )
      ORDER BY psi.last_seen_at ASC
      LIMIT 500
    )
    UPDATE product_source_items psi
    SET active = FALSE,
        source_quality = 'reject',
        last_intelligence_at = NOW()
    FROM bad
    WHERE psi.asin = bad.asin
    RETURNING psi.asin
  `.catch(() => [])
  return rows.length
}

async function recordAgentRun(input: {
  provider: string
  status: 'success' | 'failed'
  plan: AgentPlan
  metrics: Record<string, unknown>
  error?: string
  startedAt: number
}) {
  await ensureSourceIntelligenceTables()
  await sql`
    CREATE TABLE IF NOT EXISTS source_agent_runs (
      id BIGSERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      plan JSONB NOT NULL DEFAULT '{}'::jsonb,
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      error TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS source_agent_runs_created_idx ON source_agent_runs (created_at DESC)`.catch(() => {})
  await sql`
    INSERT INTO source_agent_runs (provider, status, plan, metrics, error, duration_ms)
    VALUES (
      ${input.provider},
      ${input.status},
      ${JSON.stringify(input.plan)}::jsonb,
      ${JSON.stringify(input.metrics)}::jsonb,
      ${input.error || null},
      ${Math.max(0, Math.round(Date.now() - input.startedAt))}
    )
  `.catch(() => {})
}

export async function getRecentSourceAgentRuns(limit = 8) {
  await ensureSourceIntelligenceTables()
  await sql`
    CREATE TABLE IF NOT EXISTS source_agent_runs (
      id BIGSERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      plan JSONB NOT NULL DEFAULT '{}'::jsonb,
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      error TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => {})
  return queryRows<{
    id: string | number
    provider: string
    status: string
    plan: unknown
    metrics: unknown
    error: string | null
    duration_ms: string | number
    created_at: string | null
  }>`
    SELECT id, provider, status, plan, metrics, error, duration_ms, created_at
    FROM source_agent_runs
    ORDER BY created_at DESC
    LIMIT ${Math.max(1, Math.min(20, limit))}
  `.catch(() => [])
}

export async function runSourceAgent(input: AgentRunInput) {
  const startedAt = Date.now()
  let provider = 'deterministic'
  let plan: AgentPlan = {}
  try {
    const built = await buildAgentPlan()
    provider = built.provider
    plan = built.plan
    const createdNiches: string[] = []

    if (!input.dryRun) {
      for (const niche of plan.newNiches || []) {
        const saved = await upsertCustomSourceNiche({
          name: niche.name,
          queries: niche.queries,
          active: true,
          notes: `Source Agent: ${niche.reason || 'AI-selected sourcing niche.'}`,
        }).catch(() => null)
        if (saved) createdNiches.push(niche.name)
      }
    }

    const cleanedProducts = input.dryRun ? 0 : await cleanupWeakSourceRows()
    const repairNiches = unique([...(plan.repairNiches || []), ...createdNiches], 5)
    if (!input.dryRun) {
      for (const niche of repairNiches) {
        if (!isAllowedNiche(niche, [])) continue
        await upsertCustomSourceNiche({
          name: niche,
          queries: defaultRepairQueries(niche),
          active: true,
          notes: 'Source Agent repair target: keeps this product pool refreshable by cron.',
        }).catch(() => null)
      }
    }
    const refreshUrl = repairNiches.length > 0
      ? `${input.origin}/api/cron/refresh-products?stockWeak=1&wait=1&batch=${repairNiches.length}&niche=${encodeURIComponent(repairNiches.join(','))}&source=source-agent`
      : `${input.origin}/api/cron/refresh-products?sourceOnly=1&source=source-agent`

    await refreshSourceIntelligenceState({ applyScores: true }).catch(() => [])
    const metrics = { createdNiches, repairNiches, cleanedProducts, refreshScheduled: !input.dryRun, refreshUrl }
    await recordAgentRun({ provider, status: 'success', plan, metrics, startedAt })
    return { ok: true, provider, plan, metrics, refreshUrl }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Source agent failed.'
    await recordAgentRun({ provider, status: 'failed', plan, metrics: {}, error: message, startedAt })
    return { ok: false, provider, plan, error: message }
  }
}
