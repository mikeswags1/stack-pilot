#!/usr/bin/env node

/**
 * Repair literal HTML-entity residue in live eBay titles.
 *
 * Safety properties:
 *   - Preview/read-only by default. Listing and DB writes require explicit --apply.
 *   - Candidates come from a complete live GetMyeBaySelling scan, not listed_asins.title.
 *   - The repair only decodes recognized entities; it never changes a legitimate bare `&`.
 *   - ReviseFixedPriceItem sends ItemID + Title only. No price, quantity, image, SEO, or
 *     brand fields are touched.
 *   - listed_asins.title is updated only after eBay returns Ack=Success or Ack=Warning.
 *   - Apply mode finishes with another complete live scan and exits nonzero if any
 *     malformed title remains.
 *
 * Usage:
 *   node scripts/repair-encoded-ebay-titles.mjs
 *   node scripts/repair-encoded-ebay-titles.mjs --user=1
 *   node scripts/repair-encoded-ebay-titles.mjs --user=1 --apply
 *   node scripts/repair-encoded-ebay-titles.mjs --all-users --apply
 */

import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const ENTRIES_PER_PAGE = 200
const MAX_PAGES_PER_ACCOUNT = 100
const SCAN_CONCURRENCY = 4
const REVISION_DELAY_MS = 100
const TOKEN_EXPIRY_BUFFER_MS = 10 * 60 * 1000

function usage() {
  console.log(`Usage: node scripts/repair-encoded-ebay-titles.mjs [--user=<id>] [--all-users] [--apply]

Default mode is a live, read-only preview. No listing or database title is changed
unless --apply is present. --user limits the scan to one StackPilot user; otherwise
every active row in ebay_accounts is previewed. Apply mode requires either an explicit
--user=<id> scope or the explicit --all-users acknowledgement.`)
}

