/**
 * Production Build Script for QNet Wallet
 * Builds production-ready wallet with real cryptography and Solana integration
 */

const fs = require('fs');
const path = require('path');

// Build configuration
const BUILD_CONFIG = {
    sourceDir: '.',
    buildDir: './dist-production',
    excludeFiles: [
        'node_modules',
        'dist',
        'dist-production',
        'build-production.js',
        'package-lock.json',
        '.git',
        'README.md',
        'background.js', // Use production version instead
        'test-*.html',
        'debug-*.html',
        'create-icons.*'
    ],
    manifestUpdates: {
        "name": "QNet Wallet - Production",
        "version": "1.0.0",
        "description": "Production QNet Wallet with Solana integration and real cryptography"
    }
};

/**
 * Create directory recursively
 */
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * Copy file from source to destination
 */
function copyFile(src, dest) {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
    console.log(`✅ Copied: ${src} -> ${dest}`);
}

/**
 * Copy directory recursively
 */
function copyDirectory(src, dest, excludeList = []) {
    if (!fs.existsSync(src)) {
        console.warn(`⚠️ Source directory not found: ${src}`);
        return;
    }
    
    ensureDir(dest);
    
    const items = fs.readdirSync(src);
    
    for (const item of items) {
        const srcPath = path.join(src, item);
        const destPath = path.join(dest, item);
        
        // Skip excluded files/directories
        if (excludeList.some(exclude => item.includes(exclude))) {
            console.log(`⏭️ Skipped: ${srcPath}`);
            continue;
        }
        
        const stat = fs.statSync(srcPath);
        
        if (stat.isDirectory()) {
            copyDirectory(srcPath, destPath, excludeList);
        } else {
            copyFile(srcPath, destPath);
        }
    }
}

/**
 * Update manifest.json for production
 */
function updateManifest() {
    const manifestPath = path.join(BUILD_CONFIG.buildDir, 'manifest.json');
    
    if (!fs.existsSync(manifestPath)) {
        console.error('❌ Manifest.json not found in build directory');
        return;
    }
    
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    
    // Apply production updates
    Object.assign(manifest, BUILD_CONFIG.manifestUpdates);
    
    // Ensure production background script
    manifest.background = {
        "service_worker": "background-production.js",
        "type": "module"
    };
    
    // Add production permissions
    if (!manifest.permissions.includes('storage')) {
        manifest.permissions.push('storage');
    }
    
    // Write updated manifest
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log('✅ Updated manifest.json for production');
}

/**
 * Validate production build
 */
function validateBuild() {
    const requiredFiles = [
        'manifest.json',
        'background-production.js',
        'popup.html',
        'popup.js',
        'setup.html',
        'setup.js',
        'src/crypto/RealCrypto.js',
        'src/blockchain/SolanaRPC.js',
        'src/utils/QRGenerator.js'
    ];
    
    let isValid = true;
    
    for (const file of requiredFiles) {
        const filePath = path.join(BUILD_CONFIG.buildDir, file);
        if (!fs.existsSync(filePath)) {
            console.error(`❌ Missing required file: ${file}`);
            isValid = false;
        }
    }
    
    if (isValid) {
        console.log('✅ Production build validation passed');
    } else {
        console.error('❌ Production build validation failed');
        process.exit(1);
    }
}

/**
 * Create production package info
 */
function createPackageInfo() {
    const packageInfo = {
        name: "qnet-wallet-production",
        version: "1.0.0",
        description: "Production QNet Wallet with real cryptography and Solana integration",
        buildDate: new Date().toISOString(),
        features: [
            "Real BIP39 mnemonic generation and validation",
            "Production-grade AES encryption with PBKDF2",
            "Solana RPC integration with real balance fetching",
            "QR code generation for addresses",
            "Dual network support (Solana + QNet)",
            "Auto-balance updates every 30 seconds",
            "Transaction history from Solana blockchain",
            "Secure message signing with Ed25519",
            "Network caching for performance",
            "Production error handling"
        ],
        security: {
            encryption: "AES-256 with PBKDF2 (10,000 iterations)",
            keyDerivation: "BIP39 + HMAC-SHA256",
            signing: "Ed25519 (Solana) / Custom (QNet)",
            storage: "Chrome extension encrypted storage"
        },
        networks: {
            solana: {
                rpc: "https://api.devnet.solana.com",
                features: ["Balance fetching", "Transaction history", "Real addresses"]
            },
            qnet: {
                status: "Simulated (ready for mainnet integration)",
                features: ["EON address generation", "Balance simulation"]
            }
        }
    };
    
    const infoPath = path.join(BUILD_CONFIG.buildDir, 'PRODUCTION_INFO.json');
    fs.writeFileSync(infoPath, JSON.stringify(packageInfo, null, 2));
    console.log('✅ Created production package info');
}

/**
 * Main build function
 */
function buildProduction() {
    console.log('🚀 Starting production build...');
    
    // Clean build directory
    if (fs.existsSync(BUILD_CONFIG.buildDir)) {
        fs.rmSync(BUILD_CONFIG.buildDir, { recursive: true, force: true });
        console.log('🧹 Cleaned build directory');
    }
    
    // Copy all files except excluded ones
    copyDirectory(BUILD_CONFIG.sourceDir, BUILD_CONFIG.buildDir, BUILD_CONFIG.excludeFiles);
    
    // Update manifest for production
    updateManifest();
    
    // Create production package info
    createPackageInfo();
    
    // Validate build
    validateBuild();
    
    console.log('🎉 Production build completed successfully!');
    console.log(`📦 Build location: ${BUILD_CONFIG.buildDir}`);
    console.log('');
    console.log('🔧 Installation instructions:');
    console.log('1. Open Chrome and go to chrome://extensions/');
    console.log('2. Enable "Developer mode"');
    console.log(`3. Click "Load unpacked" and select: ${path.resolve(BUILD_CONFIG.buildDir)}`);
    console.log('4. The production wallet is ready to use!');
    console.log('');
    console.log('✨ Production Features:');
    console.log('- Real Solana RPC integration');
    console.log('- Production-grade cryptography');
    console.log('- QR code generation');
    console.log('- Auto-balance updates');
    console.log('- Secure encrypted storage');
}

// Run build if called directly
if (require.main === module) {
    buildProduction();
}

module.exports = { buildProduction }; 