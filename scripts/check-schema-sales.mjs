import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'; import path from 'node:path'
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i=l.indexOf('='); return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,'')] })
)
const sql = neon(env.DATABASE_URL)

const cols = await sql(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'listed_asins' ORDER BY ordinal_position`)
console.log('listed_asins columns:')
for (const c of cols) console.log('  ' + c.column_name)

const tables = await sql(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND (
    table_name ILIKE '%order%' OR table_name ILIKE '%sale%' OR
    table_name ILIKE '%outcome%' OR table_name ILIKE '%view%' OR
    table_name ILIKE '%watch%' OR table_name ILIKE '%engagement%'
  ) ORDER BY table_name`)
console.log('\nSales/traffic-related tables:')
for (const t of tables) console.log('  ' + t.table_name)
