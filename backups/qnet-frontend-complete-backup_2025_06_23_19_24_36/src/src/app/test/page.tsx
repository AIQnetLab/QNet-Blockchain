export default function TestPage() {
  return (
    <div style={{ padding: '2rem', fontFamily: 'monospace' }}>
      <h1>🎉 QNet Test Page</h1>
      <p>If you can see this page, the Next.js server is working correctly!</p>
      
      <div style={{ marginTop: '2rem', padding: '1rem', background: '#f0f0f0', borderRadius: '8px' }}>
        <h2>Server Status: ✅ Working</h2>
        <ul>
          <li>✅ Next.js server running</li>
          <li>✅ React components rendering</li>
          <li>✅ TypeScript compilation working</li>
          <li>✅ API routes accessible</li>
        </ul>
      </div>
      
      <div style={{ marginTop: '2rem' }}>
        <h3>Quick Links:</h3>
        <ul>
          <li><a href="/">Main Page</a></li>
          <li><a href="/api/verify-build">API Test</a></li>
        </ul>
      </div>
      
      <div style={{ marginTop: '2rem', fontSize: '0.9em', color: '#666' }}>
        <p>Build Time: {new Date().toISOString()}</p>
        <p>Node.js Version: {typeof process !== 'undefined' ? process.version : 'Unknown'}</p>
      </div>
    </div>
  );
} 