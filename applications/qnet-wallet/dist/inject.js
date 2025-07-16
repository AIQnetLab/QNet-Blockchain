
// QNet Wallet Inject Script
console.log('QNet Wallet Inject Script Loaded');

// Inject wallet provider
if (typeof window !== 'undefined') {
    window.qnet = {
        isQNet: true,
        version: '2.0.0',
        network: 'testnet'
    };
}
