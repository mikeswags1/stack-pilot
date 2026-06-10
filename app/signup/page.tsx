'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { signIn } from 'next-auth/react'
import { useState } from 'react'
import { GetTheAppBanner } from '@/app/components/GetTheAppBanner'

const launchNotes = [
  'Create an account in under a minute',
  'Connect eBay from Settings after sign-up',
  'Trial: list up to 5 items free, no card needed',
  'Built-in listing quality and profit checks',
]

const betaChecks = [
  'Listing queues',
  'Seller performance',
  'Financial tracking',
  'Fulfillment tools',
]

export default function Signup() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      })
      const data = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) {
        setError(data.error || 'Unable to create account. Try again.')
        return
      }

      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
      })
      if (result?.error) {
        router.push('/login')
        return
      }
      router.push('/dashboard')
    } catch {
      setError('Unable to create account. Try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleGoogle() {
    setGoogleLoading(true)
    await signIn('google', { callbackUrl: '/dashboard' })
  }

  return (
    <main className="access-page">
      <nav className="access-nav">
        <Link href="/" className="home-brand" aria-label="StackPilot home">
          Stack<span>Pilot</span>
        </Link>
        <Link href="/login" className="btn btn-ghost btn-sm">
          Sign In
        </Link>
      </nav>

      <section className="access-shell">
        <div className="access-shell__install-hint">
          <GetTheAppBanner variant="marketing" />
        </div>
        <div className="access-copy">
          <div className="home-kicker">
            <span />
            Create account
          </div>
          <h1>Start testing StackPilot.</h1>
          <p>
            Create an account, connect eBay, and try the product listing workflow
            with the built-in trial limit.
          </p>

          <div className="access-note-list">
            {launchNotes.map((note) => (
              <div key={note}>
                <span />
                {note}
              </div>
            ))}
          </div>
          <p style={{ marginTop: '18px', fontSize: '14px' }}>
            <Link href="/guide" style={{ color: 'var(--gold)', fontWeight: 700, textDecoration: 'none' }}>
              How StackPilot works -&gt;
            </Link>
          </p>
        </div>

        <div className="access-card" aria-label="Create a StackPilot account">
          <div className="access-status">
            <span>Tester access</span>
            <strong>Create account</strong>
            <p>
              New testers can create an account now. After sign-up, connect eBay
              from Settings before publishing listings.
            </p>
          </div>

          <button
            type="button"
            onClick={handleGoogle}
            disabled={googleLoading}
            className="btn btn-ghost btn-full"
          >
            {googleLoading ? 'Redirecting...' : 'Continue With Google'}
          </button>

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '16px' }}>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name"
              autoComplete="name"
            />
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Email"
              autoComplete="email"
              required
            />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password (8+ characters)"
              autoComplete="new-password"
              minLength={8}
              required
            />

            {error ? (
              <div style={{ background: 'rgba(232,63,80,0.08)', border: '1px solid rgba(232,63,80,0.25)', borderRadius: '10px', padding: '10px 12px', fontSize: '13px', color: 'var(--red)' }}>
                {error}
              </div>
            ) : null}

            <button type="submit" className="btn btn-solid btn-full" disabled={loading}>
              {loading ? 'Creating Account...' : 'Create Account'}
            </button>
          </form>

          <div className="access-check-grid" style={{ marginTop: '18px' }}>
            {betaChecks.map((check) => (
              <div key={check}>{check}</div>
            ))}
          </div>

          <Link href="/login" className="btn btn-ghost btn-full">
            Already Have An Account?
          </Link>
        </div>
      </section>
    </main>
  )
}
