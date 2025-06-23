'use client';

import { useState } from 'react';

export default function TestnetPage() {
  const [lastFaucetClaim, setLastFaucetClaim] = useState<number | null>(null);
  const [faucetAddress, setFaucetAddress] = useState('');
  const [showFaucetAlert, setShowFaucetAlert] = useState(false);
  const [showSuccessAlert, setShowSuccessAlert] = useState(false);

  const handleFaucetClaim = () => {
    if (!faucetAddress.trim()) {
      alert('Please enter a valid testnet address');
      return;
    }

    const now = Date.now();
    const cooldownPeriod = 24 * 60 * 60 * 1000; // 24 hours

    if (lastFaucetClaim && (now - lastFaucetClaim) < cooldownPeriod) {
      setShowFaucetAlert(true);
      return;
    }

    setLastFaucetClaim(now);
    setShowSuccessAlert(true);
    setFaucetAddress('');
  };

  return (
    <div className="page-testnet">
      <section className="explorer-section" data-section="testnet">
        <div className="explorer-header">
          <h2 className="section-title">QNet Testnet</h2>
          <p className="section-subtitle">
            Test network for development and experimentation
          </p>
        </div>

        <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
          <div className="explorer-card" style={{ padding: '3rem' }}>
            <div className="card-header" style={{ marginBottom: '2rem', textAlign: 'center' }}>
              <h3 style={{ fontSize: '1.8rem', marginBottom: '1rem' }}>Token Faucet</h3>
              <div className="faucet-heading" style={{ fontSize: '1.1rem', color: '#e5e5e5', lineHeight: '1.5' }}>
                Get 1,500 test 1DEV tokens for development and testing on QNet testnet
              </div>
            </div>

            <div className="faucet-row" style={{ display: 'flex', gap: '1rem', alignItems: 'stretch', width: '100%' }}>
              <input 
                type="text" 
                placeholder="Enter your testnet address" 
                className="qnet-input"
                value={faucetAddress}
                onChange={(e) => setFaucetAddress(e.target.value)}
                style={{ flex: '1', fontSize: '1rem', padding: '1rem', height: '3.5rem', boxSizing: 'border-box' }}
              />
              <button 
                className="qnet-button" 
                onClick={handleFaucetClaim}
                style={{ flex: '1', fontSize: '1rem', padding: '1rem', fontWeight: 'bold', height: '3.5rem', boxSizing: 'border-box' }}
              >
                GET TEST TOKENS
              </button>
            </div>
          </div>
        </div>

        {showFaucetAlert && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000
          }}>
            <div style={{
              background: '#1a1a1a',
              border: '2px solid #ffaa00',
              borderRadius: '12px',
              padding: '2rem',
              maxWidth: '400px',
              textAlign: 'center'
            }}>
              <h3 style={{ color: '#ffaa00', marginBottom: '1rem' }}>Cooldown Active</h3>
              <p style={{ color: '#e5e5e5', marginBottom: '2rem' }}>
                Tokens are distributed once every 24 hours per address. Please wait before claiming again.
              </p>
              <button 
                className="qnet-button"
                onClick={() => setShowFaucetAlert(false)}
                style={{ fontSize: '1rem', padding: '0.75rem 1.5rem' }}
              >
                OK
              </button>
            </div>
          </div>
        )}

        {showSuccessAlert && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000
          }}>
            <div style={{
              background: '#1a1a1a',
              border: '2px solid #00ffff',
              borderRadius: '12px',
              padding: '2rem',
              maxWidth: '400px',
              textAlign: 'center'
            }}>
              <h3 style={{ color: '#00ffff', marginBottom: '1rem' }}>Success!</h3>
              <p style={{ color: '#e5e5e5', marginBottom: '2rem' }}>
                1,500 test 1DEV tokens have been sent to your address successfully!
              </p>
              <button 
                className="qnet-button"
                onClick={() => setShowSuccessAlert(false)}
                style={{ fontSize: '1rem', padding: '0.75rem 1.5rem' }}
              >
                OK
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}