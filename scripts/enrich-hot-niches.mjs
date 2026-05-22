// Mass-enrich HOT niches via the admin endpoint. Reads the niche audit results
// (scripts/niche-audit-results.json) and only enriches products in score-65+ niches.
// Runs in repeated batches until the queue is empty or RapidAPI quota is reached.

import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)

const audit = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'scripts', 'niche-audit-results.json'), 'utf-8')
)
const hotNiches = audit.hot.map((n) => n.niche)
console.log(`Hot niches loaded: ${hotNiches.length}`)
console.log(`Target products: ~${audit.hot.reduce((sum, n) => sum + n.pool_count, 0)}`)

const url = 'https://stackpilot-app.vercel.app/api/admin/enrich-pool'
const cronSecret = env.CRON_SECRET

const batchLimit = Number(process.argv[2] || 80)
const maxBatches = Number(process.argv[3] || 100)

let totalWarmed = 0, totalFailed = 0, totalEnrichedImages = 0, batchesRun = 0
const startedAt = Date.now()

for (let i = 0; i < maxBatches; i++) {
  process.stdout.write(`  Batch ${i + 1}/${maxBatches}: `)
  const t0 = Date.now()
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cronSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: batchLimit, niches: hotNiches }),
      signal: AbortSignal.timeout(295_000),
    })
  } catch (e) {
    console.log(`ERROR ${e.message}`)
    break
  }
  const data = await res.json().catch(() => null)
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

  if (!data?.ok) {
    console.log(`HTTP ${res.status} — ${JSON.stringify(data).slice(0, 200)}`)
    break
  }

  totalWarmed += data.warmed
  totalFailed += data.failed
  totalEnrichedImages += data.enrichedWithImages || 0
  batchesRun++

  console.log(`warmed=${data.warmed} enriched_w_imgs=${data.enrichedWithImages || 0} failed=${data.failed} (${elapsed}s)`)

  // Stop if a whole batch returned nothing — queue is empty
  if (data.warmed === 0 && data.failed === 0) {
    console.log('\nQueue empty.')
    break
  }
  // Stop if the batch returned fewer than half the limit — running out of products
  if (data.warmed + data.failed < batchLimit * 0.5) {
    console.log('\nLow batch yield — queue nearly empty.')
    break
  }

  // Tiny gap so we don't hammer
  await new Promise((r) => setTimeout(r, 1000))
}

const totalElapsed = ((Date.now() - startedAt) / 1000 / 60).toFixed(1)
console.log(`\n═══════════════════════════════════════════════════════`)
console.log(`Total batches: ${batchesRun}`)
console.log(`Total warmed: ${totalWarmed}`)
console.log(`  with >=2 real images: ${totalEnrichedImages}`)
console.log(`Total failed: ${totalFailed}`)
console.log(`Success rate: ${(totalWarmed / (totalWarmed + totalFailed) * 100).toFixed(1)}%`)
console.log(`Image-enrichment rate: ${(totalEnrichedImages / (totalWarmed + totalFailed) * 100).toFixed(1)}%`)
console.log(`Elapsed: ${totalElapsed} minutes`)
