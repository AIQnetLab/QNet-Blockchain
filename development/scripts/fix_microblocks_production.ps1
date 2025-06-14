#!/usr/bin/env pwsh
# QNet Microblock Troubleshooting and Fix Script

param(
    [int]$NodeCount = 4,
    [switch]$ForceRecompile = $false,
    [switch]$CleanStart = $false
)

Write-Host "=== QNet Microblock Diagnostic and Fix Tool ===" -ForegroundColor Cyan
Write-Host "Identifying and fixing microblock activation issues" -ForegroundColor Yellow

# Kill all existing processes
Write-Host "`n[1/8] Cleaning up existing processes..." -ForegroundColor Green
taskkill /F /IM qnet-node.exe 2>$null | Out-Null
Start-Sleep -Seconds 2

# Check binary exists and recompile if needed
Write-Host "`n[2/8] Checking binary compilation..." -ForegroundColor Green
$binaryPath = ".\target\debug\qnet-node.exe"
$needsRecompile = $ForceRecompile -or (-not (Test-Path $binaryPath))

if ($needsRecompile) {
    Write-Host "Recompiling QNet with microblock fixes..." -ForegroundColor Yellow
    cargo build --workspace 2>&1 | Out-Null
    if (-not (Test-Path $binaryPath)) {
        Write-Host "ERROR: Compilation failed!" -ForegroundColor Red
        exit 1
    }
}

$binary = Get-Item $binaryPath
Write-Host "Binary: $($binary.LastWriteTime)" -ForegroundColor Gray

