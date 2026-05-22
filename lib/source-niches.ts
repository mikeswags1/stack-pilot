import { queryRows, sql } from '@/lib/db'

export const TRENDING_NEW_NICHE_QUERIES: Record<string, string[]> = {
  'Golf Accessories': [
    'golf towel magnetic clip', 'golf ball marker divot tool', 'golf club brush cleaner',
    'golf rangefinder case', 'golf tee holder pouch', 'golf alignment sticks training',
    'golf glove holder clip', 'golf cart phone holder', 'golf swing trainer aid',
    'golf scorecard holder waterproof', 'golf bag cooler sleeve', 'golf club groove sharpener',
    'putting mat alignment mirror', 'golf ball retriever telescopic', 'golf spikes replacement',
    'golf sunscreen towel bundle', 'golf accessories under 50', 'father day golf gift',
    // Expansion: 22 additional queries targeting margin-friendly accessories
    'golf shoe bag mesh ventilated', 'golf hat clip magnetic ball marker', 'golf grip enhancer spray',
    'golf scorecard pencil set holster', 'golf glove rain wet weather', 'golf shaft extender steel',
    'golf cigar holder cart bag', 'golf wedge cleaner brush kit', 'golf ball cleaner pouch portable',
    'golf rangefinder strap lanyard', 'golf practice net portable backyard', 'golf chipping mat indoor',
    'golf cart fan rechargeable clip', 'golf yardage book holder cover', 'golf hand warmers winter pack',
    'golf cooler bag insulated tube', 'golf pin flags backyard practice', 'golf tees plastic bulk 100',
    'golf training aid putting arc', 'golf umbrella double canopy 68 inch', 'golf grip kit re grip tape',
    'golf ball monitor portable launch',
  ],
  'Pool Products': [
    'pool skimmer net heavy duty', 'pool test strips chlorine', 'pool float drink holder',
    'inflatable pool lounger adult', 'pool vacuum head brush', 'pool thermometer floating',
    'pool cover clips above ground', 'pool filter cartridge replacement', 'pool storage basket',
    'pool basketball hoop floating', 'waterproof phone pouch pool', 'pool towel clips chair',
    'swim goggles anti fog adult', 'pool toys diving rings', 'solar pool lights floating',
    'pool maintenance accessories', 'pool party supplies summer', 'above ground pool accessories',
  ],
  'Beach & Sunny Day': [
    'beach towel clips windproof', 'beach bag waterproof sandproof', 'sun hat wide brim upf',
    'cooling towel neck wrap', 'sunscreen applicator back', 'beach blanket sandproof compact',
    'waterproof phone pouch beach', 'portable fan rechargeable clip', 'polarized sunglasses case',
    'beach chair cup holder', 'umbrella sand anchor', 'sand free beach mat',
    'insulated water bottle straw lid', 'kids beach toys mesh bag', 'sun shade canopy accessories',
    'after sun cooling gel applicator', 'summer outdoor accessories under 50',
    // Expansion: 22 additional queries targeting margin-friendly summer items
    'beach wagon foldable cart', 'beach sand toys bucket set', 'snorkel mask kids full face',
    'swim cap silicone adult', 'swim goggles women anti fog', 'rash guard kids upf 50',
    'beach tent shade pop up', 'body board kids 33 inch', 'beach ball giant inflatable',
    'wetsuit shorts mens neoprene', 'swim earplugs adult silicone', 'dive flag float tow',
    'pool swim ring inflatable adult', 'mesh beach bag large drawstring', 'sandless beach mat extra large',
    'beach cabana sun shade portable', 'beach side table umbrella clip', 'beach trolley wheels cart',
    'floating sunglasses polarized', 'beach radio bluetooth waterproof', 'beach hammock portable tree',
    'sun shelter beach pop up upf',
  ],
  'Summer Outdoor Gear': [
    'camping fan rechargeable lantern', 'mosquito repellent patio device', 'outdoor misting fan portable',
    'picnic blanket waterproof foldable', 'portable hammock straps set', 'bug zapper outdoor rechargeable',
    'outdoor solar string lights', 'cooler backpack insulated leakproof', 'hydration pack lightweight',
    'water bottle carrier sling', 'camp chair cup holder attachment', 'portable power bank solar',
    'outdoor first aid kit compact', 'dry bag waterproof roll top', 'camping table organizer',
    'summer camping accessories', 'outdoor gear gifts under 50',
  ],
  'Backyard & Patio': [
    'patio string lights outdoor shatterproof', 'outdoor pillow covers waterproof', 'grill tools set stainless',
    'grill mat non stick', 'patio umbrella lights solar', 'bird feeder squirrel proof',
    'garden hose nozzle heavy duty', 'outdoor tablecloth waterproof', 'patio furniture clips',
    'deck box organizer small', 'solar pathway lights outdoor', 'plant watering stakes',
    'outdoor rug clips', 'mosquito repellent coil holder', 'bbq thermometer instant read',
    'backyard party accessories', 'patio accessories under 50',
    // Expansion: 24 additional queries focused on backyard/patio items
    'outdoor rug 5x7 weatherproof', 'patio chair cushions set 2', 'pool noodle floating chair',
    'fire pit table portable propane', 'outdoor planter box raised', 'gazebo curtains 10x10',
    'mosquito netting patio canopy', 'outdoor sectional sofa cover', 'hammock with stand portable',
    'citronella candles outdoor large', 'lawn games adults backyard set', 'patio heater portable propane',
    'outdoor bbq apron pockets', 'outdoor speaker bluetooth waterproof', 'deck box waterproof storage 50 gallon',
    'outdoor curtains porch waterproof', 'plant stand multi tier outdoor', 'outdoor pillow inserts 18x18',
    'gardening tools set ergonomic 8 piece', 'lawn mower bag replacement universal', 'patio side table folding',
    'cornhole boards regulation set', 'bird bath solar fountain', 'wind chimes outdoor large deep tone',
    'patio table umbrella stand weighted',
  ],
  'Travel Accessories': [
    'packing cubes compression set', 'travel toiletry bag hanging', 'luggage scale digital portable',
    'passport holder rfid travel wallet', 'travel pillow memory foam neck', 'airplane phone holder mount',
    'cable organizer travel electronics', 'shoe bags travel waterproof', 'luggage tags silicone',
    'travel laundry bag', 'tsa approved toiletry bottles', 'portable charger travel slim',
    'ear plugs sleep mask travel', 'carry on cup holder', 'travel jewelry organizer small',
    'road trip organizer car', 'travel accessories under 50', 'summer travel essentials',
    // Expansion: 24 additional queries (the worst-supplied niche, needs most depth)
    'travel adapter universal worldwide usb c', 'neck wallet hidden travel pouch', 'money belt rfid travel',
    'packing organizer compression cubes 8 piece', 'luggage straps tsa approved 2 inch', 'suitcase cover protector clear',
    'foldable backpack lightweight 30l', 'travel laundry detergent sheets', 'travel slippers disposable',
    'luggage handle wrap silicone', 'travel size containers leak proof tsa', 'portable steamer travel wrinkle remover',
    'travel hair dryer dual voltage compact', 'foldable water bottle silicone collapsible', 'eye mask weighted travel sleep',
    'travel humidifier portable usb', 'foot rest hammock airplane travel', 'travel coffee mug spill proof',
    'compression socks women travel 20 30 mmhg', 'luggage tracker bluetooth tag', 'travel umbrella compact wind resistant',
    'travel makeup bag hanging organizer', 'tsa toiletry bottles silicone leak proof', 'travel garment bag carry on',
    'foldable travel duffel waterproof', 'travel first aid kit compact',
  ],
  'Fitness Recovery': [
    'massage ball lacrosse set', 'foam roller deep tissue compact', 'massage gun mini portable',
    'stretching strap physical therapy', 'ice pack wrap reusable', 'knee compression sleeve pair',
    'ankle compression socks recovery', 'yoga block strap set', 'neck stretcher cervical pillow',
    'muscle roller stick', 'hot cold therapy pack', 'foot roller plantar fasciitis',
    'cupping therapy set silicone', 'post workout recovery tools', 'fitness recovery gifts under 50',
  ],
  'Home Organization': [
    'drawer organizer adjustable dividers', 'under sink organizer pull out', 'clear pantry bins with lids',
    'cable management box wood', 'closet shelf dividers acrylic', 'vacuum storage bags travel',
    'spice rack organizer cabinet', 'fridge organizer bins clear', 'shoe slots organizer space saver',
    'bathroom counter organizer', 'laundry room organizer wall mount', 'garage hooks heavy duty',
    'bedside caddy organizer', 'makeup organizer acrylic drawers', 'home organization under 50',
  ],
  'Pet Products': [
    'dog enrichment toy puzzle', 'cat water fountain filter', 'pet hair remover reusable',
    'dog car seat cover waterproof', 'cat window perch hammock', 'dog cooling mat summer',
    'portable dog water bottle', 'pet grooming brush self cleaning', 'slow feeder dog bowl',
    'cat litter mat double layer', 'dog treat pouch training', 'pet travel bag organizer',
    'dog paw cleaner cup', 'cat tunnel collapsible', 'pet products under 50',
  ],
  'Viral Gadgets': [
    'viral kitchen gadget', 'tiktok made me buy it gadget', 'magnetic cable organizer',
    'rechargeable portable blender', 'mini label maker bluetooth', 'sunset lamp projector',
    'led motion sensor closet light', 'phone stand bluetooth speaker', 'electric cleaning brush',
    'foldable desk fan rechargeable', 'mini thermal printer', 'car trash can leakproof',
    'automatic soap dispenser touchless', 'desktop vacuum cleaner mini', 'viral gadgets under 50',
  ],
  'Giftable Under $50': [
    'gift ideas under 50 useful', 'unique gifts under 50 adults', 'tech gifts under 50',
    'home gifts under 50', 'travel gifts under 50', 'gifts for dad under 50',
    'gifts for mom under 50', 'stocking stuffers useful gadgets', 'birthday gifts practical',
    'desk gifts under 50', 'self care gifts under 50', 'pet lover gifts under 50',
    'outdoor gifts under 50', 'car gifts under 50', 'white elephant gifts useful',
  ],
}

