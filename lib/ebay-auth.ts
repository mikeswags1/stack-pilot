import { queryRows, sql } from '@/lib/db'

export const EBAY_OAUTH_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.finances',
  'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.marketing',
  'https://api.ebay.com/oauth/api_scope/sell.marketing.readonly',
  // Offers-to-watchers (Negotiation API) — added 2026-07-17 so the app can send
  // margin-safe discount offers to interested buyers automatically. Takes effect
  // after the user reconnects their eBay account (consent screen re-approval).
  'https://api.ebay.com/oauth/api_scope/sell.negotiation',
]

const EBAY_REFRESH_FALLBACK_SCOPES = EBAY_OAUTH_SCOPES.filter(
  (scope) =>
    !scope.includes('/sell.analytics.readonly') &&
    !scope.includes('/sell.marketing') &&
    !scope.includes('/sell.negotiation')
)

export const EBAY_MINIMAL_OAUTH_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
]

type StoredEbayCredentials = {
  id?: number
  oauth_token?: string
  refresh_token?: string
  token_expires_at?: string
  sandbox_mode?: boolean
}

export class EbayReconnectRequiredError extends Error {
  constructor(message = 'Your eBay session expired. Reconnect your account in Settings.') {
    super(message)
    this.name = 'EbayReconnectRequiredError'
  }
}

export class EbayNetworkError extends Error {
  constructor(message = 'Unable to reach eBay right now. Please try again in a minute or reconnect eBay in Settings.') {
    super(message)
    this.name = 'EbayNetworkError'
  }
}

export async function getStoredEbayCredentials(userId: string, accountId?: number | null) {
  // Prefer multi-account table when present. Falls back to legacy `ebay_credentials`.
  const uid = String(userId)
  const accountRows = await queryRows<StoredEbayCredentials>`
    SELECT id, oauth_token, refresh_token, token_expires_at, sandbox_mode
    FROM ebay_accounts
    WHERE user_id = ${uid}
      AND active = TRUE
      AND (${accountId ?? null}::int IS NULL OR id = ${accountId ?? null})
    ORDER BY id ASC
    LIMIT 1
  `.catch(() => [])

  if (accountRows[0]) return accountRows[0]

  const legacyRows = await queryRows<StoredEbayCredentials>`
    SELECT oauth_token, refresh_token, token_expires_at, sandbox_mode
    FROM ebay_credentials
    WHERE user_id = ${uid}
    LIMIT 1
  `.catch(() => [])

  return legacyRows[0] || null
}

export function isEbayTokenExpired(tokenExpiresAt?: string, bufferMs = 5 * 60 * 1000) {
  if (!tokenExpiresAt) return true
  return new Date(tokenExpiresAt) < new Date(Date.now() + bufferMs)
}

export async function refreshEbayAccessToken(userId: string, refreshToken: string) {
  const appId = process.env.EBAY_APP_ID
  const certId = process.env.EBAY_CERT_ID

  if (!appId || !certId) {
    throw new Error('eBay app credentials are not configured')
  }

  const credentials = Buffer.from(`${appId}:${certId}`).toString('base64')
  const requestRefresh = (scopes: string[]) =>
    fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: scopes.join(' '),
      }),
    })

  let response: Response
  try {
    response = await requestRefresh(EBAY_OAUTH_SCOPES)
  } catch {
    throw new EbayNetworkError()
  }

  let data = await response.json().catch(() => null)
  if (!response.ok && /scope/i.test(String(data?.error_description || data?.error || ''))) {
    try {
      response = await requestRefresh(EBAY_REFRESH_FALLBACK_SCOPES)
      data = await response.json().catch(() => null)
    } catch {
      throw new EbayNetworkError()
    }
  }
  if (!response.ok || !data.access_token) {
    const detail = String(data?.error_description || data?.error || '')
    if (response.status === 400 || response.status === 401 || /invalid|expired|revoked/i.test(detail)) {
      throw new EbayReconnectRequiredError()
    }

    throw new Error(detail || `eBay token refresh failed (${response.status})`)
  }

  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString()
  // Update whichever table holds the refresh token.
  await sql`
    UPDATE ebay_accounts
    SET oauth_token = ${data.access_token}, token_expires_at = ${expiresAt}, updated_at = NOW()
    WHERE user_id = ${userId} AND refresh_token = ${refreshToken}
  `.catch(() => {})
  await sql`
    UPDATE ebay_credentials
    SET oauth_token = ${data.access_token}, token_expires_at = ${expiresAt}, updated_at = NOW()
    WHERE user_id = ${userId}
  `.catch(() => {})

  return {
    accessToken: data.access_token as string,
    expiresAt,
  }
}

export async function getValidEbayAccessToken(userId: string, accountId?: number | null) {
  const credentials = await getStoredEbayCredentials(userId, accountId)
  if (!credentials) return null

  const oauthToken = credentials.oauth_token ? String(credentials.oauth_token) : ''
  const refreshToken = credentials.refresh_token ? String(credentials.refresh_token) : ''

  if (oauthToken && !isEbayTokenExpired(credentials.token_expires_at)) {
    return {
      accessToken: oauthToken,
      sandboxMode: Boolean(credentials.sandbox_mode),
      refreshed: false,
    }
  }

  if (!refreshToken) return null

  const refreshed = await refreshEbayAccessToken(userId, refreshToken)
  return {
    accessToken: refreshed.accessToken,
    sandboxMode: Boolean(credentials.sandbox_mode),
    refreshed: true,
    expiresAt: refreshed.expiresAt,
  }
}
