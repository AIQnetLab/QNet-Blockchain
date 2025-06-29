/**
 * QNet Wallet - Compatibility Tests
 * Testing import compatibility with major wallets including Phantom and Solflare
 */

import { secureBIP39 } from '../src/crypto/ProductionBIP39.js';
import * as bip39 from 'bip39';

describe('Wallet Compatibility Tests', () => {
    
    // Standard test vectors for BIP39 (never use these in production)
    const testSeeds = {
        standard_12: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        standard_24: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"
    };

    describe('Major Wallet Compatibility', () => {
        
        test('Should support MetaMask seed format', () => {
            const result = secureBIP39.validateImportedSeed(testSeeds.standard_12);
            expect(result.valid).toBe(true);
            expect(result.wordCount).toBe(12);
            expect(result.entropyBits).toBe(128);
        });

        test('Should support Trust Wallet seed format', () => {
            const result = secureBIP39.validateImportedSeed(testSeeds.standard_12);
            expect(result.valid).toBe(true);
        });

        test('Should support Phantom wallet seed format', () => {
            // Phantom uses standard BIP39
            const result = secureBIP39.validateImportedSeed(testSeeds.standard_12);
            expect(result.valid).toBe(true);
            expect(result.message).toBe("Valid BIP39 seed phrase ready for import");
        });

        test('Should support Solflare wallet seed format', () => {
            // Solflare uses standard BIP39
            const result = secureBIP39.validateImportedSeed(testSeeds.standard_12);
            expect(result.valid).toBe(true);
        });

        test('Should support Exodus 24-word format', () => {
            const result = secureBIP39.validateImportedSeed(testSeeds.standard_24);
            expect(result.valid).toBe(true);
            expect(result.wordCount).toBe(24);
            expect(result.entropyBits).toBe(256);
        });
    });

    describe('Input Format Handling', () => {
        
        test('Should handle extra whitespace from copy/paste', () => {
            const withSpaces = "  abandon   abandon  abandon abandon abandon abandon abandon abandon abandon abandon abandon about  ";
            const result = secureBIP39.validateImportedSeed(withSpaces);
            expect(result.valid).toBe(true);
        });

        test('Should handle mixed case input', () => {
            const mixedCase = "Abandon ABANDON abandon Abandon abandon abandon abandon abandon abandon abandon abandon about";
            const result = secureBIP39.validateImportedSeed(mixedCase);
            expect(result.valid).toBe(true);
        });

        test('Should handle line breaks from mobile paste', () => {
            const withBreaks = "abandon abandon abandon\nabandon abandon abandon\nabandon abandon abandon\nabandon abandon about";
            const normalized = withBreaks.replace(/\n/g, ' ');
            const result = secureBIP39.validateImportedSeed(normalized);
            expect(result.valid).toBe(true);
        });
    });

    describe('Security Validation', () => {
        
        test('Should enforce minimum entropy', () => {
            const instance = new (secureBIP39.constructor)();
            expect(instance.MIN_ENTROPY_BITS).toBe(128);
        });

        test('Should validate entropy calculations', () => {
            const tests = [
                { words: 12, bits: 128 },
                { words: 15, bits: 160 },
                { words: 18, bits: 192 },
                { words: 21, bits: 224 },
                { words: 24, bits: 256 }
            ];

            tests.forEach(test => {
                const instance = new (secureBIP39.constructor)();
                expect(instance.ENTROPY_MAPPING[test.words]).toBe(test.bits);
            });
        });

        test('Should reject invalid word counts', () => {
            const invalidCounts = [6, 9, 11, 13, 16, 20, 25];
            
            invalidCounts.forEach(count => {
                const words = Array(count).fill('abandon');
                const result = secureBIP39.validateImportedSeed(words.join(' '));
                expect(result.valid).toBe(false);
                expect(result.error).toContain('Invalid word count');
            });
        });
    });

    describe('Real-time Validation', () => {
        
        test('Should provide progress feedback', () => {
            const tests = [
                { input: "abandon", expectedProgress: 8.33 },
                { input: "abandon abandon abandon", expectedProgress: 25 },
                { input: testSeeds.standard_12, expectedProgress: 100 }
            ];

            tests.forEach(testCase => {
                const result = secureBIP39.validateRealTime(testCase.input);
                expect(Math.round(result.progress)).toBe(Math.round(testCase.expectedProgress));
            });
        });

        test('Should validate partial input correctly', () => {
            const partial = "abandon abandon abandon";
            const result = secureBIP39.validateRealTime(partial);
            
            expect(result.hasValidLength).toBe(false);
            expect(result.allWordsValid).toBe(true);
            expect(result.checksumValid).toBe(false);
        });
    });

    describe('Error Handling', () => {
        
        test('Should handle empty input', () => {
            const result = secureBIP39.validateImportedSeed("");
            expect(result.valid).toBe(false);
            expect(result.error).toBe("Seed phrase is required");
        });

        test('Should handle invalid input types', () => {
            const invalidInputs = [null, undefined, 123, {}, []];
            
            invalidInputs.forEach(input => {
                const result = secureBIP39.validateImportedSeed(input);
                expect(result.valid).toBe(false);
            });
        });
    });

    describe('Memory Security', () => {
        
        test('Should clear sensitive data', () => {
            const testArray = new Uint8Array([1, 2, 3, 4, 5]);
            secureBIP39.secureCleanup(testArray);
            expect(testArray.every(byte => byte === 0)).toBe(true);
        });
    });
});

// Integration test with actual wallet operations
describe('Wallet Integration Tests', () => {
    
    test('Should complete full import workflow', async () => {
        const testSeed = testSeeds.standard_12;
        const testPassword = "SecurePassword123!";
        
        // Step 1: Validate seed
        const validation = secureBIP39.validateImportedSeed(testSeed);
        expect(validation.valid).toBe(true);
        
        // Step 2: Import wallet
        const walletData = await secureBIP39.importFromExternalWallet(testSeed, testPassword);
        expect(walletData.imported).toBe(true);
        expect(walletData.entropyBits).toBe(128);
        
        // Step 3: Verify seed derivation
        expect(walletData.seed).toBeDefined();
        expect(walletData.seed.length).toBe(64); // 512 bits = 64 bytes
    });

    test('Should maintain consistency across multiple validations', () => {
        const testSeed = testSeeds.standard_12;
        
        // Run same validation multiple times
        for (let i = 0; i < 10; i++) {
            const result = secureBIP39.validateImportedSeed(testSeed);
            expect(result.valid).toBe(true);
            expect(result.wordCount).toBe(12);
            expect(result.entropyBits).toBe(128);
        }
    });
}); 