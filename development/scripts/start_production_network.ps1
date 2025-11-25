#!/usr/bin/env pwsh
# QNet Production Network Startup Script - Maximum TPS Configuration

param(
    [int]$NodeCount = 8,
    [int]$StartPort = 9876
    # REMOVED: SkipValidation - all transactions MUST be validated in production
)

Write-Host "=== Starting QNet Production Network with $NodeCount nodes ===" -ForegroundColor Green
Write-Host "Production TPS Configuration Active" -ForegroundColor Yellow

# Kill any existing nodes
Write-Host "Stopping any existing nodes..." -ForegroundColor Yellow
taskkill /F /IM qnet-node.exe 2>$null | Out-Null

# Set production environment variables
Write-Host "Setting production environment variables..." -ForegroundColor Cyan

# Microblock configuration
$env:QNET_ENABLE_MICROBLOCKS = "1"
$env:QNET_MICROBLOCK_SIZE = "100000"
$env:QNET_HIGH_FREQUENCY = "0"

# Mempool configuration (production-ready)
$env:QNET_MEMPOOL_SIZE = "200000"
$env:QNET_MAX_PER_SENDER = "1000"
$env:QNET_MEMPOOL_TTL = "1800"

# Sharding configuration
$env:QNET_ENABLE_SHARDING = "1"
$env:QNET_TOTAL_SHARDS = "32"
$env:QNET_FULL_NODE_SHARDS = "1"
$env:QNET_SUPER_NODE_SHARDS = "4"

# Performance optimizations
$env:QNET_PARALLEL_VALIDATION = "1"
$env:QNET_PARALLEL_THREADS = "16"
$env:QNET_P2P_COMPRESSION = "1"
$env:QNET_HIGH_THROUGHPUT = "1"
$env:QNET_CREATE_EMPTY_BLOCKS = "1"

# PRODUCTION: All transactions are ALWAYS validated (signature, balance, nonce)
# No skip_validation option - removed for security

# Display configuration
Write-Host "`nProduction Configuration:" -ForegroundColor Green
Write-Host "  Microblocks: Enabled (100k tx, 1s intervals)" -ForegroundColor Gray
Write-Host "  Mempool: 200k per node (burst: 1k per sender)" -ForegroundColor Gray
Write-Host "  Sharding: 32 shards (Full:1, Super:4)" -ForegroundColor Gray
Write-Host "  Parallel: 16 threads" -ForegroundColor Gray
Write-Host "  Network: $NodeCount nodes" -ForegroundColor Gray

# Start nodes with different roles
for ($i = 0; $i -lt $NodeCount; $i++) {
    $p2pPort = $StartPort + ($i * 2)
    $rpcPort = $StartPort + ($i * 2) + 1
    $dataDir = "node$($i+1)_data"
    
    # Determine node type
    $nodeRole = if ($i -lt 2) { "Super" } elseif ($i -lt 6) { "Full" } else { "Light" }
    
    Write-Host "`nStarting Node $($i+1) [$nodeRole]:" -ForegroundColor Cyan
    Write-Host "  P2P Port: $p2pPort" -ForegroundColor Gray
    Write-Host "  RPC Port: $rpcPort" -ForegroundColor Gray
    Write-Host "  Data Dir: $dataDir" -ForegroundColor Gray
    
    # Set leader for first super node
    if ($i -eq 0) {
        $env:QNET_IS_LEADER = "1"
        Write-Host "  Role: Block Producer (Leader)" -ForegroundColor Yellow
    } else {
        $env:QNET_IS_LEADER = "0"
        Write-Host "  Role: Validator" -ForegroundColor Gray
    }
    
    if ($i -eq 0) {
        # First node - no bootstrap peers
        Start-Process -FilePath ".\target\release\qnet-node.exe" `
            -ArgumentList "--p2p-port", $p2pPort, "--rpc-port", $rpcPort, "--data-dir", $dataDir `
            -WindowStyle Minimized
    } else {
        # Other nodes - connect to first node
        $bootstrapPeer = "127.0.0.1:$StartPort"
        Write-Host "  Bootstrap: $bootstrapPeer" -ForegroundColor Gray
        
        Start-Process -FilePath ".\target\release\qnet-node.exe" `
            -ArgumentList "--p2p-port", $p2pPort, "--rpc-port", $rpcPort, "--data-dir", $dataDir, "--bootstrap-peers", $bootstrapPeer `
            -WindowStyle Minimized
    }
    
    Start-Sleep -Seconds 3
}

# Wait for network to initialize
Write-Host "`nWaiting for network initialization..." -ForegroundColor Yellow
Start-Sleep -Seconds 10

# Test connectivity
Write-Host "`nTesting network connectivity..." -ForegroundColor Cyan
try {
    $response = Invoke-RestMethod -Uri "http://localhost:9877/rpc" -Method Post -Body (@{
        jsonrpc = "2.0"
        method = "node_getInfo"
        params = @()
        id = 1
    } | ConvertTo-Json) -ContentType "application/json" -TimeoutSec 5
    
    Write-Host "Network operational!" -ForegroundColor Green
    Write-Host "   Node ID: $($response.result.node_id)" -ForegroundColor Gray
    Write-Host "   Node Type: $($response.result.node_type)" -ForegroundColor Gray
} catch {
    Write-Host "Network starting... (may take a few more seconds)" -ForegroundColor Yellow
}

Write-Host "`nProduction Network Started!" -ForegroundColor Green
Write-Host "   Expected TPS: 400k+ (100k per node x $NodeCount nodes)" -ForegroundColor Green
Write-Host "   Network capacity: $($NodeCount * 200)k transactions" -ForegroundColor Green

Write-Host "`nManagement Commands:" -ForegroundColor Yellow
Write-Host "  Monitor TPS: .\monitor_tps.ps1" -ForegroundColor Gray
Write-Host "  Monitor Microblocks: .\monitor_microblocks.ps1" -ForegroundColor Gray
Write-Host "  Send Test Transactions: .\send_test_transactions.ps1" -ForegroundColor Gray
Write-Host "  Check Status: .\check_node_status.ps1" -ForegroundColor Gray

Write-Host "`nTo test maximum TPS:" -ForegroundColor Yellow
Write-Host "  python production_performance_test.py --nodes $NodeCount" -ForegroundColor Gray

Write-Host "`nPress Ctrl+C to stop all nodes" -ForegroundColor Red 