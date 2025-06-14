#!/usr/bin/env pwsh
# Start QNet Network with Microblocks

param(
    [int]$NodeCount = 2,
    [int]$StartPort = 9876
)

Write-Host "=== Starting QNet Network with Microblocks ===" -ForegroundColor Cyan
Write-Host "Microblocks: Every 1 second" -ForegroundColor Green
Write-Host "Macroblocks: Every 90 seconds" -ForegroundColor Green

# Set environment variable to enable microblocks
$env:QNET_ENABLE_MICROBLOCKS = "1"
$env:ENABLE_MICROBLOCKS = "1"

# Kill any existing nodes
Write-Host "`nStopping any existing nodes..." -ForegroundColor Yellow
Get-Process | Where-Object {$_.ProcessName -like "*qnet*"} | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# Check if binary exists
$binaryPath = ".\target\debug\qnet-node.exe"
if (-not (Test-Path $binaryPath)) {
    Write-Host "Error: Binary not found at $binaryPath" -ForegroundColor Red
    Write-Host "Please run 'cargo build' first" -ForegroundColor Yellow
    exit 1
}

Write-Host "Using binary: $binaryPath" -ForegroundColor Green
$binaryInfo = Get-Item $binaryPath
Write-Host "Binary date: $($binaryInfo.LastWriteTime)" -ForegroundColor Gray

# Start nodes
for ($i = 0; $i -lt $NodeCount; $i++) {
    $p2pPort = $StartPort + ($i * 2)
    $rpcPort = $StartPort + ($i * 2) + 1
    $dataDir = "node$($i+1)_data"
    
    Write-Host "`nStarting Node $($i+1):" -ForegroundColor Cyan
    Write-Host "  P2P Port: $p2pPort" -ForegroundColor Gray
    Write-Host "  RPC Port: $rpcPort" -ForegroundColor Gray
    Write-Host "  Data Dir: $dataDir" -ForegroundColor Gray
    
    # Clear data directory for fresh start with microblocks
    if (Test-Path $dataDir) {
        Write-Host "  Clearing old data..." -ForegroundColor Yellow
        Remove-Item -Path "$dataDir\*" -Recurse -Force -ErrorAction SilentlyContinue
    }
    
    # First node is the initial leader
    if ($i -eq 0) {
        $env:QNET_IS_LEADER = "true"
        Write-Host "  Role: LEADER (will create microblocks)" -ForegroundColor Magenta
    } else {
        $env:QNET_IS_LEADER = "false"
        Write-Host "  Role: Follower" -ForegroundColor Gray
    }
    
    if ($i -eq 0) {
        # First node - no bootstrap peers
        Start-Process -FilePath $binaryPath `
            -ArgumentList "--p2p-port", $p2pPort, "--rpc-port", $rpcPort, "--data-dir", $dataDir `
            -WindowStyle Hidden
    } else {
        # Other nodes - connect to first node
        $bootstrapPeer = "127.0.0.1:$StartPort"
        Write-Host "  Bootstrap: $bootstrapPeer" -ForegroundColor Gray
        
        Start-Process -FilePath $binaryPath `
            -ArgumentList "--p2p-port", $p2pPort, "--rpc-port", $rpcPort, "--data-dir", $dataDir, "--bootstrap-peers", $bootstrapPeer `
            -WindowStyle Hidden
    }
    
    Start-Sleep -Seconds 2
}

Write-Host "`n✅ Network started with $NodeCount nodes!" -ForegroundColor Green
Write-Host "🚀 Microblock architecture is now active!" -ForegroundColor Magenta
Write-Host "⚡ Expected: 1 microblock per second" -ForegroundColor Yellow

Write-Host "`nWaiting for nodes to initialize..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

# Check if nodes are running
Write-Host "`nChecking node status..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "http://localhost:9877/rpc" -Method Post -Body '{"jsonrpc":"2.0","method":"node_getInfo","params":[],"id":1}' -ContentType "application/json"
    Write-Host "✅ Node 1 is running! Height: $($response.result.height)" -ForegroundColor Green
} catch {
    Write-Host "⚠️ Node 1 is not responding yet" -ForegroundColor Yellow
}

Write-Host "`nTo monitor microblocks:" -ForegroundColor Yellow
Write-Host "  ./test_microblocks.ps1" -ForegroundColor Gray
Write-Host "`nTo monitor TPS:" -ForegroundColor Yellow
Write-Host "  ./monitor_tps.ps1" -ForegroundColor Gray
Write-Host "`nPress Ctrl+C to stop all nodes" -ForegroundColor Yellow

# Keep script running
try {
    while ($true) {
        Start-Sleep -Seconds 1
    }
} finally {
    Write-Host "`nStopping all nodes..." -ForegroundColor Yellow
    Get-Process | Where-Object {$_.ProcessName -like "*qnet*"} | Stop-Process -Force
    Write-Host "Network stopped." -ForegroundColor Red
} 