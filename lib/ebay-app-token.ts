// Shared eBay Browse API OAuth helper (client-credentials grant).
// Used by ebay-competition (competitor counts/prices) and demand-scout (trending
// product discovery). One token covers the entire app for ~2 hours, so we cache.

let tokenCache: { token: string; expiresAt: number } | null = null

export async function getEbayAppToken(): Promise<string | null> {
  const appId = process.env.EBAY_APP_ID
  const certId = process.env.EBAY_CERT_ID
  if (!appId || !certId) return null
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token

  const basic = Buffer.from(`${appId}:${certId}`).toString('base64')
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
    signal: AbortSignal.timeout(8000),
  }).catch(() => null)
  if (!res || !res.ok) return null
  const j = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null
  if (!j?.access_token) return null
  tokenCache = { token: j.access_token, expiresAt: Date.now() + (j.expires_in || 7200) * 1000 }
  return j.access_token
}
