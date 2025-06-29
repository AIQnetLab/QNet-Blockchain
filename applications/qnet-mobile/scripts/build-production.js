#!/usr/bin/env node

/**
 * QNet Mobile - Production Build Script
 * Builds APK for Android and IPA for iOS with production configurations
 * Handles code signing, optimization, and bundle creation
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class QNetMobileBuilder {
    constructor() {
        this.projectRoot = path.resolve(__dirname, '..');
        this.buildDir = path.join(this.projectRoot, 'build');
        this.distDir = path.join(this.projectRoot, 'dist');
        
        this.config = {
            appName: 'QNetWallet',
            bundleId: 'io.qnet.mobile',
            version: '2.0.0',
            buildNumber: '200',
            
            // Production endpoints
            apiEndpoint: 'https://bridge.qnet.io',
            solanaRPC: 'https://api.mainnet-beta.solana.com',
            qnetRPC: 'https://rpc.qnet.io'
        };
    }

    log(message) {
        console.log(`🚀 QNet Build: ${message}`);
    }

    error(message) {
        console.error(`❌ QNet Build Error: ${message}`);
        process.exit(1);
    }

    ensureDirectories() {
        [this.buildDir, this.distDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
    }

    checkPrerequisites() {
        this.log('Checking build prerequisites...');
        
        try {
            // Check Node.js and npm
            execSync('node --version', { stdio: 'ignore' });
            execSync('npm --version', { stdio: 'ignore' });
            
            // Check React Native CLI
            execSync('npx react-native --version', { stdio: 'ignore' });
            
            this.log('✅ Prerequisites check passed');
        } catch (error) {
            this.error('Prerequisites check failed. Ensure Node.js, npm, and React Native CLI are installed.');
        }
    }

    installDependencies() {
        this.log('Installing dependencies...');
        
        try {
            process.chdir(this.projectRoot);
            execSync('npm install', { stdio: 'inherit' });
            this.log('✅ Dependencies installed');
        } catch (error) {
            this.error('Failed to install dependencies');
        }
    }

    async buildAndroid() {
        this.log('Building Android APK...');
        
        try {
            // Clean previous builds
            const androidDir = path.join(this.projectRoot, 'android');
            process.chdir(androidDir);
            
            this.log('Cleaning Android build...');
            execSync('./gradlew clean', { stdio: 'inherit' });
            
            // Bundle React Native assets
            this.log('Bundling React Native assets for Android...');
            process.chdir(this.projectRoot);
            execSync(`npx react-native bundle \\
                --platform android \\
                --dev false \\
                --entry-file index.js \\
                --bundle-output android/app/src/main/assets/index.android.bundle \\
                --assets-dest android/app/src/main/res`, { stdio: 'inherit' });
            
            // Build APK
            this.log('Building release APK...');
            process.chdir(androidDir);
            execSync('./gradlew assembleRelease', { stdio: 'inherit' });
            
            // Copy APK to dist
            const apkSource = path.join(androidDir, 'app/build/outputs/apk/release/app-release.apk');
            const apkDest = path.join(this.distDir, `QNetWallet-v${this.config.version}-release.apk`);
            
            if (fs.existsSync(apkSource)) {
                fs.copyFileSync(apkSource, apkDest);
                this.log(`✅ Android APK built successfully: ${apkDest}`);
            } else {
                this.error('APK file not found after build');
            }
            
            // Build AAB for Play Store
            this.log('Building Android App Bundle (AAB)...');
            execSync('./gradlew bundleRelease', { stdio: 'inherit' });
            
            const aabSource = path.join(androidDir, 'app/build/outputs/bundle/release/app-release.aab');
            const aabDest = path.join(this.distDir, `QNetWallet-v${this.config.version}-release.aab`);
            
            if (fs.existsSync(aabSource)) {
                fs.copyFileSync(aabSource, aabDest);
                this.log(`✅ Android AAB built successfully: ${aabDest}`);
            }
            
        } catch (error) {
            this.error(`Android build failed: ${error.message}`);
        }
    }

    async buildiOS() {
        this.log('Building iOS IPA...');
        
        // Check if running on macOS
        if (process.platform !== 'darwin') {
            this.log('⚠️  iOS build skipped - requires macOS');
            return;
        }
        
        try {
            const iosDir = path.join(this.projectRoot, 'ios');
            
            // Install CocoaPods
            this.log('Installing CocoaPods dependencies...');
            process.chdir(iosDir);
            execSync('pod install', { stdio: 'inherit' });
            
            // Bundle React Native assets
            this.log('Bundling React Native assets for iOS...');
            process.chdir(this.projectRoot);
            execSync(`npx react-native bundle \\
                --platform ios \\
                --dev false \\
                --entry-file index.js \\
                --bundle-output ios/main.jsbundle \\
                --assets-dest ios`, { stdio: 'inherit' });
            
            // Build for device
            this.log('Building iOS app for device...');
            process.chdir(iosDir);
            
            const buildCommand = `xcodebuild \\
                -workspace QNetMobile.xcworkspace \\
                -scheme QNetMobile \\
                -configuration Release \\
                -destination generic/platform=iOS \\
                -archivePath ${this.buildDir}/QNetMobile.xcarchive \\
                archive`;
                
            execSync(buildCommand, { stdio: 'inherit' });
            
            // Export IPA
            this.log('Exporting IPA...');
            const exportOptions = path.join(this.buildDir, 'ExportOptions.plist');
            
            // Create export options plist
            const exportOptionsPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store</string>
    <key>teamID</key>
    <string>QNET_TEAM_ID</string>
    <key>uploadBitcode</key>
    <false/>
    <key>uploadSymbols</key>
    <true/>
    <key>compileBitcode</key>
    <false/>
</dict>
</plist>`;
            
            fs.writeFileSync(exportOptions, exportOptionsPlist);
            
            const exportCommand = `xcodebuild \\
                -exportArchive \\
                -archivePath ${this.buildDir}/QNetMobile.xcarchive \\
                -exportOptionsPlist ${exportOptions} \\
                -exportPath ${this.buildDir}`;
                
            execSync(exportCommand, { stdio: 'inherit' });
            
            // Copy IPA to dist
            const ipaSource = path.join(this.buildDir, 'QNet Wallet.ipa');
            const ipaDest = path.join(this.distDir, `QNetWallet-v${this.config.version}-release.ipa`);
            
            if (fs.existsSync(ipaSource)) {
                fs.copyFileSync(ipaSource, ipaDest);
                this.log(`✅ iOS IPA built successfully: ${ipaDest}`);
            } else {
                this.error('IPA file not found after build');
            }
            
        } catch (error) {
            this.error(`iOS build failed: ${error.message}`);
        }
    }

    generateBuildInfo() {
        const buildInfo = {
            appName: this.config.appName,
            version: this.config.version,
            buildNumber: this.config.buildNumber,
            buildDate: new Date().toISOString(),
            buildEnvironment: 'production',
            endpoints: {
                bridge: this.config.apiEndpoint,
                solana: this.config.solanaRPC,
                qnet: this.config.qnetRPC
            },
            features: [
                'Phase 1: 1DEV burn activation',
                'Phase 2: QNC spend-to-Pool3 activation',
                'Dual network support (Solana/QNet)',
                'EON address generation',
                'Dynamic pricing based on network size',
                'Secure BIP39 implementation',
                'Bridge authentication'
            ],
            platforms: []
        };
        
        // Check which platforms were built
        const apkPath = path.join(this.distDir, `QNetWallet-v${this.config.version}-release.apk`);
        const ipaPath = path.join(this.distDir, `QNetWallet-v${this.config.version}-release.ipa`);
        
        if (fs.existsSync(apkPath)) {
            buildInfo.platforms.push({
                platform: 'Android',
                file: path.basename(apkPath),
                size: fs.statSync(apkPath).size
            });
        }
        
        if (fs.existsSync(ipaPath)) {
            buildInfo.platforms.push({
                platform: 'iOS',
                file: path.basename(ipaPath),
                size: fs.statSync(ipaPath).size
            });
        }
        
        const buildInfoPath = path.join(this.distDir, 'build-info.json');
        fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2));
        
        this.log(`✅ Build info generated: ${buildInfoPath}`);
    }

    async build(platforms = ['android', 'ios']) {
        this.log(`Starting QNet Mobile production build for: ${platforms.join(', ')}`);
        
        this.ensureDirectories();
        this.checkPrerequisites();
        this.installDependencies();
        
        if (platforms.includes('android')) {
            await this.buildAndroid();
        }
        
        if (platforms.includes('ios')) {
            await this.buildiOS();
        }
        
        this.generateBuildInfo();
        
        this.log('🎉 QNet Mobile production build completed!');
        this.log(`📦 Build artifacts available in: ${this.distDir}`);
    }
}

// CLI interface
if (require.main === module) {
    const builder = new QNetMobileBuilder();
    
    const args = process.argv.slice(2);
    let platforms = ['android', 'ios'];
    
    if (args.includes('--android-only')) {
        platforms = ['android'];
    } else if (args.includes('--ios-only')) {
        platforms = ['ios'];
    }
    
    builder.build(platforms).catch(error => {
        console.error('Build failed:', error);
        process.exit(1);
    });
}

module.exports = QNetMobileBuilder; 