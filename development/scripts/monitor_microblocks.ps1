# QNet Microblock Monitor
# Monitors microblock creation in real-time

Write-Host "=== QNet Microblock Monitor ===" -ForegroundColor Cyan
Write-Host "Monitoring microblock creation..." -ForegroundColor Yellow

# Function to get block info
function Get-BlockInfo {
    param([int]$Port = 9877)
    
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:$Port/rpc" -Method Post -Body (@{
            jsonrpc = "2.0"
            method = "node_getInfo"
            params = @()
            id = 1
        } | ConvertTo-Json) -ContentType "application/json" -ErrorAction Stop
        
        return $response.result
    } catch {
        return $null
    }
}

# Initialize tracking variables
$startTime = Get-Date
$lastHeight = 0
$blockTimes = @()
$microblockCount = 0
$macroBlockCount = 0

# Get initial state
$info = Get-BlockInfo
if ($info) {
    $lastHeight = $info.height
    Write-Host "Starting height: $lastHeight" -ForegroundColor Green
} else {
    Write-Host "Cannot connect to node!" -ForegroundColor Red
    exit 1
}

Write-Host "`nMonitoring... (Press Ctrl+C to stop)" -ForegroundColor Cyan
Write-Host "Expected: 1 microblock per second, 1 macroblock every 90 seconds" -ForegroundColor Gray
Write-Host ""

# Main monitoring loop
while ($true) {
    Start-Sleep -Milliseconds 500  # Check twice per second
    
    $info = Get-BlockInfo
    if (-not $info) { continue }
    
    $currentHeight = $info.height
    
    # New block detected
    if ($currentHeight -gt $lastHeight) {
        $blockTime = Get-Date
        $blockTimes += $blockTime
        
        # Calculate block rate
        $blocksCreated = $currentHeight - $lastHeight
        $elapsedTotal = ($blockTime - $startTime).TotalSeconds
        $avgBlockTime = if ($blockTimes.Count -gt 1) {
            $recentBlocks = $blockTimes | Select-Object -Last 10
            if ($recentBlocks.Count -gt 1) {
                $timeDiffs = @()
                for ($i = 1; $i -lt $recentBlocks.Count; $i++) {
                    $timeDiffs += ($recentBlocks[$i] - $recentBlocks[$i-1]).TotalSeconds
                }
                ($timeDiffs | Measure-Object -Average).Average
            } else { 0 }
        } else { 0 }
        
        # Determine block type (enhanced detection)
        $blockType = "Unknown"
        
        # Get block details to check producer
        try {
            $blockResponse = Invoke-RestMethod -Uri "http://localhost:9877/rpc" `
                -Method Post `
                -Body "{`"jsonrpc`":`"2.0`",`"method`":`"chain_getBlock`",`"params`":{`"height`":$currentHeight},`"id`":1}" `
                -ContentType "application/json" `
                -TimeoutSec 2
            
            $producer = $blockResponse.result.producer
            
            if ($producer -and $producer.StartsWith('microblock_')) {
                $blockType = "MICROBLOCK"
                $microblockCount += $blocksCreated
            } elseif ($avgBlockTime -lt 3) {
                $blockType = "MICROBLOCK (Fast)"
                $microblockCount += $blocksCreated
            } else {
                $blockType = "STANDARD"
            }
        } catch {
            # Fallback to timing-based detection
            if ($avgBlockTime -lt 5) {
                $blockType = "MICROBLOCK (Timing)"
                $microblockCount += $blocksCreated
            } else {
                $blockType = "STANDARD"
            }
        }
        
        # Check if this might be a macroblock (every ~90 blocks)
        if ($microblockCount -ge 90) {
            $blockType = "MACROBLOCK"
            $macroBlockCount++
            $microblockCount = 0
        }
        
        # Display block info
        $timestamp = $blockTime.ToString("HH:mm:ss.fff")
        Write-Host "[$timestamp] " -NoNewline
        
        if ($blockType -eq "MACROBLOCK") {
            Write-Host "★ MACROBLOCK #$currentHeight" -ForegroundColor Magenta -NoNewline
        } else {
            Write-Host "▪ Block #$currentHeight" -ForegroundColor Green -NoNewline
        }
        
        Write-Host " | Interval: " -NoNewline
        Write-Host ("{0:F2}s" -f $avgBlockTime) -ForegroundColor Yellow -NoNewline
        Write-Host " | Mempool: " -NoNewline
        Write-Host $info.mempool_size -ForegroundColor Cyan -NoNewline
        Write-Host " | Peers: " -NoNewline
        Write-Host $info.peers -ForegroundColor Blue
        
        # Performance summary every 30 seconds
        if ($elapsedTotal -gt 0 -and [int]$elapsedTotal % 30 -eq 0 -and $blocksCreated -eq 1) {
            Write-Host "`n--- Performance Summary ---" -ForegroundColor Yellow
            $totalBlocks = $currentHeight - ($info.height - $blockTimes.Count + 1)
            $blocksPerSecond = $totalBlocks / $elapsedTotal
            $effectiveTPS = $blocksPerSecond * 1000  # Assuming 1000 tx per block average
            
            Write-Host "Total blocks: $totalBlocks" -ForegroundColor Gray
            Write-Host "Blocks/second: $([math]::Round($blocksPerSecond, 2))" -ForegroundColor Gray
            Write-Host "Estimated TPS: $([math]::Round($effectiveTPS, 0))" -ForegroundColor Gray
            Write-Host "Macroblock count: $macroBlockCount" -ForegroundColor Gray
            Write-Host "----------------------------`n" -ForegroundColor Yellow
        }
        
        $lastHeight = $currentHeight
    }
    
    # Show heartbeat every 10 seconds if no new blocks
    if ([int](Get-Date).Second % 10 -eq 0 -and (Get-Date).Millisecond -lt 500) {
        $elapsed = ((Get-Date) - $startTime).TotalSeconds
        if ($elapsed -gt 10 -and $blockTimes.Count -eq 0) {
            Write-Host "." -NoNewline -ForegroundColor DarkGray
        }
    }
} 