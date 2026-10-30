export default function Home() {
  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '56px 24px' }}>
      <h1 style={{ fontFamily: 'var(--font-serif)', fontSize: 40, letterSpacing: '0.2em', margin: 0 }}>
        预演<span style={{ color: 'var(--red)' }}>。</span>
      </h1>
      <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.14em', color: 'var(--muted)', marginTop: 12 }}>
        STAGE 0 · SCAFFOLD READY · <a href="/api/health" style={{ color: 'var(--red)' }}>/api/health</a>
      </p>
    </main>
  );
}
