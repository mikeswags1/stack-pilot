import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { promises as fs } from 'fs'
import sharp from 'sharp'

export const dynamic = 'force-dynamic'

const STAMP_PATH = path.join(process.cwd(), 'public', 'free-shipping-stamp.png')

async function prepareStampOverlay(stampBuffer: Buffer, width: number) {
  const input = await sharp(stampBuffer)
    .ensureAlpha()
    .trim({ threshold: 18 })
    .resize({ width })
    .png()
    .toBuffer()
  const metadata = await sharp(input).metadata()
  return {
    input,
    width: metadata.width || width,
    height: metadata.height || width,
  }
}

async function buildFallbackImage(title: string, asin: string) {
  const stampBuffer = await fs.readFile(STAMP_PATH)
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
  const stampWidth = 500
  const stamp = await prepareStampOverlay(stampBuffer, stampWidth)

  return sharp(Buffer.from(svg))
    .composite([
      {
        input: stamp.input,
        top: height - stamp.height - 42,
        left: 18,
      },
    ])
    .jpeg({ quality: 92 })
    .toBuffer()
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url')
  const title = req.nextUrl.searchParams.get('title')?.trim() || 'Amazon Product'
  const asin = req.nextUrl.searchParams.get('asin')?.trim() || 'UNKNOWNASIN'

  try {
    if (!url || !url.startsWith('http')) {
      const fallback = await buildFallbackImage(title, asin)
      return new NextResponse(new Uint8Array(fallback), {
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=2592000',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    const [imageResponse, stampBuffer] = await Promise.all([
      fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          Referer: 'https://www.amazon.com/',
        },
        signal: AbortSignal.timeout(10000),
      }),
      fs.readFile(STAMP_PATH),
    ])

    if (!imageResponse.ok) {
      const fallback = await buildFallbackImage(title, asin)
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

    const stampWidth = Math.max(300, Math.min(520, Math.round(width * 0.38)))
    const stamp = await prepareStampOverlay(stampBuffer, stampWidth)
    const insetX = Math.max(10, Math.round(width * 0.015))
    const insetY = Math.max(14, Math.round(height * 0.03))

    const output = await source
      .composite([
        {
          input: stamp.input,
          top: Math.max(14, height - stamp.height - insetY),
          left: insetX,
        },
      ])
      .jpeg({ quality: 92 })
      .toBuffer()

    return new NextResponse(new Uint8Array(output), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=2592000',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch {
    try {
      const fallback = await buildFallbackImage(title, asin)
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
