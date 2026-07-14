import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { queryRows, sql } from '@/lib/db'
import { EbayReconnectRequiredError, getValidEbayAccessToken } from '@/lib/ebay-auth'
import { hasEncodedTitleArtifact, repairEncodedEbayTitle } from '@/lib/html-entities'
import { ensureQuotaTables } from '@/lib/quota-tracker'

export const maxDuration = 300

const ENTRIES_PER_PAGE = 200
const MAX_SCAN_PAGES_PER_ACCOUNT = 60
const MAX_REVISES_PER_RUN = 50
const SCAN_CONCURRENCY = 4
const RUN_BUDGET_MS = 235_000

let callLogReady: Promise<void> | null = null

type EbayAccount = {
  id: number | null
  label: string
  accessToken: string
  sandboxMode: boolean
}

type LiveListing = {
  accountId: number | null
  accountLabel: string
  ebayListingId: string
  title: string
}

type RepairCandidate = LiveListing & {
  newTitle: string
}

type ActivePage = {
  listings: Array<{ ebayListingId: string; title: string }>
  totalPages: number
  totalEntries: number
}

class EbayScanError extends Error {
  constructor(message: string, public readonly code = 'EBAY_TITLE_SCAN_FAILED') {
    super(message)
    this.name = 'EbayScanError'
  }
}

async function logEbayCall(input: {
  callName: 'GetMyeBaySelling' | 'ReviseFixedPriceItem'
  userId: string | number
  success: boolean
  durationMs: number
  errorCode?: string
  errorMessage?: string
}) {
  // `recordApiCall` defensively re-runs schema checks on every invocation. A full-store
  // scan uses dozens of pages, so initialize once and write each exact call directly.
  callLogReady ||= ensureQuotaTables()
  await callLogReady
  const userId = Number(input.userId)
  await sql`
    INSERT INTO api_usage_log (provider, call_name, user_id, success, duration_ms, error_code, error_message)
    VALUES (
      'ebay',
      ${input.callName},
      ${Number.isFinite(userId) ? userId : null},
      ${input.success},
      ${input.durationMs},
      ${input.errorCode?.slice(0, 60) || null},
      ${input.errorMessage?.slice(0, 500) || null}
    )
  `.catch(() => {})
}

function tradingEndpoint(sandboxMode: boolean) {
  return sandboxMode
    ? 'https://api.sandbox.ebay.com/ws/api.dll'
    : 'https://api.ebay.com/ws/api.dll'
}

function escapeXml(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// Decode exactly one XML transport layer. Numeric/name entities are decoded before
// `&amp;` so a literal entity stored in the eBay title remains visible to the repair
// detector instead of being accidentally decoded recursively while parsing XML.
function decodeXmlLayer(value: string) {
  return String(value || '')
    .replace(/&#x([0-9a-f]{1,6});/gi, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16)
      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : ''
    })
    .replace(/&#([0-9]{1,7});/g, (_match, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10)
      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : ''
    })
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

function tag(block: string, name: string) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))
  return match?.[1] ? decodeXmlLayer(match[1].trim()) : ''
}

function getTradingError(text: string) {
  const errorCode = tag(text, 'ErrorCode') || ''
  const longMessage = tag(text, 'LongMessage') || tag(text, 'ShortMessage') || ''
  return {
    errorCode,
    message: longMessage || 'Unknown eBay Trading API error.',
  }
}

function buildGetActiveXml(accessToken: string, page: number) {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(accessToken)}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>${ENTRIES_PER_PAGE}</EntriesPerPage>
      <PageNumber>${page}</PageNumber>
    </Pagination>
  </ActiveList>
  <OutputSelector>ActiveList.ItemArray.Item.ItemID</OutputSelector>
  <OutputSelector>ActiveList.ItemArray.Item.Title</OutputSelector>
  <OutputSelector>ActiveList.PaginationResult.TotalNumberOfPages</OutputSelector>
  <OutputSelector>ActiveList.PaginationResult.TotalNumberOfEntries</OutputSelector>
