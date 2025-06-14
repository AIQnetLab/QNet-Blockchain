# Start nodes individually with verification

Write-Host "Starting QNet nodes individually..." -ForegroundColor Cyan

# Node 1
Write-Host "`nStarting Node 1..." -ForegroundColor Yellow
Start-Process -FilePath "target\release\qnet-node.exe" `
    -ArgumentList "--data-dir", "node1_data", "--p2p-port", "9876", "--rpc-port", "9877" `
    -WindowStyle Hidden

Start-Sleep -Seconds 3

# Check if Node 1 is running
try {
    $response = Invoke-RestMethod -Uri "http://localhost:9877/rpc" -Method Post -Body (@{
        jsonrpc = "2.0"
        method = "node_getInfo"
        params = @()
        id = 1
    } | ConvertTo-Json) -ContentType "application/json"
    Write-Host "✅ Node 1 started successfully" -ForegroundColor Green
} catch {
    Write-Host "❌ Node 1 failed to start" -ForegroundColor Red
    exit 1
}

# Node 2
Write-Host "`nStarting Node 2..." -ForegroundColor Yellow
$env:BOOTSTRAP_PEERS = "127.0.0.1:9876"
Start-Process -FilePath "target\release\qnet-node.exe" `
    -ArgumentList "--data-dir", "node2_data", "--p2p-port", "9878", "--rpc-port", "9879" `
    -WindowStyle Hidden

Start-Sleep -Seconds 3

# Check if Node 2 is running
try {
    $response = Invoke-RestMethod -Uri "http://localhost:9879/rpc" -Method Post -Body (@{
        jsonrpc = "2.0"
        method = "node_getInfo"
        params = @()
        id = 1
    } | ConvertTo-Json) -ContentType "application/json"
    Write-Host "✅ Node 2 started successfully" -ForegroundColor Green
} catch {
    Write-Host "❌ Node 2 failed to start" -ForegroundColor Red
}

# Node 3
Write-Host "`nStarting Node 3..." -ForegroundColor Yellow
Start-Process -FilePath "target\release\qnet-node.exe" `
    -ArgumentList "--data-dir", "node3_data", "--p2p-port", "9880", "--rpc-port", "9881" `
    -WindowStyle Hidden

Start-Sleep -Seconds 3

# Check if Node 3 is running
try {
    $response = Invoke-RestMethod -Uri "http://localhost:9881/rpc" -Method Post -Body (@{
        jsonrpc = "2.0"
        method = "node_getInfo"
        params = @()
        id = 1
    } | ConvertTo-Json) -ContentType "application/json"
    Write-Host "✅ Node 3 started successfully" -ForegroundColor Green
} catch {
    Write-Host "❌ Node 3 failed to start" -ForegroundColor Red
}

# Node 4
Write-Host "`nStarting Node 4..." -ForegroundColor Yellow
Start-Process -FilePath "target\release\qnet-node.exe" `
    -ArgumentList "--data-dir", "node4_data", "--p2p-port", "9882", "--rpc-port", "9883" `
    -WindowStyle Hidden

Start-Sleep -Seconds 3

# Check if Node 4 is running
try {
    $response = Invoke-RestMethod -Uri "http://localhost:9883/rpc" -Method Post -Body (@{
        jsonrpc = "2.0"
        method = "node_getInfo"
        params = @()
        id = 1
    } | ConvertTo-Json) -ContentType "application/json"
    Write-Host "✅ Node 4 started successfully" -ForegroundColor Green
} catch {
    Write-Host "❌ Node 4 failed to start" -ForegroundColor Red
}

# Final check
Write-Host "`nChecking all nodes..." -ForegroundColor Cyan
$running = 0
$ports = @(9877, 9879, 9881, 9883)
foreach ($port in $ports) {
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:$port/rpc" -Method Post -Body (@{
            jsonrpc = "2.0"
            method = "node_getPeers"
            params = @()
            id = 1
        } | ConvertTo-Json) -ContentType "application/json"
        $peers = $response.result.count
        Write-Host "Node on port $port`: $peers peers" -ForegroundColor Green
        $running++
    } catch {
        Write-Host "Node on port $port`: Not responding" -ForegroundColor Red
    }
}

Write-Host "`n✅ $running/4 nodes running" -ForegroundColor $(if ($running -eq 4) { "Green" } else { "Yellow" }) 