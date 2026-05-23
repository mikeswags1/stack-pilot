// Re-activate products that were wrongly deactivated by the scrape-fallback bug.
// Only re-activates if:
//   - Cache says available = TRUE (Amazon confirmed available, not just bot-detected)
//   - Cache has >= 2 images (real enrichment data exists)
//   - Cache updated_at within the last 7 days (still fresh)
//   - source_quality is NOT 'reject' (was not rejected for real reasons like ASIN_MISMATCH)
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

// Preview first
const preview = await sql(`
  SELECT psi.source_niche, COUNT(*)::int AS recoverable
  FROM product_source_items psi
  JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
  WHERE psi.active = FALSE
    AND apc.available = TRUE
    AND apc.updated_at > NOW() - INTERVAL '7 days'
    AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2
    AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
    AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 30
`)
console.log('Will re-activate per niche:')
for (const r of preview) console.log(`  ${(r.source_niche || '(none)').padEnd(28)} +${r.recoverable}`)

const total = preview.reduce((sum, r) => sum + r.recoverable, 0)
console.log(`\nTotal to re-activate: ${total}\n`)

// Do it
const result = await sql(`
  UPDATE product_source_items psi
  SET active = TRUE, last_intelligence_at = NOW()
  FROM amazon_product_cache apc
  WHERE UPPER(apc.asin) = UPPER(psi.asin)
    AND psi.active = FALSE
    AND apc.available = TRUE
    AND apc.updated_at > NOW() - INTERVAL '7 days'
    AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2
    AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
    AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
  RETURNING psi.asin
`)
console.log(`Re-activated: ${result.length} products`)
