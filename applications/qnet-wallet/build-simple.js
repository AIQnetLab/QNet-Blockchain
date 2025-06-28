/**
 * Simple build script for QNet Wallet
 * Updates dist files with production functionality
 */

const fs = require('fs');
const path = require('path');

console.log('Building QNet Wallet...');

// Copy popup.js with production functionality
const popupSource = fs.readFileSync('popup.js', 'utf8');
fs.writeFileSync('dist/popup.js', popupSource);
console.log('✅ Updated dist/popup.js');

// Copy updated styles
const stylesSource = fs.readFileSync('styles/popup.css', 'utf8');
fs.writeFileSync('dist/styles/popup.css', stylesSource);
console.log('✅ Updated dist/styles/popup.css');

// Update popup.html to use correct script
const popupHtmlSource = fs.readFileSync('popup.html', 'utf8');
fs.writeFileSync('dist/popup.html', popupHtmlSource);
console.log('✅ Updated dist/popup.html');

// Update manifest.json
const manifestSource = fs.readFileSync('manifest.json', 'utf8');
fs.writeFileSync('dist/manifest.json', manifestSource);
console.log('✅ Updated dist/manifest.json');

console.log('🎉 Build complete! Extension ready in dist/ folder');
console.log('📁 Load dist/ folder in Chrome extensions page'); 