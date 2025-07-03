/**
 * QNet Dual Wallet Debug Version - Test Imports
 */

console.log('🔍 Starting QNet Wallet Debug Mode');

// Test imports step by step
async function testImports() {
    console.log('1. Testing basic DOM...');
    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen) {
        console.log('✅ DOM elements accessible');
    } else {
        console.error('❌ Cannot access DOM elements');
        return;
    }

    try {
        console.log('2. Testing I18n import...');
        const { I18n } = await import('./i18n/I18n.js');
        console.log('✅ I18n imported successfully');
        
        const i18n = new I18n();
        await i18n.initialize();
        console.log('✅ I18n initialized');
        
    } catch (error) {
        console.error('❌ I18n import failed:', error);
        return;
    }

    try {
        console.log('3. Testing EON generator import...');
        const { EONAddressGenerator } = await import('./crypto/EONAddressGenerator.js');
        console.log('✅ EON generator imported successfully');
        
        const eonGenerator = new EONAddressGenerator();
        console.log('✅ EON generator created');
        
    } catch (error) {
        console.error('❌ EON generator import failed:', error);
        return;
    }

    try {
        console.log('4. Testing network manager import...');
        const { DualNetworkManager } = await import('./network/DualNetworkManager.js');
        console.log('✅ Network manager imported successfully');
        
        const networkManager = new DualNetworkManager();
        console.log('✅ Network manager created');
        
    } catch (error) {
        console.error('❌ Network manager import failed:', error);
        return;
    }

    try {
        console.log('5. Testing integrations import...');
        const { SolanaIntegration } = await import('./integration/SolanaIntegration.js');
        const { QNetIntegration } = await import('./integration/QNetIntegration.js');
        console.log('✅ Integrations imported successfully');
        
        const solanaIntegration = new SolanaIntegration();
        const qnetIntegration = new QNetIntegration();
        console.log('✅ Integrations created');
        
    } catch (error) {
        console.error('❌ Integrations import failed:', error);
        return;
    }

    try {
        console.log('6. Testing dual wallet import...');
        const { QNetDualWallet } = await import('./wallet/QNetDualWallet.js');
        console.log('✅ Dual wallet imported successfully');
        
        // Don't create instance yet, just test import
        console.log('✅ All imports successful!');
        
    } catch (error) {
        console.error('❌ Dual wallet import failed:', error);
        return;
    }

    console.log('🎉 All imports working! Switching to full version...');
    
    // Hide loading screen and show success
    const loadingContainer = loadingScreen.querySelector('.loading-container');
    if (loadingContainer) {
        loadingContainer.innerHTML = `
            <div style="text-align: center;">
                <div style="font-size: 48px; margin-bottom: 20px;">✅</div>
                <h2>Debug Complete</h2>
                <p>All imports successful!</p>
                <button onclick="loadFullVersion()" class="qnet-button primary">
                    🚀 Load Full Wallet
                </button>
            </div>
        `;
    }
}

// Function to load full version
window.loadFullVersion = async function() {
    try {
        console.log('🔄 Loading full wallet version...');
        
        // Import and run full main
        const fullMain = await import('./main-full.js');
        console.log('✅ Full version loaded');
        
    } catch (error) {
        console.error('❌ Failed to load full version:', error);
        alert('Failed to load full wallet. Please check console for details.');
    }
};

// Show basic error if something fails completely
function showError(message) {
    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen) {
        loadingScreen.innerHTML = `
            <div class="loading-container">
                <div style="font-size: 48px; margin-bottom: 20px; color: #ef4444;">❌</div>
                <h2>Debug Failed</h2>
                <p style="color: #ef4444;">${message}</p>
                <button onclick="window.location.reload()" class="qnet-button primary">
                    🔄 Reload
                </button>
            </div>
        `;
    }
}

// Start debug when DOM loads
document.addEventListener('DOMContentLoaded', async () => {
    console.log('📱 DOM loaded - Starting import tests');
    
    try {
        await testImports();
    } catch (error) {
        console.error('❌ Debug failed:', error);
        showError(error.message);
    }
});

console.log('🔍 Debug script loaded'); 