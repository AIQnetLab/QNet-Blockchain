# ============================================================================
# QNet Explorer - PostgreSQL Security Setup Script (Windows)
# ============================================================================

param(
    [switch]$Production,
    [string]$AllowedIP = "",
    [switch]$SkipPasswordChange
)

$ErrorActionPreference = "Stop"

Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host "QNet Explorer - PostgreSQL Security Configuration" -ForegroundColor Cyan
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host ""

# ============================================================================
# 1. Detect PostgreSQL installation
# ============================================================================

Write-Host "[1/8] Detecting PostgreSQL installation..." -ForegroundColor Yellow

$pgDataDir = $null
$pgBinDir = $null

# Try to find PostgreSQL data directory
$pgInstallations = Get-ChildItem -Path "C:\Program Files\PostgreSQL" -Directory -ErrorAction SilentlyContinue

if ($pgInstallations) {
    $pgVersion = $pgInstallations | Sort-Object Name -Descending | Select-Object -First 1
    $pgDataDir = Join-Path $pgVersion.FullName "data"
    $pgBinDir = Join-Path $pgVersion.FullName "bin"
    
    if (Test-Path $pgDataDir) {
        Write-Host "   Found PostgreSQL $($pgVersion.Name) at: $pgDataDir" -ForegroundColor Green
    } else {
        throw "PostgreSQL data directory not found at: $pgDataDir"
    }
} else {
    throw "PostgreSQL installation not found in C:\Program Files\PostgreSQL"
}

# ============================================================================
# 2. Create backups
# ============================================================================

Write-Host "[2/8] Creating configuration backups..." -ForegroundColor Yellow

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$backupDir = Join-Path $PSScriptRoot "backups\$timestamp"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

Copy-Item (Join-Path $pgDataDir "postgresql.conf") (Join-Path $backupDir "postgresql.conf.backup") -Force
Copy-Item (Join-Path $pgDataDir "pg_hba.conf") (Join-Path $backupDir "pg_hba.conf.backup") -Force

Write-Host "   Backups saved to: $backupDir" -ForegroundColor Green

# ============================================================================
# 3. Generate or read secure password
# ============================================================================

