import { sql } from '@/lib/db'

export async function ensureListedAsinsFinancialColumns() {
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS amazon_price NUMERIC(10,2)`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS ebay_price NUMERIC(10,2)`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS ebay_fee_rate NUMERIC(6,4)`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS amazon_image_url TEXT`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS amazon_images JSONB`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS amazon_snapshot JSONB`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS niche VARCHAR(100)`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS category_id VARCHAR(50)`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS category_name TEXT`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS amazon_available BOOLEAN`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS amazon_status_reason TEXT`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS amazon_status_checked_at TIMESTAMPTZ`.catch(() => {})
  await sql`
    DELETE FROM listed_asins a
    USING listed_asins b
    WHERE a.user_id = b.user_id
      AND a.asin = b.asin
      AND a.id < b.id
  `.catch(() => {})
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS listed_asins_user_asin_unique_idx ON listed_asins (user_id, asin)`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS listed_asins_user_listing_idx ON listed_asins (user_id, ebay_listing_id)`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS listed_asins_user_niche_idx ON listed_asins (user_id, niche)`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS listed_asins_amazon_status_idx ON listed_asins (ended_at, amazon_status_checked_at)`.catch(() => {})
  // Image quality tracking: records how many images were actually used in the eBay listing
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS image_count SMALLINT`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS image_quality_warning BOOLEAN NOT NULL DEFAULT FALSE`.catch(() => {})
}
