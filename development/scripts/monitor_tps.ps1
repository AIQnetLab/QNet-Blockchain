#!/usr/bin/env pwsh
# Monitor TPS in real-time

Write-Host "=== QNet TPS Monitor ===" -ForegroundColor Cyan

$lastHeight = 0
$lastTime = Get-Date
$lastTxCount = 0
$samples = @()

while ($true) {
    try {
        # Get current stats
        $response = Invoke-RestMethod -Uri "http://localhost:9877/rpc" -Method Post -Body '{"jsonrpc":"2.0","method":"chain_getHeight","params":[],"id":1}' -ContentType "application/json"
        $currentHeight = $response.result.height
        
        # Get mempool size
        $mempoolResponse = Invoke-RestMethod -Uri "http://localhost:9877/rpc" -Method Post -Body '{"jsonrpc":"2.0","method":"mempool_getTransactions","params":[],"id":1}' -ContentType "application/json"
        $mempoolSize = $mempoolResponse.result.Count
        
        # Calculate TPS if height changed
        if ($currentHeight -gt $lastHeight) {
            $currentTime = Get-Date
            $timeDiff = ($currentTime - $lastTime).TotalSeconds
            
            # Get block to count transactions
            $blockResponse = Invoke-RestMethod -Uri "http://localhost:9877/rpc" -Method Post -Body "{`"jsonrpc`":`"2.0`",`"method`":`"chain_getBlock`",`"params`":{`"height`":$currentHeight},`"id`":1}" -ContentType "application/json"
            $txCount = $blockResponse.result.transactions.Count
            
            $tps = if ($timeDiff -gt 0) { [math]::Round($txCount / $timeDiff, 2) } else { 0 }
            
            # Add to samples for average
            $samples += $tps
            if ($samples.Count -gt 10) { $samples = $samples[-10..-1] }
            $avgTps = [math]::Round(($samples | Measure-Object -Average).Average, 2)
            
            # Display
            Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Block #$currentHeight" -ForegroundColor Green
            Write-Host "  Transactions: $txCount"
            Write-Host "  Instant TPS: $tps"
            Write-Host "  Average TPS: $avgTps"
            Write-Host "  Mempool: $mempoolSize pending"
            
            # Determine block type based on producer name or timing
            $blockType = 'Standard'
            if ($blockResponse.result.producer -and $blockResponse.result.producer.StartsWith('microblock_')) {
                $blockType = 'MicroBlock'
            } elseif ($timeDiff -lt 5) {
                # If block was created in less than 5 seconds, likely a microblock
                $blockType = 'MicroBlock (Fast)'
            } elseif ($blockResponse.result.block_type) {
                $blockType = $blockResponse.result.block_type
            }
            
            if ($blockType -eq 'MicroBlock' -or $blockType -eq 'MicroBlock (Fast)') {
                Write-Host "  Block Type: " -NoNewline
                Write-Host $blockType -ForegroundColor Magenta
            } else {
                Write-Host "  Block Type: $blockType"
            }
            
            # Update for next iteration
            $lastHeight = $currentHeight
            $lastTime = $currentTime
            $lastTxCount = $txCount
        }
        else {
            Write-Host "." -NoNewline
        }
        
        Start-Sleep -Seconds 1
    }
    catch {
        Write-Host "`nError: $_" -ForegroundColor Red
        Start-Sleep -Seconds 5
    }
} 