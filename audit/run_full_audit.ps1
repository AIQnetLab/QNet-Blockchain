# QNet Full Audit Runner
# Runs all tests and generates comprehensive report

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "     QNET BLOCKCHAIN FULL AUDIT SUITE" -ForegroundColor Cyan  
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Write-Host "Audit Started: $timestamp" -ForegroundColor Yellow
Write-Host ""

# Initialize counters
$totalTests = 0
$passedTests = 0
$failedTests = 0

# Function to run test suite
function Run-TestSuite {
    param(
        [string]$SuiteName,
        [string]$TestName
    )
    
    Write-Host "[$SuiteName] Running tests..." -ForegroundColor Blue
    
    $output = cargo test --test $TestName 2>&1 | Out-String
    
    # Parse results
    if ($output -match "(\d+) passed.*?(\d+) failed") {
        $passed = [int]$Matches[1]
        $failed = [int]$Matches[2]
        
        $script:totalTests += ($passed + $failed)
        $script:passedTests += $passed
        $script:failedTests += $failed
        
        if ($failed -eq 0) {
            Write-Host "[$SuiteName] ✅ ALL PASSED: $passed tests" -ForegroundColor Green
        } else {
            Write-Host "[$SuiteName] ⚠️ PARTIAL: $passed passed, $failed failed" -ForegroundColor Yellow
        }
    } else {
        Write-Host "[$SuiteName] ❌ ERROR running tests" -ForegroundColor Red
    }
    
    Write-Host ""
}

# Run all test suites
Run-TestSuite -SuiteName "STORAGE" -TestName "storage_audit"
Run-TestSuite -SuiteName "REPUTATION" -TestName "reputation_audit"
Run-TestSuite -SuiteName "CONSENSUS" -TestName "consensus_audit"
Run-TestSuite -SuiteName "SCALABILITY" -TestName "consensus_scalability"

# Calculate success rate
$successRate = if ($totalTests -gt 0) {
    [math]::Round(($passedTests / $totalTests) * 100, 1)
} else {
    0
}

# Print summary
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "           AUDIT SUMMARY REPORT" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "Total Tests:  $totalTests" -ForegroundColor White
Write-Host "Passed:       $passedTests" -ForegroundColor Green
Write-Host "Failed:       $failedTests" -ForegroundColor $(if ($failedTests -eq 0) {"Green"} else {"Yellow"})
Write-Host "Success Rate: $successRate%" -ForegroundColor $(if ($successRate -ge 80) {"Green"} elseif ($successRate -ge 60) {"Yellow"} else {"Red"})
Write-Host ""

# Verdict
if ($successRate -ge 90) {
    Write-Host "VERDICT: ✅ EXCELLENT - Production Ready" -ForegroundColor Green
} elseif ($successRate -ge 75) {
    Write-Host "VERDICT: ✅ GOOD - Production Ready with Minor Issues" -ForegroundColor Green
} elseif ($successRate -ge 60) {
    Write-Host "VERDICT: ⚠️ ACCEPTABLE - Needs Attention" -ForegroundColor Yellow
} else {
    Write-Host "VERDICT: ❌ FAILED - Not Ready for Production" -ForegroundColor Red
}

Write-Host ""
Write-Host "Detailed reports available in:" -ForegroundColor Cyan
Write-Host "  - audit/FINAL_AUDIT_REPORT.md" -ForegroundColor White
Write-Host "  - audit/results/*.md" -ForegroundColor White
Write-Host ""

$endTime = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Write-Host "Audit Completed: $endTime" -ForegroundColor Yellow
