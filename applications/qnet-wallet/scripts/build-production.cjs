/**
 * QNet Wallet - Production Build Script
 * Creates a production-ready Chrome extension build in /dist
 */

const fs = require('fs');
const path = require('path');

console.log('🚀 Building QNet Wallet Extension...');

// Clean and create dist directory
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
}
fs.mkdirSync(distDir, { recursive: true });

// Files to copy to dist
const filesToCopy = [
    'manifest.json',
    'background.js',
    'background-production.js',
    'popup.html',
    'popup.js',
    'setup.html',
    'inject.js'
];

// Directories to copy to dist
const dirsToCopy = [
    'icons',
    'styles',
    'scripts',
    'src'
];

// Copy individual files
filesToCopy.forEach(file => {
    const srcPath = path.join(__dirname, '..', file);
    const destPath = path.join(distDir, file);
    
    if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`✅ Copied ${file}`);
    } else {
        console.log(`⚠️  ${file} not found`);
    }
});

// --- Start: Added logic to copy content script ---
const contentScriptSrc = path.join(__dirname, '..', 'src', 'content', 'index.js');
const contentScriptDest = path.join(distDir, 'content.js');
if (fs.existsSync(contentScriptSrc)) {
    fs.copyFileSync(contentScriptSrc, contentScriptDest);
    console.log('✅ Copied content.js');
} else {
    console.error('❌ Critical: content script not found at', contentScriptSrc);
}
// --- End: Added logic to copy content script ---

// Copy directories recursively
function copyDir(src, dest) {
    if (!fs.existsSync(src)) {
        console.log(`⚠️  Directory ${src} not found`);
        return;
    }
    
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    
    const items = fs.readdirSync(src);
    
    items.forEach(item => {
        const srcPath = path.join(src, item);
        const destPath = path.join(dest, item);
        
        if (fs.statSync(srcPath).isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    });
}

dirsToCopy.forEach(dir => {
    const srcPath = path.join(__dirname, '..', dir);
    const destPath = path.join(distDir, dir);
    
    copyDir(srcPath, destPath);
    console.log(`✅ Copied ${dir}/ directory`);
});

// Create production manifest with correct paths
const manifestPath = path.join(distDir, 'manifest.json');
if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    
    // Update web_accessible_resources for production
    manifest.web_accessible_resources = [{
        "resources": [
            "inject.js",
            "setup.html",
            "styles/*",
            "scripts/*",
            "src/*",
            "icons/*"
        ],
        "matches": ["<all_urls>"]
    }];
    
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log('✅ Updated manifest.json for production');
}

console.log('');
// Switch popup.html to use full main.js instead of simple version
const popupPath = path.join(distDir, 'popup.html');
if (fs.existsSync(popupPath)) {
    let popupContent = fs.readFileSync(popupPath, 'utf8');
    popupContent = popupContent.replace(
        'src="src/main-simple.js"',
        'type="module" src="src/main.js"'
    );
    fs.writeFileSync(popupPath, popupContent);
    console.log('✅ Switched to full production wallet');
}

console.log('');
console.log('🎉 Production build completed!');
console.log('📁 Extension files are in: /dist');
console.log('💎 Full QNet Dual Wallet with all production features');
console.log('');
console.log('🚀 To install in Chrome:');
console.log('1. Open chrome://extensions/');
console.log('2. Enable Developer mode');
console.log('3. Click "Load unpacked"');
console.log('4. Select the /dist folder');
console.log('');
console.log('✅ Production-ready QNet Wallet with dual network support!'); 