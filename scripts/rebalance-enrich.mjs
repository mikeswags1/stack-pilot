// Rebalance enrichment: target ONLY niches under 30 enriched products.
// Sends enrich-pool requests per-niche so each niche gets attention,
// instead of letting the global queue cluster on top-scoring niches.
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)
const cronSecret = env.CRON_SECRET
const url = 'https://stackpilot-app.vercel.app/api/admin/enrich-pool'

// Load HOT niches from the audit
const audit = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'scripts', 'niche-audit-results.json'), 'utf-8')
)
const hotNiches = audit.hot.map((n) => n.niche)

// Find HOT niches currently below 30 enriched
const underTarget = await sql(`
  SELECT psi.source_niche AS niche,
    COUNT(*) FILTER (
      WHERE apc.asin IS NOT NULL
        AND jsonb_array_length(apc.images) >= 2
        AND psi.profit >= 4 AND psi.roi >= 25
        AND psi.risk <> 'HIGH'
        AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
        AND COALESCE(apc.available, TRUE) <> FALSE
        AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
    )::int AS enriched_count,
    COUNT(*) FILTER (
      WHERE apc.asin IS NULL
        AND psi.profit >= 4 AND psi.roi >= 25
        AND psi.risk <> 'HIGH'
        AND psi.image_url IS NOT NULL AND psi.image_url <> ''
        AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
    )::int AS unenriched_candidates
  FROM product_source_items psi
  LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
  WHERE psi.active = TRUE
    AND psi.source_niche = ANY($1::text[])
  GROUP BY 1
  HAVING COUNT(*) FILTER (
    WHERE apc.asin IS NOT NULL
      AND jsonb_array_length(apc.images) >= 2
      AND psi.profit >= 4 AND psi.roi >= 25
      AND psi.risk <> 'HIGH'
      AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
      AND COALESCE(apc.available, TRUE) <> FALSE
      AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
  ) < 30
  ORDER BY enriched_count ASC
`, [hotNiches])

console.log(`HOT niches below 30 enriched: ${underTarget.length}\n`)
console.log('Niche'.padEnd(30) + 'Current  Need   Pool to try')
for (const r of underTarget) {
  console.log(`${r.niche.padEnd(30)}${String(r.enriched_count).padStart(7)}  ${String(30 - r.enriched_count).padStart(4)}   ${r.unenriched_candidates}`)
}

// For each under-30 niche, send enrich requests until we have 30 enriched (or run out of candidates)
const startedAt = Date.now()
let totalCalls = 0, totalWarmed = 0

for (const niche of underTarget) {
  const deficit = 30 - niche.enriched_count
  // We need to enrich ~deficit products. At 94% success, request deficit * 1.1 to cover failures.
  // Cap at 80 per call (sane batch size for ~75s call).
  const target = Math.min(80, Math.ceil(deficit * 1.15))
  if (target <= 0) continue
  if (niche.unenriched_candidates === 0) {
    console.log(`\n${niche.niche.padEnd(30)} SKIP — no unenriched candidates`)
    continue
  }
  process.stdout.write(`\n${niche.niche.padEnd(30)} requesting ${target}: `)
  const t0 = Date.now()
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cronSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: target, niches: [niche.niche] }),
      signal: AbortSignal.timeout(295_000),
    })
  } catch (e) {
    console.log(`ERROR ${e.message}`)
    continue
  }
  const data = await res.json().catch(() => null)
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  if (!data?.ok) {
    console.log(`HTTP ${res.status}`)
    continue
  }
  totalCalls += target
  totalWarmed += data.warmed
  console.log(`warmed=${data.warmed} enriched_w_imgs=${data.enrichedWithImages} failed=${data.failed} (${elapsed}s)`)
  await new Promise((r) => setTimeout(r, 500))
}

console.log(`\n═══════════════════════════════════════════════════`)
console.log(`Rebalance complete.`)
console.log(`Niches addressed: ${underTarget.length}`)
console.log(`Total RapidAPI calls used: ${totalCalls}`)
console.log(`Total warmed: ${totalWarmed}`)
console.log(`Elapsed: ${((Date.now() - startedAt) / 60 / 1000).toFixed(1)} min`)
