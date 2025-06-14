# Start QNet test network with microblock architecture

Write-Host "=== QNet Microblock Test Network ===" -ForegroundColor Green
Write-Host "Starting 2-node network to test micro/macro blocks..."

# Clean up old data
Write-Host "Cleaning up old data..." -ForegroundColor Yellow
Remove-Item -Path "node1_data", "node2_data" -Recurse -Force -ErrorAction SilentlyContinue

# Build the project
Write-Host "Building QNet..." -ForegroundColor Yellow
cargo build --release
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}

# Start Node 1 (Super node, will be initial leader)
Write-Host "Starting Node 1 (Super node)..." -ForegroundColor Cyan
$node1 = Start-Process -FilePath "cargo" -ArgumentList @(
    "run", "--release", "--bin", "qnet-node", "--",
    "--data-dir", "node1_data",
    "--port", "9876",
    "--rpc-port", "8545",
    "--node-type", "super",
    "--region", "na"
) -PassThru -WindowStyle Hidden -RedirectStandardOutput "node1.log" -RedirectStandardError "node1_err.log"

Write-Host "Node 1 PID: $($node1.Id)"

# Wait for Node 1 to start
Write-Host "Waiting for Node 1 to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

# Start Node 2 (Full node)
Write-Host "Starting Node 2 (Full node)..." -ForegroundColor Cyan
$node2 = Start-Process -FilePath "cargo" -ArgumentList @(
    "run", "--release", "--bin", "qnet-node", "--",
    "--data-dir", "node2_data",
    "--port", "9877",
    "--rpc-port", "8546",
    "--node-type", "full",
    "--region", "na",
    "--bootstrap", "localhost:9876"
) -PassThru -WindowStyle Hidden -RedirectStandardOutput "node2.log" -RedirectStandardError "node2_err.log"

Write-Host "Node 2 PID: $($node2.Id)"

# Wait for nodes to connect
Write-Host "Waiting for nodes to connect..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

# Show status
Write-Host ""
Write-Host "=== Network Status ===" -ForegroundColor Green
Write-Host "Node 1 (Super): http://localhost:8545" -ForegroundColor White
Write-Host "Node 2 (Full): http://localhost:8546" -ForegroundColor White
Write-Host ""
Write-Host "Logs:" -ForegroundColor Yellow
Write-Host "  Get-Content node1.log -Tail 50 -Wait" -ForegroundColor Gray
Write-Host "  Get-Content node2.log -Tail 50 -Wait" -ForegroundColor Gray
Write-Host ""
Write-Host "To stop nodes:" -ForegroundColor Yellow
Write-Host "  Stop-Process -Id $($node1.Id), $($node2.Id)" -ForegroundColor Gray
Write-Host ""
Write-Host "Run test:" -ForegroundColor Yellow
Write-Host "  python test_microblocks.py" -ForegroundColor Gray

# Monitor logs in new windows
Write-Host ""
Write-Host "Opening log monitors..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Get-Content node1.log -Tail 50 -Wait"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Get-Content node2.log -Tail 50 -Wait"

Write-Host ""
Write-Host "Press Ctrl+C to stop all nodes..." -ForegroundColor Red

# Keep script running
try {
    while ($true) {
        Start-Sleep -Seconds 1
        if (-not $node1.HasExited -and -not $node2.HasExited) {
            # Both nodes still running
        } else {
            Write-Host "One or more nodes have stopped!" -ForegroundColor Red
            break
        }
    }
} finally {
    Write-Host "Stopping nodes..." -ForegroundColor Yellow
    Stop-Process -Id $node1.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $node2.Id -Force -ErrorAction SilentlyContinue
} 