export const TRENDING_EXISTING_NICHE_QUERY_ADDITIONS: Record<string, string[]> = {
  'Car Accessories': [
    'summer car accessories', 'car sun shade windshield foldable', 'car seat gap organizer',
    'car trash can leakproof', 'road trip car organizer', 'car cup holder expander',
    'car visor organizer', 'portable tire inflator digital', 'car cleaning gel dust putty',
  ],
  'Storage & Organization': [
    'home organization trending', 'under sink organizer pull out', 'clear pantry bins',
    'drawer organizer adjustable', 'fridge organizer clear bins', 'closet dividers acrylic',
  ],
  'Pet Supplies': [
    'dog cooling mat summer', 'portable dog water bottle', 'pet travel accessories',
    'cat water fountain filters', 'pet hair remover couch', 'dog enrichment puzzle toy',
  ],
  'Fitness Equipment': [
    'fitness recovery tools', 'mini massage gun portable', 'stretching strap physical therapy',
    'ice pack wrap knee', 'foam roller compact', 'muscle roller stick',
  ],
}

const SEASONAL_TRENDING_TERMS = [
  'golf', 'pool', 'beach', 'summer', 'sun', 'patio', 'backyard', 'outdoor', 'camping',
  'travel', 'road trip', 'cooling', 'portable fan', 'pickleball', 'grill', 'garden',
]

