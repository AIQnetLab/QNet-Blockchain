/**
 * EON Address Generator for QNet Dual-Network Wallet
 * PRODUCTION FORMAT: 19 chars + "eon" + 15 chars + 4 char checksum = 41 total
 * Compatible with mobile app and backend validation
 */

export class EONAddressGenerator {
    constructor() {
        this.hexCharset = '0123456789abcdef'; // Hex characters only for production
        this.checksumAlgo = 'SHA-256';
    }

    /**
     * Generate new EON address
     * PRODUCTION FORMAT: 19 + 3 + 15 + 4 = 41 characters
     * @returns {string} EON address in format: xxxxxxxxxxxxxxxxxxx eon xxxxxxxxxxxxxxx xxxx
     */
    async generateEONAddress() {
        // Generate 64 random bytes for entropy
        const randomBytes = new Uint8Array(64);
        crypto.getRandomValues(randomBytes);
        
        // Convert to hex
        const hex = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        
        // PRODUCTION FORMAT: 19 + 3 + 15 + 4 = 41
        const part1 = hex.substring(0, 19).toLowerCase();
        const part2 = hex.substring(19, 34).toLowerCase();
        const checksum = await this.calculateChecksum(part1 + 'eon' + part2);
        
        return `${part1}eon${part2}${checksum}`;
    }

    /**
     * Generate cryptographically secure random hex string
     * @param {number} length - Length of hex string
     * @returns {string} Random hex string
     */
    generateSecureRandomHex(length) {
        const bytesNeeded = Math.ceil(length / 2);
        const randomBytes = new Uint8Array(bytesNeeded);
        crypto.getRandomValues(randomBytes);
        
        const hex = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        return hex.substring(0, length).toLowerCase();
    }

    /**
     * Calculate SHA-256 checksum for address validation
     * @param {string} data - Data to calculate checksum for (part1 + "eon" + part2)
     * @returns {string} 4-character hex checksum
     */
    async calculateChecksum(data) {
        const encoder = new TextEncoder();
        const dataBytes = encoder.encode(data);
        
        const hashBuffer = await crypto.subtle.digest('SHA-256', dataBytes);
        const hashArray = new Uint8Array(hashBuffer);
        
        // Use first 2 bytes = 4 hex chars for checksum
        const checksum = Array.from(hashArray.slice(0, 2))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('')
            .toLowerCase();
        
        return checksum;
    }

    /**
     * Validate EON address format and checksum
     * @param {string} address - EON address to validate
     * @returns {boolean} True if valid EON address
     */
    async validateEONAddress(address) {
        if (!address || typeof address !== 'string') {
            return false;
        }

        // Check new format: 19 chars + "eon" + 15 chars + 4 chars = 41 total
        if (address.length !== 41) {
            return false;
        }

        // Check for "eon" in the middle
        if (address.substring(19, 22) !== 'eon') {
            return false;
        }

        // Extract parts for new format
        const part1 = address.substring(0, 19);
        const part2 = address.substring(22, 37);
        const providedChecksum = address.substring(37, 41);

        // Validate character set
        const fullContent = part1 + part2 + providedChecksum;
        for (let char of fullContent) {
            if (!this.charset.includes(char)) {
                return false;
            }
        }

        // Validate checksum
        const calculatedChecksum = await this.calculateChecksum(part1 + part2);
        return calculatedChecksum === providedChecksum;
    }

    /**
     * Convert EON address to QNet blockchain format
     * @param {string} eonAddress - EON address
     * @returns {string} QNet blockchain address
     */
    eonToQNetAddress(eonAddress) {
        // For blockchain storage, we use the full EON address as unique identifier
        return eonAddress;
    }

    /**
     * Generate deterministic EON address from seed
     * @param {string} seed - Seed phrase or private key
     * @param {number} accountIndex - Account derivation index
     * @returns {string} Deterministic EON address
     */
    async generateDeterministicEON(seed, accountIndex = 0) {
        const encoder = new TextEncoder();
        const seedData = encoder.encode(seed + accountIndex.toString());
        
        const hashBuffer = await crypto.subtle.digest('SHA-256', seedData);
        const hashArray = new Uint8Array(hashBuffer);
        
        // Use hash to generate deterministic but random-looking address
        let part1 = '';
        let part2 = '';
        
        for (let i = 0; i < 8; i++) {
            part1 += this.charset[hashArray[i] % this.charset.length];
            part2 += this.charset[hashArray[i + 8] % this.charset.length];
        }
        
        const checksum = await this.calculateChecksum(part1 + part2);
        return `${part1}eon${part2}${checksum}`;
    }

    /**
     * Batch generate multiple EON addresses
     * @param {number} count - Number of addresses to generate
     * @returns {Array<string>} Array of EON addresses
     */
    async generateBatchEON(count) {
        const addresses = [];
        for (let i = 0; i < count; i++) {
            addresses.push(await this.generateEONAddress());
        }
        return addresses;
    }

    /**
     * Get address info for display
     * @param {string} eonAddress - EON address
     * @returns {Object} Address information
     */
    getAddressInfo(eonAddress) {
        if (!eonAddress || eonAddress.length !== 23) {
            return null;
        }

        return {
            full: eonAddress,
            short: `${eonAddress.substring(0, 6)}...${eonAddress.substring(37)}`,
            part1: eonAddress.substring(0, 19),
            part2: eonAddress.substring(22, 37),
            checksum: eonAddress.substring(37, 41),
            display: `${eonAddress.substring(0, 19)} eon ${eonAddress.substring(22, 37)} ${eonAddress.substring(37, 41)}`
        };
    }
} 