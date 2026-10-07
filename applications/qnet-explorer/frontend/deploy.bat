@echo off
REM QNet Explorer Frontend Deployment Script for Windows
REM This script builds and deploys the QNet Explorer frontend

echo 🚀 QNet Explorer Frontend Deployment
echo ======================================

REM Check if we're in the right directory
if not exist "package.json" (
    echo ❌ Error: package.json not found. Please run this script from the frontend directory.
    pause
    exit /b 1
)

REM Install dependencies
echo 📦 Installing dependencies...
npm install
if errorlevel 1 (
    echo ❌ Failed to install dependencies
    pause
    exit /b 1
)

REM Build the application
echo 🔨 Building application...
npm run build
if errorlevel 1 (
    echo ❌ Failed to build application
    pause
    exit /b 1
)

REM Start the production server
echo 🌐 Starting production server...
echo Frontend will be available at: http://localhost:3000
echo API endpoints available at: http://localhost:3000/api/*
echo.
echo Available endpoints:
echo   - /api/dao/proposals - DAO proposals
echo   - /api/dao/vote - DAO voting
echo   - /api/faucet/claim - Faucet claims
echo.
echo Press Ctrl+C to stop the server
echo.

npm start 