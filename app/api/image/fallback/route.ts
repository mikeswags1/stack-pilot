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

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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

function splitTitle(title: string) {
  const words = title.trim().split(/\s+/).slice(0, 14)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > 28 && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }

  if (current) lines.push(current)
  return lines.slice(0, 4)
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

export async function GET(req: NextRequest) {
  const asin = req.nextUrl.searchParams.get('asin')?.trim() || 'Amazon Product'
  const title = req.nextUrl.searchParams.get('title')?.trim() || `Amazon Product ${asin}`
  const variant = chooseVariant(asin, title, req.nextUrl.searchParams.get('variant'))

  try {
    const width = 1400
    const height = 1400
    const titleLines = splitTitle(title)
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
        <text x="120" y="220" fill="#8f6d2d" font-size="40" font-family="Arial, Helvetica, sans-serif" font-weight="700" letter-spacing="4">STACKPILOT LISTING</text>
        ${titleLines
          .map(
            (line, index) =>
              `<text x="120" y="${360 + index * 94}" fill="#23180b" font-size="58" font-family="Arial, Helvetica, sans-serif" font-weight="700">${escapeHtml(line)}</text>`
          )
          .join('')}
        <text x="120" y="980" fill="#4a3920" font-size="36" font-family="Arial, Helvetica, sans-serif">ASIN: ${escapeHtml(asin)}</text>
        <text x="120" y="1070" fill="#4a3920" font-size="34" font-family="Arial, Helvetica, sans-serif">Fast handling, free shipping, 30-day returns</text>
        <text x="120" y="1160" fill="#7b6232" font-size="30" font-family="Arial, Helvetica, sans-serif">Generated fallback image used when product media is unavailable.</text>
      </svg>
    `

    let output = sharp(Buffer.from(svg)).jpeg({ quality: 92 })
    if (variant !== 'none') {
      const badge = await prepareBadgeAsset(variant, 340)
      output = sharp(Buffer.from(svg))
        .composite([
          {
            input: badge.input,
            top: height - badge.height - 56,
            left: 56,
          },
        ])
        .jpeg({ quality: 92 })
    }
    const buffer = await output.toBuffer()

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=2592000',
      },
    })
  } catch {
    return new NextResponse('Error generating fallback image', { status: 500 })
  }
}
