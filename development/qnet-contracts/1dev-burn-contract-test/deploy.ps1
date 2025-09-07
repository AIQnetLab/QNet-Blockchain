# 1DEV Burn Contract Deployment Script (PowerShell)
# This script deploys the burn tracking contract to Solana

Write-Host "🚀 Deploying 1DEV Burn Contract to Solana..." -ForegroundColor Green

# Check if Solana CLI is installed
if (!(Get-Command solana -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Solana CLI is not installed. Please install it first:" -ForegroundColor Red
    Write-Host "   Download from: https://github.com/solana-labs/solana/releases"
    Write-Host "   Or use: winget install Solana.SolanaCLI"
    exit 1
}

# Check if Anchor CLI is installed
if (!(Get-Command anchor -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Anchor CLI is not installed. Please install it first:" -ForegroundColor Red
    Write-Host "   cargo install --git https://github.com/coral-xyz/anchor avm --locked"
    Write-Host "   avm install latest"
    Write-Host "   avm use latest"
    exit 1
}

# Set cluster to devnet
Write-Host "🔧 Setting cluster to devnet..." -ForegroundColor Yellow
solana config set --url https://api.devnet.solana.com

# Check wallet balance
Write-Host "💰 Checking wallet balance..." -ForegroundColor Yellow
$balance = solana balance --lamports
$minBalance = 1000000000  # 1 SOL in lamports

if ([int]$balance -lt $minBalance) {
    Write-Host "❌ Insufficient balance. You need at least 1 SOL for deployment." -ForegroundColor Red
    Write-Host "   Request airdrop: solana airdrop 2"
    Write-Host "   Current balance: $(solana balance)"
    exit 1
}

# Build the contract
Write-Host "🔨 Building contract..." -ForegroundColor Yellow
anchor build

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Build failed. Please check the code." -ForegroundColor Red
    exit 1
}

# Deploy the contract
Write-Host "🚀 Deploying contract..." -ForegroundColor Yellow
anchor deploy

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Contract deployed successfully!" -ForegroundColor Green
    $programId = (anchor keys list | Select-String "onedev_burn_contract" | ForEach-Object { $_.ToString().Split(' ')[1] })
    Write-Host "📋 Program ID: $programId" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "🔧 Next steps:" -ForegroundColor Yellow
    Write-Host "1. Update BURN_TRACKER_PROGRAM_ID environment variable"
    Write-Host "2. Update all config files with the new program ID"
    Write-Host "3. Initialize the contract with:"
    Write-Host "   anchor run initialize"
} else {
    Write-Host "❌ Deployment failed. Please check the logs." -ForegroundColor Red
    exit 1
}

Write-Host "🎉 Deployment completed!" -ForegroundColor Green 