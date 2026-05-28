import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { promises as fs } from 'fs'
import sharp from 'sharp'

export const dynamic = 'force-dynamic'

type BadgeVariant = 'classic-free-2-4-day-shipping' | 'free-2-4-day-shipping' | 'free-shipping' | 'fast-delivery' | 'ships-fast' | 'none'

const BADGE_LABELS: Record<Exclude<BadgeVariant, 'none'>, string> = {
  'classic-free-2-4-day-shipping': 'Classic Free 2-4 Day Shipping',
  'free-2-4-day-shipping': 'Free 2-4 Day Shipping',
  'free-shipping': 'Free Shipping',
  'fast-delivery': 'Fast Delivery',
  'ships-fast': 'Ships Fast',
}

const BADGE_ASSET_FILES: Record<Exclude<BadgeVariant, 'none'>, string> = {
  'classic-free-2-4-day-shipping': 'free-shipping-stamp.png',
  'free-2-4-day-shipping': 'free-2-4-day-shipping.png',
  'free-shipping': 'free-shipping.png',
  'fast-delivery': 'fast-delivery.png',
  'ships-fast': 'ships-fast.png',
}

async function prepareBadgeAsset(variant: Exclude<BadgeVariant, 'none'>, width: number) {
  const badgePath = variant === 'classic-free-2-4-day-shipping'
    ? path.join(process.cwd(), 'public', BADGE_ASSET_FILES[variant])
    : path.join(process.cwd(), 'public', 'badges', BADGE_ASSET_FILES[variant])
  const pipeline = sharp(await fs.readFile(badgePath)).ensureAlpha()
  if (variant === 'classic-free-2-4-day-shipping') pipeline.trim({ threshold: 18 })
  const input = await pipeline
    .resize({ width: variant === 'classic-free-2-4-day-shipping' ? Math.round(width * 0.82) : width })
    .png()
    .toBuffer()
  const metadata = await sharp(input).metadata()
  return {
    input,
    width: metadata.width || width,
    height: metadata.height || Math.round(width * 0.27),
  }
}

