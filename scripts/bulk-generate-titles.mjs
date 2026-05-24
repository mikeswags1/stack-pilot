// Bulk-generate AI titles for all enriched products via admin endpoint.
// Runs in batches until the queue is empty.
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)

const url = 'https://stackpilot-app.vercel.app/api/admin/generate-ai-titles'
const cronSecret = env.CRON_SECRET
const batchLimit = 100
const maxBatches = 40

let totalGenerated = 0, totalFailed = 0, batchesRun = 0
const startedAt = Date.now()

console.log(`Starting bulk AI title generation. Batch size: ${batchLimit}, max batches: ${maxBatches}\n`)

for (let i = 0; i < maxBatches; i++) {
  process.stdout.write(`  Batch ${i + 1}/${maxBatches}: `)
  const t0 = Date.now()
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cronSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: batchLimit }),
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
  totalGenerated += data.generated
  totalFailed += data.failed
  batchesRun++
  console.log(`scanned=${data.scanned} generated=${data.generated} failed=${data.failed} (${elapsed}s)`)

  if (data.scanned === 0) {
    console.log('\nQueue empty — all eligible products have AI titles now.')
    break
  }
  // tiny gap to be polite to the API
  await new Promise((r) => setTimeout(r, 500))
}

const elapsedMin = ((Date.now() - startedAt) / 60 / 1000).toFixed(1)
console.log(`\n═══════════════════════════════════════════════`)
console.log(`Batches run: ${batchesRun}`)
console.log(`Titles generated: ${totalGenerated}`)
console.log(`Failed: ${totalFailed}`)
console.log(`Elapsed: ${elapsedMin} min`)
console.log(`Cost (est.): $${(totalGenerated * 0.0002).toFixed(2)}`)
