import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'; import path from 'node:path'
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i=l.indexOf('='); return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,'')] })
)
const sql = neon(env.DATABASE_URL)
const r = await sql(`
  WITH base AS (
    SELECT psi.asin, psi.source_niche, psi.amazon_price, psi.ebay_competitor_min_price, psi.ebay_competitor_count
    FROM product_source_items psi
    JOIN amazon_product_cache apc ON UPPER(apc.asin)=UPPER(psi.asin)
    WHERE psi.active AND psi.profit>=4 AND psi.roi>=25 AND psi.risk<>'HIGH'
      AND psi.image_url<>'' AND COALESCE(psi.source_quality,'candidate') NOT IN ('reject','needs_images','stale')
      AND COALESCE(apc.available,TRUE)<>FALSE AND jsonb_array_length(apc.images)>=2
      AND (psi.ebay_competitor_count IS NULL OR psi.ebay_competitor_count <= 50)
      AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin)=UPPER(psi.asin) AND la.ended_at IS NULL)
  )
  SELECT
    COUNT(*)::int before_rules,
    COUNT(*) FILTER (WHERE source_niche IN (
      'Beach & Sunny Day','Vintage & Antiques','Fishing & Hunting','Coins & Currency',
      'Industrial Equipment','Cycling','Desk Drawer Organizers','Closet & Wardrobe Organizers',
      'Safety Gear','Desk Monitor Arm & Cable Clip Bundles','Pet Supplies','Camping & Hiking',
      'Office Supplies','Trading Cards','Personal Care','Closet Rod & Shelf Divider Spring Refresh Bundle',
      'Bathroom Cabinet & Vanity Organizers','Gaming Gear','Drawer Dividers & Inserts',
      'Entryway & Mudroom Organizer Systems','Toys & Games'
    ))::int rule_a_drops,
    COUNT(*) FILTER (WHERE ebay_competitor_min_price IS NOT NULL AND amazon_price >= ebay_competitor_min_price * 1.65)::int rule_c_drops,
    COUNT(*) FILTER (WHERE
      (source_niche IS NULL OR source_niche NOT IN (
        'Beach & Sunny Day','Vintage & Antiques','Fishing & Hunting','Coins & Currency',
        'Industrial Equipment','Cycling','Desk Drawer Organizers','Closet & Wardrobe Organizers',
        'Safety Gear','Desk Monitor Arm & Cable Clip Bundles','Pet Supplies','Camping & Hiking',
        'Office Supplies','Trading Cards','Personal Care','Closet Rod & Shelf Divider Spring Refresh Bundle',
        'Bathroom Cabinet & Vanity Organizers','Gaming Gear','Drawer Dividers & Inserts',
        'Entryway & Mudroom Organizer Systems','Toys & Games'
      ))
      AND (ebay_competitor_min_price IS NULL OR amazon_price < ebay_competitor_min_price * 1.65)
    )::int after_rules
  FROM base`)
const d = r[0]
console.log(`List-ready before new gates:    ${d.before_rules}`)
console.log(`  Drops from Rule A (blacklist):    ${d.rule_a_drops}`)
console.log(`  Drops from Rule C (cost ratio):   ${d.rule_c_drops}`)
console.log(`List-ready AFTER new gates:    ${d.after_rules}  (${(d.after_rules*100/d.before_rules).toFixed(0)}% survive)`)
