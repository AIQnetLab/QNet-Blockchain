'use client';

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface FaucetResponse {
  success: boolean;
  txHash?: string;
  error?: string;
  balance?: string;
}

export default function TokenFaucet() {
  const [walletAddress, setWalletAddress] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [lastClaim, setLastClaim] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isWalletConnected, setIsWalletConnected] = useState(false);

  const FAUCET_AMOUNT = 1500; // 1500 1DEV tokens
  const COOLDOWN_HOURS = 24; // 24 hour cooldown

  // Check for QNet Wallet on component mount
  useEffect(() => {
    const checkWallet = async () => {
      // Check if QNet Wallet is installed
      const qnetWallet = (window as any).qnet || (window as any).qnetWallet;
      
      if (qnetWallet && qnetWallet.isConnected) {
        try {
          const accounts = await qnetWallet.getAccounts();
          if (accounts && accounts.length > 0) {
            setWalletAddress(accounts[0]);
            setIsWalletConnected(true);
          }
        } catch (err) {
          // Silently handle error
        }
      }
    };

    // Check immediately
    checkWallet();

    // Also check after a delay (wallet might not be ready immediately)
    setTimeout(checkWallet, 1000);
    setTimeout(checkWallet, 2000);
    
    // Load last claim time from localStorage
    const storedLastClaim = localStorage.getItem('qnet_faucet_last_claim');
    if (storedLastClaim) {
      setLastClaim(storedLastClaim);
    }
  }, []);

  // Connect to wallet
  const connectWallet = async () => {
    const qnetWallet = (window as any).qnet || (window as any).qnetWallet;
    
    if (!qnetWallet) {
      setError('QNet Wallet not found. Please install the extension.');
      return;
    }

    try {
      await qnetWallet.connect();
      const accounts = await qnetWallet.getAccounts();
      
      if (accounts && accounts.length > 0) {
        setWalletAddress(accounts[0]);
        setIsWalletConnected(true);
        setError(null);
      } else {
        setError('No accounts found in wallet');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to connect wallet');
    }
  };

  const validateSolanaAddress = (address: string): boolean => {
    // Basic Solana address validation (base58, 32-44 chars)
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    return base58Regex.test(address);
  };

  const checkCooldown = (): boolean => {
    if (!lastClaim) return true;
    
    const lastClaimTime = new Date(lastClaim).getTime();
    const now = new Date().getTime();
    const hoursSinceLastClaim = (now - lastClaimTime) / (1000 * 60 * 60);
    
    return hoursSinceLastClaim >= COOLDOWN_HOURS;
  };

  const handleClaim = async () => {
    setError(null);
    setSuccess(null);

    // Validation
    if (!walletAddress.trim()) {
      setError('Please enter your Solana wallet address');
      return;
    }

    if (!validateSolanaAddress(walletAddress)) {
      setError('Invalid Solana wallet address format');
      return;
    }

    if (!checkCooldown()) {
      const lastClaimTime = new Date(lastClaim!);
      const nextClaimTime = new Date(lastClaimTime.getTime() + (COOLDOWN_HOURS * 60 * 60 * 1000));
      setError(`Please wait until ${nextClaimTime.toLocaleString()} before claiming again`);
      return;
    }

    setIsLoading(true);

    try {
      const requestBody = {
        walletAddress: walletAddress.trim(),
        amount: FAUCET_AMOUNT,
        tokenType: '1DEV'
      };
      
      const response = await fetch('/api/faucet/claim', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
      
      const data: FaucetResponse = await response.json();

      if (data.success && data.txHash) {
        setSuccess(`Successfully sent ${FAUCET_AMOUNT} 1DEV tokens! Transaction: ${data.txHash}`);
        setLastClaim(new Date().toISOString());
        setWalletAddress('');
        localStorage.setItem('qnet_faucet_last_claim', new Date().toISOString());
      } else {
        setError(data.error || 'Failed to send tokens. Please try again.');
      }
    } catch (err) {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleBurnAndActivate = async () => {
    if (!walletAddress.trim()) {
      setError('Please enter your Solana wallet address');
      return;
    }

    setIsLoading(true);
    setError(null);
    setSuccess(null);

    try {
      // Call burn and activation API
      const response = await fetch('/api/node/activate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          walletAddress: walletAddress.trim(),
          nodeType: 'light', // Default to light node
          burnAmount: FAUCET_AMOUNT
        }),
      });

      const data = await response.json();

      if (data.success) {
        setSuccess(`Node activation successful! Activation code: ${data.activationCode}`);
        setWalletAddress('');
      } else {
        setError(data.error || 'Node activation failed. Please try again.');
      }
    } catch (err) {
      console.error('Activation error:', err);
      setError('Network error during activation. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // Load last claim time from localStorage on component mount
  useState(() => {
    const stored = localStorage.getItem('qnet_faucet_last_claim');
    if (stored) {
      setLastClaim(stored);
    }
  });

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Faucet Card */}
      <Card className="quantum-card p-8">
        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold quantum-text-gradient mb-4">
            🚰 1DEV Token Faucet
          </h2>
          <p className="text-gray-300 mb-2">
            Get {FAUCET_AMOUNT} 1DEV tokens for QNet node activation testing
          </p>
          <p className="text-sm text-gray-400">
            Cooldown: {COOLDOWN_HOURS} hours between claims
          </p>
        </div>

        <div className="space-y-6">
          {!isWalletConnected ? (
            <div className="text-center">
              <Button
                onClick={connectWallet}
                disabled={isLoading}
                className="quantum-button primary"
              >
                🔗 Connect QNet Wallet
              </Button>
              <p className="text-sm text-gray-400 mt-4">
                Or enter address manually:
              </p>
            </div>
          ) : (
            <div className="p-4 bg-purple-500/10 border border-purple-500/30 rounded-lg">
              <p className="text-purple-400 text-sm">
                ✅ Wallet Connected: <span className="font-mono">{walletAddress}</span>
              </p>
            </div>
          )}
          
          {!isWalletConnected && (
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Solana Wallet Address
              </label>
              <Input
                type="text"
                placeholder="Enter your Solana wallet address (e.g., 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU)"
                value={walletAddress}
                onChange={(e) => setWalletAddress(e.target.value)}
                className="quantum-card border-purple-500/30 focus:border-purple-400"
                disabled={isLoading}
              />
            </div>
          )}

          {error && (
            <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          {success && (
            <div className="p-4 bg-green-500/10 border border-green-500/30 rounded-lg">
              <p className="text-green-400 text-sm break-all">{success}</p>
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-4">
            <Button
              onClick={handleClaim}
              disabled={isLoading || !walletAddress.trim()}
              className="flex-1 quantum-button-pro"
            >
              {isLoading ? (
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                  Sending...
                </div>
              ) : (
                `Claim ${FAUCET_AMOUNT} 1DEV Tokens`
              )}
            </Button>

            <Button
              onClick={handleBurnAndActivate}
              disabled={isLoading || !walletAddress.trim()}
              variant="outline"
              className="flex-1 border-purple-500/50 hover:border-purple-400"
            >
              {isLoading ? 'Processing...' : 'Burn & Activate Node'}
            </Button>
          </div>
        </div>
      </Card>

      {/* Information Card */}
      <Card className="quantum-card p-6">
        <h3 className="text-xl font-semibold quantum-text-gradient mb-4">
          How to Use the Faucet
        </h3>
        <div className="space-y-4 text-gray-300">
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 bg-purple-500/20 rounded-full flex items-center justify-center text-purple-400 text-sm font-bold mt-0.5">
              1
            </div>
            <div>
              <h4 className="font-medium text-white mb-1">Get Test Tokens</h4>
              <p className="text-sm text-gray-400">
                Enter your Solana wallet address and claim 1,500 1DEV tokens for testing
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="w-6 h-6 bg-purple-500/20 rounded-full flex items-center justify-center text-purple-400 text-sm font-bold mt-0.5">
              2
            </div>
            <div>
              <h4 className="font-medium text-white mb-1">Activate Node</h4>
              <p className="text-sm text-gray-400">
                Use "Burn & Activate" to automatically burn tokens and get your node activation code
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="w-6 h-6 bg-purple-500/20 rounded-full flex items-center justify-center text-purple-400 text-sm font-bold mt-0.5">
              3
            </div>
            <div>
              <h4 className="font-medium text-white mb-1">Start Your Node</h4>
              <p className="text-sm text-gray-400">
                Use the activation code to start your QNet node and begin earning rewards
              </p>
            </div>
          </div>
        </div>
      </Card>

      {/* Token Info Card */}
      <Card className="quantum-card p-6">
        <h3 className="text-xl font-semibold quantum-text-gradient mb-4">
          1DEV Token Information
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-400">Network:</span>
              <span className="text-white">Solana Devnet</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Symbol:</span>
              <span className="text-white">1DEV</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Decimals:</span>
              <span className="text-white">6</span>
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-400">Total Supply:</span>
              <span className="text-white">1,000,000,000</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Faucet Amount:</span>
              <span className="text-white">1,500 1DEV</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Cooldown:</span>
              <span className="text-white">24 hours</span>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
} 