</GetMyeBaySellingRequest>`
}

async function fetchActivePage(
  account: EbayAccount,
  page: number,
  appId: string,
  userId: string | number,
): Promise<ActivePage> {
  const startedAt = Date.now()
  try {
    const response = await fetch(tradingEndpoint(account.sandboxMode), {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-APP-NAME': appId,
        'Content-Type': 'text/xml',
      },
      body: buildGetActiveXml(account.accessToken, page),
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    const acknowledged = /<Ack>(Success|Warning)<\/Ack>/i.test(text)
    await logEbayCall({
      callName: 'GetMyeBaySelling',
      userId,
      success: response.ok && acknowledged,
      durationMs: Date.now() - startedAt,
      errorCode: response.ok && acknowledged ? undefined : getTradingError(text).errorCode || `HTTP_${response.status}`,
      errorMessage: response.ok && acknowledged ? undefined : getTradingError(text).message,
    })

    if (!response.ok || !acknowledged) {
      const detail = getTradingError(text)
      throw new EbayScanError(
        `Could not completely scan ${account.label}: ${detail.message}`,
      )
    }

    const blocks = [...text.matchAll(/<Item>([\s\S]*?)<\/Item>/gi)].map((match) => String(match[1] || ''))
    const listings = blocks
      .map((block) => ({
        ebayListingId: tag(block, 'ItemID'),
        title: tag(block, 'Title'),
      }))
      .filter((listing) => Boolean(listing.ebayListingId && listing.title))
    const totalPagesText = tag(text, 'TotalNumberOfPages')
    const totalEntriesText = tag(text, 'TotalNumberOfEntries')
    if (!/^\d+$/.test(totalPagesText) || !/^\d+$/.test(totalEntriesText)) {
      throw new EbayScanError(
        `eBay omitted pagination totals for ${account.label}. The scan cannot prove it is complete, so nothing was changed.`,
      )
    }
    const totalPages = Math.max(1, Number.parseInt(totalPagesText, 10))
    const totalEntries = Number.parseInt(totalEntriesText, 10)
    return { listings, totalPages, totalEntries }
  } catch (error) {
    if (error instanceof EbayScanError) throw error
    await logEbayCall({
      callName: 'GetMyeBaySelling',
      userId,
      success: false,
      durationMs: Date.now() - startedAt,
      errorCode: 'NETWORK',
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    throw new EbayScanError(`Could not completely scan ${account.label}. eBay did not respond in time.`)
  }
}

async function scanAccount(
  account: EbayAccount,
  appId: string,
  userId: string | number,
  startedAt: number,
): Promise<LiveListing[]> {
  const firstPage = await fetchActivePage(account, 1, appId, userId)
  if (firstPage.totalPages > MAX_SCAN_PAGES_PER_ACCOUNT) {
    throw new EbayScanError(
      `${account.label} has ${firstPage.totalPages} active-listing pages, above this repair's safe scan limit. Nothing was changed.`,
      'EBAY_TITLE_SCAN_TOO_LARGE',
    )
  }

  const pages = Array.from({ length: Math.max(0, firstPage.totalPages - 1) }, (_value, index) => index + 2)
  const all = [...firstPage.listings]
  for (let index = 0; index < pages.length; index += SCAN_CONCURRENCY) {
    if (Date.now() - startedAt > RUN_BUDGET_MS) {
      throw new EbayScanError('The complete eBay title scan could not finish inside the safe time limit. Nothing was changed.')
    }
    const batch = pages.slice(index, index + SCAN_CONCURRENCY)
    const results = await Promise.all(batch.map((page) => fetchActivePage(account, page, appId, userId)))
    for (const result of results) all.push(...result.listings)
  }

  const unique = new Map(all.map((listing) => [listing.ebayListingId, listing]))
  if (unique.size !== firstPage.totalEntries) {
    throw new EbayScanError(
      `eBay reported ${firstPage.totalEntries} live listings for ${account.label}, but only ${unique.size} were returned. The scan was incomplete, so nothing was changed.`,
    )
  }

  return [...unique.values()].map((listing) => ({
    accountId: account.id,
    accountLabel: account.label,
    ...listing,
  }))
}