function hashText(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function chooseVariant(asin: string, title: string, override?: string | null): BadgeVariant {
  if (override) {
    const normalized = override.toLowerCase().trim()
    if (normalized === 'none') return 'none'
    if (normalized in BADGE_LABELS) return normalized as BadgeVariant
  }

  const bucket = hashText(`${asin}:${title}`) % 100
  if (bucket < 20) return 'none'

  const variants = Object.keys(BADGE_LABELS) as Array<Exclude<BadgeVariant, 'none'>>
  return variants[bucket % variants.length]
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function buildBadgeOverlay(variant: Exclude<BadgeVariant, 'none'>, width: number) {
  const height = Math.round(width * 0.27)
  const rx = Math.round(height * 0.33)
  const stroke = Math.max(2, Math.round(width * 0.008))
  const titleSize = Math.round(width * 0.065)
  const iconX = Math.round(width * 0.11)
  const iconY = Math.round(height * 0.35)
  const iconScale = width / 340

  const truckIcon = (fill: string) => `
    <g fill="${fill}">
      <rect x="${iconX}" y="${iconY}" width="${Math.round(52 * iconScale)}" height="${Math.round(30 * iconScale)}" rx="${Math.round(4 * iconScale)}"/>
      <path d="M ${iconX + Math.round(52 * iconScale)} ${iconY + Math.round(8 * iconScale)} h ${Math.round(17 * iconScale)} l ${Math.round(15 * iconScale)} ${Math.round(18 * iconScale)} v ${Math.round(4 * iconScale)} h -${Math.round(84 * iconScale)} v -${Math.round(10 * iconScale)} h ${Math.round(10 * iconScale)} v ${Math.round(6 * iconScale)} h ${Math.round(59 * iconScale)} v -${Math.round(8 * iconScale)} h -${Math.round(11 * iconScale)} l -${Math.round(8 * iconScale)} -${Math.round(10 * iconScale)} h -${Math.round(9 * iconScale)} z"/>
      <circle cx="${iconX + Math.round(21 * iconScale)}" cy="${iconY + Math.round(39 * iconScale)}" r="${Math.round(9 * iconScale)}"/>
      <circle cx="${iconX + Math.round(72 * iconScale)}" cy="${iconY + Math.round(39 * iconScale)}" r="${Math.round(9 * iconScale)}"/>
      <rect x="${iconX - Math.round(34 * iconScale)}" y="${iconY + Math.round(4 * iconScale)}" width="${Math.round(28 * iconScale)}" height="${Math.round(4 * iconScale)}" rx="${Math.round(2 * iconScale)}"/>
      <rect x="${iconX - Math.round(45 * iconScale)}" y="${iconY + Math.round(16 * iconScale)}" width="${Math.round(39 * iconScale)}" height="${Math.round(4 * iconScale)}" rx="${Math.round(2 * iconScale)}"/>
      <rect x="${iconX - Math.round(31 * iconScale)}" y="${iconY + Math.round(28 * iconScale)}" width="${Math.round(25 * iconScale)}" height="${Math.round(4 * iconScale)}" rx="${Math.round(2 * iconScale)}"/>
    </g>
  `

  const checkIcon = `
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="${Math.round(width * 0.17)}" cy="${Math.round(height * 0.50)}" r="${Math.round(height * 0.24)}" stroke="#152438" stroke-width="${Math.max(3, Math.round(width * 0.012))}"/>
      <path d="M ${Math.round(width * 0.115)} ${Math.round(height * 0.50)} l ${Math.round(width * 0.04)} ${Math.round(height * 0.10)} l ${Math.round(width * 0.085)} -${Math.round(height * 0.20)}" stroke="#f4b63f" stroke-width="${Math.max(5, Math.round(width * 0.018))}"/>
    </g>
  `

  const body =
    variant === 'free-2-4-day-shipping'
      ? `
        <rect x="${stroke}" y="${stroke}" width="${width - stroke * 2}" height="${height - stroke * 2}" rx="${rx}" fill="#132235" stroke="#405168" stroke-width="${stroke}"/>
        <rect x="${stroke * 3}" y="${stroke * 3}" width="${width - stroke * 6}" height="${height - stroke * 6}" rx="${Math.max(4, rx - stroke * 2)}" fill="none" stroke="#526274" stroke-width="${Math.max(1, Math.round(stroke * 0.7))}" opacity="0.7"/>
        ${truckIcon('#ffffff')}
        <text x="${Math.round(width * 0.38)}" y="${Math.round(height * 0.46)}" fill="#ffffff" stroke="#0b1220" stroke-width="${Math.max(1, Math.round(width * 0.003))}" paint-order="stroke" font-size="${Math.round(width * 0.055)}" font-family="Arial, Helvetica, sans-serif" font-weight="900" letter-spacing="${Math.round(width * 0.006)}">FREE 2-4 DAY</text>
        <text x="${Math.round(width * 0.38)}" y="${Math.round(height * 0.67)}" fill="#ffffff" stroke="#0b1220" stroke-width="${Math.max(1, Math.round(width * 0.003))}" paint-order="stroke" font-size="${Math.round(width * 0.055)}" font-family="Arial, Helvetica, sans-serif" font-weight="900" letter-spacing="${Math.round(width * 0.006)}">SHIPPING</text>
        <rect x="${Math.round(width * 0.38)}" y="${Math.round(height * 0.77)}" width="${Math.round(width * 0.50)}" height="${Math.max(2, Math.round(height * 0.035))}" fill="#f4c56f"/>
      `
      : variant === 'free-shipping'
      ? `
        <rect x="${stroke}" y="${stroke}" width="${width - stroke * 2}" height="${height - stroke * 2}" rx="${rx}" fill="#132235" stroke="#405168" stroke-width="${stroke}"/>
        <rect x="${stroke * 3}" y="${stroke * 3}" width="${width - stroke * 6}" height="${height - stroke * 6}" rx="${Math.max(4, rx - stroke * 2)}" fill="none" stroke="#526274" stroke-width="${Math.max(1, Math.round(stroke * 0.7))}" opacity="0.7"/>
        ${truckIcon('#ffffff')}
        <text x="${Math.round(width * 0.38)}" y="${Math.round(height * 0.55)}" fill="#ffffff" stroke="#0b1220" stroke-width="${Math.max(1, Math.round(width * 0.003))}" paint-order="stroke" font-size="${titleSize}" font-family="Arial, Helvetica, sans-serif" font-weight="900" letter-spacing="${Math.round(width * 0.006)}">FREE SHIPPING</text>
        <rect x="${Math.round(width * 0.38)}" y="${Math.round(height * 0.68)}" width="${Math.round(width * 0.50)}" height="${Math.max(2, Math.round(height * 0.035))}" fill="#f4c56f"/>
      `
      : variant === 'fast-delivery'
        ? `
          <path d="M ${rx} ${stroke} h ${width - rx * 1.4} q ${Math.round(rx * 0.75)} 0 ${Math.round(rx * 0.58)} ${Math.round(rx * 0.75)} l -${Math.round(rx * 0.22)} ${height - rx * 1.5} q -${Math.round(rx * 0.12)} ${Math.round(rx * 0.75)} -${Math.round(rx * 0.85)} ${Math.round(rx * 0.75)} h -${width - rx * 1.85} q -${rx - stroke} 0 -${rx - stroke} -${rx - stroke} v -${height - rx * 2} q 0 -${rx - stroke} ${rx - stroke} -${rx - stroke} z" fill="#f7c636" stroke="#f7d978" stroke-width="${stroke}"/>
          <rect x="${stroke * 3}" y="${stroke * 3}" width="${width - stroke * 8}" height="${height - stroke * 6}" rx="${Math.max(4, rx - stroke * 2)}" fill="none" stroke="#ffe68a" stroke-width="${Math.max(1, Math.round(stroke * 0.7))}" opacity="0.85"/>
          ${truckIcon('#172033')}
          <text x="${Math.round(width * 0.38)}" y="${Math.round(height * 0.55)}" fill="#172033" font-size="${titleSize}" font-family="Arial, Helvetica, sans-serif" font-weight="900" letter-spacing="${Math.round(width * 0.005)}">FAST DELIVERY</text>
          <rect x="${Math.round(width * 0.38)}" y="${Math.round(height * 0.68)}" width="${Math.round(width * 0.50)}" height="${Math.max(2, Math.round(height * 0.035))}" fill="#172033"/>
        `
        : `
          <rect x="${stroke}" y="${stroke}" width="${width - stroke * 2}" height="${height - stroke * 2}" rx="${rx}" fill="#ffffff" stroke="#152438" stroke-width="${stroke}"/>
          ${checkIcon}
          <text x="${Math.round(width * 0.34)}" y="${Math.round(height * 0.56)}" fill="#172033" stroke="#f8fafc" stroke-width="${Math.max(1, Math.round(width * 0.003))}" paint-order="stroke" font-size="${Math.round(width * 0.085)}" font-family="Arial, Helvetica, sans-serif" font-weight="900" letter-spacing="${Math.round(width * 0.008)}">SHIPS FAST</text>
          <rect x="${Math.round(width * 0.34)}" y="${Math.round(height * 0.69)}" width="${Math.round(width * 0.51)}" height="${Math.max(2, Math.round(height * 0.03))}" fill="#f4b63f"/>
        `

  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow" x="-10%" y="-28%" width="125%" height="160%">
          <feDropShadow dx="0" dy="${Math.max(3, Math.round(width * 0.012))}" stdDeviation="${Math.max(3, Math.round(width * 0.018))}" flood-color="#0f172a" flood-opacity="${variant === 'fast-delivery' ? '0.22' : '0.18'}"/>
        </filter>
      </defs>
      <g filter="url(#shadow)">
        ${body}
      </g>
    </svg>
  `
  const input = await sharp(Buffer.from(svg)).png().toBuffer()
  const metadata = await sharp(input).metadata()
  return {
    input,
    width: metadata.width || width,
    height: metadata.height || height,
  }
}

async function isBusyBadgeArea(source: sharp.Sharp, area: { left: number; top: number; width: number; height: number }) {
  try {
    const { data, info } = await source
      .clone()
      .extract(area)
      .removeAlpha()
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (!info.width || !info.height || data.length === 0) return true

    let sum = 0
    for (const value of data) sum += value
    const mean = sum / data.length
    let variance = 0
    for (const value of data) variance += (value - mean) ** 2
    const stdDev = Math.sqrt(variance / data.length)

    // Clean product photography usually has bright, low-detail corners. If the
    // corner is dark or visually busy, skip the badge rather than covering details.
    return mean < 205 || stdDev > 42
  } catch {
    return true
  }
}

function buildFallbackSvg() {
  const width = 1400
  const height = 1400
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#f6f1e6" />
          <stop offset="100%" stop-color="#e3d2a1" />
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bg)" />
      <rect x="78" y="78" width="${width - 156}" height="${height - 156}" rx="48" fill="#fffaf0" stroke="#c8a250" stroke-width="6" />
      <rect x="170" y="240" width="620" height="740" rx="32" fill="#ffffff" stroke="#cfb26b" stroke-width="6" />
      <rect x="850" y="280" width="360" height="70" rx="18" fill="#e9dcc0" />
      <rect x="850" y="390" width="260" height="48" rx="14" fill="#efe4cb" />
      <rect x="850" y="470" width="300" height="48" rx="14" fill="#efe4cb" />
      <rect x="850" y="550" width="230" height="48" rx="14" fill="#efe4cb" />
      <rect x="850" y="700" width="320" height="48" rx="14" fill="#efe4cb" />
      <rect x="850" y="780" width="280" height="48" rx="14" fill="#efe4cb" />
      <circle cx="480" cy="610" r="120" fill="#f2e8d1" stroke="#c8a250" stroke-width="14" />
      <circle cx="480" cy="610" r="62" fill="#fffaf0" stroke="#c8a250" stroke-width="10" />
      <rect x="360" y="430" width="240" height="70" rx="22" fill="#f2e8d1" />
      <rect x="410" y="965" width="140" height="20" rx="10" fill="#d7c18a" />
    </svg>
  `
  return { svg, width, height }
}

async function compositeBadge(source: sharp.Sharp, width: number, height: number, variant: BadgeVariant) {
  if (variant === 'none') return source.jpeg({ quality: 92 }).toBuffer()

  const badgeWidth = Math.max(170, Math.min(300, Math.round(width * 0.22)))
  const badge = await prepareBadgeAsset(variant, badgeWidth)
  const insetX = Math.max(22, Math.round(width * 0.032))
  const insetY = Math.max(18, Math.round(height * 0.032))
  const badgeArea = {
    left: insetX,
    top: Math.max(insetY, height - badge.height - insetY),
    width: Math.min(badge.width, width - insetX),
    height: Math.min(badge.height, height - Math.max(insetY, height - badge.height - insetY)),
  }

  if (badgeArea.width < 20 || badgeArea.height < 20) {
    return source.jpeg({ quality: 92 }).toBuffer()
  }

  if (await isBusyBadgeArea(source, badgeArea)) {
    return source.jpeg({ quality: 92 }).toBuffer()
  }

  return source
    .composite([
      {
        input: badge.input,
        top: badgeArea.top,
        left: insetX,
      },
    ])
    .jpeg({ quality: 92 })
    .toBuffer()
}

async function buildFallbackImage(variant: BadgeVariant) {
  const { svg, width, height } = buildFallbackSvg()
  return compositeBadge(sharp(Buffer.from(svg)), width, height, variant)
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url')
  const title = req.nextUrl.searchParams.get('title')?.trim() || 'Amazon Product'
  const asin = req.nextUrl.searchParams.get('asin')?.trim() || 'UNKNOWNASIN'
  const variant = chooseVariant(asin, title, req.nextUrl.searchParams.get('variant'))

  try {
    if (!url || !url.startsWith('http')) {
      const fallback = await buildFallbackImage(variant)
      return new NextResponse(new Uint8Array(fallback), {
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=2592000',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    const imageResponse = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: 'https://www.amazon.com/',
      },
      signal: AbortSignal.timeout(10000),
    })

    if (!imageResponse.ok) {
      const fallback = await buildFallbackImage(variant)
      return new NextResponse(new Uint8Array(fallback), {
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=2592000',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    const sourceBuffer = Buffer.from(await imageResponse.arrayBuffer())
    const source = sharp(sourceBuffer)
    const metadata = await source.metadata()
    const width = metadata.width || 1200
    const height = metadata.height || 1200
    const output = await compositeBadge(source, width, height, variant)

    return new NextResponse(new Uint8Array(output), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=2592000',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch {
    try {
      const fallback = await buildFallbackImage(variant)
      return new NextResponse(new Uint8Array(fallback), {
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=2592000',
          'Access-Control-Allow-Origin': '*',
        },
      })
    } catch {
      return new NextResponse('Error generating image badge', { status: 500 })
    }
  }
}
