import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk, getErrorText } from '@/lib/api-response'
import { getValidEbayAccessToken } from '@/lib/ebay-auth'
import { queryRows, sql } from '@/lib/db'

type FeedbackCandidate = {
  orderId: string
  lineItemId: string
  itemId: string
  buyerUsername: string
  title: string
  soldAt: string
  estimatedDeliveryDate?: string
  reason: string
}

type EbayOrder = {
  orderId?: string
  creationDate?: string
  orderFulfillmentStatus?: string
  buyer?: { username?: string }
  lineItems?: Array<{
    lineItemId?: string
    legacyItemId?: string
    title?: string
    lineItemFulfillmentStatus?: string
    deliveryCost?: unknown
    lineItemFulfillmentInstructions?: {
      maxEstimatedDeliveryDate?: string
      minEstimatedDeliveryDate?: string
    }
  }>
}

const FEEDBACK_SUBJECT = 'Thanks for your order'
const FEEDBACK_BODY = [
  'Hi, thank you again for your order.',
  '',
  'If everything arrived safely and you are happy with your purchase, positive feedback would be greatly appreciated.',
  '',
  'If there is any issue at all, please message me first and I will be happy to help make it right.',
  '',
  'Thank you!',
].join('\n')

function escapeXml(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function stripXml(value: string, tag: string) {
  const match = value.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() || ''
}

function getTradingBase(sandboxMode?: boolean) {
  return sandboxMode ? 'https://api.sandbox.ebay.com/ws/api.dll' : 'https://api.ebay.com/ws/api.dll'
}

async function callTradingApi(args: {
  token: string
  sandboxMode?: boolean
  callName: string
  xml: string
}) {
  const appId = process.env.EBAY_APP_ID
  if (!appId) throw new Error('eBay app credentials are not configured.')

  const res = await fetch(getTradingBase(args.sandboxMode), {
    method: 'POST',
    headers: {
      'X-EBAY-API-CALL-NAME': args.callName,
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1453',
      'X-EBAY-API-APP-NAME': appId,
      Authorization: `Bearer ${args.token}`,
      'Content-Type': 'text/xml',
    },
    body: args.xml,
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`eBay Trading API ${args.callName} failed (${res.status}).`)

  const ack = stripXml(text, 'Ack')
  if (ack && !/^(Success|Warning)$/i.test(ack)) {
    const short = stripXml(text, 'ShortMessage')
    const long = stripXml(text, 'LongMessage')
    throw new Error(long || short || `eBay Trading API ${args.callName} failed.`)
  }

  return text
}

async function ensureFeedbackRequestTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS ebay_feedback_requests (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      line_item_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      buyer_username TEXT NOT NULL,
      title TEXT,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, line_item_id)
    )
  `.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS ebay_feedback_requests_user_idx ON ebay_feedback_requests (user_id, sent_at DESC)`.catch(() => {})
}

async function loadFulfilledOrders(token: string, sandboxMode?: boolean) {
  const base = sandboxMode ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'
  const url = new URL(`${base}/sell/fulfillment/v1/order`)
  url.searchParams.set('limit', '100')
  url.searchParams.set('filter', 'orderfulfillmentstatus:{FULFILLED}')

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Language': 'en-US',
    },
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Unable to load fulfilled orders from eBay (${res.status}). ${text.slice(0, 200)}`)
  }

  const data = await res.json()
  return Array.isArray(data.orders) ? data.orders as EbayOrder[] : []
}

function isLikelyDelivered(order: EbayOrder, lineItem: NonNullable<EbayOrder['lineItems']>[number]) {
  const now = Date.now()
  const estimated = lineItem.lineItemFulfillmentInstructions?.maxEstimatedDeliveryDate
  if (estimated) {
    const deliveredAfter = new Date(estimated).getTime() + 24 * 60 * 60 * 1000
    if (Number.isFinite(deliveredAfter) && deliveredAfter <= now) {
      return { ok: true, reason: 'estimated delivery date has passed', estimatedDeliveryDate: estimated }
    }
  }

  const soldAt = order.creationDate ? new Date(order.creationDate).getTime() : 0
  if (Number.isFinite(soldAt) && soldAt > 0 && now - soldAt >= 10 * 24 * 60 * 60 * 1000) {
    return { ok: true, reason: 'fulfilled order is 10+ days old', estimatedDeliveryDate: estimated }
  }

  return { ok: false, reason: 'not old enough yet', estimatedDeliveryDate: estimated }
}

async function hasBuyerFeedback(args: {
  token: string
  sandboxMode?: boolean
  orderLineItemId: string
  buyerUsername: string
}) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetFeedbackRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(args.token)}</eBayAuthToken></RequesterCredentials>
  <OrderLineItemID>${escapeXml(args.orderLineItemId)}</OrderLineItemID>
  <DetailLevel>ReturnAll</DetailLevel>
</GetFeedbackRequest>`
  const text = await callTradingApi({
    token: args.token,
    sandboxMode: args.sandboxMode,
    callName: 'GetFeedback',
    xml,
  })
  const details = text.match(/<FeedbackDetail\b[\s\S]*?<\/FeedbackDetail>/gi) || []
  const buyer = args.buyerUsername.toLowerCase()
  return details.some((detail) => {
    const commenter = stripXml(detail, 'CommentingUser').toLowerCase()
    const role = stripXml(detail, 'Role').toLowerCase()
    return commenter === buyer || role === 'buyer'
  })
}

