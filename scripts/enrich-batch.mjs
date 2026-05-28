// Mass-enrich Amazon product cache via the new admin endpoint.
// Each call enriches up to 80 products (~3 min). Run repeatedly until pool is enriched.
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)

const cronSecret = env.CRON_SECRET
const url = 'https://stackpilot-app.vercel.app/api/admin/enrich-pool'
const limit = Number(process.argv[2] || 80)

console.log(`POST ${url} { limit: ${limit} }`)
const startedAt = Date.now()
const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${cronSecret}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ limit }),
  signal: AbortSignal.timeout(295_000),
})
const text = await res.text()
console.log(`Status: ${res.status}, elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2))
} catch {
  console.log(text.slice(0, 500))
}
