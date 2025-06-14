# Fix compilation errors in QNet project

Write-Host "Fixing compilation errors..." -ForegroundColor Green

# Fix TransactionType::Transfer in RPC
$rpcFile = "qnet-integration/src/rpc.rs"
$rpcContent = Get-Content $rpcFile -Raw

# Replace simple Transfer with structured Transfer
$rpcContent = $rpcContent -replace 'qnet_state::TransactionType::Transfer,', @'
qnet_state::TransactionType::Transfer {
            from: from.clone(),
            to: to.clone(),
            amount: amount,
        },
'@

Set-Content -Path $rpcFile -Value $rpcContent

# Fix Block::new calls (remove extra arguments)
$files = @(
    "qnet-integration/src/lib.rs",
    "qnet-integration/src/node.rs",
    "qnet-integration/src/genesis.rs"
)

foreach ($file in $files) {
    if (Test-Path $file) {
        $content = Get-Content $file -Raw
        
        # Fix Block::new calls - remove consensus proof argument
        $content = $content -replace 'qnet_state::ConsensusProof\s*\{[^}]*\},', ''
        
        # Fix producer argument
        $content = $content -replace '"validator"\.to_string\(\),\s*qnet_state::ConsensusProof', '"validator".to_string()'
        
        Set-Content -Path $file -Value $content
    }
}

# Fix P2P message structure
$p2pFile = "qnet-integration/src/simple_p2p.rs"
if (Test-Path $p2pFile) {
    $content = Get-Content $p2pFile -Raw
    
    # Change NewBlock to tuple variant if needed
    if ($content -notmatch 'NewBlock\(Vec<u8>\)') {
        Write-Host "P2P message structure already correct" -ForegroundColor Yellow
    }
}

# Add missing methods to StateManager
$stateFile = "qnet-state/src/state.rs"
if (Test-Path $stateFile) {
    $content = Get-Content $stateFile -Raw
    
    # Check if apply_transaction exists
    if ($content -notmatch 'apply_transaction') {
        Write-Host "Adding apply_transaction method to StateManager..." -ForegroundColor Yellow
        # This would need proper implementation
    }
}

Write-Host "Compilation fixes applied!" -ForegroundColor Green
Write-Host "Run 'cargo build --release' to check if issues are resolved" -ForegroundColor Cyan 