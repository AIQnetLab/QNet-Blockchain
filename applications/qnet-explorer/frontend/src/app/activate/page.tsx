"use client";

import { useState, useEffect } from 'react';

export default function ActivatePage() {
  const [selectedNodeType, setSelectedNodeType] = useState<'light' | 'full' | 'super'>('light');
  const [nodeId, setNodeId] = useState('');
  const [activating, setActivating] = useState(false);
  
  // PRODUCTION VALUES: Real-time data from bridge API  
  const currentPhase: 'phase1' | 'phase2' = 'phase1';
  const [burnedTokensPhase1, setBurnedTokensPhase1] = useState(0); // Real-time from blockchain
  const [currentPricing, setCurrentPricing] = useState<Record<string, [number, number]>>({
    light: [1500, 150], // [currentPrice, minimumPrice] - updated from API
    full: [1500, 150],
    super: [1500, 150]
  });
  const activeNodes = 156;

  const totalPhase1Supply = 1_000_000_000; // 1 billion 1DEV total supply (pump.fun standard)
  
  // Fetch real-time pricing on component mount
  useEffect(() => {
    fetch('/api/node/activate')
      .then(response => response.json())
      .then(data => {
        if (data.dynamicPricing && data.dynamicPricing.enabled) {
          const currentPrice = data.nodeTypes.light.burnAmount;
          setCurrentPricing({
            light: [currentPrice, 150],
            full: [currentPrice, 150], 
            super: [currentPrice, 150]
          });
          
          // Calculate burned tokens from pricing info
          if (data.dynamicPricing.burnPercentage !== undefined) {
            const burnedAmount = Math.floor((data.dynamicPricing.burnPercentage / 100) * totalPhase1Supply);
            setBurnedTokensPhase1(burnedAmount);
          }
        }
      })
      .catch(error => {
        console.error('Failed to fetch real-time pricing:', error);
        // Keep default values on error
      });
  }, []);

  // Use current pricing instead of static basePricing
  const basePricing = currentPricing;

  const getCostInfo = (type: 'light' | 'full' | 'super') => {
    if (currentPhase === 'phase1') {
      const base: Record<'light' | 'full' | 'super', [number, number]> = {
        light: [1500, 150],
        full: [1500, 150],
        super: [1500, 150]
      };
      // CORRECT Phase 1 pricing: 1500 base, -150 per each COMPLETE 10% burned, min 150
      const burnedPercent = Math.min(1, burnedTokensPhase1 / totalPhase1Supply);
      const completedTiers = Math.floor((burnedPercent * 100) / 10); // Each complete 10% = 1 tier
      const reduction = completedTiers * 150; // 150 1DEV per tier
      const cost = Math.max(1500 - reduction, 150); // Min 150 1DEV
      const percentBurned = Math.round(burnedPercent * 100);
      
      return {
        cost: cost.toLocaleString(),
        currency: '1DEV',
        method: 'burn',
        details: `${percentBurned}% burned (${burnedTokensPhase1.toLocaleString()}/${totalPhase1Supply.toLocaleString()})`,
        phase: 'Phase 1'
      };
    }

    // Phase 2 dynamic QNC pricing - CORRECT implementation
    const basePrices: Record<'light' | 'full' | 'super', number> = {
      light: 5000,   // Base price for Light node
      full: 7500,    // Base price for Full node
      super: 10000,  // Base price for Super node
    };

    // Determine network multiplier based on active nodes
    let netMultiplier = 0.5;   // 0-100k nodes
    if (activeNodes >= 10_000_000) netMultiplier = 3.0;      // 10M+ nodes
    else if (activeNodes >= 1_000_000) netMultiplier = 2.0;  // 1M-10M nodes  
    else if (activeNodes >= 100_000) netMultiplier = 1.0;    // 100k-1M nodes

    const basePrice = basePrices[type];
    const currentPrice = Math.round(basePrice * netMultiplier);
    
    // Show range from minimum (0.5x) to maximum (3.0x) possible prices
    const minPrice = Math.round(basePrice * 0.5);
    const maxPrice = Math.round(basePrice * 3.0);
    const [calcLow, calcHigh] = [minPrice, maxPrice];
    
    return {
      cost: `${calcLow.toLocaleString()} - ${calcHigh.toLocaleString()}`,
      currency: 'QNC',
      method: 'dynamic',
      details: `${activeNodes.toLocaleString()} active nodes (${netMultiplier}x multiplier)`,
      phase: 'Phase 2'
    };
  };

  const activateNode = async () => {
    if (!nodeId.trim()) return;
    
    setActivating(true);
    try {
      // Simulate activation process
      await new Promise(resolve => setTimeout(resolve, 2000));
      console.log('Node activated:', nodeId);
    } catch (error) {
      console.error('Activation failed:', error);
    } finally {
      setActivating(false);
    }
  };

  const currentCostInfo = getCostInfo(selectedNodeType);

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 25%, #16213e 50%, #1a1a2e 75%, #0a0a0a 100%)",
      color: "white",
      padding: "80px 24px 40px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      position: "relative",
      overflow: "hidden"
    }}>
      {/* Animated background elements */}
      <div style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: `
          radial-gradient(circle at 20% 20%, rgba(0, 255, 255, 0.1) 0%, transparent 50%),
          radial-gradient(circle at 80% 80%, rgba(147, 51, 234, 0.1) 0%, transparent 50%),
          radial-gradient(circle at 40% 60%, rgba(0, 255, 255, 0.05) 0%, transparent 50%)
        `,
        animation: "pulse 4s ease-in-out infinite"
      }} />
      
      <div style={{ position: "relative", zIndex: 1, maxWidth: "1200px", margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: "48px" }}>
          <h1 style={{
            fontSize: "3.5rem",
            fontWeight: "bold",
            marginBottom: "16px",
            background: "linear-gradient(135deg, #00ffff 0%, #ffffff 50%, #00ffff 100%)",
            backgroundClip: "text",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            animation: "shimmer 3s ease-in-out infinite"
          }}>
            Node Activation
          </h1>
          
          <p style={{
            fontSize: "1.25rem",
            color: "#e5e5e5",
            marginBottom: "24px",
            maxWidth: "800px",
            margin: "0 auto"
          }}>
            Activate your QNet node to join the network and start earning rewards
          </p>
          
          <div style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "12px",
            background: "rgba(0, 255, 255, 0.1)",
            border: "1px solid rgba(0, 255, 255, 0.3)",
            borderRadius: "24px",
            padding: "8px 16px",
            fontSize: "0.9rem"
          }}>
            <div style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: currentPhase === 'phase1' ? "#00ffff" : "#9333ea",
              animation: "pulse 2s ease-in-out infinite"
            }} />
            <span>Current: {currentCostInfo.phase}</span>
          </div>
        </div>

        {/* Node Type Selection */}
        <div style={{
          background: "rgba(0, 255, 255, 0.05)",
          border: "1px solid rgba(0, 255, 255, 0.2)",
          borderRadius: "16px",
          padding: "32px",
          marginBottom: "32px"
        }}>
          <h2 style={{
            fontSize: "1.5rem",
            color: "#00ffff",
            textAlign: "center",
            marginBottom: "24px"
          }}>
            Select Node Type
          </h2>
          
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: "16px",
            marginBottom: "32px"
          }}>
            {(['light', 'full', 'super'] as const).map((type) => (
              <button
                key={type}
                onClick={() => setSelectedNodeType(type)}
                style={{
                  background: selectedNodeType === type 
                    ? "linear-gradient(135deg, #00ffff 0%, #0099cc 100%)" 
                    : "rgba(255, 255, 255, 0.05)",
                  border: selectedNodeType === type 
                    ? "2px solid #00ffff" 
                    : "1px solid rgba(255, 255, 255, 0.2)",
                  borderRadius: "12px",
                  padding: "20px",
                  color: selectedNodeType === type ? "#000" : "#fff",
                  fontSize: "1rem",
                  fontWeight: "bold",
                  cursor: "pointer",
                  transition: "all 0.3s ease",
                  textTransform: "uppercase"
                }}
              >
                <div style={{ fontSize: "1.2rem", marginBottom: "8px" }}>
                  {type} NODE
                </div>
                <div style={{ 
                  fontSize: "0.8rem", 
                  opacity: 0.8,
                  color: selectedNodeType === type ? "#000" : "#ccc"
                }}>
                  {type === 'light' ? '(MOBILE)' : '(SERVER)'}
                </div>
              </button>
            ))}
          </div>

          {/* Node Requirements */}
          <div style={{
            background: "rgba(0, 0, 0, 0.3)",
            borderRadius: "12px",
            padding: "24px",
            border: "1px solid rgba(255, 255, 255, 0.1)"
          }}>
            <h3 style={{
              color: "#00ffff",
              fontSize: "1.2rem",
              marginBottom: "16px",
              textAlign: "center"
            }}>
              {selectedNodeType.charAt(0).toUpperCase() + selectedNodeType.slice(1)} Node Requirements
            </h3>
            
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              {/* Requirements in compact 2-row format */}
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                gap: "8px",
                fontSize: "0.9rem"
              }}>
                {selectedNodeType === 'light' && (
                  <>
                    <div>• Ping interval: every 4 h (mobile)</div>
                    <div>• Response rate: 100%</div>
                    <div>• Up to 3 devices per node</div>
                    <div>• Battery-friendly design</div>
                  </>
                )}
                {selectedNodeType === 'full' && (
                  <>
                    <div>• Ping interval: every 4 min</div>
                    <div>• Response rate: ≥ 95%</div>
                    <div>• Public HTTP endpoint</div>
                    <div>• Stable 24/7 connection</div>
                  </>
                )}
                {selectedNodeType === 'super' && (
                  <>
                    <div>• Ping interval: every 4 min</div>
                    <div>• Response rate: ≥ 98%</div>
                    <div>• Backbone routing priority</div>
                    <div>• High-performance hardware</div>
                  </>
                )}
              </div>
              
              {/* Cost info */}
              <div style={{
                background: "rgba(0, 255, 255, 0.1)",
                border: "1px solid rgba(0, 255, 255, 0.3)",
                borderRadius: "8px",
                padding: "12px",
                textAlign: "center"
              }}>
                <div style={{ fontSize: "1.1rem", fontWeight: "bold", color: "#00ffff", marginBottom: "4px" }}>
                  Activation Cost: {currentCostInfo.cost} {currentCostInfo.currency} ({currentCostInfo.method})
                </div>
                <div style={{ fontSize: "0.85rem", color: "#ccc" }}>
                  {currentCostInfo.details}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Activation Form */}
        <div style={{
          background: "rgba(0, 0, 0, 0.3)",
          border: "1px solid rgba(255, 255, 255, 0.2)",
          borderRadius: "16px",
          padding: "32px",
          textAlign: "center"
        }}>
          <div style={{
            display: "flex",
            gap: "16px",
            alignItems: "center",
            maxWidth: "600px",
            margin: "0 auto"
          }}>
            <input
              type="text"
              placeholder={`Enter your ${selectedNodeType} node ID`}
              value={nodeId}
              onChange={(e) => setNodeId(e.target.value)}
              style={{
                flex: 1,
                padding: "16px",
                fontSize: "1rem",
                background: "rgba(255, 255, 255, 0.1)",
                border: "1px solid rgba(0, 255, 255, 0.3)",
                borderRadius: "8px",
                color: "#fff",
                outline: "none"
              }}
              disabled={activating}
            />
            <button
              onClick={activateNode}
              disabled={activating || !nodeId.trim()}
              style={{
                background: activating || !nodeId.trim() 
                  ? "rgba(255, 255, 255, 0.2)" 
                  : "linear-gradient(135deg, #00ffff 0%, #0099cc 100%)",
                border: "none",
                borderRadius: "8px",
                padding: "16px 32px",
                color: activating || !nodeId.trim() ? "#999" : "#000",
                fontSize: "1rem",
                fontWeight: "bold",
                cursor: activating || !nodeId.trim() ? "not-allowed" : "pointer",
                transition: "all 0.3s ease",
                whiteSpace: "nowrap"
              }}
            >
              {activating ? (
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <div style={{
                    width: "16px",
                    height: "16px",
                    border: "2px solid #666",
                    borderTop: "2px solid #000",
                    borderRadius: "50%",
                    animation: "spin 1s linear infinite"
                  }} />
                  ACTIVATING...
                </div>
              ) : (
                `ACTIVATE ${selectedNodeType.toUpperCase()} NODE`
              )}
            </button>
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 0.6; }
        }
        
        @keyframes shimmer {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.8; }
        }
        
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
} 