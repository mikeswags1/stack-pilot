import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import GoogleProvider from 'next-auth/providers/google'
import bcrypt from 'bcryptjs'
import { queryRows, sql } from './db'
import { ensureSubscriptionRow } from './subscription'

const providers: NextAuthOptions['providers'] = []

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    })
  )
}

providers.push(
  CredentialsProvider({
    name: 'credentials',
    credentials: {
      email: { label: 'Email', type: 'email' },
      password: { label: 'Password', type: 'password' },
    },
    async authorize(credentials) {
      if (!credentials?.email || !credentials?.password) return null

      const rows = await queryRows`SELECT * FROM users WHERE email = ${credentials.email} LIMIT 1`
      const user = rows[0]
      if (!user || !user.password_hash) return null

      const valid = await bcrypt.compare(credentials.password, user.password_hash as string)
      if (!valid) return null

      return { id: String(user.id), email: user.email as string, name: user.name as string }
    },
  })
)

export const authOptions: NextAuthOptions = {
  providers,
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider === 'google') {
        const email = String(user.email || '').trim().toLowerCase()
        if (!email) return false
        await sql`
          CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            email VARCHAR(255) UNIQUE NOT NULL,
            password_hash VARCHAR(255),
            name VARCHAR(255),
            created_at TIMESTAMP DEFAULT NOW()
          )
        `.catch(() => {})
        const rows = await queryRows<{ id: number }>`
          INSERT INTO users (email, name)
          VALUES (${email}, ${user.name || email.split('@')[0]})
          ON CONFLICT (email) DO UPDATE SET
            name = COALESCE(users.name, EXCLUDED.name)
          RETURNING id
        `.catch(() => [])
        await ensureSubscriptionRow(rows[0]?.id).catch(() => {})
      }

      return true
    },
    async jwt({ token, user }) {
      if (user && token.email) {
        const rows = await queryRows`SELECT id FROM users WHERE email = ${token.email} LIMIT 1`
        if (rows[0]) token.id = String(rows[0].id)
      }

      return token
    },
    session({ session, token }) {
      if (session.user) session.user.id = token.id
      return session
    },
  },
}