function parseArgs(argv) {
  let apply = false
  let allUsers = false
  let userId = null

  for (const arg of argv) {
    if (arg === '--apply') {
      apply = true
      continue
    }
    if (arg === '--all-users') {
      allUsers = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    }
    if (arg.startsWith('--user=')) {
      const value = Number(arg.slice('--user='.length))
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Invalid --user value: ${arg}`)
      }
      userId = value
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  if (allUsers && userId !== null) throw new Error('Choose either --user=<id> or --all-users, not both.')
  if (apply && userId === null && !allUsers) {
    throw new Error('Apply mode requires --user=<id>. Use --all-users only when intentionally repairing every active account.')
  }

  return { apply, allUsers, userId }
}

function loadLocalEnv() {
  const envPath = path.resolve(process.cwd(), '.env.local')
  if (!fs.existsSync(envPath)) return

  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
  }
}

const { apply: APPLY, allUsers: ALL_USERS, userId: USER_ID } = parseArgs(process.argv.slice(2))
loadLocalEnv()

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.')
if (!process.env.EBAY_APP_ID) throw new Error('EBAY_APP_ID is not configured.')

const sql = neon(process.env.DATABASE_URL)

// Keep this detector/decoder equivalent to lib/html-entities.ts. It recognizes encoded
// residue only; a normal title such as "Home & Garden" is deliberately not a candidate.
const NAMED_HTML_ENTITIES = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}

const TITLE_ENTITY_ARTIFACT =
  /&(?:amp;)*(?:#(?:x[0-9a-f]{1,6}|[0-9]{1,7});?|(?:amp|apos|gt|lt|nbsp|quot);)/i

function validCodePoint(codePoint) {
  return Number.isFinite(codePoint) &&
    codePoint >= 0 &&
    codePoint <= 0x10ffff &&
    !(codePoint >= 0xd800 && codePoint <= 0xdfff)
}

function decodeNumericEntity(match, hexValue, decimalValue) {
  const codePoint = Number.parseInt(hexValue || decimalValue || '', hexValue ? 16 : 10)
  if (!validCodePoint(codePoint)) return match
  try {
    return String.fromCodePoint(codePoint)
  } catch {
    return match
  }
}

function decodeHtmlEntityPass(value) {
  return value
    .replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));?/gi, decodeNumericEntity)
    .replace(/&(amp|apos|gt|lt|nbsp|quot);/gi, (match, name) => (
      NAMED_HTML_ENTITIES[name.toLowerCase()] ?? match
    ))
}

function decodeHtmlEntitiesDeep(value, maxPasses = 4) {
  let decoded = String(value || '')
  for (let pass = 0; pass < Math.max(1, Math.min(8, maxPasses)); pass += 1) {
    const next = decodeHtmlEntityPass(decoded)
    if (next === decoded) break
    decoded = next
  }
  return decoded
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201f]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00a0/g, ' ')
}

function hasEncodedTitleArtifact(value) {
  return TITLE_ENTITY_ARTIFACT.test(String(value || ''))
}

function repairEncodedEbayTitle(value) {
  return decodeHtmlEntitiesDeep(value)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// Decode exactly one XML transport layer. Numeric/name entities run before &amp; so an
// entity literally stored in the eBay title stays visible for the deep repair step.
function decodeXmlLayer(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]{1,6});/gi, (match, hex) => {
      const codePoint = Number.parseInt(hex, 16)
      return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match
    })
    .replace(/&#([0-9]{1,7});/g, (match, decimal) => {
      const codePoint = Number.parseInt(decimal, 10)
      return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match
    })
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

function tag(block, name) {
  const match = String(block || '').match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))
  return match?.[1] ? decodeXmlLayer(match[1].trim()) : ''
}

function ebayError(text) {
  return {
    code: tag(text, 'ErrorCode') || '',
    message: tag(text, 'LongMessage') || tag(text, 'ShortMessage') || 'Unknown eBay error.',
  }
}

function tradingEndpoint(account) {
  return account.sandboxMode
    ? 'https://api.sandbox.ebay.com/ws/api.dll'
    : 'https://api.ebay.com/ws/api.dll'
}

function identityEndpoint(account) {
  return account.sandboxMode
    ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
    : 'https://api.ebay.com/identity/v1/oauth2/token'
}

let usageLoggingAvailable = APPLY
async function logApiCall({ account, callName, success, durationMs, errorCode, errorMessage }) {
  if (!usageLoggingAvailable) return
  try {
    await sql(`
      INSERT INTO api_usage_log
        (provider, call_name, user_id, success, duration_ms, error_code, error_message)
      VALUES ('ebay', $1, $2, $3, $4, $5, $6)
    `, [
      String(callName).slice(0, 60),
      Number(account.userId),
      Boolean(success),
      Number.isFinite(durationMs) ? Math.round(durationMs) : null,
      errorCode ? String(errorCode).slice(0, 60) : null,
      errorMessage ? String(errorMessage).slice(0, 500) : null,
    ])
  } catch (error) {
    usageLoggingAvailable = false
    console.warn(`Warning: API usage logging is unavailable: ${String(error?.message || error)}`)
  }
}

async function refreshAccessToken(account, force = false) {
  const expiresAt = new Date(account.tokenExpiresAt || 0).getTime()
  if (!force && account.accessToken && Number.isFinite(expiresAt) && expiresAt > Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
    return
  }
  if (!account.refreshToken) {
    throw new Error(`${account.display}: eBay access token is expired and no refresh token is stored.`)
  }
  if (!process.env.EBAY_CERT_ID) {
    throw new Error(`${account.display}: EBAY_CERT_ID is required to refresh the eBay access token.`)
  }

  const startedAt = Date.now()
  const basic = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`).toString('base64')
  let response
  let data
  try {
    response = await fetch(identityEndpoint(account), {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: account.refreshToken,
        scope: 'https://api.ebay.com/oauth/api_scope',
      }),
      signal: AbortSignal.timeout(20_000),
    })
    data = await response.json().catch(() => null)
  } catch (error) {
    await logApiCall({
      account,
      callName: 'OAuthRefresh',
      success: false,
      durationMs: Date.now() - startedAt,
      errorCode: 'NETWORK',
      errorMessage: String(error?.message || error),
    })
    throw new Error(`${account.display}: eBay token refresh did not respond.`)
  }

  const ok = response.ok && data?.access_token
  await logApiCall({
    account,
    callName: 'OAuthRefresh',
    success: Boolean(ok),
    durationMs: Date.now() - startedAt,
    errorCode: ok ? null : `HTTP_${response.status}`,
    errorMessage: ok ? null : String(data?.error_description || data?.error || 'Token refresh failed.'),
  })
  if (!ok) {
    throw new Error(`${account.display}: eBay token refresh failed; reconnect the account in Settings.`)
  }

  account.accessToken = String(data.access_token)
  account.tokenExpiresAt = new Date(Date.now() + Number(data.expires_in || 7200) * 1000).toISOString()
}

