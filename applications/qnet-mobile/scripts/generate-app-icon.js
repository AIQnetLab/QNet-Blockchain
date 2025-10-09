const fs = require('fs');
const path = require('path');

/**
 * QNet Android App Icon Generator - Production Version
 * Creates perfect geometric icon with smooth lines matching extension wallet design
 */

// Icon configuration - matching extension wallet lockscreen design
const ICON_CONFIG = {
    backgroundColor: '#1a1a2e',
    primaryColor: '#4a90e2',
    secondaryColor: '#00d4ff',
    accentColor: '#357abd',
    
    // Sizes for Android adaptive icon (xxxhdpi)
    foregroundSize: 432,  // 108dp * 4 for xxxhdpi
    backgroundSize: 432,  // 108dp * 4 for xxxhdpi
    
    // Standard launcher icon sizes  
    sizes: {
        mdpi: 48,
        hdpi: 72,
        xhdpi: 96,
        xxhdpi: 144,
        xxxhdpi: 192
    }
};

/**
 * Generate SVG for the Q logo with perfect circles
 * IMPORTANT: Q design must match extension wallet exactly
 */
function generateQLogoSVG(size, isAdaptive = false) {
    // Calculate dimensions for perfect geometry
    const center = size / 2;
    const scale = isAdaptive ? 0.6 : 0.8; // Adaptive icons need more padding
    
    // Ring dimensions - perfect concentric circles
    const outerRingRadius = (size * scale) / 2;
    const middleRingRadius = outerRingRadius * 0.75;
    const innerRingRadius = outerRingRadius * 0.5;
    
    // Q letter dimensions - matching extension proportions
    const qRadius = innerRingRadius * 0.7;
    const strokeWidth = size * 0.025; // Consistent stroke width
    const qTailLength = qRadius * 0.4;
    const qTailAngle = 45; // degrees
    
    // Calculate Q tail endpoint
    const tailStartX = center + (qRadius * Math.cos(qTailAngle * Math.PI / 180));
    const tailStartY = center + (qRadius * Math.sin(qTailAngle * Math.PI / 180));
    const tailEndX = tailStartX + (qTailLength * Math.cos(qTailAngle * Math.PI / 180));
    const tailEndY = tailStartY + (qTailLength * Math.sin(qTailAngle * Math.PI / 180));
    
    // Create gradient effect like in extension
    const gradientId = `gradient_${Date.now()}`;
    
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <defs>
        <!-- Gradient matching extension wallet colors -->
        <linearGradient id="${gradientId}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:${ICON_CONFIG.secondaryColor};stop-opacity:1" />
            <stop offset="50%" style="stop-color:${ICON_CONFIG.primaryColor};stop-opacity:1" />
            <stop offset="100%" style="stop-color:${ICON_CONFIG.accentColor};stop-opacity:1" />
        </linearGradient>
        
        <!-- Glow effect for smoother appearance -->
        <filter id="glow">
            <feGaussianBlur stdDeviation="2" result="coloredBlur"/>
            <feMerge>
                <feMergeNode in="coloredBlur"/>
                <feMergeNode in="SourceGraphic"/>
            </feMerge>
        </filter>
    </defs>
    
    <!-- Dark background for contrast -->
    <rect width="${size}" height="${size}" fill="${ICON_CONFIG.backgroundColor}"/>
    
    <!-- Outer ring - perfect circle -->
    <circle 
        cx="${center}" 
        cy="${center}" 
        r="${outerRingRadius}" 
        fill="none" 
        stroke="url(#${gradientId})" 
        stroke-width="${strokeWidth * 2}"
        opacity="0.3"
    />
    
    <!-- Middle ring - perfect circle -->
    <circle 
        cx="${center}" 
        cy="${center}" 
        r="${middleRingRadius}" 
        fill="none" 
        stroke="url(#${gradientId})" 
        stroke-width="${strokeWidth * 1.5}"
        opacity="0.5"
    />
    
    <!-- Inner ring - perfect circle -->
    <circle 
        cx="${center}" 
        cy="${center}" 
        r="${innerRingRadius}" 
        fill="none" 
        stroke="url(#${gradientId})" 
        stroke-width="${strokeWidth}"
        opacity="0.7"
    />
    
    <!-- Q letter - perfect geometry matching extension -->
    <g filter="url(#glow)">
        <!-- Q circle -->
        <circle 
            cx="${center}" 
            cy="${center}" 
            r="${qRadius}" 
            fill="none" 
            stroke="url(#${gradientId})" 
            stroke-width="${strokeWidth * 3}"
            stroke-linecap="round"
        />
        
        <!-- Q tail - smooth line -->
        <line 
            x1="${tailStartX}" 
            y1="${tailStartY}" 
            x2="${tailEndX}" 
            y2="${tailEndY}" 
            stroke="url(#${gradientId})" 
            stroke-width="${strokeWidth * 3}"
            stroke-linecap="round"
        />
    </g>
    
    <!-- Subtle animation-like gradient overlay for depth -->
    <circle 
        cx="${center}" 
        cy="${center}" 
        r="${outerRingRadius}" 
        fill="none" 
        stroke="url(#${gradientId})" 
        stroke-width="1"
        opacity="0.2"
        stroke-dasharray="5,10"
    />
</svg>`;
}

/**
 * Generate background for adaptive icon
 */
function generateBackgroundSVG(size) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <defs>
        <linearGradient id="bgGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#0a0a0a;stop-opacity:1" />
            <stop offset="50%" style="stop-color:${ICON_CONFIG.backgroundColor};stop-opacity:1" />
            <stop offset="100%" style="stop-color:#16213e;stop-opacity:1" />
        </linearGradient>
    </defs>
    <rect width="${size}" height="${size}" fill="url(#bgGradient)"/>
</svg>`;
}

