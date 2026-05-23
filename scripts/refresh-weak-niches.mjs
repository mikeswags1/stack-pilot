// Trigger refresh-products stockWeak repair for the 4 niches still under 30
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)

const niches = ['Kitchen Gadgets', 'Travel Accessories', 'Summer Outdoor Gear', 'Golf Accessories']
const cronSecret = env.CRON_SECRET

for (const niche of niches) {
  const url = `https://stackpilot-app.vercel.app/api/cron/refresh-products?stockWeak=1&wait=1&batch=1&niche=${encodeURIComponent(niche)}&auditLimit=30`
  console.log(`Triggering source repair for ${niche}...`)
  const t0 = Date.now()
  let res
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${cronSecret}` },
      signal: AbortSignal.timeout(290_000),
    })
  } catch (e) {
    console.log(`  ERROR: ${e.message}`)
    continue
  }
  const data = await res.json().catch(() => null)
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`  ${niche.padEnd(28)} ${res.status} (${elapsed}s) — ${JSON.stringify(data).slice(0, 200)}`)
}
