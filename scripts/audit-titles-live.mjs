// Look at recent eBay-bound titles to assess title quality
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

// Get the 15 most-recent listings — title in DB is the raw Amazon title,
// but the actual eBay-side title is the first 80 chars of cleanTitle
const listings = await sql(`
  SELECT title, niche, listed_at::date AS d
  FROM listed_asins
  WHERE ended_at IS NULL
  ORDER BY listed_at DESC
  LIMIT 15
`)

function cleanLikeEbay(title) {
  // Mimics list-product/route.ts cleanTitle logic
  let t = String(title || '')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&amp;|&#38;/gi, '&')
    .replace(/&lt;|&#60;/gi, '<')
    .replace(/&gt;|&#62;/gi, '>')
    // Strip Amazon-specific badges
    .replace(/\[?\b(amazon['']?s?\s+choice|overall\s+pick|#?\s*1\s+best\s+seller|best\s+seller|limited\s+time\s+deal|climate\s+pledge\s+friendly|small\s+business|sponsored|top\s+brand|highly\s+rated|deal\s+of\s+the\s+day)\b\]?/gi, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[<>"]/g, '')
    .replace(/\s*[-|,]\s*(Pack of|Pack|Count|Piece|Pcs|Units?|Set of)\s*\d+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (t.length > 80) {
    t = t.slice(0, 80).replace(/\s+\S*$/, '').trim()
    t = t.replace(/\s+(?:with|for|in|to|of|and|or|a|an|the|by|at|from|as|into|zero|one|two|three|four|five|&|\+)$/i, '').trim()
    t = t.replace(/[\s,;:\-|]+$/, '').trim()
  }
  return t
}

console.log('Recent listings (Amazon title → cleaned eBay title up to 80 chars):\n')
for (const r of listings) {
  const ebay = cleanLikeEbay(r.title)
  console.log(`📦 ${r.niche || '(none)'} (${r.d.toISOString?.()?.slice(0,10) || r.d})`)
  console.log(`   Amazon: ${r.title.slice(0, 110)}`)
  console.log(`   eBay:   [${ebay.length}] ${ebay}\n`)
}