async function tradingCall(account, callName, xml, { allowAuthRetry = true, timeoutMs = 30_000 } = {}) {
  await refreshAccessToken(account)
  const startedAt = Date.now()
  let response
  let text
  try {
    response = await fetch(tradingEndpoint(account), {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': callName,
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-APP-NAME': process.env.EBAY_APP_ID,
        'Content-Type': 'text/xml',
      },
      body: xml,
      signal: AbortSignal.timeout(timeoutMs),
    })
    text = await response.text()
  } catch (error) {
    await logApiCall({
      account,
      callName,
      success: false,
      durationMs: Date.now() - startedAt,
      errorCode: 'NETWORK',
      errorMessage: String(error?.message || error),
    })
    throw new Error(`${account.display}: ${callName} did not respond; outcome is unknown.`)
  }

  const acknowledged = /<Ack>(Success|Warning)<\/Ack>/i.test(text)
  const detail = acknowledged ? { code: '', message: '' } : ebayError(text)
  const ok = response.ok && acknowledged
  await logApiCall({
    account,
    callName,
    success: ok,
    durationMs: Date.now() - startedAt,
    errorCode: ok ? null : detail.code || `HTTP_${response.status}`,
    errorMessage: ok ? null : detail.message,
  })

  const authFailure = !ok && /token|auth|credential|931|932|16110/i.test(`${detail.code} ${detail.message}`)
  if (allowAuthRetry && authFailure && account.refreshToken) {
    await refreshAccessToken(account, true)
    return tradingCall(account, callName, xml.replace(
      /<eBayAuthToken>[\s\S]*?<\/eBayAuthToken>/i,
      `<eBayAuthToken>${escapeXml(account.accessToken)}</eBayAuthToken>`,
    ), { allowAuthRetry: false, timeoutMs })
  }

  return { ok, acknowledged, status: response.status, text, detail }
}

function getActiveXml(account, page) {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(account.accessToken)}</eBayAuthToken></RequesterCredentials>
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

async function fetchActivePage(account, page) {
  const result = await tradingCall(account, 'GetMyeBaySelling', getActiveXml(account, page))
  if (!result.ok) {
    throw new Error(`${account.display}: GetMyeBaySelling failed on page ${page}: ${result.detail.message}`)
  }

  const listings = [...result.text.matchAll(/<Item>([\s\S]*?)<\/Item>/gi)]
    .map((match) => String(match[1] || ''))
    .map((block) => ({
      accountId: account.id,
      userId: account.userId,
      accountLabel: account.label,
      ebayListingId: tag(block, 'ItemID'),
      title: tag(block, 'Title'),
    }))
    .filter((listing) => Boolean(listing.ebayListingId && listing.title))

  const totalPagesText = tag(result.text, 'TotalNumberOfPages')
  const totalEntriesText = tag(result.text, 'TotalNumberOfEntries')
  if (!/^\d+$/.test(totalPagesText) || !/^\d+$/.test(totalEntriesText)) {
    throw new Error(`${account.display}: eBay omitted pagination totals; completeness cannot be proven, so nothing was changed.`)
  }

  return {
    listings,
    totalPages: Math.max(1, Number.parseInt(totalPagesText, 10)),
    totalEntries: Number.parseInt(totalEntriesText, 10),
  }
}

async function scanAccount(account) {
  const first = await fetchActivePage(account, 1)
  if (first.totalPages > MAX_PAGES_PER_ACCOUNT) {
    throw new Error(`${account.display}: ${first.totalPages} pages exceed the safe scan limit; nothing was changed.`)
  }

  const listings = [...first.listings]
  const pages = Array.from({ length: Math.max(0, first.totalPages - 1) }, (_unused, index) => index + 2)
  for (let offset = 0; offset < pages.length; offset += SCAN_CONCURRENCY) {
    const batch = pages.slice(offset, offset + SCAN_CONCURRENCY)
    const results = await Promise.all(batch.map((page) => fetchActivePage(account, page)))
    for (const result of results) listings.push(...result.listings)
  }

  const unique = new Map(listings.map((listing) => [listing.ebayListingId, listing]))
  if (unique.size !== first.totalEntries) {
    throw new Error(
      `${account.display}: eBay reported ${first.totalEntries} active listings but the complete scan returned ${unique.size}; nothing was changed.`,
    )
  }
  return [...unique.values()]
}

