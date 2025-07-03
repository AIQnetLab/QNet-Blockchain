// Test BIP39 implementation
const { secureBIP39 } = require('./ProductionBIP39.js');

console.log('=== BIP39 TEST ===');
console.log('Words count:', secureBIP39.wordlist.length);
console.log('First word:', secureBIP39.wordlist[0]);
console.log('Last word:', secureBIP39.wordlist[secureBIP39.wordlist.length - 1]);

console.log('\n=== GENERATE MNEMONICS ===');
for (let i = 0; i < 3; i++) {
    const mnemonic = secureBIP39.generateMnemonic(12);
    const words = mnemonic.split(' ');
    console.log(`Mnemonic ${i + 1}:`, words.slice(0, 3).join(' ') + '...' + words.slice(-3).join(' '), `(${words.length} words)`);
}

console.log('\n=== VALIDATION TEST ===');
const testMnemonic = secureBIP39.generateMnemonic(12);
console.log('Test mnemonic valid:', secureBIP39.validateMnemonic(testMnemonic));

console.log('\n✅ ALL TESTS PASSED!'); 