// Call eBay GetAPIAccessRules to see daily/hourly limits + current usage per API call
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

// Get user's eBay access token from the DB (most recent for user_id 1)
const rows = await sql(`SELECT oauth_token, refresh_token, token_expires_at FROM ebay_credentials WHERE user_id = 1 ORDER BY updated_at DESC NULLS LAST LIMIT 1`)
if (!rows[0]) {
  console.log('No eBay credentials found for user 1.')
  process.exit(1)
}

let token = rows[0].oauth_token
const tokenExpires = new Date(rows[0].token_expires_at)
if (tokenExpires < new Date()) {
  console.log('Token expired. Refresh required first via the app — please reload the dashboard.')
  process.exit(1)
}

const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetAPIAccessRulesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
</GetAPIAccessRulesRequest>`

const res = await fetch('https://api.ebay.com/ws/api.dll', {
  method: 'POST',
  headers: {
    'X-EBAY-API-CALL-NAME': 'GetAPIAccessRules',
    'X-EBAY-API-SITEID': '0',
    'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
    'X-EBAY-API-APP-NAME': env.EBAY_APP_ID,
    'X-EBAY-API-DEV-NAME': env.EBAY_DEV_ID,
    'X-EBAY-API-CERT-NAME': env.EBAY_CERT_ID,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'text/xml',
  },
  body: xml,
})
const text = await res.text()

// Parse the response for rule blocks
const rules = [...text.matchAll(/<APIAccessRule>([\s\S]*?)<\/APIAccessRule>/g)]
const parsed = rules.map((m) => {
  const block = m[1]
  return {
    callName: block.match(/<CallName>(.*?)<\/CallName>/)?.[1] || 'unknown',
    dailyHardLimit: Number(block.match(/<DailyHardLimit>(.*?)<\/DailyHardLimit>/)?.[1] || 0),
    dailySoftLimit: Number(block.match(/<DailySoftLimit>(.*?)<\/DailySoftLimit>/)?.[1] || 0),
    dailyUsage: Number(block.match(/<DailyUsage>(.*?)<\/DailyUsage>/)?.[1] || 0),
    hourlyHardLimit: Number(block.match(/<HourlyHardLimit>(.*?)<\/HourlyHardLimit>/)?.[1] || 0),
    hourlySoftLimit: Number(block.match(/<HourlySoftLimit>(.*?)<\/HourlySoftLimit>/)?.[1] || 0),
    hourlyUsage: Number(block.match(/<HourlyUsage>(.*?)<\/HourlyUsage>/)?.[1] || 0),
  }
})

// Sort by usage percent
const withPercent = parsed.map((r) => ({
  ...r,
  hourlyPct: r.hourlyHardLimit > 0 ? Math.round((r.hourlyUsage / r.hourlyHardLimit) * 100) : 0,
  dailyPct: r.dailyHardLimit > 0 ? Math.round((r.dailyUsage / r.dailyHardLimit) * 100) : 0,
}))
const exceeded = withPercent.filter((r) => r.hourlyPct >= 90 || r.dailyPct >= 90 || r.hourlyUsage >= r.hourlyHardLimit || r.dailyUsage >= r.dailyHardLimit)
const heavy = withPercent.filter((r) => r.hourlyUsage + r.dailyUsage > 0 && !exceeded.includes(r))

console.log('═════════════ eBay API QUOTA STATUS ═════════════\n')

if (exceeded.length > 0) {
  console.log('🚨 EXHAUSTED or NEAR LIMIT:')
  for (const r of exceeded) {
    console.log(`  ${r.callName.padEnd(35)} hourly: ${r.hourlyUsage}/${r.hourlyHardLimit} (${r.hourlyPct}%)  daily: ${r.dailyUsage}/${r.dailyHardLimit} (${r.dailyPct}%)`)
  }
} else {
  console.log('✓ No calls at/over limit.')
}

console.log('\n📊 Heavy usage (most-called today):')
heavy.sort((a, b) => (b.dailyUsage || 0) - (a.dailyUsage || 0))
for (const r of heavy.slice(0, 15)) {
  console.log(`  ${r.callName.padEnd(35)} hourly: ${r.hourlyUsage}/${r.hourlyHardLimit}  daily: ${r.dailyUsage}/${r.dailyHardLimit}`)
}

console.log(`\nTotal rules returned: ${parsed.length}`)
console.log('\nRaw response excerpt:')
console.log(text.slice(0, 2000))
