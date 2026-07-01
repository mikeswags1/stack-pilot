import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { sql } from '@/lib/db'

// ── eBay Marketplace Account Deletion / Closure notification endpoint ─────────────
// Required by eBay for any app that stores eBay user data, and a prerequisite for the
// Application Growth Check (increased API call limits).
//
// Setup handshake: eBay sends GET ?challenge_code=XXX. We must reply with
//   { "challengeResponse": sha256(challengeCode + verificationToken + endpointUrl) }
// hex-encoded, as JSON, 200. The three values are concatenated in THAT exact order.
//
// Ongoing: eBay POSTs a notification when a user closes their account / requests data
// deletion. We ack 200 and best-effort purge any stored data tied to that eBay user.

// A shared secret (32–80 chars, [a-zA-Z0-9_-]) — must EXACTLY match the token entered in
// the eBay Developer console. Overridable via env; the default lets it work out of the box.
const VERIFICATION_TOKEN =
  process.env.EBAY_DELETION_VERIFICATION_TOKEN ||
  'stackpilot-ebay-acct-deletion-4f8a2e6c9b1d7053af62e8c4b9d0f715'

function endpointUrl(req: NextRequest): string {
  // Must match the URL registered in eBay. Derive it from the request host so it works
  // on whatever domain eBay actually calls (vercel.app or a custom domain).
  if (process.env.EBAY_DELETION_ENDPOINT_URL) return process.env.EBAY_DELETION_ENDPOINT_URL
  const host = req.headers.get('host') || 'stackpilot-app.vercel.app'
  return `https://${host}/api/ebay/account-deletion`
}

// GET — eBay's verification challenge.
export async function GET(req: NextRequest) {
  const challengeCode = req.nextUrl.searchParams.get('challenge_code')
  if (!challengeCode) {
    return NextResponse.json({ error: 'missing challenge_code' }, { status: 400 })
  }
  const hash = crypto.createHash('sha256')
  hash.update(challengeCode)
  hash.update(VERIFICATION_TOKEN)
  hash.update(endpointUrl(req))
  return NextResponse.json({ challengeResponse: hash.digest('hex') }, { status: 200 })
}

// POST — actual account-deletion notification. Ack fast with 200, then best-effort purge.
export async function POST(req: NextRequest) {
  let body: unknown = null
  try {
    body = await req.json()
  } catch {
    // eBay expects a 200 even if we can't parse — never make it retry into an error loop.
    return new NextResponse(null, { status: 200 })
  }

  try {
    const data = (body as { notification?: { data?: { username?: string; userId?: string } } })?.notification?.data
    const username = data?.username
    const userId = data?.userId
    // Best-effort removal of any stored data tied to this eBay user. StackPilot keys its
    // records by its OWN user accounts, so these are defensive no-ops on schemas without
    // an eBay-username column (wrapped so a missing column can't error the ack).
    if (username) {
      await sql`DELETE FROM ebay_accounts WHERE ebay_username = ${username}`.catch(() => {})
      await sql`DELETE FROM ebay_credentials WHERE ebay_username = ${username}`.catch(() => {})
    }
    await sql`
      INSERT INTO ebay_account_deletion_log (ebay_username, ebay_user_id, received_at)
      VALUES (${username || null}, ${userId || null}, NOW())
    `.catch(async () => {
      // Create the audit table on first use, then retry once.
      await sql`
        CREATE TABLE IF NOT EXISTS ebay_account_deletion_log (
          id BIGSERIAL PRIMARY KEY,
          ebay_username TEXT,
          ebay_user_id TEXT,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`.catch(() => {})
      await sql`INSERT INTO ebay_account_deletion_log (ebay_username, ebay_user_id) VALUES (${username || null}, ${userId || null})`.catch(() => {})
    })
  } catch {
    // Swallow — eBay must always get a 200 so it marks the notification delivered.
  }

  return new NextResponse(null, { status: 200 })
}
