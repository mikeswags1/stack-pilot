// Trigger the score-backfill endpoint on production
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)

const cronSecret = env.CRON_SECRET
if (!cronSecret) { console.error('CRON_SECRET not in .env.local'); process.exit(1) }

const url = 'https://stackpilot-app.vercel.app/api/admin/backfill-scores'
const body = { limit: 10000, onlyUnscored: true }

console.log(`POST ${url}\nbody: ${JSON.stringify(body)}\n`)
const startedAt = Date.now()

const res = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${cronSecret}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(295_000),
})

const text = await res.text()
console.log(`Status: ${res.status}`)
console.log(`Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
try {
  console.log('Response:', JSON.stringify(JSON.parse(text), null, 2))
} catch {
  console.log('Response (raw):', text.slice(0, 1000))
}