/**
 * Convert SVG to PNG using sharp
 */
async function svgToPng(svgString, outputPath, width, height) {
    try {
        // Try to use sharp if available
        const sharp = require('sharp');
        await sharp(Buffer.from(svgString))
            .resize(width, height)
            .png()
            .toFile(outputPath);
        console.log(`✅ Created: ${outputPath}`);
    } catch (error) {
        // Fallback: save as SVG for manual conversion
        const svgPath = outputPath.replace('.png', '.svg');
        fs.writeFileSync(svgPath, svgString);
        console.log(`⚠️ Saved as SVG (install 'sharp' for PNG): ${svgPath}`);
    }
}

/**
 * Generate all required icon files
 */
async function generateAllIcons() {
    const resPath = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
    
    console.log('🎨 QNet Mobile Icon Generator - Production');
    console.log('=========================================');
    console.log('✨ Creating icons with perfect geometry matching extension wallet...\n');
    
    // Generate standard launcher icons
    for (const [density, size] of Object.entries(ICON_CONFIG.sizes)) {
        const dirPath = path.join(resPath, `mipmap-${density}`);
        
        // Create directory if it doesn't exist
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        
        // Generate icon
        const svgContent = generateQLogoSVG(size, false);
        const outputPath = path.join(dirPath, 'ic_launcher.png');
        await svgToPng(svgContent, outputPath, size, size);
        
        // Also generate round variant
        const roundPath = path.join(dirPath, 'ic_launcher_round.png');
        await svgToPng(svgContent, roundPath, size, size);
    }
    
    // Generate adaptive icon foreground (xxxhdpi)
    const foregroundDir = path.join(resPath, 'drawable-xxxhdpi');
    if (!fs.existsSync(foregroundDir)) {
        fs.mkdirSync(foregroundDir, { recursive: true });
    }
    
    const foregroundSvg = generateQLogoSVG(ICON_CONFIG.foregroundSize, true);
    const foregroundPath = path.join(foregroundDir, 'ic_launcher_foreground.png');
    await svgToPng(foregroundSvg, foregroundPath, ICON_CONFIG.foregroundSize, ICON_CONFIG.foregroundSize);
    
    // Generate splash screen logos with perfect geometry
    const splashSizes = {
        'hdpi': 150,
        'mdpi': 100,
        'xhdpi': 200,
        'xxhdpi': 300,
        'xxxhdpi': 400
    };
    
    for (const [density, size] of Object.entries(splashSizes)) {
        const dirPath = path.join(resPath, `drawable-${density}`);
        
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        
        const splashSvg = generateQLogoSVG(size, false);
        const splashPath = path.join(dirPath, 'splash_logo.png');
        await svgToPng(splashSvg, splashPath, size, size);
    }
    
    // Create adaptive icon XML configuration
    const adaptiveIconXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground"/>
</adaptive-icon>`;
    
    const mipmapAnydpiDir = path.join(resPath, 'mipmap-anydpi-v26');
    if (!fs.existsSync(mipmapAnydpiDir)) {
        fs.mkdirSync(mipmapAnydpiDir, { recursive: true });
    }
    
    fs.writeFileSync(path.join(mipmapAnydpiDir, 'ic_launcher.xml'), adaptiveIconXml);
    fs.writeFileSync(path.join(mipmapAnydpiDir, 'ic_launcher_round.xml'), adaptiveIconXml);
    
    console.log('\n✅ Icon generation complete!');
    console.log('📱 Icons created with perfect geometry matching extension wallet');
    console.log('🎯 Q letter and circles are now perfectly smooth and aligned');
    console.log('\n📦 Next step: Rebuild the Android app to see the new icons');
}

// Run generator
generateAllIcons().catch(console.error);
