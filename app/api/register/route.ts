import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { queryRows, sql } from '@/lib/db'
import { ensureSubscriptionRow } from '@/lib/subscription'

function normalizeEmail(value: unknown) {
  return String(value || '').trim().toLowerCase()
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { name?: unknown; email?: unknown; password?: unknown } | null
  const email = normalizeEmail(body?.email)
  const name = String(body?.name || '').trim()
  const password = String(body?.password || '')

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 })
  }

  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 })
  }

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255),
      name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `

  const existing = await queryRows<{ id: number }>`SELECT id FROM users WHERE email = ${email} LIMIT 1`
  if (existing[0]) {
    return NextResponse.json({ error: 'An account with that email already exists. Sign in instead.' }, { status: 409 })
  }

  const passwordHash = await bcrypt.hash(password, 12)
  const rows = await queryRows<{ id: number }>`
    INSERT INTO users (email, password_hash, name)
    VALUES (${email}, ${passwordHash}, ${name || email.split('@')[0]})
    RETURNING id
  `

  await ensureSubscriptionRow(rows[0]?.id).catch(() => {})

  return NextResponse.json({ ok: true })
}
