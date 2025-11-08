# QNet Genesis Nodes Endpoint Check Script
$ErrorActionPreference = "Continue"

$nodes = @(
    @{ip="154.38.160.39"; name="genesis_node_001"},
    @{ip="62.171.157.44"; name="genesis_node_002"},
    @{ip="161.97.86.81"; name="genesis_node_003"},
    @{ip="173.212.219.226"; name="genesis_node_004"},
    @{ip="164.68.108.218"; name="genesis_node_005"}
)

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "QNET GENESIS NODES ENDPOINT CHECK" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

foreach ($node in $nodes) {
    Write-Host "`n--- $($node.name) ($($node.ip)) ---" -ForegroundColor Yellow
    
    # Health
    try {
        $health = curl "http://$($node.ip):8001/api/v1/node/health" 2>&1
        if ($health.StatusCode -eq 200) {
            $data = $health.Content | ConvertFrom-Json
            Write-Host "[OK] Health: height=$($data.height), peers=$($data.peers), status=$($data.status)" -ForegroundColor Green
        }
    } catch {
        Write-Host "[FAIL] Health endpoint" -ForegroundColor Red
    }
    
    # Height
    try {
        $height = curl "http://$($node.ip):8001/api/v1/height" 2>&1
        if ($height.StatusCode -eq 200) {
            Write-Host "[OK] Height: $($height.Content)" -ForegroundColor Green
        }
    } catch {
        Write-Host "[FAIL] Height endpoint" -ForegroundColor Red
    }
    
    # Peers
    try {
        $peers = curl "http://$($node.ip):8001/api/v1/peers" 2>&1
        if ($peers.StatusCode -eq 200) {
            $peerData = $peers.Content | ConvertFrom-Json
            Write-Host "[OK] Peers: $($peerData.peers.Count) connected" -ForegroundColor Green
        }
    } catch {
        Write-Host "[FAIL] Peers endpoint" -ForegroundColor Red
    }
    
    # Producer Status
    try {
        $producer = curl "http://$($node.ip):8001/api/v1/producer/status" 2>&1
        if ($producer.StatusCode -eq 200) {
            Write-Host "[OK] Producer status available" -ForegroundColor Green
        }
    } catch {
        Write-Host "[FAIL] Producer status endpoint" -ForegroundColor Red
    }
    
    # Failovers
    try {
        $failovers = curl "http://$($node.ip):8001/api/v1/failovers" 2>&1
        if ($failovers.StatusCode -eq 200) {
            Write-Host "[OK] Failovers history available" -ForegroundColor Green
        }
    } catch {
        Write-Host "[FAIL] Failovers endpoint" -ForegroundColor Red
    }
}

Write-Host "`n========================================`n" -ForegroundColor Cyan

