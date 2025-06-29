/**
 * QNet Wallet - Production BIP39 Implementation
 * CRITICAL SECURITY: Full 2048 BIP39 wordlist implementation
 * Supports import from MetaMask, Trust Wallet, Phantom, Solflare, Exodus, etc.
 * Production-ready with comprehensive validation
 */
import * as bip39 from "bip39";

export class ProductionBIP39 {
    constructor() {
        this.SUPPORTED_LENGTHS = [12, 15, 18, 21, 24];
        this.MIN_ENTROPY_BITS = 128;
        this.ENTROPY_MAPPING = {
            12: 128, 15: 160, 18: 192, 21: 224, 24: 256
        };
    }
    /**
     * Validate imported seed phrase from other wallets
     * Supports: MetaMask, Trust Wallet, Phantom, Solflare, Ledger, Trezor, Exodus
     * CRITICAL: Uses full BIP39 validation (2048 words + checksum)
     */
    validateImportedSeed(seedPhrase) {
        try {
            // Step 1: Basic validation
            if (!seedPhrase || typeof seedPhrase !== 'string') {
                return { valid: false, error: "Seed phrase is required" };
            }

            const cleanPhrase = seedPhrase.trim().toLowerCase();
            const words = cleanPhrase.split(/\s+/);

            // Step 2: Check word count
            if (!this.SUPPORTED_LENGTHS.includes(words.length)) {
                return { 
                    valid: false, 
                    error: `Invalid word count: ${words.length}. Must be 12, 15, 18, 21, or 24 words.` 
                };
            }

            // Step 3: CRITICAL - Full BIP39 validation (2048 words + checksum)
            if (!bip39.validateMnemonic(cleanPhrase)) {
                return { 
                    valid: false, 
                    error: "Invalid BIP39 seed phrase. Check words and spelling." 
                };
            }

            // Step 4: Entropy strength validation
            const entropyBits = this.ENTROPY_MAPPING[words.length];
            if (entropyBits < this.MIN_ENTROPY_BITS) {
                return { 
                    valid: false, 
                    error: `Insufficient entropy: ${entropyBits} bits. Minimum required: ${this.MIN_ENTROPY_BITS} bits.` 
                };
            }

            return { 
                valid: true, 
                wordCount: words.length,
                entropyBits: entropyBits,
                message: "Valid BIP39 seed phrase ready for import"
            };

        } catch (error) {
            return { 
                valid: false, 
                error: `Validation error: ${error.message}` 
            };
        }
    }

    /**
     * Generate secure seed phrase with full entropy
     */
    generateSecure(wordCount = 12) {
        if (!this.SUPPORTED_LENGTHS.includes(wordCount)) {
            throw new Error(`Invalid word count: ${wordCount}`);
        }

        try {
            const entropyBits = this.ENTROPY_MAPPING[wordCount];
            return bip39.generateMnemonic(entropyBits);
        } catch (error) {
            throw new Error(`Failed to generate secure seed: ${error.message}`);
        }
    }

    /**
     * Import wallet from external seed phrase
     */
    async importFromExternalWallet(seedPhrase, password) {
        // Validate seed phrase
        const validation = this.validateImportedSeed(seedPhrase);
        if (!validation.valid) {
            throw new Error(validation.error);
        }

        try {
            // Generate seed from mnemonic
            const seed = await bip39.mnemonicToSeed(seedPhrase.trim().toLowerCase());
            
            return {
                seed: seed,
                mnemonic: seedPhrase.trim().toLowerCase(),
                entropyBits: validation.entropyBits,
                wordCount: validation.wordCount,
                imported: true,
                timestamp: Date.now()
            };

        } catch (error) {
            throw new Error(`Import failed: ${error.message}`);
        }
    }

    /**
     * Real-time validation for UI input
     */
    validateRealTime(inputPhrase) {
        const phrase = inputPhrase.trim().toLowerCase();
        const words = phrase.split(/\s+/);

        return {
            hasValidLength: this.SUPPORTED_LENGTHS.includes(words.length),
            allWordsValid: phrase.length > 0 ? this.checkWordsInWordlist(words) : false,
            checksumValid: phrase.length > 0 ? bip39.validateMnemonic(phrase) : false,
            entropyBits: this.ENTROPY_MAPPING[words.length] || 0,
            progress: words.length / 12 * 100
        };
    }

    /**
     * Check if all words are in BIP39 wordlist
     */
    checkWordsInWordlist(words) {
        try {
            const wordlist = bip39.wordlists.EN;
            return words.every(word => wordlist.includes(word));
        } catch (error) {
            return false;
        }
    }

    /**
     * Get entropy strength description
     */
    getEntropyStrength(bits) {
        if (bits >= 256) return "Excellent";
        if (bits >= 192) return "Very Strong";
        if (bits >= 160) return "Strong";
        if (bits >= 128) return "Good";
        return "Weak";
    }

    /**
     * Secure memory cleanup
     */
    secureCleanup(sensitiveData) {
        if (sensitiveData && typeof sensitiveData.fill === 'function') {
            sensitiveData.fill(0);
        }
    }
}

// Export singleton instance
export const secureBIP39 = new ProductionBIP39();
export default ProductionBIP39;