async function getOwnedAccounts(userId: string | number): Promise<EbayAccount[]> {
  const accountRows = await queryRows<{ id: number; label: string }>`
    SELECT id, label
    FROM ebay_accounts
    WHERE user_id = ${userId}
      AND active = TRUE
    ORDER BY id ASC
  `

  if (accountRows.length === 0) {
    const credentials = await getValidEbayAccessToken(String(userId))
    if (!credentials?.accessToken) throw new EbayReconnectRequiredError()
    return [{
      id: null,
      label: 'Default eBay account',
      accessToken: credentials.accessToken,
      sandboxMode: Boolean(credentials.sandboxMode),
    }]
  }

  const accounts: EbayAccount[] = []
  for (const row of accountRows) {
    // `row.id` came from an ownership-filtered query. Never pass a request-provided
    // account ID into ebay-auth, whose legacy fallback could otherwise cross scopes.
    const credentials = await getValidEbayAccessToken(String(userId), row.id)
    if (!credentials?.accessToken) {
      throw new EbayReconnectRequiredError(`${row.label || 'An eBay account'} needs to be reconnected in Settings.`)
    }
    accounts.push({
      id: row.id,
      label: row.label || `eBay account ${row.id}`,
      accessToken: credentials.accessToken,
      sandboxMode: Boolean(credentials.sandboxMode),
    })
  }
  return accounts
}

async function scanAllAccounts(userId: string | number, startedAt = Date.now()) {
  const appId = process.env.EBAY_APP_ID || ''
  if (!appId) throw new EbayScanError('eBay application credentials are not configured.', 'EBAY_NOT_CONFIGURED')
  const accounts = await getOwnedAccounts(userId)
  const listings: LiveListing[] = []

  // Accounts are deliberately scanned one at a time. Page requests inside each account
  // use low concurrency, which keeps the complete scan quick without hammering eBay.
  for (const account of accounts) {
    listings.push(...await scanAccount(account, appId, userId, startedAt))
  }
  return { accounts, listings, appId }
}

function getCandidates(listings: LiveListing[]): RepairCandidate[] {
  const candidates: RepairCandidate[] = []
  for (const listing of listings) {
    if (!hasEncodedTitleArtifact(listing.title)) continue
    const newTitle = repairEncodedEbayTitle(listing.title)
    if (!newTitle || newTitle === listing.title || newTitle.length > 80) continue
    // Fail closed if the shared repair could not remove the complete artifact.
    if (hasEncodedTitleArtifact(newTitle)) continue
    candidates.push({ ...listing, newTitle })
  }
  return candidates
}

