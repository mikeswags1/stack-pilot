export type AmazonFulfillmentSignals = {
  primeEligible: boolean | null
  deliveryDaysMax: number | null
  fastFulfillment: boolean
  blockedOrSlow: boolean
  summary: string
}

const MAX_FAST_DELIVERY_DAYS = 8

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
}

const BLOCKED_OR_SLOW_PATTERNS = [
  /\busually ships within\s+(?:[2-9]|[1-9]\d+)\s+(?:weeks?|months?)\b/i,
  /\bships within\s+(?:[2-9]|[1-9]\d+)\s+(?:weeks?|months?)\b/i,
  /\btemporarily out of stock\b/i,
  /\bthis item cannot be shipped to your selected delivery location\b/i,
  /\bcannot be shipped to the address you selected\b/i,
  /\bdoes not ship to\b/i,
  /\bmay not ship to\b/i,
]

function compactText(value: string) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function daysUntil(month: string, day: string, now = new Date()) {
  const monthIndex = MONTH_INDEX[month.toLowerCase()]
  const dayNumber = Number.parseInt(day, 10)
  if (monthIndex === undefined || !Number.isFinite(dayNumber)) return null

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let candidate = new Date(now.getFullYear(), monthIndex, dayNumber)
  if (candidate.getTime() < today.getTime() - 24 * 60 * 60 * 1000) {
    candidate = new Date(now.getFullYear() + 1, monthIndex, dayNumber)
  }

  return Math.round((candidate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
}

function collectDeliveryDaySignals(text: string) {
  const days: number[] = []

  if (/\btoday\b/i.test(text) || /\bsame[-\s]?day\b/i.test(text)) days.push(0)
  if (/\btomorrow\b/i.test(text) || /\bovernight\b/i.test(text)) days.push(1)
  if (/\btwo[-\s]?day\b/i.test(text)) days.push(2)

  for (const match of text.matchAll(/\b(?:delivery|arrives?|get it|estimated delivery|delivered)[^.!?]{0,120}\b(?:in\s+)?(\d{1,2})\s*(?:-|to)\s*(\d{1,2})\s+(days?|weeks?|months?)\b/gi)) {
    const upper = Number.parseInt(match[2] || match[1] || '0', 10)
    const unit = String(match[3] || '').toLowerCase()
    if (!Number.isFinite(upper)) continue
    if (unit.startsWith('month')) days.push(60)
    else if (unit.startsWith('week')) days.push(upper * 7)
    else days.push(upper)
  }

  for (const match of text.matchAll(/\b(?:delivery|arrives?|get it|estimated delivery|delivered|ships?)[^.!?]{0,120}\bwithin\s+(\d{1,2})\s+(days?|weeks?|months?)\b/gi)) {
    const upper = Number.parseInt(match[1] || '0', 10)
    const unit = String(match[2] || '').toLowerCase()
    if (!Number.isFinite(upper)) continue
    if (unit.startsWith('month')) days.push(60)
    else if (unit.startsWith('week')) days.push(upper * 7)
    else days.push(upper)
  }

  for (const match of text.matchAll(/\b(?:delivery|arrives?|get it|estimated delivery|delivered)[^.!?]{0,140}?\b(?:mon|tue|wed|thu|fri|sat|sun)?(?:day)?[,]?\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})\b/gi)) {
    const parsed = daysUntil(match[1], match[2])
    if (parsed !== null) days.push(parsed)
  }

  return days.filter((day) => Number.isFinite(day) && day >= 0)
}

export function evaluateAmazonFulfillmentText(input: string): AmazonFulfillmentSignals {
  const text = compactText(input).toLowerCase()
  const blockedOrSlow = BLOCKED_OR_SLOW_PATTERNS.some((pattern) => pattern.test(text))
  const daySignals = collectDeliveryDaySignals(text)
  const deliveryDaysMax = daySignals.length > 0 ? Math.max(...daySignals) : null
  const hasPrimeSignal =
    /\bprime\s+(?:one[-\s]?day|two[-\s]?day|delivery|shipping|eligible)\b/i.test(text) ||
    /\b(?:free|fast|one[-\s]?day|two[-\s]?day|delivery|shipping|arrives?|get it)[^.!?]{0,80}\bprime\b/i.test(text) ||
    /\bprime\b[^.!?]{0,80}\b(?:free|fast|one[-\s]?day|two[-\s]?day|delivery|shipping|arrives?|get it)\b/i.test(text)

  const primeEligible = hasPrimeSignal ? true : deliveryDaysMax !== null && deliveryDaysMax <= 2 ? true : null
  const fastFulfillment = !blockedOrSlow && (
    primeEligible === true ||
    (deliveryDaysMax !== null && deliveryDaysMax <= MAX_FAST_DELIVERY_DAYS)
  )

  return {
    primeEligible,
    deliveryDaysMax,
    fastFulfillment,
    blockedOrSlow: blockedOrSlow || (deliveryDaysMax !== null && deliveryDaysMax > MAX_FAST_DELIVERY_DAYS),
    summary: deliveryDaysMax !== null
      ? `delivery <= ${deliveryDaysMax} day${deliveryDaysMax === 1 ? '' : 's'}`
      : primeEligible === true
        ? 'prime signal'
        : '',
  }
}
