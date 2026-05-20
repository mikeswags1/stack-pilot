import { queryRows, sql } from '@/lib/db'

type DigestContext = {
  totalActiveListings: number
  totalListings24h: number
  totalSourceProducts: number
  weakNicheCount: number
  avgNicheHealth: number
  topNiches: Array<{ niche: string; health: number; ready: number }>
  failedQueueJobs24h: number
  completedQueueJobs24h: number
  agentRunsToday: number
}

async function buildDigestContext(): Promise<DigestContext> {
  const [listingRows, sourceRows, nicheRows, queueRows, agentRows] = await Promise.all([
    queryRows<{ total_active: string | number; listed_24h: string | number }>`
      SELECT
        COUNT(*) FILTER (WHERE ended_at IS NULL)::int AS total_active,
        COUNT(*) FILTER (WHERE listed_at > NOW() - INTERVAL '24 hours')::int AS listed_24h
      FROM listed_asins
    `.catch(() => []),
    queryRows<{ active_products: string | number }>`
      SELECT COUNT(*)::int AS active_products
      FROM product_source_items
      WHERE active = TRUE
    `.catch(() => []),
    queryRows<{
      niche: string
      health_score: string | number
      ready_products: string | number
      weak_count: string | number
      avg_health: string | number | null
    }>`
      SELECT
        niche,
        health_score,
        ready_products,
        COUNT(*) FILTER (WHERE health_score < 65 OR ready_products < 30) OVER () AS weak_count,
        AVG(health_score) OVER () AS avg_health
      FROM source_niche_intelligence
      ORDER BY health_score DESC
      LIMIT 5
    `.catch(() => []),
    queryRows<{ completed: string | number; failed: string | number }>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'completed' AND listed_at > NOW() - INTERVAL '24 hours')::int AS completed,
        COUNT(*) FILTER (WHERE status = 'failed' AND updated_at > NOW() - INTERVAL '24 hours')::int AS failed
      FROM auto_listing_queue
    `.catch(() => []),
    queryRows<{ runs: string | number }>`
      SELECT COUNT(*)::int AS runs
      FROM source_agent_runs
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `.catch(() => []),
  ])

  const topNiches = nicheRows.map((row) => ({
    niche: row.niche,
    health: Number(row.health_score || 0),
    ready: Number(row.ready_products || 0),
  }))

  return {
    totalActiveListings: Number(listingRows[0]?.total_active || 0),
    totalListings24h: Number(listingRows[0]?.listed_24h || 0),
    totalSourceProducts: Number(sourceRows[0]?.active_products || 0),
    weakNicheCount: Number(nicheRows[0]?.weak_count || 0),
    avgNicheHealth: Number(nicheRows[0]?.avg_health || 0),
    topNiches,
    failedQueueJobs24h: Number(queueRows[0]?.failed || 0),
    completedQueueJobs24h: Number(queueRows[0]?.completed || 0),
    agentRunsToday: Number(agentRows[0]?.runs || 0),
  }
}

async function callAnthropic(prompt: string): Promise<string | null> {
  const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim()
  if (!apiKey) return null
  const model = String(process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest').trim()
  const system = [
    'You are StackPilot Digest Agent.',
    'Generate brief, actionable daily insights for an eBay dropshipping operation.',
    'Focus on what is working, what needs attention, and one concrete action to take today.',
    'Keep output under 200 words. Use plain text, no markdown.',
  ].join(' ')
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      temperature: 0.3,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) return null
  const data = await res.json()
  return Array.isArray(data?.content)
    ? data.content.map((p: { text?: string }) => p?.text || '').join('\n').trim() || null
    : null
}

async function callOpenRouter(prompt: string): Promise<string | null> {
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim()
  if (!apiKey) return null
  const model = String(process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini').trim()
  const system = [
    'You are StackPilot Digest Agent.',
    'Generate brief, actionable daily insights for an eBay dropshipping operation.',
    'Focus on what is working, what needs attention, and one concrete action to take today.',
    'Keep output under 200 words. Use plain text, no markdown.',
  ].join(' ')
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) return null
  const data = await res.json()
  return data?.choices?.[0]?.message?.content || null
}

async function generateInsights(context: DigestContext): Promise<string> {
  const listingRate = context.completedQueueJobs24h
  const failRate = context.failedQueueJobs24h
  const successPct =
    listingRate + failRate > 0
      ? Math.round((listingRate / (listingRate + failRate)) * 100)
      : 100

  const prompt = JSON.stringify({
    goal: 'Generate a brief daily operations digest with key observations and one priority action.',
    data: {
      activeListings: context.totalActiveListings,
      newListings24h: context.totalListings24h,
      sourcePoolProducts: context.totalSourceProducts,
      weakNiches: context.weakNicheCount,
      avgNicheHealthScore: Math.round(context.avgNicheHealth),
      topHealthyNiches: context.topNiches.slice(0, 3).map((n) => n.niche),
      listingSuccessRate24h: `${successPct}%`,
      listingsCompletedToday: listingRate,
      listingsFailedToday: failRate,
      sourceAgentRunsToday: context.agentRunsToday,
    },
  })

  const anthropicKey = String(process.env.ANTHROPIC_API_KEY || '').trim()
  const insight = anthropicKey
    ? await callAnthropic(prompt)
    : await callOpenRouter(prompt)

  if (insight) return insight

  const lines: string[] = []
  lines.push(`Active listings: ${context.totalActiveListings}. New in 24h: ${context.totalListings24h}.`)
  if (failRate > listingRate * 0.2 && failRate > 2) {
    lines.push(`Warning: ${failRate} listing jobs failed today vs ${listingRate} completed. Review your eBay account settings.`)
  } else {
    lines.push(`Listing queue success rate: ${successPct}%.`)
  }
  if (context.weakNicheCount > 5) {
    lines.push(`${context.weakNicheCount} niches are low on ready-to-list products. The source agent will refresh them automatically.`)
  }
  if (context.totalSourceProducts < 100) {
    lines.push(`Source pool is thin (${context.totalSourceProducts} active products). Trigger a deep catalog crawl from the admin panel.`)
  }
  return lines.join(' ')
}

async function ensureDigestTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS performance_digests (
      id BIGSERIAL PRIMARY KEY,
      digest_date DATE NOT NULL DEFAULT CURRENT_DATE,
      context JSONB NOT NULL DEFAULT '{}'::jsonb,
      insights TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT 'deterministic',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (digest_date)
    )
  `.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS performance_digests_date_idx ON performance_digests (digest_date DESC)`.catch(() => {})
}

export async function runDigestAgent(options: { force?: boolean } = {}) {
  const startedAt = Date.now()
  await ensureDigestTable()

  if (!options.force) {
    const existingRows = await queryRows<{ id: string | number }>`
      SELECT id FROM performance_digests WHERE digest_date = CURRENT_DATE LIMIT 1
    `.catch(() => [])
    if (existingRows.length > 0) {
      return {
        ok: true,
        skipped: 'already_generated_today',
        durationMs: Date.now() - startedAt,
      }
    }
  }

  const context = await buildDigestContext()
  const insights = await generateInsights(context)

  const provider = String(process.env.ANTHROPIC_API_KEY || '').trim()
    ? 'anthropic'
    : String(process.env.OPENROUTER_API_KEY || '').trim()
      ? 'openrouter'
      : 'deterministic'

  await sql`
    INSERT INTO performance_digests (digest_date, context, insights, provider, duration_ms)
    VALUES (
      CURRENT_DATE,
      ${JSON.stringify(context)}::jsonb,
      ${insights},
      ${provider},
      ${Math.round(Date.now() - startedAt)}
    )
    ON CONFLICT (digest_date) DO UPDATE SET
      context = EXCLUDED.context,
      insights = EXCLUDED.insights,
      provider = EXCLUDED.provider,
      duration_ms = EXCLUDED.duration_ms,
      created_at = NOW()
  `.catch(() => {})

  return {
    ok: true,
    insights,
    provider,
    context,
    durationMs: Date.now() - startedAt,
  }
}

export async function getLatestDigests(limit = 7) {
  await ensureDigestTable()
  return queryRows<{
    id: string | number
    digest_date: string
    insights: string
    provider: string
    context: unknown
    created_at: string | null
  }>`
    SELECT id, digest_date, insights, provider, context, created_at
    FROM performance_digests
    ORDER BY digest_date DESC
    LIMIT ${Math.max(1, Math.min(30, limit))}
  `.catch(() => [])
}