async function scanAllAccounts(accounts, phase) {
  const listings = []
  console.log(`\n${phase}: scanning ${accounts.length} active eBay account${accounts.length === 1 ? '' : 's'}...`)
  for (const account of accounts) {
    const rows = await scanAccount(account)
    listings.push(...rows)
    console.log(`  ${account.display}: ${rows.length.toLocaleString()} active listings`)
  }
  return listings
}

function inspectTitles(listings) {
  const candidates = []
  const unsafe = []

  for (const listing of listings) {
    if (!hasEncodedTitleArtifact(listing.title)) continue
    const newTitle = repairEncodedEbayTitle(listing.title)
    const reason = !newTitle
      ? 'empty repaired title'
      : newTitle.length > 80
        ? `repaired title is ${newTitle.length} characters`
        : newTitle === listing.title
          ? 'decoder made no change'
          : hasEncodedTitleArtifact(newTitle)
            ? 'encoded artifact remains after decoding'
            : null

    if (reason) unsafe.push({ ...listing, newTitle, reason })
    else candidates.push({ ...listing, newTitle })
  }
  return { candidates, unsafe }
}

function printInspection(listings, inspection) {
  console.log(`  Scanned: ${listings.length.toLocaleString()}`)
  console.log(`  Safe mechanical repairs: ${inspection.candidates.length.toLocaleString()}`)
  console.log(`  Unsafe/unresolved artifacts: ${inspection.unsafe.length.toLocaleString()}`)

  for (const candidate of inspection.candidates.slice(0, 12)) {
    console.log(`\n  [${candidate.userId}/${candidate.accountLabel}] ${candidate.ebayListingId}`)
    console.log(`    BEFORE: ${candidate.title}`)
    console.log(`    AFTER:  ${candidate.newTitle}`)
  }
  if (inspection.candidates.length > 12) {
    console.log(`\n  ...${(inspection.candidates.length - 12).toLocaleString()} more repairable titles`)
  }
  for (const row of inspection.unsafe.slice(0, 5)) {
    console.log(`\n  UNSAFE ${row.ebayListingId}: ${row.reason}`)
  }
}

function reviseXml(account, candidate) {
  return `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(account.accessToken)}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <Item>
    <ItemID>${escapeXml(candidate.ebayListingId)}</ItemID>
    <Title>${escapeXml(candidate.newTitle)}</Title>
  </Item>
</ReviseFixedPriceItemRequest>`
}

async function reviseCandidate(account, candidate) {
  const result = await tradingCall(account, 'ReviseFixedPriceItem', reviseXml(account, candidate))
  const transient = !result.ok && (
    result.status >= 500 ||
    /limit|quota|temporar|try again|system error|service unavailable/i.test(`${result.detail.code} ${result.detail.message}`)
  )
  return { ...result, transient }
}

async function updateStoredTitle(candidate) {
  return sql(`
    UPDATE listed_asins
    SET title = $3
    WHERE user_id = $1
      AND ebay_listing_id = $2
      AND ended_at IS NULL
    RETURNING id
  `, [Number(candidate.userId), candidate.ebayListingId, candidate.newTitle])
}

async function loadAccounts() {
  const params = []
  let userFilter = ''
  if (USER_ID !== null) {
    params.push(USER_ID)
    userFilter = 'AND user_id = $1'
  }
  const rows = await sql(`
    SELECT id, user_id, label, oauth_token, refresh_token, token_expires_at, sandbox_mode
    FROM ebay_accounts
    WHERE active = TRUE
      ${userFilter}
    ORDER BY user_id ASC, id ASC
  `, params)

  if (rows.length === 0) {
    throw new Error(USER_ID === null
      ? 'No active ebay_accounts rows were found.'
      : `No active eBay account was found for user ${USER_ID}.`)
  }

  return rows.map((row) => ({
    id: Number(row.id),
    userId: Number(row.user_id),
    label: String(row.label || `account ${row.id}`),
    display: `user ${row.user_id} / ${row.label || `account ${row.id}`}`,
    accessToken: String(row.oauth_token || ''),
    refreshToken: String(row.refresh_token || ''),
    tokenExpiresAt: row.token_expires_at ? String(row.token_expires_at) : '',
    sandboxMode: Boolean(row.sandbox_mode),
  }))
}

