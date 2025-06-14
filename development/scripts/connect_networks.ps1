#!/usr/bin/env pwsh
# Connect two isolated networks

Write-Host "=== Connecting Two QNet Networks ===" -ForegroundColor Green
Write-Host "This will create a bridge node that knows about both networks" -ForegroundColor Yellow

# Bridge node configuration
$bridgeP2pPort = 9920
$bridgeRpcPort = 9921
$bridgeDataDir = "bridge_node_data"

# Bootstrap peers from BOTH networks
$bootstrapPeers = "127.0.0.1:9876,127.0.0.1:9900"

Write-Host "`nStarting Bridge Node:" -ForegroundColor Cyan
Write-Host "  P2P Port: $bridgeP2pPort" -ForegroundColor Gray
Write-Host "  RPC Port: $bridgeRpcPort" -ForegroundColor Gray
Write-Host "  Bootstrap peers: $bootstrapPeers" -ForegroundColor Gray

Start-Process -FilePath ".\target\release\qnet-node.exe" `
    -ArgumentList "--p2p-port", $bridgeP2pPort, "--rpc-port", $bridgeRpcPort, "--data-dir", $bridgeDataDir, "--bootstrap-peers", $bootstrapPeers

Write-Host "`n✅ Bridge node started!" -ForegroundColor Green
Write-Host "`nThe bridge node will connect to both networks and they will discover each other!" -ForegroundColor Yellow
Write-Host "Monitor with: python monitor_network.py --dual" -ForegroundColor Gray 