'use client'

// Catches crashes that happen in the root layout / providers (which app/error.tsx
// can't reach). Must render its own <html>/<body>. Turns an otherwise-blank screen
// into the real error message.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: '100vh', background: '#0a1420', color: '#e8eef5', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '48px 24px' }}>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: '#fff' }}>App error</h1>
          <p style={{ color: '#9fb1c4', marginTop: 8 }}>The page failed to load. Actual error:</p>
          <pre style={{
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 16, padding: 16,
            background: 'rgba(232,63,80,0.08)', border: '1px solid rgba(232,63,80,0.3)',
            borderRadius: 10, color: '#ff9aa6', fontSize: 13,
          }}>{error?.message || 'Unknown error'}</pre>
          {error?.digest && <p style={{ color: '#6b7d90', marginTop: 8, fontSize: 12 }}>Reference: {error.digest}</p>}
          <button
            onClick={() => reset()}
            style={{ marginTop: 20, background: '#2f6fed', border: 'none', color: '#fff', borderRadius: 8, padding: '10px 20px', cursor: 'pointer', fontSize: 14 }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  )
}