async function main() {
  console.log(`Encoded eBay title maintenance: ${APPLY ? 'APPLY' : 'PREVIEW (read-only)'}`)
  if (USER_ID !== null) console.log(`User filter: ${USER_ID}`)
  if (ALL_USERS) console.log('Scope acknowledgement: all active users')

  const accounts = await loadAccounts()
  // Refresh in memory only when necessary. Preview mode never writes refreshed tokens or
  // anything else to the DB.
  for (const account of accounts) await refreshAccessToken(account)

  // Finish the entire preflight scan before the first possible revision. Any incomplete
  // account/page aborts the run with zero listing mutations.
  const initialListings = await scanAllAccounts(accounts, 'Preflight')
  const initial = inspectTitles(initialListings)
  printInspection(initialListings, initial)

  if (!APPLY) {
    console.log('\nPREVIEW COMPLETE: no eBay listing or database title was changed.')
    if (initial.candidates.length > 0) {
      const userArg = USER_ID === null ? ' --all-users' : ` --user=${USER_ID}`
      console.log(`To apply exactly these mechanical repairs, rerun with:${userArg} --apply`)
    }
    return
  }

  if (initial.unsafe.length > 0) {
    throw new Error(`Refusing to apply: ${initial.unsafe.length} encoded title(s) could not be repaired mechanically.`)
  }
  if (initial.candidates.length === 0) {
    console.log('\nAPPLY COMPLETE: all live titles were already clear; nothing changed.')
    return
  }

  console.log(`\nApplying ${initial.candidates.length.toLocaleString()} title-only revision${initial.candidates.length === 1 ? '' : 's'}...`)
  const accountById = new Map(accounts.map((account) => [account.id, account]))
  let revised = 0
  let failed = 0
  let dbRowsUpdated = 0
  let dbSyncFailures = 0
  let stoppedForTransient = false

  for (const candidate of initial.candidates) {
    const account = accountById.get(candidate.accountId)
    if (!account) {
      failed += 1
      console.error(`  FAIL ${candidate.ebayListingId}: account ${candidate.accountId} is unavailable`)
      continue
    }

    let result
    try {
      result = await reviseCandidate(account, candidate)
    } catch (error) {
      failed += 1
      stoppedForTransient = true
      console.error(`  STOP ${candidate.ebayListingId}: ${String(error?.message || error)}`)
      break
    }

    if (!result.ok) {
      failed += 1
      console.error(`  FAIL ${candidate.ebayListingId}: ${result.detail.code || 'EBAY'} ${result.detail.message}`)
      if (result.transient) {
        stoppedForTransient = true
        console.error('  Stopping revisions on a transient/quota response; final verification will report what remains.')
        break
      }
      continue
    }

    revised += 1
    try {
      const updated = await updateStoredTitle(candidate)
      dbRowsUpdated += updated.length
      console.log(`  OK   ${candidate.ebayListingId}${updated.length === 0 ? ' (live-only; no active DB row)' : ''}`)
    } catch (error) {
      dbSyncFailures += 1
      console.error(`  DB   ${candidate.ebayListingId}: eBay is fixed, but listed_asins sync failed: ${String(error?.message || error)}`)
    }

    await new Promise((resolve) => setTimeout(resolve, REVISION_DELAY_MS))
  }

  console.log(`\nRevision results: ${revised} acknowledged, ${failed} failed, ${dbRowsUpdated} DB row(s) synchronized.`)
  if (stoppedForTransient) console.log('The run stopped early on a transient response and is expected to exit nonzero.')

  // Authoritative verification: discard the preflight data and pull every live title again.
  const verifiedListings = await scanAllAccounts(accounts, 'Post-apply verification')
  const verified = inspectTitles(verifiedListings)
  console.log(`\nVerification remaining: ${verified.candidates.length} repairable, ${verified.unsafe.length} unsafe/unresolved.`)
  for (const row of [...verified.candidates, ...verified.unsafe].slice(0, 10)) {
    console.log(`  REMAINS [${row.userId}/${row.accountLabel}] ${row.ebayListingId}: ${row.title}`)
  }

  if (verified.candidates.length > 0 || verified.unsafe.length > 0 || dbSyncFailures > 0) {
    process.exitCode = 1
    console.error('\nINCOMPLETE: malformed live titles or database synchronization errors remain.')
    return
  }

  console.log(`\nVERIFIED COMPLETE: all ${verifiedListings.length.toLocaleString()} live titles are clear of encoded artifacts.`)
}

main().catch((error) => {
  console.error(`\nFAILED: ${String(error?.message || error)}`)
  process.exitCode = 1
})
