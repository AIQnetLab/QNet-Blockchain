@echo off
REM QNet Audit Runner for Windows (Batch version)

echo ================================
echo   QNET SECURITY AUDIT SUITE
echo ================================
echo.

REM Check if Cargo.toml exists
if not exist "Cargo.toml" (
    echo Error: Must run from audit/ directory
    exit /b 1
)

echo Starting audit tests...
echo.

REM Run Storage Audit
echo Running Storage System Audit...
cargo test --test storage_audit -- --nocapture --test-threads=1 > storage_audit.log 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [PASS] Storage System Audit
) else (
    echo [FAIL] Storage System Audit
)
echo.

REM Run Reputation Audit
echo Running Reputation System Audit...
cargo test --test reputation_audit -- --nocapture --test-threads=1 > reputation_audit.log 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [PASS] Reputation System Audit
) else (
    echo [FAIL] Reputation System Audit
)
echo.

echo ================================
echo        AUDIT COMPLETE
echo ================================
echo.
echo Check log files for details:
echo   - storage_audit.log
echo   - reputation_audit.log
echo.
pause
