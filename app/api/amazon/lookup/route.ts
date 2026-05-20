import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { fetchAmazonProductByAsin } from '@/lib/amazon-product'
import { sql } from '@/lib/db'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const asin = req.nextUrl.searchParams.get('asin')
  if (!asin || !/^[A-Z0-9]{10}$/i.test(asin)) {
    return apiError('Invalid ASIN. It must be 10 characters, for example B08N5WRWNW.', {
      status: 400,
      code: 'INVALID_ASIN',
    })
  }

  const product = await fetchAmazonProductByAsin({ asin, strictAsin: true })
  if (!product) {
    return apiError('ASIN validation failed. The Amazon product is missing a valid title, price, or primary image.', {
      status: 404,
      code: 'ASIN_VALIDATION_FAILED',
    })
  }

  if (product.available === false) {
    await sql`
      UPDATE product_source_items
      SET active = FALSE,
          source_quality = 'reject',
          last_intelligence_at = NOW(),
          last_seen_at = NOW()
      WHERE UPPER(asin) = UPPER(${product.asin})
    `.catch(() => {})
  }

  return apiOk({
    asin: product.asin,
    title: product.title,
    amazonPrice: product.amazonPrice,
    imageUrl: product.imageUrl,
    images: product.images,
    features: product.features,
    description: product.description,
    specs: product.specs,
    available: product.available,
    amazonUrl: `https://www.amazon.com/dp/${product.asin}`,
    source: product.source,
  })
}