if (-not $SkipPasswordChange) {
    Write-Host "[3/8] Managing database password..." -ForegroundColor Yellow
    
    $passwordFile = Join-Path $PSScriptRoot "..\..\.postgres_password"
    
    if (-not (Test-Path $passwordFile)) {
        Write-Host "   Generating new secure password..." -ForegroundColor Cyan
        $chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*_+-="
        $newPassword = -join ((1..32) | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
        $newPassword | Out-File $passwordFile -Force -NoNewline
        Write-Host "   New password generated and saved to: $passwordFile" -ForegroundColor Green
    } else {
        $newPassword = Get-Content $passwordFile -Raw
        $newPassword = $newPassword.Trim()
        Write-Host "   Using existing password from: $passwordFile" -ForegroundColor Green
    }
    
    Write-Host ""
    Write-Host "   IMPORTANT: Save this password securely!" -ForegroundColor Red
    Write-Host "   Password: $newPassword" -ForegroundColor Cyan
    Write-Host ""
} else {
    Write-Host "[3/8] Skipping password change (--SkipPasswordChange flag)" -ForegroundColor Yellow
}

# ============================================================================
# 4. Update postgresql.conf
# ============================================================================

Write-Host "[4/8] Updating postgresql.conf..." -ForegroundColor Yellow

$postgresqlConf = Join-Path $PSScriptRoot "postgresql.security.conf"
$targetConf = Join-Path $pgDataDir "postgresql.conf"

if (Test-Path $postgresqlConf) {
    # Read current config to preserve custom settings
    $currentConf = Get-Content $targetConf
    
    # Append security settings
    $securityConf = Get-Content $postgresqlConf
    
    # Add marker
    $marker = "# ============================================================================`n# QNet Security Settings (Applied: $timestamp)`n# ============================================================================"
    
    $newConf = $currentConf + "`n`n$marker`n" + $securityConf
    
    # For production, adjust listen_addresses
    if ($Production -and $AllowedIP) {
        $newConf = $newConf -replace "listen_addresses = 'localhost'", "listen_addresses = 'localhost,$AllowedIP'"
        Write-Host "   Production mode: Added allowed IP: $AllowedIP" -ForegroundColor Cyan
    }
    
    $newConf | Out-File $targetConf -Force -Encoding UTF8
    Write-Host "   postgresql.conf updated successfully" -ForegroundColor Green
} else {
    Write-Host "   WARNING: postgresql.security.conf not found" -ForegroundColor Red
}

# ============================================================================
# 5. Update pg_hba.conf
# ============================================================================

Write-Host "[5/8] Updating pg_hba.conf..." -ForegroundColor Yellow

$pgHbaConf = Join-Path $PSScriptRoot "pg_hba.security.conf"
$targetHba = Join-Path $pgDataDir "pg_hba.conf"

if (Test-Path $pgHbaConf) {
    $securityHba = Get-Content $pgHbaConf
    
    # For production, add allowed IP
    if ($Production -and $AllowedIP) {
        $productionRule = "hostssl qnet_explorer   qnet_user       $AllowedIP/32           scram-sha-256"
        $securityHba = $securityHba -replace "# hostssl qnet_explorer   qnet_user       XXX.XXX.XXX.XXX/32", $productionRule
        Write-Host "   Production mode: Added hostssl rule for $AllowedIP" -ForegroundColor Cyan
    }
    
    $securityHba | Out-File $targetHba -Force -Encoding UTF8
    Write-Host "   pg_hba.conf updated successfully" -ForegroundColor Green
} else {
    Write-Host "   WARNING: pg_hba.security.conf not found" -ForegroundColor Red
}

# ============================================================================
# 6. Update .env file
# ============================================================================

if (-not $SkipPasswordChange) {
    Write-Host "[6/8] Updating .env file..." -ForegroundColor Yellow
    
    $envFile = Join-Path $PSScriptRoot "..\.env.local"
    $envContent = @"
# QNet Explorer - Database Configuration
# Generated: $timestamp

DATABASE_URL=postgresql://qnet_user:$newPassword@localhost:5432/qnet_explorer
QNET_API_URL=http://161.97.86.81:8001
DB_SSL=false
"@
    
    $envContent | Out-File $envFile -Force
    Write-Host "   .env.local created with new password" -ForegroundColor Green
} else {
    Write-Host "[6/8] Skipping .env update (--SkipPasswordChange flag)" -ForegroundColor Yellow
}

# ============================================================================
# 7. Restart PostgreSQL service
# ============================================================================

Write-Host "[7/8] Restarting PostgreSQL service..." -ForegroundColor Yellow

$serviceName = Get-Service | Where-Object { $_.Name -like "postgresql*" } | Select-Object -First 1

if ($serviceName) {
    Write-Host "   Stopping service: $($serviceName.Name)..." -ForegroundColor Cyan
    Restart-Service $serviceName.Name -Force
    Start-Sleep -Seconds 3
    
    $serviceStatus = (Get-Service $serviceName.Name).Status
    if ($serviceStatus -eq "Running") {
        Write-Host "   Service restarted successfully" -ForegroundColor Green
    } else {
        Write-Host "   WARNING: Service status is $serviceStatus" -ForegroundColor Red
    }
} else {
    Write-Host "   WARNING: PostgreSQL service not found" -ForegroundColor Red
    Write-Host "   Please restart PostgreSQL manually" -ForegroundColor Yellow
}

# ============================================================================
# 8. Update database password
# ============================================================================

if (-not $SkipPasswordChange) {
    Write-Host "[8/8] Updating database user password..." -ForegroundColor Yellow
    
    $psqlExe = Join-Path $pgBinDir "psql.exe"
    
    if (Test-Path $psqlExe) {
        try {
            # Try with current password first
            $env:PGPASSWORD = "qnet_password"
            $sqlCommand = "ALTER USER qnet_user WITH PASSWORD '$newPassword';"
            
            & $psqlExe -U qnet_user -d qnet_explorer -c $sqlCommand 2>&1 | Out-Null
            
            if ($LASTEXITCODE -eq 0) {
                Write-Host "   Password updated successfully" -ForegroundColor Green
            } else {
                Write-Host "   WARNING: Could not update password automatically" -ForegroundColor Red
                Write-Host "   Please run manually:" -ForegroundColor Yellow
                Write-Host "   psql -U postgres -c `"ALTER USER qnet_user WITH PASSWORD '$newPassword';`"" -ForegroundColor Cyan
            }
        } catch {
            Write-Host "   WARNING: Error updating password: $_" -ForegroundColor Red
        }
    }
} else {
    Write-Host "[8/8] Skipping database password update (--SkipPasswordChange flag)" -ForegroundColor Yellow
}

# ============================================================================
# Summary
# ============================================================================

Write-Host ""
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host "Security Configuration Complete!" -ForegroundColor Green
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next Steps:" -ForegroundColor Yellow
Write-Host ""
Write-Host "1. Test database connection:" -ForegroundColor White
Write-Host "   psql -U qnet_user -d qnet_explorer -h localhost" -ForegroundColor Cyan
Write-Host ""
Write-Host "2. Update Explorer environment:" -ForegroundColor White
Write-Host "   cd applications/qnet-explorer/frontend" -ForegroundColor Cyan
Write-Host "   Copy .env.local to .env" -ForegroundColor Cyan
Write-Host ""
Write-Host "3. For production deployment:" -ForegroundColor White
Write-Host "   - Generate SSL certificates (see postgresql.security.conf)" -ForegroundColor Cyan
Write-Host "   - Configure firewall to block port 5432 externally" -ForegroundColor Cyan
Write-Host "   - Set up fail2ban for brute force protection" -ForegroundColor Cyan
Write-Host "   - Implement connection pooling (PgBouncer)" -ForegroundColor Cyan
Write-Host ""
Write-Host "4. Monitor logs:" -ForegroundColor White
Write-Host "   Get-Content '$pgDataDir\log\postgresql-*.log' -Tail 50 -Wait" -ForegroundColor Cyan
Write-Host ""
Write-Host "============================================================================" -ForegroundColor Cyan

