'use client';

import { useState } from 'react';

export default function TestnetPage() {
  const [lastFaucetClaim, setLastFaucetClaim] = useState<number | null>(null);
  const [faucetAddress, setFaucetAddress] = useState('');
  const [showFaucetAlert, setShowFaucetAlert] = useState(false);
  const [showSuccessAlert, setShowSuccessAlert] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [txHash, setTxHash] = useState('');

  const handleFaucetClaim = async () => {
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

    setIsLoading(true);
    setErrorMessage('');

    try {
      const requestBody = {
        walletAddress: faucetAddress.trim(),
        amount: 1500,
        tokenType: '1DEV'
      };
      
      const response = await fetch('/api/faucet/claim', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
      
      const data = await response.json();

      if (data.success && data.txHash) {
        setLastFaucetClaim(now);
        setTxHash(data.txHash);
        setShowSuccessAlert(true);
        setFaucetAddress('');
      } else {
        setErrorMessage(data.error || 'Failed to send tokens. Please try again.');
        alert('Error: ' + (data.error || 'Failed to send tokens'));
      }
    } catch (error) {
      setErrorMessage('Network error. Please check your connection.');
      alert('Network error: ' + (error as Error).message);
    } finally {
      setIsLoading(false);
    }
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
                placeholder="Enter your Solana testnet address" 
                className="qnet-input"
                value={faucetAddress}
                onChange={(e) => setFaucetAddress(e.target.value)}
                disabled={isLoading}
                style={{ flex: '1', fontSize: '1rem', padding: '1rem', height: '3.5rem', boxSizing: 'border-box' }}
              />
              <button 
                className="qnet-button" 
                onClick={handleFaucetClaim}
                disabled={isLoading || !faucetAddress.trim()}
                style={{ 
                  flex: '1', 
                  fontSize: '1rem', 
                  padding: '1rem', 
                  fontWeight: 'bold', 
                  height: '3.5rem', 
                  boxSizing: 'border-box',
                  opacity: isLoading || !faucetAddress.trim() ? 0.6 : 1,
                  cursor: isLoading || !faucetAddress.trim() ? 'not-allowed' : 'pointer'
                }}
              >
                {isLoading ? 'SENDING...' : 'GET TEST TOKENS'}
              </button>
            </div>
            
            {errorMessage && (
              <div style={{
                marginTop: '1rem',
                padding: '1rem',
                background: 'rgba(244, 67, 54, 0.1)',
                border: '1px solid rgba(244, 67, 54, 0.3)',
                borderRadius: '8px',
                color: '#f44336'
              }}>
                {errorMessage}
              </div>
            )}
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
              maxWidth: '500px',
              textAlign: 'center'
            }}>
              <h3 style={{ color: '#00ffff', marginBottom: '1rem' }}>✅ Success!</h3>
              <p style={{ color: '#e5e5e5', marginBottom: '1rem' }}>
                1,500 test 1DEV tokens have been sent to your address successfully!
              </p>
              {txHash && (
                <div style={{
                  background: 'rgba(0, 255, 255, 0.1)',
                  border: '1px solid rgba(0, 255, 255, 0.3)',
                  borderRadius: '8px',
                  padding: '1rem',
                  marginBottom: '1rem'
                }}>
                  <p style={{ color: '#888', fontSize: '0.8rem', marginBottom: '0.5rem' }}>Transaction Hash:</p>
                  <p style={{ 
                    color: '#00ffff', 
                    fontSize: '0.9rem', 
                    fontFamily: 'monospace',
                    wordBreak: 'break-all'
                  }}>
                    {txHash}
                  </p>
                  <a 
                    href={`https://explorer.solana.com/tx/${txHash}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color: '#00ffff',
                      fontSize: '0.85rem',
                      textDecoration: 'underline',
                      marginTop: '0.5rem',
                      display: 'inline-block'
                    }}
                  >
                    View on Solana Explorer →
                  </a>
                </div>
              )}
              <button 
                className="qnet-button"
                onClick={() => {
                  setShowSuccessAlert(false);
                  setTxHash('');
                }}
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