const VIRAL_GIFTABLE_TERMS = [
  'viral', 'tiktok', 'mini', 'portable', 'rechargeable', 'wireless', 'magnetic',
  'foldable', 'silicone', 'led', 'smart', 'organizer', 'gadget', 'gift', 'under 50',
]

const LIGHTWEIGHT_TERMS = [
  'clip', 'holder', 'pouch', 'case', 'bag', 'strap', 'sleeve', 'towel', 'mat',
  'brush', 'marker', 'organizer', 'cover', 'light', 'wallet', 'cable', 'band',
]

const BULKY_OR_HIGH_RETURN_TERMS = [
  'sofa', 'couch', 'mattress', 'desk', 'chair', 'table', 'treadmill', 'elliptical',
  'generator', 'chainsaw', 'tv ', 'television', 'monitor', 'laptop', 'tablet',
  'apparel', 'dress', 'jeans', 'shoes', 'cosmetic', 'makeup foundation', 'perfume',
  'supplement', 'vitamin', 'medical', 'fragile', 'glass set',
]

function uniqueQueries(values: string[]) {
  const seen = new Set<string>()
  const queries: string[] = []
  for (const value of values) {
    const query = String(value || '').replace(/\s+/g, ' ').trim()
    const key = query.toLowerCase()
    if (!query || seen.has(key)) continue
    seen.add(key)
    queries.push(query)
  }
  return queries
}

function includesAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term))
}

export function mergeTrendingNicheQueries(base: Record<string, string[]>) {
  const merged: Record<string, string[]> = {}
  for (const [niche, queries] of Object.entries(base)) {
    merged[niche] = uniqueQueries([
      ...queries,
      ...(TRENDING_EXISTING_NICHE_QUERY_ADDITIONS[niche] || []),
    ])
  }
  for (const [niche, queries] of Object.entries(TRENDING_NEW_NICHE_QUERIES)) {
    merged[niche] = uniqueQueries([...(merged[niche] || []), ...queries])
  }
  return merged
}

