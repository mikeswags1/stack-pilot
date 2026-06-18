'use client'

// App-level error boundary. Without this, any client render crash shows as a
// blank dark screen with no clue what failed. This turns a crash into a readable
// message (and a digest ref for the server logs) so problems are diagnosable.
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div style={{ minHeight: '100vh', padding: '48px 24px', color: '#e8eef5', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: '#fff' }}>Something broke on this page</h1>
        <p style={{ color: '#9fb1c4', marginTop: 8 }}>Here&apos;s the actual error (screenshot this if you want help):</p>
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
          Try again
        </button>
      </div>
    </div>
  )
}
