# QNet Node Status Checker
# Checks the status of running QNet nodes

Write-Host "=== QNet Node Status ===" -ForegroundColor Cyan
Write-Host "Checking nodes..." -ForegroundColor Yellow

# Function to check node status
function Check-NodeStatus {
    param(
        [string]$NodeName,
        [int]$RpcPort
    )
    
    Write-Host "`n$NodeName (RPC Port: $RpcPort):" -ForegroundColor Green
    
    try {
        # Get node info
        $response = Invoke-RestMethod -Uri "http://localhost:$RpcPort/rpc" -Method Post -Body (@{
            jsonrpc = "2.0"
            method = "node_getInfo"
            params = @()
            id = 1
        } | ConvertTo-Json) -ContentType "application/json" -ErrorAction Stop
        
        if ($response.result) {
            $info = $response.result
            Write-Host "  Status: " -NoNewline
            Write-Host "ONLINE" -ForegroundColor Green
            Write-Host "  Node ID: $($info.node_id)" -ForegroundColor Gray
            Write-Host "  Height: $($info.height)" -ForegroundColor Gray
            Write-Host "  Peers: $($info.peers)" -ForegroundColor Gray
            Write-Host "  Mempool: $($info.mempool_size) transactions" -ForegroundColor Gray
            Write-Host "  TPS: $($info.tps)" -ForegroundColor Gray
            
            # Check if microblocks are enabled
            if ($info.microblock_enabled) {
                Write-Host "  Microblocks: " -NoNewline
                Write-Host "ENABLED" -ForegroundColor Green
                Write-Host "  Microblock Height: $($info.microblock_height)" -ForegroundColor Gray
                Write-Host "  Is Leader: $($info.is_leader)" -ForegroundColor Gray
            }
        } else {
            Write-Host "  Status: " -NoNewline
            Write-Host "ERROR" -ForegroundColor Red
            Write-Host "  Error: Invalid response" -ForegroundColor Red
        }
    } catch {
        Write-Host "  Status: " -NoNewline
        Write-Host "OFFLINE" -ForegroundColor Red
        Write-Host "  Error: Cannot connect to node" -ForegroundColor Red
    }
}

# Check standard nodes
Check-NodeStatus "Node 1" 9877
Check-NodeStatus "Node 2" 9879

# Check if additional nodes are running
if (Test-Path "node3_data") {
    Check-NodeStatus "Node 3" 9881
}
if (Test-Path "node4_data") {
    Check-NodeStatus "Node 4" 9883
}

# Check microblock status
Write-Host "`n=== Microblock Status ===" -ForegroundColor Cyan
if ($env:QNET_ENABLE_MICROBLOCKS -or $env:ENABLE_MICROBLOCKS) {
    Write-Host "Microblocks: " -NoNewline
    Write-Host "ENABLED" -ForegroundColor Green
    Write-Host "Expected block rate: 1 per second" -ForegroundColor Gray
    Write-Host "Macroblock interval: Every 90 seconds" -ForegroundColor Gray
} else {
    Write-Host "Microblocks: " -NoNewline
    Write-Host "DISABLED" -ForegroundColor Yellow
    Write-Host "Running in standard mode (10 second blocks)" -ForegroundColor Gray
}

Write-Host "`nPress any key to exit..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") 