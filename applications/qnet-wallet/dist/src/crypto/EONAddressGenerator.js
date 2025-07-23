/**
 * EON Address Generator for QNet Dual-Network Wallet
 * Generates beautiful EON addresses: 7a9bk4f2eon8x3m5z1c7
 * Format: 8chars + "eon" + 8chars + checksum
 */

export class EONAddressGenerator {
    constructor() {
        this.charset = '123456789abcdefghijkmnopqrstuvwxyz'; // Base32-like without confusing chars
        this.checksumAlgo = 'SHA-256';
    }

    /**
     * Generate new EON address
     * @returns {string} EON address in format: 7a9bk4f2eon8x3m5z1c7
     */
    async generateEONAddress() {
        const part1 = this.generateSecureRandom(8);
        const part2 = this.generateSecureRandom(8);
        const checksum = await this.calculateChecksum(part1 + part2);
        
        return `${part1}eon${part2}${checksum}`;
    }

    /**
     * Generate cryptographically secure random string
     * @param {number} length - Length of random string
     * @returns {string} Random string using safe charset
     */
    generateSecureRandom(length) {
        const randomBytes = new Uint8Array(length);
        crypto.getRandomValues(randomBytes);
        
        let result = '';
        for (let i = 0; i < length; i++) {
            result += this.charset[randomBytes[i] % this.charset.length];
        }
        
        return result;
    }

    /**
     * Calculate checksum for address validation
     * @param {string} data - Data to calculate checksum for
     * @returns {string} 4-character checksum
     */
    async calculateChecksum(data) {
        const encoder = new TextEncoder();
        const dataBytes = encoder.encode(data);
        
        const hashBuffer = await crypto.subtle.digest('SHA-256', dataBytes);
        const hashArray = new Uint8Array(hashBuffer);
        
        // Use first 4 bytes for checksum, convert to charset
        let checksum = '';
        for (let i = 0; i < 4; i++) {
            checksum += this.charset[hashArray[i] % this.charset.length];
        }
        
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

        // Check format: 8chars + "eon" + 8chars + 4chars = 23 total
        if (address.length !== 23) {
            return false;
        }

        // Check for "eon" in the middle
        if (address.substring(8, 11) !== 'eon') {
            return false;
        }

        // Extract parts
        const part1 = address.substring(0, 8);
        const part2 = address.substring(11, 19);
        const providedChecksum = address.substring(19, 23);

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
            short: `${eonAddress.substring(0, 6)}...${eonAddress.substring(-4)}`,
            part1: eonAddress.substring(0, 8),
            part2: eonAddress.substring(11, 19),
            checksum: eonAddress.substring(19, 23),
            display: `${eonAddress.substring(0, 8)} eon ${eonAddress.substring(11, 19)} ${eonAddress.substring(19, 23)}`
        };
    }
} 