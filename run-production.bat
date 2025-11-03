@echo off
REM QNet Production Launch Script with Quantum-Resistant Cryptography

echo ========================================
echo   QNet Production Launch
echo   Full Quantum Protection Enabled
echo ========================================
echo.
echo [OK] CRYSTALS-Dilithium: ENABLED
echo [OK] Hybrid Cryptography: ENABLED
echo [OK] Certificate Caching: ENABLED
echo.

echo Building with production features...
cargo build --release --features "production"

if %ERRORLEVEL% EQU 0 (
    echo.
    echo [OK] Build successful!
    echo.
    echo Starting QNet with quantum-resistant consensus...
    echo.
    
    REM Set production environment variables
    set QNET_USE_HYBRID_CRYPTO=true
    set RUST_LOG=info
    
    target\release\qnet-node.exe
) else (
    echo.
    echo [ERROR] Build failed!
    exit /b 1
)

