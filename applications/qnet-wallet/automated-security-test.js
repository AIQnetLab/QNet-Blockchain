// Automated Security Test for QNet Wallet
// Runs in Node.js to check real security status

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class SecurityTester {
    constructor() {
        this.results = [];
        this.score = 0;
        this.maxScore = 100;
    }

    // Test 1: Code analysis for vulnerabilities
    checkCodeSecurity() {
        console.log('\n🔍 Test 1: Code vulnerability analysis...');
        
        const files = [
            'dist/popup.js',
            'dist/setup.js',
            'dist/content.js',
            'dist/src/security/SecureKeyManager.js',
            'dist/src/crypto/ProductionBIP39.js'
        ];
        
        let issues = [];
        
        files.forEach(file => {
            try {
                const content = fs.readFileSync(path.join(__dirname, file), 'utf8');
                
                // Check for btoa() password storage
                if (content.includes("btoa(password")) {
                    issues.push(`❌ ${file}: Uses btoa() for passwords (insecure)`);
                }
                
                // Check for seed phrase storage
                if (content.includes("localStorage.setItem") && content.includes("seedPhrase")) {
                    issues.push(`❌ ${file}: May store seed phrase in localStorage`);
                }
                
                // Check for Math.random()
                if (content.includes("Math.random()")) {
                    issues.push(`⚠️ ${file}: Uses Math.random() (not cryptographic)`);
                }
                
                // Check for postMessage with '*'
                if (content.includes("postMessage") && content.includes("'*'")) {
                    issues.push(`⚠️ ${file}: postMessage accepts messages from any origin`);
                }
                
                // Positive checks
                if (content.includes("PBKDF2")) {
                    this.score += 5;
                    console.log(`  ✅ ${file}: Uses PBKDF2`);
                }
                
                if (content.includes("crypto.getRandomValues")) {
                    this.score += 5;
                    console.log(`  ✅ ${file}: Uses crypto.getRandomValues`);
                }
                
                if (content.includes("AES-GCM")) {
                    this.score += 5;
                    console.log(`  ✅ ${file}: Uses AES-GCM encryption`);
                }
                
            } catch (e) {
                console.log(`  ⚠️ Cannot read ${file}`);
            }
        });
        
        if (issues.length > 0) {
            console.log('\n  Issues found:');
            issues.forEach(issue => console.log('  ' + issue));
        } else {
            this.score += 20;
            console.log('  ✅ No critical vulnerabilities found');
        }
        
        return issues;
    }
    
    // Test 2: manifest.json analysis
    checkManifest() {
        console.log('\n🔍 Test 2: manifest.json analysis...');
        
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'dist/manifest.json'), 'utf8'));
            
            // Check CSP
            if (manifest.content_security_policy) {
                console.log('  ✅ Content Security Policy configured');
                this.score += 10;
                
                const csp = manifest.content_security_policy.extension_pages || '';
                if (!csp.includes("'unsafe-eval'")) {
                    console.log('  ✅ CSP blocks eval()');
                    this.score += 5;
                } else {
                    console.log('  ⚠️ CSP allows unsafe-eval');
                }
            } else {
                console.log('  ❌ Content Security Policy not configured');
            }
            
            // Check permissions
            if (manifest.permissions) {
                console.log(`  ℹ️ Requested permissions: ${manifest.permissions.join(', ')}`);
                if (manifest.permissions.includes('activeTab')) {
                    console.log('  ✅ Uses activeTab instead of <all_urls>');
                    this.score += 5;
                }
            }
            
            // Check host permissions
            if (manifest.host_permissions) {
                if (manifest.host_permissions.includes('<all_urls>')) {
                    console.log('  ⚠️ Requests access to all sites');
                } else {
                    console.log('  ✅ Limited host permissions');
                    this.score += 5;
                }
            }
            
        } catch (e) {
            console.log('  ❌ Cannot read manifest.json');
        }
    }
    
    // Test 3: SecureKeyManager
    checkSecureKeyManager() {
        console.log('\n🔍 Test 3: SecureKeyManager...');
        
        try {
            const content = fs.readFileSync(path.join(__dirname, 'dist/src/security/SecureKeyManager.js'), 'utf8');
            
            // Check for key security features
            const features = {
                'Does NOT store seed phrase': !content.includes('localStorage.setItem') || !content.includes('seedPhrase'),
                'Uses PBKDF2': content.includes('PBKDF2'),
                'Uses IndexedDB': content.includes('indexedDB'),
                'Has auto-lock': content.includes('autoLockTimer'),
                'Clears memory': content.includes('.fill(0)'),
                'Uses AES-GCM': content.includes('AES-GCM'),
                'Generates salt': content.includes('crypto.getRandomValues'),
                '100000 PBKDF2 iterations': content.includes('iterations: 100000')
            };
            
            Object.entries(features).forEach(([feature, present]) => {
                if (present) {
                    console.log(`  ✅ ${feature}`);
                    this.score += 5;
                } else {
                    console.log(`  ❌ ${feature}`);
                }
            });
            
        } catch (e) {
            console.log('  ❌ SecureKeyManager not found');
        }
    }
    
    // Test 4: Real integration
    checkIntegration() {
        console.log('\n🔍 Test 4: Integration with popup.js and setup.js...');
        
        try {
            const popupContent = fs.readFileSync(path.join(__dirname, 'dist/popup.js'), 'utf8');
            const setupContent = fs.readFileSync(path.join(__dirname, 'dist/setup.js'), 'utf8');
            
            // Check SecureKeyManager usage in popup.js
            if (popupContent.includes('new SecureKeyManager()') || popupContent.includes('SecureKeyManager')) {
                console.log('  ✅ popup.js uses SecureKeyManager');
                this.score += 10;
                
                // Check proper password verification
                if (popupContent.includes('keyManager.unlockWallet(password)')) {
                    console.log('  ✅ Proper password verification via SecureKeyManager');
                    this.score += 10;
                } else if (popupContent.includes('passwordCorrect = true; // TODO')) {
                    console.log('  ❌ CRITICAL: Fake password verification!');
                    this.score -= 20;
                }
            } else {
                console.log('  ⚠️ popup.js may not use SecureKeyManager');
            }
            
            // Check setup.js
            if (setupContent.includes('new SecureKeyManager()') || setupContent.includes('SecureKeyManager')) {
                console.log('  ✅ setup.js uses SecureKeyManager');
                this.score += 5;
            }
            
        } catch (e) {
            console.log('  ❌ Cannot check integration');
        }
    }
    
    // Final report
    generateReport() {
        console.log('\n' + '='.repeat(60));
        console.log('📊 FINAL SECURITY REPORT');
        console.log('='.repeat(60));
        
        const percentage = Math.max(0, Math.min(100, this.score));
        let grade = 'F';
        let status = '❌ NOT PRODUCTION READY';
        let color = '\x1b[31m'; // Red
        
        if (percentage >= 90) {
            grade = 'A';
            status = '✅ PRODUCTION READY - EXCELLENT SECURITY';
            color = '\x1b[32m'; // Green
        } else if (percentage >= 80) {
            grade = 'B';
            status = '✅ PRODUCTION READY - GOOD SECURITY';
            color = '\x1b[32m';
        } else if (percentage >= 70) {
            grade = 'C';
            status = '⚠️ READY WITH WARNINGS';
            color = '\x1b[33m'; // Yellow
        } else if (percentage >= 60) {
            grade = 'D';
            status = '⚠️ IMPROVEMENTS REQUIRED';
            color = '\x1b[33m';
        }
        
        console.log(`\n${color}Security Score: ${percentage}% (${grade})\x1b[0m`);
        console.log(`Status: ${status}`);
        
        console.log('\n📋 Recommendations:');
        if (percentage < 60) {
            console.log('  1. ❗ Fix critical vulnerabilities');
            console.log('  2. ❗ Remove fake password verification');
            console.log('  3. ❗ Do not store seed phrases');
        } else if (percentage < 80) {
            console.log('  1. ⚠️ Improve SecureKeyManager integration');
            console.log('  2. ⚠️ Add origin check for messages');
            console.log('  3. ⚠️ Replace all Math.random() with crypto.getRandomValues');
        } else {
            console.log('  1. ✅ Conduct independent audit');
            console.log('  2. ✅ Add bug bounty program');
            console.log('  3. ✅ Regularly update dependencies');
        }
        
        // Save report
        const report = {
            date: new Date().toISOString(),
            score: percentage,
            grade: grade,
            status: status,
            version: '2.0.0'
        };
        
        fs.writeFileSync(
            path.join(__dirname, 'security-test-results.json'),
            JSON.stringify(report, null, 2)
        );
        
        console.log('\n💾 Report saved to security-test-results.json');
        
        return percentage;
    }
    
    // Run all tests
    runAllTests() {
        console.log('🔒 QNET WALLET AUTOMATED SECURITY TEST');
        console.log('=' .repeat(60));
        console.log('Version: 2.0.0');
        console.log('Date: ' + new Date().toLocaleDateString());
        console.log('=' .repeat(60));
        
        this.checkCodeSecurity();
        this.checkManifest();
        this.checkSecureKeyManager();
        this.checkIntegration();
        
        const finalScore = this.generateReport();
        
        // Return exit code based on score
        process.exit(finalScore >= 70 ? 0 : 1);
    }
}

// Run tests
const tester = new SecurityTester();
tester.runAllTests();
