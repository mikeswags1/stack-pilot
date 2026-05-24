import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { getValidEbayAccessToken } from '@/lib/ebay-auth'

type ApiAccessRule = {
  callName: string
  dailyHardLimit: number
  dailySoftLimit: number
  dailyUsage: number
  dailyRemaining: number | null
  hourlyHardLimit: number
  hourlySoftLimit: number
  hourlyUsage: number
  hourlyRemaining: number | null
  dailyPercent: number | null
  hourlyPercent: number | null
}

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function readTag(block: string, tag: string) {
  return block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1]?.trim() || ''
}

function readNumber(block: string, tag: string) {
  const value = Number(readTag(block, tag) || 0)
  return Number.isFinite(value) ? value : 0
}

function pct(usage: number, limit: number) {
  if (limit <= 0) return null
  return Math.round((usage / limit) * 100)
}

function remaining(usage: number, limit: number) {
  if (limit <= 0) return null
  return Math.max(0, limit - usage)
}

function parseApiAccessRules(xml: string): ApiAccessRule[] {
  return [...xml.matchAll(/<APIAccessRule>([\s\S]*?)<\/APIAccessRule>/gi)].map((match) => {
    const block = match[1] || ''
    const dailyHardLimit = readNumber(block, 'DailyHardLimit')
    const dailyUsage = readNumber(block, 'DailyUsage')
    const hourlyHardLimit = readNumber(block, 'HourlyHardLimit')
    const hourlyUsage = readNumber(block, 'HourlyUsage')
    return {
      callName: readTag(block, 'CallName') || 'unknown',
      dailyHardLimit,
      dailySoftLimit: readNumber(block, 'DailySoftLimit'),
      dailyUsage,
      dailyRemaining: remaining(dailyUsage, dailyHardLimit),
      hourlyHardLimit,
      hourlySoftLimit: readNumber(block, 'HourlySoftLimit'),
      hourlyUsage,
      hourlyRemaining: remaining(hourlyUsage, hourlyHardLimit),
      dailyPercent: pct(dailyUsage, dailyHardLimit),
      hourlyPercent: pct(hourlyUsage, hourlyHardLimit),
    }
  })
}

function getNextPacificMidnightIso() {
  const now = new Date()
  const pacificDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const [year, month, day] = pacificDate.split('-').map(Number)
  const candidates = [7, 8].map((hour) => new Date(Date.UTC(year, month - 1, day + 1, hour, 0, 0)))
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  return (candidates.find((candidate) => timeFormatter.format(candidate) === '00:00') || candidates[0]).toISOString()
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const credentials = await getValidEbayAccessToken(String(session.user.id)).catch(() => null)
  if (!credentials?.accessToken) {
    return apiError('Your eBay session expired. Reconnect your account in Settings.', {
      status: 401,
      code: 'RECONNECT_REQUIRED',
    })
  }

  const appId = process.env.EBAY_APP_ID || ''
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetAPIAccessRulesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(credentials.accessToken)}</eBayAuthToken></RequesterCredentials>
</GetAPIAccessRulesRequest>`

  const response = await fetch('https://api.ebay.com/ws/api.dll', {
    method: 'POST',
    headers: {
      'X-EBAY-API-CALL-NAME': 'GetAPIAccessRules',
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-APP-NAME': appId,
      Authorization: `Bearer ${credentials.accessToken}`,
      'Content-Type': 'text/xml',
    },
    body: xml,
    signal: AbortSignal.timeout(10000),
  }).catch(() => null)

  if (!response) {
    return apiError('Unable to reach eBay quota service right now.', { status: 502, code: 'EBAY_QUOTA_CHECK_FAILED' })
  }

  const text = await response.text()
  if (!response.ok || /<Ack>Failure<\/Ack>/i.test(text)) {
    return apiError('Unable to read eBay API quota right now.', {
      status: response.status || 502,
      code: 'EBAY_QUOTA_CHECK_FAILED',
      details: { raw: text.slice(0, 1200) },
    })
  }

  const rules = parseApiAccessRules(text)
  const activeRules = rules.filter((rule) => (rule.dailyUsage + rule.hourlyUsage) > 0)
  const limitingRules = rules
    .filter((rule) => {
      const dailyLow = rule.dailyRemaining !== null && rule.dailyRemaining <= 25
      const hourlyLow = rule.hourlyRemaining !== null && rule.hourlyRemaining <= 10
      const dailyHot = rule.dailyPercent !== null && rule.dailyPercent >= 90
      const hourlyHot = rule.hourlyPercent !== null && rule.hourlyPercent >= 90
      return dailyLow || hourlyLow || dailyHot || hourlyHot
    })
    .sort((a, b) => Math.max(b.dailyPercent || 0, b.hourlyPercent || 0) - Math.max(a.dailyPercent || 0, a.hourlyPercent || 0))

  const exhausted = limitingRules.some((rule) =>
    (rule.dailyRemaining !== null && rule.dailyRemaining <= 0) ||
    (rule.hourlyRemaining !== null && rule.hourlyRemaining <= 0)
  )
  const nearLimit = exhausted || limitingRules.length > 0

  return apiOk({
    nearLimit,
    exhausted,
    resetEstimateIso: getNextPacificMidnightIso(),
    limitingRules,
    activeRules: activeRules
      .sort((a, b) => b.dailyUsage - a.dailyUsage)
      .slice(0, 12),
    rulesCount: rules.length,
  })
}