async function loadSentLineItemIds(userId: string) {
  await ensureFeedbackRequestTable()
  const rows = await queryRows<{ line_item_id: string }>`
    SELECT line_item_id
    FROM ebay_feedback_requests
    WHERE user_id = ${userId}
  `.catch(() => [])
  return new Set(rows.map((row) => String(row.line_item_id)))
}

async function buildCandidates(userId: string, token: string, sandboxMode?: boolean) {
  const [orders, sentLineItemIds] = await Promise.all([
    loadFulfilledOrders(token, sandboxMode),
    loadSentLineItemIds(userId),
  ])
  const candidates: FeedbackCandidate[] = []
  const checked: string[] = []

  for (const order of orders) {
    if (candidates.length >= 25) break
    const orderId = String(order.orderId || '')
    const buyerUsername = String(order.buyer?.username || '').trim()
    if (!orderId || !buyerUsername) continue

    for (const lineItem of order.lineItems || []) {
      if (candidates.length >= 25) break
      const lineItemId = String(lineItem.lineItemId || '').trim()
      const itemId = String(lineItem.legacyItemId || lineItemId.split('-')[0] || '').trim()
      if (!lineItemId || !itemId || sentLineItemIds.has(lineItemId)) continue

      const delivered = isLikelyDelivered(order, lineItem)
      if (!delivered.ok) continue

      checked.push(lineItemId)
      const alreadyLeftFeedback = await hasBuyerFeedback({
        token,
        sandboxMode,
        orderLineItemId: lineItemId,
        buyerUsername,
      }).catch(() => true)
      if (alreadyLeftFeedback) continue

      candidates.push({
        orderId,
        lineItemId,
        itemId,
        buyerUsername,
        title: String(lineItem.title || 'eBay order').slice(0, 180),
        soldAt: order.creationDate || '',
        estimatedDeliveryDate: delivered.estimatedDeliveryDate,
        reason: delivered.reason,
      })
    }
  }

  return { candidates, checkedCount: checked.length, scannedOrders: orders.length }
}

async function sendFeedbackRequest(args: {
  userId: string
  token: string
  sandboxMode?: boolean
  candidate: FeedbackCandidate
}) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<AddMemberMessageAAQToPartnerRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(args.token)}</eBayAuthToken></RequesterCredentials>
  <ItemID>${escapeXml(args.candidate.itemId)}</ItemID>
  <MemberMessage>
    <Subject>${escapeXml(FEEDBACK_SUBJECT)}</Subject>
    <Body>${escapeXml(FEEDBACK_BODY)}</Body>
    <QuestionType>General</QuestionType>
    <RecipientID>${escapeXml(args.candidate.buyerUsername)}</RecipientID>
    <EmailCopyToSender>false</EmailCopyToSender>
  </MemberMessage>
</AddMemberMessageAAQToPartnerRequest>`

  await callTradingApi({
    token: args.token,
    sandboxMode: args.sandboxMode,
    callName: 'AddMemberMessageAAQToPartner',
    xml,
  })

  await ensureFeedbackRequestTable()
  await sql`
    INSERT INTO ebay_feedback_requests (user_id, order_id, line_item_id, item_id, buyer_username, title, sent_at)
    VALUES (
      ${args.userId},
      ${args.candidate.orderId},
      ${args.candidate.lineItemId},
      ${args.candidate.itemId},
      ${args.candidate.buyerUsername},
      ${args.candidate.title},
      NOW()
    )
    ON CONFLICT (user_id, line_item_id) DO NOTHING
  `
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  try {
    const credentials = await getValidEbayAccessToken(session.user.id)
    if (!credentials?.accessToken) {
      return apiError('eBay is not connected. Open Settings and reconnect your account.', { status: 401, code: 'RECONNECT_REQUIRED' })
    }

    const result = await buildCandidates(String(session.user.id), credentials.accessToken, credentials.sandboxMode)
    return apiOk({
      ...result,
      count: result.candidates.length,
      message: result.candidates.length === 0
        ? `Scanned ${result.scannedOrders} fulfilled orders. No delivered orders without buyer feedback found.`
        : `Found ${result.candidates.length} delivered order${result.candidates.length === 1 ? '' : 's'} without buyer feedback.`,
    })
  } catch (error) {
    return apiError(getErrorText(error, 'Failed to preview feedback requests.'), { status: 500, code: 'FEEDBACK_REQUEST_PREVIEW_FAILED' })
  }
}

export async function POST() {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  try {
    const credentials = await getValidEbayAccessToken(session.user.id)
    if (!credentials?.accessToken) {
      return apiError('eBay is not connected. Open Settings and reconnect your account.', { status: 401, code: 'RECONNECT_REQUIRED' })
    }

    const result = await buildCandidates(String(session.user.id), credentials.accessToken, credentials.sandboxMode)
    const selected = result.candidates.slice(0, 10)
    let sent = 0
    let failed = 0

    for (const candidate of selected) {
      try {
        await sendFeedbackRequest({
          userId: String(session.user.id),
          token: credentials.accessToken,
          sandboxMode: credentials.sandboxMode,
          candidate,
        })
        sent += 1
      } catch {
        failed += 1
      }
    }

    return apiOk({
      sent,
      failed,
      total: result.candidates.length,
      message: `${sent} feedback request${sent === 1 ? '' : 's'} sent.${failed > 0 ? ` ${failed} failed.` : ''}${result.candidates.length > selected.length ? ` ${result.candidates.length - selected.length} remain for another run.` : ''}`,
    })
  } catch (error) {
    return apiError(getErrorText(error, 'Failed to send feedback requests.'), { status: 500, code: 'FEEDBACK_REQUEST_SEND_FAILED' })
  }
}
