# Run second QNet node for testing

# Set environment variables for second node
$env:QNET_PORT = "9878"
$env:QNET_RPC_PORT = "9879"
$env:QNET_BOOTSTRAP_PEERS = "localhost:9876"
$env:QNET_DATA_DIR = "data/blockchain2"

# Create data directory
New-Item -ItemType Directory -Force -Path "data/blockchain2"

Write-Host "Starting second QNet node..." -ForegroundColor Green
Write-Host "P2P Port: 9878" -ForegroundColor Yellow
Write-Host "RPC Port: 9879" -ForegroundColor Yellow
Write-Host "Bootstrap peer: localhost:9876" -ForegroundColor Yellow
Write-Host "Data directory: data/blockchain2" -ForegroundColor Yellow

# Run the node
& ".\target\debug\qnet-node.exe" 