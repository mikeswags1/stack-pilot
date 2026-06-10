'use client'
import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { GetTheAppBanner } from '@/app/components/GetTheAppBanner'

export default function Login() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const res = await signIn('credentials', { email, password, redirect: false })
    setLoading(false)
    if (res?.error) {
      setError('Invalid email or password')
    } else {
      router.push('/dashboard')
    }
  }

  async function handleGoogle() {
    setGoogleLoading(true)
    await signIn('google', { callbackUrl: '/dashboard' })
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '24px', position: 'relative', zIndex: 1,
    }}>
      <div style={{ width: '100%', maxWidth: '420px' }}>
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <Link href="/" style={{ textDecoration: 'none', display: 'inline-block', marginBottom: '32px' }}>
            <div style={{ fontFamily: 'var(--serif)', fontSize: '28px', fontWeight: 700, color: 'var(--txt)' }}>
              Stack<span style={{ background: 'linear-gradient(135deg,var(--gold),var(--gld2))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Pilot</span>
            </div>
          </Link>
          <h1 style={{ fontFamily: 'var(--serif)', fontSize: '36px', fontWeight: 600, color: 'var(--txt)', marginBottom: '8px' }}>Welcome back</h1>
          <p style={{ color: 'var(--sil)', fontSize: '14px' }}>Sign in to your operations dashboard</p>
          <p style={{ marginTop: '12px', fontSize: '13px', lineHeight: 1.5 }}>
            <Link href="/guide" style={{ color: 'var(--gold)', fontWeight: 600, textDecoration: 'none' }}>
              Simple how-to guide →
            </Link>
            <span style={{ color: 'var(--dim)' }}> · Trial: 5 live listings</span>
          </p>
        </div>

        <GetTheAppBanner variant="login" />

        <div className="card" style={{ padding: '36px' }}>

          {/* Google button */}
          <button
            onClick={handleGoogle}
            disabled={googleLoading}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px',
              padding: '13px', borderRadius: '12px', cursor: 'pointer', fontFamily: 'inherit',
              fontSize: '14px', fontWeight: 600, border: '1px solid rgba(195,158,88,0.2)',
              background: 'rgba(255,255,255,0.04)', color: 'var(--txt)',
              transition: 'all 0.2s', marginBottom: '20px',
            }}
          >
            <GoogleIcon />
            {googleLoading ? 'Redirecting...' : 'Continue with Google'}
          </button>

          {/* Divider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
            <div style={{ flex: 1, height: '1px', background: 'rgba(195,158,88,0.14)' }} />
            <span style={{ fontSize: '11px', color: 'var(--dim)', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' }}>or</span>
            <div style={{ flex: 1, height: '1px', background: 'rgba(195,158,88,0.14)' }} />
          </div>

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--dim)', marginBottom: '8px' }}>Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--dim)', marginBottom: '8px' }}>Password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" required />
            </div>

            {error && (
              <div style={{ background: 'rgba(232,63,80,0.08)', border: '1px solid rgba(232,63,80,0.25)', borderRadius: '10px', padding: '12px 16px', fontSize: '13px', color: 'var(--red)' }}>
                {error}
              </div>
            )}

            <button type="submit" className="btn btn-solid btn-full" style={{ marginTop: '4px' }} disabled={loading}>
              {loading ? 'Signing in...' : 'Sign In with Email'}
            </button>
          </form>
        </div>

        <p style={{ textAlign: 'center', marginTop: '20px', fontSize: '13px', color: 'var(--dim)' }}>
          Don&apos;t have an account?{' '}
          <Link href="/signup" style={{ color: 'var(--gold)', textDecoration: 'none', fontWeight: 600 }}>Create account</Link>
        </p>
      </div>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
      <path fill="none" d="M0 0h48v48H0z"/>
    </svg>
  )
}
