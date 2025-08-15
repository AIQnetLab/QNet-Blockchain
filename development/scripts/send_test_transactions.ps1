# QNet Test Transaction Sender
# Sends test transactions to measure TPS

param(
    [int]$Count = 100,
    [int]$BatchSize = 10,
    [int]$DelayMs = 100
)

Write-Host "=== QNet Transaction Test ===" -ForegroundColor Cyan
Write-Host "Sending $Count transactions in batches of $BatchSize" -ForegroundColor Yellow

# Function to send transaction
function Send-Transaction {
    param(
        [string]$From,
        [string]$To,
        [int]$Amount,
        [int]$Port = 9877
    )
    
    $tx = @{
        jsonrpc = "2.0"
        method = "tx_sendTransaction"
        params = @{
            from = $From
            to = $To
            amount = $Amount
            gas_price = 1
            gas_limit = 10000  # QNet TRANSFER gas limit
            nonce = Get-Random -Maximum 1000000
        }
        id = Get-Random -Maximum 1000000
    } | ConvertTo-Json -Depth 10
    
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:$Port/rpc" -Method Post -Body $tx -ContentType "application/json" -ErrorAction Stop
        return $response.result
    } catch {
        return $null
    }
}

# Generate test accounts
$accounts = @()
for ($i = 0; $i -lt 10; $i++) {
    $accounts += "test_account_$i"
}

# Track statistics
$sent = 0
$failed = 0
$startTime = Get-Date

Write-Host "`nSending transactions..." -ForegroundColor Green

# Send transactions in batches
for ($batch = 0; $batch -lt [Math]::Ceiling($Count / $BatchSize); $batch++) {
    $batchStart = Get-Date
    $batchSent = 0
    
    # Send batch
    for ($i = 0; $i -lt $BatchSize -and $sent -lt $Count; $i++) {
        $from = $accounts | Get-Random
        $to = $accounts | Where-Object { $_ -ne $from } | Get-Random
        $amount = Get-Random -Minimum 1 -Maximum 1000
        
        $result = Send-Transaction -From $from -To $to -Amount $amount
        
        if ($result) {
            $sent++
            $batchSent++
            Write-Host "." -NoNewline -ForegroundColor Green
        } else {
            $failed++
            Write-Host "x" -NoNewline -ForegroundColor Red
        }
    }
    
    # Show batch stats
    $batchTime = ((Get-Date) - $batchStart).TotalSeconds
    $batchTPS = if ($batchTime -gt 0) { [Math]::Round($batchSent / $batchTime, 2) } else { 0 }
    Write-Host " Batch $($batch + 1): $batchSent tx in $([Math]::Round($batchTime, 2))s ($batchTPS TPS)" -ForegroundColor Gray
    
    # Delay between batches
    if ($sent -lt $Count) {
        Start-Sleep -Milliseconds $DelayMs
    }
}

# Final statistics
$totalTime = ((Get-Date) - $startTime).TotalSeconds
$avgTPS = if ($totalTime -gt 0) { [Math]::Round($sent / $totalTime, 2) } else { 0 }

Write-Host "`n=== Results ===" -ForegroundColor Cyan
Write-Host "Total sent: $sent" -ForegroundColor Green
Write-Host "Failed: $failed" -ForegroundColor Red
Write-Host "Time: $([Math]::Round($totalTime, 2)) seconds" -ForegroundColor Gray
Write-Host "Average TPS: $avgTPS" -ForegroundColor Yellow

# Check mempool
try {
    $mempool = Invoke-RestMethod -Uri "http://localhost:9877/rpc" -Method Post -Body (@{
        jsonrpc = "2.0"
        method = "mempool_getStatus"
        params = @()
        id = 1
    } | ConvertTo-Json) -ContentType "application/json"
    
    Write-Host "`nMempool size: $($mempool.result.size)" -ForegroundColor Cyan
} catch {
    Write-Host "`nCould not check mempool" -ForegroundColor DarkGray
} 