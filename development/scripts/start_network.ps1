#!/usr/bin/env pwsh
# QNet Network Startup Script

param(
    [int]$NodeCount = 2,
    [int]$StartPort = 9876
)

Write-Host "=== Starting QNet Network with $NodeCount nodes ===" -ForegroundColor Green

# Kill any existing nodes
Write-Host "Stopping any existing nodes..." -ForegroundColor Yellow
taskkill /F /IM qnet-node.exe 2>$null | Out-Null

# Start nodes
for ($i = 0; $i -lt $NodeCount; $i++) {
    $p2pPort = $StartPort + ($i * 2)
    $rpcPort = $StartPort + ($i * 2) + 1
    $dataDir = "node$($i+1)_data"
    
    Write-Host "`nStarting Node $($i+1):" -ForegroundColor Cyan
    Write-Host "  P2P Port: $p2pPort" -ForegroundColor Gray
    Write-Host "  RPC Port: $rpcPort" -ForegroundColor Gray
    Write-Host "  Data Dir: $dataDir" -ForegroundColor Gray
    
    if ($i -eq 0) {
        # First node - no bootstrap peers
        Start-Process -FilePath ".\target\release\qnet-node.exe" `
            -ArgumentList "--p2p-port", $p2pPort, "--rpc-port", $rpcPort, "--data-dir", $dataDir
    } else {
        # Other nodes - connect to first node
        $bootstrapPeer = "127.0.0.1:$StartPort"
        Write-Host "  Bootstrap: $bootstrapPeer" -ForegroundColor Gray
        
        Start-Process -FilePath ".\target\release\qnet-node.exe" `
            -ArgumentList "--p2p-port", $p2pPort, "--rpc-port", $rpcPort, "--data-dir", $dataDir, "--bootstrap-peers", $bootstrapPeer
    }
    
    Start-Sleep -Seconds 2
}

Write-Host "`n✅ Network started with $NodeCount nodes!" -ForegroundColor Green
Write-Host "`nTo check node status:" -ForegroundColor Yellow
Write-Host '  Invoke-RestMethod -Uri "http://localhost:9877/rpc" -Method Post -Body (@{jsonrpc = "2.0"; method = "node_getInfo"; params = @(); id = 1} | ConvertTo-Json) -ContentType "application/json"' -ForegroundColor Gray
Write-Host "`nPress Ctrl+C to stop all nodes" -ForegroundColor Yellow 