export function getSeasonalQueryExpansions(niche: string) {
  const lower = niche.toLowerCase()
  const expansions = [
    `summer ${niche}`,
    `${niche} under 50`,
    `${niche} gifts`,
    `viral ${niche}`,
    `${niche} essentials`,
  ]
  if (includesAny(lower, ['golf', 'pool', 'beach', 'patio', 'outdoor', 'travel'])) {
    expansions.push(`2026 ${niche} trends`, `${niche} summer best seller`)
  }
  return uniqueQueries(expansions)
}

export function getSourcingTrendSignals(input: {
  title: string
  sourceNiche?: string
  price?: number
  imageCount?: number
}) {
  const text = `${input.title || ''} ${input.sourceNiche || ''}`.toLowerCase()
  const price = Number(input.price || 0)
  const imageCount = Number(input.imageCount || 0)
  const seasonal = includesAny(text, SEASONAL_TRENDING_TERMS)
  const viralGiftable = includesAny(text, VIRAL_GIFTABLE_TERMS) || (price > 0 && price <= 50)
  const lightweight = includesAny(text, LIGHTWEIGHT_TERMS)
  const highReturnRisk = includesAny(text, BULKY_OR_HIGH_RETURN_TERMS)
  const imageQuality = imageCount >= 4 ? 'strong' : imageCount >= 2 ? 'ok' : 'weak'
  return { seasonal, viralGiftable, lightweight, highReturnRisk, imageQuality }
}

export function getSourcingTrendMultiplier(input: {
  title: string
  sourceNiche?: string
  price?: number
  imageCount?: number
}) {
  const signals = getSourcingTrendSignals(input)
  let multiplier = 1
  if (signals.seasonal) multiplier += 0.16
  if (signals.viralGiftable) multiplier += 0.12
  if (signals.lightweight) multiplier += 0.10
  if (signals.imageQuality === 'strong') multiplier += 0.08
  if (signals.imageQuality === 'weak') multiplier -= 0.10
  if (signals.highReturnRisk) multiplier -= 0.22
  return Math.max(0.58, Math.min(1.55, multiplier))
}

export async function ensureSourceNicheConfigTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS product_source_niches (
      name TEXT PRIMARY KEY,
      queries JSONB NOT NULL DEFAULT '[]'::jsonb,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => {})
}

export async function loadCustomSourceNicheRows() {
  await ensureSourceNicheConfigTable()
  return queryRows<{ name: string; queries: unknown; active: boolean; notes: string | null; updated_at: string | null }>`
    SELECT name, queries, active, notes, updated_at
    FROM product_source_niches
    ORDER BY active DESC, name ASC
  `.catch(() => [])
}

export async function loadActiveCustomSourceNicheQueries() {
  const rows = await loadCustomSourceNicheRows()
  const entries: Record<string, string[]> = {}
  for (const row of rows) {
    if (!row.active) continue
    const queries = Array.isArray(row.queries) ? row.queries.map((entry) => String(entry || '')) : []
    entries[row.name] = uniqueQueries(queries.length > 0 ? queries : [`${row.name} bestseller`, `trending ${row.name}`])
  }
  return entries
}

export async function upsertCustomSourceNiche(args: {
  name: string
  queries: string[]
  active?: boolean
  notes?: string
}) {
  await ensureSourceNicheConfigTable()
  const name = String(args.name || '').replace(/\s+/g, ' ').trim()
  if (!name || name.length > 80) throw new Error('Niche name must be 1-80 characters.')
  const queries = uniqueQueries(args.queries).slice(0, 40)
  if (queries.length === 0) throw new Error('Add at least one search query.')
  await sql`
    INSERT INTO product_source_niches (name, queries, active, notes, updated_at)
    VALUES (${name}, ${JSON.stringify(queries)}::jsonb, ${args.active !== false}, ${args.notes || null}, NOW())
    ON CONFLICT (name) DO UPDATE SET
      queries = EXCLUDED.queries,
      active = EXCLUDED.active,
      notes = EXCLUDED.notes,
      updated_at = NOW()
  `
  return { name, queries, active: args.active !== false, notes: args.notes || '' }
}

export async function setCustomSourceNicheActive(nameInput: string, active: boolean) {
  await ensureSourceNicheConfigTable()
  const name = String(nameInput || '').replace(/\s+/g, ' ').trim()
  if (!name) throw new Error('Niche name is required.')
  await sql`
    INSERT INTO product_source_niches (name, queries, active, updated_at)
    VALUES (${name}, ${JSON.stringify([`${name} bestseller`, `trending ${name}`])}::jsonb, ${active}, NOW())
    ON CONFLICT (name) DO UPDATE SET active = EXCLUDED.active, updated_at = NOW()
  `
  return { name, active }
}