async function ensureRepairLockTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS ebay_title_entity_repair_locks (
      user_id INTEGER PRIMARY KEY,
      owner_token TEXT NOT NULL,
      locked_until TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `
}

async function acquireRepairLock(userId: string | number, ownerToken: string) {
  await ensureRepairLockTable()
  const rows = await queryRows<{ owner_token: string }>`
    INSERT INTO ebay_title_entity_repair_locks (user_id, owner_token, locked_until, updated_at)
    VALUES (${userId}, ${ownerToken}, NOW() + INTERVAL '6 minutes', NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      owner_token = EXCLUDED.owner_token,
      locked_until = EXCLUDED.locked_until,
      updated_at = NOW()
    WHERE ebay_title_entity_repair_locks.locked_until < NOW()
    RETURNING owner_token
  `
  return rows[0]?.owner_token === ownerToken
}

async function releaseRepairLock(userId: string | number, ownerToken: string) {
  await sql`
    DELETE FROM ebay_title_entity_repair_locks
    WHERE user_id = ${userId} AND owner_token = ${ownerToken}
  `.catch(() => {})
}

async function syncStoredTitle(userId: string | number, candidate: RepairCandidate) {
  try {
    await sql`
      UPDATE listed_asins
      SET title = ${candidate.newTitle}
      WHERE user_id = ${userId}
        AND ebay_listing_id = ${candidate.ebayListingId}
        AND ended_at IS NULL
    `
    // Zero updated rows is valid: the live audit can find listings not yet tracked
    // locally. Only a database error is a synchronization failure.
    return true
  } catch {
    return false
  }
}

async function reviseTitle(
  candidate: RepairCandidate,
  account: EbayAccount,
  appId: string,
  userId: string | number,
) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(account.accessToken)}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <Item>
    <ItemID>${escapeXml(candidate.ebayListingId)}</ItemID>
    <Title>${escapeXml(candidate.newTitle)}</Title>
  </Item>
</ReviseFixedPriceItemRequest>`

  const startedAt = Date.now()
  try {
    const response = await fetch(tradingEndpoint(account.sandboxMode), {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem',
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-APP-NAME': appId,
        'Content-Type': 'text/xml',
      },
      body: xml,
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    const ok = response.ok && /<Ack>(Success|Warning)<\/Ack>/i.test(text)
    const detail = getTradingError(text)
    await logEbayCall({
      callName: 'ReviseFixedPriceItem',
      userId,
      success: ok,
      durationMs: Date.now() - startedAt,
      errorCode: ok ? undefined : detail.errorCode || `HTTP_${response.status}`,
      errorMessage: ok ? undefined : detail.message,
    })
    return {
      ok,
      transient: !ok && (
        response.status >= 500 ||
        /limit|quota|temporar|try again|system error|service unavailable/i.test(`${detail.errorCode} ${detail.message}`)
      ),
    }
  } catch (error) {
    await logEbayCall({
      callName: 'ReviseFixedPriceItem',
      userId,
      success: false,
      durationMs: Date.now() - startedAt,
      errorCode: 'NETWORK',
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    return { ok: false, transient: true }
  }
}

function previewPayload(candidates: RepairCandidate[]) {
  return candidates.slice(0, 10).map((candidate) => ({
    account: candidate.accountLabel,
    ebayListingId: candidate.ebayListingId,
    before: candidate.title,
    after: candidate.newTitle,
  }))
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  try {
    const scan = await scanAllAccounts(session.user.id)
    const candidates = getCandidates(scan.listings)
    return apiOk({
      count: candidates.length,
      scanned: scan.listings.length,
      accountsScanned: scan.accounts.length,
      samples: previewPayload(candidates),
      message: candidates.length > 0
        ? `Found ${candidates.length} live title${candidates.length === 1 ? '' : 's'} with broken codes such as #x27. Previewed directly from eBay across ${scan.accounts.length} connected account${scan.accounts.length === 1 ? '' : 's'}.`
        : `All ${scan.listings.length} live eBay titles are clear of broken symbol codes.`,
    })
  } catch (error) {
    if (error instanceof EbayReconnectRequiredError) {
      return apiError(error.message, { status: 401, code: 'RECONNECT_REQUIRED' })
    }
    return apiError(error instanceof Error ? error.message : 'Could not completely scan live eBay titles.', {
      status: 500,
      code: error instanceof EbayScanError ? error.code : 'EBAY_TITLE_SCAN_FAILED',
    })
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })
  const body = await req.json().catch(() => ({}))
  if (!body?.confirmed) {
    return apiError('Pass { confirmed: true } to repair broken title symbols.', { status: 400, code: 'NOT_CONFIRMED' })
  }

  const ownerToken = randomUUID()
  const locked = await acquireRepairLock(session.user.id, ownerToken).catch(() => false)
  if (!locked) {
    return apiError('A title repair is already running. Wait for it to finish before clicking again.', {
      status: 409,
      code: 'TITLE_REPAIR_BUSY',
    })
  }

  const startedAt = Date.now()
  try {
    // Re-scan immediately after confirmation. Only exact, currently-live malformed titles
    // from this complete scan are eligible; no stale database title can be revised.
    const scan = await scanAllAccounts(session.user.id, startedAt)
    const candidates = getCandidates(scan.listings)
    if (candidates.length === 0) {
      return apiOk({
        updated: 0,
        failed: 0,
        attempted: 0,
        remaining: 0,
        verifiedClean: true,
        scanned: scan.listings.length,
        message: `All ${scan.listings.length} live eBay titles are already clear of broken symbol codes.`,
      })
    }

    const accountsByKey = new Map(scan.accounts.map((account) => [String(account.id ?? 'legacy'), account]))
    const selected = candidates.slice(0, MAX_REVISES_PER_RUN)
    let updated = 0
    let failed = 0
    let attempted = 0
    let transientStopped = false
    const dbSyncRetry: RepairCandidate[] = []

    for (const candidate of selected) {
      if (Date.now() - startedAt > RUN_BUDGET_MS) break
      const account = accountsByKey.get(String(candidate.accountId ?? 'legacy'))
      if (!account) {
        failed += 1
        attempted += 1
        continue
      }

      const result = await reviseTitle(candidate, account, scan.appId, session.user.id)
      attempted += 1
      if (result.ok) {
        updated += 1
        // The eBay Ack is the source of truth. Never make the local record look fixed
        // when the live revision failed or timed out.
        if (!await syncStoredTitle(session.user.id, candidate)) dbSyncRetry.push(candidate)
      } else {
        failed += 1
        if (result.transient) {
          transientStopped = true
          break
        }
      }
    }

    // A transient Neon error must be visible, not swallowed. Retry once after the eBay
    // loop; live titles remain the source of truth even if local synchronization fails.
    let dbSyncFailures = 0
    for (const candidate of dbSyncRetry) {
      if (!await syncStoredTitle(session.user.id, candidate)) dbSyncFailures += 1
    }

    let remaining = Math.max(0, candidates.length - updated)
    let liveVerifiedClean = false
    let verificationPending = false

    // Only claim a clean store after a second complete live scan. Partial batches and
    // failures return an honest remaining count and are continued with another click.
    if (remaining === 0 && !transientStopped && Date.now() - startedAt < 205_000) {
      try {
        const verification = await scanAllAccounts(session.user.id, startedAt)
        remaining = getCandidates(verification.listings).length
        liveVerifiedClean = remaining === 0
      } catch {
        verificationPending = true
      }
    }

    const verifiedClean = liveVerifiedClean && dbSyncFailures === 0

    const message = verifiedClean
      ? `Fixed ${updated} title${updated === 1 ? '' : 's'} and verified every live eBay title is clear.`
      : liveVerifiedClean && dbSyncFailures > 0
        ? `Every live eBay title is clear, but ${dbSyncFailures} local database title update${dbSyncFailures === 1 ? '' : 's'} failed after retry. The live store is fixed; investigate the database sync before calling the records fully synchronized.`
      : verificationPending
        ? `Fixed ${updated} title${updated === 1 ? '' : 's'}, but the final full-store verification could not finish. Run the scan again before treating the store as fully clear.`
        : transientStopped
          ? `Fixed ${updated} title${updated === 1 ? '' : 's'}. eBay temporarily stopped responding, so the run paused safely with ${remaining} still to check.`
          : `Fixed ${updated} title${updated === 1 ? '' : 's'}.${failed > 0 ? ` ${failed} could not be revised.` : ''} ${remaining} malformed title${remaining === 1 ? '' : 's'} remain; click again to continue.`

    return apiOk({
      updated,
      failed,
      attempted,
      remaining,
      verifiedClean,
      liveVerifiedClean,
      dbSyncFailures,
      verificationPending,
      scanned: scan.listings.length,
      message,
    })
  } catch (error) {
    if (error instanceof EbayReconnectRequiredError) {
      return apiError(error.message, { status: 401, code: 'RECONNECT_REQUIRED' })
    }
    return apiError(error instanceof Error ? error.message : 'Could not safely repair live eBay titles.', {
      status: 500,
      code: error instanceof EbayScanError ? error.code : 'EBAY_TITLE_REPAIR_FAILED',
    })
  } finally {
    await releaseRepairLock(session.user.id, ownerToken)
  }
}
