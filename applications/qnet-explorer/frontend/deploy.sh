#!/bin/bash

# QNet Explorer Frontend Deployment Script
# This script builds and deploys the QNet Explorer frontend

set -e

echo "🚀 QNet Explorer Frontend Deployment"
echo "======================================"

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Please run this script from the frontend directory."
    exit 1
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build the application
echo "🔨 Building application..."
npm run build

# Start the production server
echo "🌐 Starting production server..."
echo "Frontend will be available at: http://localhost:3000"
echo "API endpoints available at: http://localhost:3000/api/*"
echo ""
echo "Available endpoints:"
echo "  - /api/dao/proposals - DAO proposals"
echo "  - /api/dao/vote - DAO voting"
echo "  - /api/faucet/claim - Faucet claims"
echo ""
echo "Press Ctrl+C to stop the server"

npm start 