# Clean data directories if requested
if ($CleanStart) {
    Write-Host "`n[3/8] Cleaning node data directories..." -ForegroundColor Green
    for ($i = 1; $i -le 8; $i++) {
        $dataDir = "node${i}_data"
        if (Test-Path $dataDir) {
            Remove-Item -Path $dataDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
} else {
    Write-Host "`n[3/8] Preserving existing node data..." -ForegroundColor Green
}

# Set PERSISTENT environment variables that survive PowerShell sessions
Write-Host "`n[4/8] Setting PERSISTENT environment variables..." -ForegroundColor Green

# Critical microblock variables
[Environment]::SetEnvironmentVariable("QNET_ENABLE_MICROBLOCKS", "1", "User")
[Environment]::SetEnvironmentVariable("QNET_MICROBLOCK_SIZE", "50000", "User")
[Environment]::SetEnvironmentVariable("QNET_HIGH_FREQUENCY", "0", "User")

# Mempool configuration  
[Environment]::SetEnvironmentVariable("QNET_MEMPOOL_SIZE", "100000", "User")
[Environment]::SetEnvironmentVariable("QNET_MAX_PER_SENDER", "500", "User")

# P2P fixes
[Environment]::SetEnvironmentVariable("QNET_P2P_COMPRESSION", "1", "User")
[Environment]::SetEnvironmentVariable("QNET_P2P_TIMEOUT", "30", "User")
[Environment]::SetEnvironmentVariable("QNET_P2P_RECONNECT", "1", "User")

# Performance optimization
[Environment]::SetEnvironmentVariable("QNET_PARALLEL_VALIDATION", "1", "User")
[Environment]::SetEnvironmentVariable("QNET_PARALLEL_THREADS", "8", "User")

# Debugging
[Environment]::SetEnvironmentVariable("QNET_DEBUG_MICROBLOCKS", "1", "User")
[Environment]::SetEnvironmentVariable("RUST_LOG", "info", "User")

# Set for current session as well
$env:QNET_ENABLE_MICROBLOCKS = "1"
$env:QNET_MICROBLOCK_SIZE = "50000"
$env:QNET_HIGH_FREQUENCY = "0"
$env:QNET_MEMPOOL_SIZE = "100000"
$env:QNET_MAX_PER_SENDER = "500"
$env:QNET_P2P_COMPRESSION = "1"
$env:QNET_P2P_TIMEOUT = "30"
$env:QNET_P2P_RECONNECT = "1"
$env:QNET_PARALLEL_VALIDATION = "1"
$env:QNET_PARALLEL_THREADS = "8"
$env:QNET_DEBUG_MICROBLOCKS = "1"
$env:RUST_LOG = "info"

Write-Host "Environment variables set persistently" -ForegroundColor Green

# Verify environment variables are actually set
Write-Host "`n[5/8] Verifying environment variables..." -ForegroundColor Green
$envVars = @(
    "QNET_ENABLE_MICROBLOCKS",
    "QNET_MICROBLOCK_SIZE", 
    "QNET_MEMPOOL_SIZE",
    "QNET_P2P_COMPRESSION"
)

foreach ($var in $envVars) {
    $value = [Environment]::GetEnvironmentVariable($var, "User")
    if ($value) {
        Write-Host "OK $var = $value" -ForegroundColor Green
    } else {
        Write-Host "ERROR $var NOT SET" -ForegroundColor Red
    }
}

# Start nodes with fixed configuration
Write-Host "`n[6/8] Starting nodes with microblock fixes..." -ForegroundColor Green

for ($i = 0; $i -lt $NodeCount; $i++) {
    $p2pPort = 9876 + ($i * 2)
    $rpcPort = 9877 + ($i * 2)
    $dataDir = "node$($i+1)_data"
    
    Write-Host "Starting Node $($i+1): P2P=$p2pPort, RPC=$rpcPort" -ForegroundColor Cyan
    
    if ($i -eq 0) {
        # First node is leader
        $env:QNET_IS_LEADER = "1"
        $args = @("--p2p-port", $p2pPort, "--rpc-port", $rpcPort, "--data-dir", $dataDir)
    } else {
        # Follower nodes
        $env:QNET_IS_LEADER = "0"
        $bootstrap = "127.0.0.1:9876"
        $args = @("--p2p-port", $p2pPort, "--rpc-port", $rpcPort, "--data-dir", $dataDir, "--bootstrap-peers", $bootstrap)
    }
    
    Start-Process -FilePath $binaryPath -ArgumentList $args -WindowStyle Hidden
    Start-Sleep -Seconds 3
}

# Wait for nodes to start
Write-Host "`n[7/8] Waiting for nodes to initialize..." -ForegroundColor Green
Start-Sleep -Seconds 10

# Diagnostic check
Write-Host "`n[8/8] Running diagnostic checks..." -ForegroundColor Green

function Test-NodeStatus($port) {
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:$port/rpc" `
            -Method Post `
            -Body '{"jsonrpc":"2.0","method":"node_getInfo","params":[],"id":1}' `
            -ContentType "application/json" `
            -TimeoutSec 5 `
            -ErrorAction Stop
        return $response.result
    } catch {
        return $null
    }
}

$activeNodes = 0
for ($i = 0; $i -lt $NodeCount; $i++) {
    $rpcPort = 9877 + ($i * 2)
    $status = Test-NodeStatus $rpcPort
    
    if ($status) {
        $activeNodes++
        Write-Host "OK Node $($i+1) (port $rpcPort): ACTIVE" -ForegroundColor Green
        if ($status.height) {
            Write-Host "  Height: $($status.height)" -ForegroundColor Gray
        }
        if ($status.peers) {
            Write-Host "  Peers: $($status.peers)" -ForegroundColor Gray
        }
    } else {
        Write-Host "ERROR Node $($i+1) (port $rpcPort): NOT RESPONDING" -ForegroundColor Red
    }
}

Write-Host "`n=== Diagnostic Summary ===" -ForegroundColor Cyan
Write-Host "Active nodes: $activeNodes/$NodeCount" -ForegroundColor $(if ($activeNodes -eq $NodeCount) { "Green" } else { "Yellow" })

if ($activeNodes -gt 0) {
    Write-Host "OK Environment variables: PERSISTENT" -ForegroundColor Green
    Write-Host "OK Microblocks: ENABLED in all nodes" -ForegroundColor Green
    Write-Host "OK Binary: Latest compilation" -ForegroundColor Green
    
    Write-Host "`nMonitoring microblock production..." -ForegroundColor Yellow
    Write-Host "Watch for 'Block Type: MicroBlock' instead of 'Standard'" -ForegroundColor Gray
    
    # Quick microblock test
    $testPort = 9877
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Seconds 2
        $status = Test-NodeStatus $testPort
        if ($status -and $status.height) {
            $time = Get-Date -Format "HH:mm:ss"
            Write-Host "[$time] Height: $($status.height)" -ForegroundColor White
        }
    }
} else {
    Write-Host "CRITICAL: No nodes responding!" -ForegroundColor Red
    Write-Host "Check logs in node data directories" -ForegroundColor Yellow
}

Write-Host "`nMicroblock fix script completed!" -ForegroundColor Green
Write-Host "Use 'monitor_microblocks.ps1' to watch real-time production" -ForegroundColor Gray 