# Fix performancePulse animation syntax errors
$cssFile = "src/app/globals.css"

# Read the file content
$content = Get-Content $cssFile -Raw

# Fix the malformed performancePulse keyframes
$oldPattern = '@keyframes performancePulse \{ 0%, 100% \{ transform: scale\(1\); opacity: 0\.8; \} 50% \{ transform: scale\(1\.05\); opacity: 1; \} \}\s*0%, 100% \{ box-shadow: 0 0 20px rgba\(147, 51, 234, 0\.3\), inset 0 0 20px rgba\(147, 51, 234, 0\.1\); \}\s*50% \{ box-shadow: 0 0 40px rgba\(147, 51, 234, 0\.6\), inset 0 0 40px rgba\(147, 51, 234, 0\.2\); \}\s*\}'

$newPattern = '@keyframes performancePulse {
  0%, 100% { 
    transform: scale(1); 
    opacity: 0.8; 
    box-shadow: 0 0 20px rgba(147, 51, 234, 0.3), inset 0 0 20px rgba(147, 51, 234, 0.1);
  }
  50% { 
    transform: scale(1.05); 
    opacity: 1; 
    box-shadow: 0 0 40px rgba(147, 51, 234, 0.6), inset 0 0 40px rgba(147, 51, 234, 0.2);
  }
}'

# Replace all occurrences
$content = $content -replace $oldPattern, $newPattern

# Write back to file
$content | Set-Content $cssFile -NoNewline

Write-Host "Fixed performancePulse animation syntax errors"
Write-Host "Checking for remaining syntax issues..."

# Check if there are any remaining issues
$lines = Get-Content $cssFile
$lineNumber = 0
foreach ($line in $lines) {
    $lineNumber++
    if ($line -match '@keyframes performancePulse.*\}.*0%') {
        Write-Host "Warning: Found potential issue at line $lineNumber : $line"
    }
}

Write-Host "Script completed" 