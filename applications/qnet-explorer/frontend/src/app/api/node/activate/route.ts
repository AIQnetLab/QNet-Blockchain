import { type NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';

// Configuration - delegating to existing bridge API
const BRIDGE_API_BASE = process.env.BRIDGE_API_BASE || 'http://localhost:5000';

interface ActivationRequest {
  walletAddress: string;
  nodeType: 'light' | 'full' | 'super';
  burnAmount: number;
}

interface ActivationResponse {
  success: boolean;
  activationCode?: string;
  txHash?: string;
  error?: string;
}


export async function POST(request: NextRequest): Promise<NextResponse<ActivationResponse>> {
  try {
    const body: ActivationRequest = await request.json();
    const { walletAddress, nodeType, burnAmount } = body;

    // Basic validation
    if (!walletAddress || !nodeType || !burnAmount) {
      return NextResponse.json({ success: false, error: 'Missing parameters' }, { status: 400 });
    }

    // PHASE 1: Use existing OneDEVPhaseHandler system - NO QNC transactions!
    // Call existing production activation system instead of reimplementing
    
    const nodeId = generateNodeId(walletAddress, nodeType);
    
    // Use existing Phase 1 activation handler via bridge API
    const activationRequest = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet_address: walletAddress,
        node_type: nodeType,
        node_id: nodeId,
        burn_amount: burnAmount
      })
    };
    
    const activationResult = await fetch(`${BRIDGE_API_BASE}/api/v1/phase1/activate`, activationRequest)
      .catch(() => null);
    
    if (!activationResult || !activationResult.ok) {
      return NextResponse.json({ 
        success: false, 
        error: 'Phase 1 activation system unavailable' 
      }, { status: 500 });
    }
    
    const activationData = await activationResult.json();
    
    if (!activationData.success) {
      return NextResponse.json({ 
        success: false, 
        error: activationData.error || 'Phase 1 activation failed' 
      }, { status: 400 });
    }

    // Return activation code from existing system
    const activationCode = activationData.node_code;

    return NextResponse.json({ 
      success: true, 
      activationCode, 
      txHash: activationData.burn_transaction || activationData.activation_id 
    });
  } catch (error) {
    console.error('Activation error:', error);
    return NextResponse.json({ success: false, error: 'Unexpected server error' }, { status: 500 });
  }
}

export async function GET(): Promise<NextResponse> {
  // Delegate to existing bridge API for dynamic pricing
  try {
    const bridgeResponse = await fetch(`${BRIDGE_API_BASE}/api/v1/1dev_burn_contract/info`);
    
    if (bridgeResponse.ok) {
      const bridgeData = await bridgeResponse.json();
      const currentPrice = bridgeData.current_burn_price;
      
      return NextResponse.json({
        nodeTypes: {
          light: {
            burnAmount: currentPrice,
            description: 'Mobile-optimized node for basic validation'
          },
          full: {
            burnAmount: currentPrice,
            description: 'Complete validation node for desktop/server'
          },
          super: {
            burnAmount: currentPrice,
            description: 'High-performance node for enterprise use'
          }
        },
        phase: 1,
        tokenType: '1DEV',
        network: 'Solana Devnet',
        dynamicPricing: bridgeData.dynamic_pricing
      });
    }
  } catch (error) {
    console.error('Bridge API unavailable:', error);
  }
  
  // Fallback if bridge offline: Use current production baseline (0% burned = 1500 1DEV)
  const productionBaselinePrice = 1500; // 0% burned baseline price
  
  return NextResponse.json({
    nodeTypes: {
      light: { burnAmount: productionBaselinePrice, description: 'Mobile-optimized node for basic validation' },
      full: { burnAmount: productionBaselinePrice, description: 'Complete validation node for desktop/server' },
      super: { burnAmount: productionBaselinePrice, description: 'High-performance node for enterprise use' }
    },
    phase: 1,
    tokenType: '1DEV', 
    network: 'Solana Devnet (Bridge offline)',
    dynamicPricing: { 
      enabled: false, 
      message: 'Bridge API unavailable - using production baseline',
      fallbackPrice: productionBaselinePrice,
      burnPercentage: 0
    }
  });
}

// Removed generateActivationCodeWithEmbeddedWallet - using bridge API generated codes

function generateNodeId(walletAddress: string, nodeType: string): string {
  // Generate unique node ID
  const data = `${walletAddress}:${nodeType}:${Date.now()}`;
  const hash = createHash('sha256').update(data).digest('hex');
  return `node_${nodeType}_${hash.substring(0, 8)}`;
} 