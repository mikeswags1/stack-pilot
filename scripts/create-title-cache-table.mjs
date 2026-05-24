// Manually create the ebay_title_cache table
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

await sql(`
  CREATE TABLE IF NOT EXISTS ebay_title_cache (
    asin TEXT PRIMARY KEY,
    ai_title TEXT NOT NULL,
    source_title TEXT,
    niche TEXT,
    model TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
  )
`)
await sql(`CREATE INDEX IF NOT EXISTS ebay_title_cache_expires_idx ON ebay_title_cache (expires_at)`)

const check = await sql(`SELECT COUNT(*)::int AS n FROM ebay_title_cache`)
console.log(`Table created. Current rows: ${check[0].n}`)
