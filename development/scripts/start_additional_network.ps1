#!/usr/bin/env pwsh
# Start additional isolated network

Write-Host "=== Starting Additional QNet Network (4 nodes) ===" -ForegroundColor Green
Write-Host "These nodes will NOT know about the first network initially" -ForegroundColor Yellow

# Start nodes on different ports
$basePort = 9900

for ($i = 0; $i -lt 4; $i++) {
    $p2pPort = $basePort + ($i * 2)
    $rpcPort = $basePort + ($i * 2) + 1
    $dataDir = "node_extra_$($i+1)_data"
    
    Write-Host "`nStarting Extra Node $($i+1):" -ForegroundColor Magenta
    Write-Host "  P2P Port: $p2pPort" -ForegroundColor Gray
    Write-Host "  RPC Port: $rpcPort" -ForegroundColor Gray
    Write-Host "  Data Dir: $dataDir" -ForegroundColor Gray
    
    if ($i -eq 0) {
        # First node of the new network - no bootstrap
        Start-Process -FilePath ".\target\release\qnet-node.exe" `
            -ArgumentList "--p2p-port", $p2pPort, "--rpc-port", $rpcPort, "--data-dir", $dataDir
    } else {
        # Connect to the first node of THIS network
        $bootstrapPeer = "127.0.0.1:$basePort"
        Write-Host "  Bootstrap: $bootstrapPeer (isolated network)" -ForegroundColor Gray
        
        Start-Process -FilePath ".\target\release\qnet-node.exe" `
            -ArgumentList "--p2p-port", $p2pPort, "--rpc-port", $rpcPort, "--data-dir", $dataDir, "--bootstrap-peers", $bootstrapPeer
    }
    
    Start-Sleep -Seconds 2
}

Write-Host "`n✅ Additional network started!" -ForegroundColor Green
Write-Host "`nFirst network ports: 9876-9883" -ForegroundColor Cyan
Write-Host "Second network ports: 9900-9907" -ForegroundColor Magenta
Write-Host "`nThese are TWO SEPARATE networks that don't know about each other!" -ForegroundColor Yellow 