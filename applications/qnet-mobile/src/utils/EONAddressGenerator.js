/**
 * QNet Mobile - EON Address Generator
 * Generates unique EON addresses in format: 7a9bk4f2eon8x3m5z1c
 * Mobile-optimized version with React Native compatibility
 */

import CryptoJS from 'crypto-js';
import { Buffer } from 'buffer';

export class EONAddressGenerator {
  constructor() {
    // EON address character set (excluding confusing characters)
    this.charset = '0123456789abcdefghijklmnopqrstuvwxyz';
    this.eonPrefix = 'eon';
    this.addressLength = 19; // Total length: 8 + 3 + 8 = 19 characters
  }

  /**
   * Generate EON address from seed phrase
   * @param {string} seedPhrase - BIP39 seed phrase
   * @returns {Promise<string>} - EON address (e.g., "7a9bk4f2eon8x3m5z1c")
   */
  async generateFromSeed(seedPhrase) {
    try {
      if (!seedPhrase) {
        throw new Error('Seed phrase is required');
      }

      // Create hash from seed phrase
      const hash = CryptoJS.SHA256(seedPhrase).toString();
      
      // Generate deterministic EON address
      const eonAddress = this.hashToEONAddress(hash);
      
      // Validate generated address
      if (!this.validateEONAddress(eonAddress)) {
        throw new Error('Generated EON address is invalid');
      }

      return eonAddress;
    } catch (error) {
      console.error('Failed to generate EON address:', error);
      throw error;
    }
  }

  /**
   * Generate EON address from public key
   * @param {string} publicKey - Public key string
   * @returns {Promise<string>} - EON address
   */
  async generateFromPublicKey(publicKey) {
    try {
      if (!publicKey) {
        throw new Error('Public key is required');
      }

      // Create hash from public key
      const hash = CryptoJS.SHA256(publicKey).toString();
      
      // Generate deterministic EON address
      const eonAddress = this.hashToEONAddress(hash);
      
      return eonAddress;
    } catch (error) {
      console.error('Failed to generate EON address from public key:', error);
      throw error;
    }
  }

  /**
   * Convert hash to EON address format
   * @param {string} hash - SHA256 hash string
   * @returns {string} - EON address
   */
  hashToEONAddress(hash) {
    try {
      // Convert hash to buffer
      const hashBuffer = Buffer.from(hash, 'hex');
      
      // Generate address components
      const prefix = this.generatePrefix(hashBuffer.slice(0, 8));
      const suffix = this.generateSuffix(hashBuffer.slice(8, 16));
      
      // Combine: prefix + 'eon' + suffix
      const eonAddress = prefix + this.eonPrefix + suffix;
      
      // Ensure correct length
      return this.normalizeLength(eonAddress);
    } catch (error) {
      console.error('Failed to convert hash to EON address:', error);
      throw error;
    }
  }

  /**
   * Generate prefix from hash bytes
   * @param {Buffer} bytes - Hash bytes
   * @returns {string} - Address prefix
   */
  generatePrefix(bytes) {
    let prefix = '';
    
    for (let i = 0; i < bytes.length && prefix.length < 8; i++) {
      const byte = bytes[i];
      const charIndex = byte % this.charset.length;
      prefix += this.charset[charIndex];
    }
    
    return prefix.substring(0, 8); // First 8 characters
  }

  /**
   * Generate suffix from hash bytes
   * @param {Buffer} bytes - Hash bytes
   * @returns {string} - Address suffix
   */
  generateSuffix(bytes) {
    let suffix = '';
    
    for (let i = 0; i < bytes.length && suffix.length < 8; i++) {
      const byte = bytes[i];
      const charIndex = byte % this.charset.length;
      suffix += this.charset[charIndex];
    }
    
    return suffix.substring(0, 8); // Last 8 characters
  }

  /**
   * Normalize address length to exactly 20 characters
   * @param {string} address - Generated address
   * @returns {string} - Normalized address
   */
  normalizeLength(address) {
    if (address.length === this.addressLength) {
      return address;
    }
    
    if (address.length < this.addressLength) {
      // Pad with deterministic characters
      const padding = this.addressLength - address.length;
      const paddingChar = this.charset[address.charCodeAt(0) % this.charset.length];
      return address + paddingChar.repeat(padding);
    }
    
    // Truncate to correct length
    return address.substring(0, this.addressLength);
  }

  /**
   * Validate EON address format
   * @param {string} address - EON address to validate
   * @returns {boolean} - True if valid
   */
  validateEONAddress(address) {
    try {
      if (!address || typeof address !== 'string') {
        return false;
      }

      // Check length
      if (address.length !== this.addressLength) {
        return false;
      }

      // Check if contains 'eon'
      if (!address.includes(this.eonPrefix)) {
        return false;
      }

      // Check character set
      for (const char of address) {
        if (!this.charset.includes(char)) {
          return false;
        }
      }

      // Check structure: 8 chars + 'eon' + 8 chars = 19 total
      const eonIndex = address.indexOf(this.eonPrefix);
      if (eonIndex !== 8) {
        return false;
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Generate random EON address (for testing)
   * @returns {string} - Random EON address
   */
  generateRandom() {
    try {
      const randomBytes = CryptoJS.lib.WordArray.random(32);
      const hash = CryptoJS.SHA256(randomBytes).toString();
      
      return this.hashToEONAddress(hash);
    } catch (error) {
      console.error('Failed to generate random EON address:', error);
      throw error;
    }
  }

  /**
   * Extract network info from EON address
   * @param {string} address - EON address
   * @returns {object} - Network info
   */
  extractNetworkInfo(address) {
    try {
      if (!this.validateEONAddress(address)) {
        throw new Error('Invalid EON address');
      }

      const prefix = address.substring(0, 8);
      const suffix = address.substring(11, 19);
      
      // Generate network info from address components
      const networkId = this.calculateNetworkId(prefix);
      const nodeType = this.calculateNodeType(suffix);
      
      return {
        networkId,
        nodeType,
        prefix,
        suffix,
        isTestnet: networkId < 100 // Testnet networks have lower IDs
      };
    } catch (error) {
      console.error('Failed to extract network info:', error);
      return null;
    }
  }

  /**
   * Calculate network ID from prefix
   * @param {string} prefix - Address prefix
   * @returns {number} - Network ID
   */
  calculateNetworkId(prefix) {
    let sum = 0;
    for (let i = 0; i < prefix.length; i++) {
      sum += this.charset.indexOf(prefix[i]) * (i + 1);
    }
    return sum % 1000; // Network ID between 0-999
  }

  /**
   * Calculate node type from suffix
   * @param {string} suffix - Address suffix
   * @returns {string} - Node type
   */
  calculateNodeType(suffix) {
    const sum = suffix.split('').reduce((acc, char) => {
      return acc + this.charset.indexOf(char);
    }, 0);
    
    const typeIndex = sum % 3;
    const nodeTypes = ['Light', 'Full', 'Super'];
    
    return nodeTypes[typeIndex];
  }

  /**
   * Get address statistics
   * @param {string} address - EON address
   * @returns {object} - Address statistics
   */
  getAddressStats(address) {
    try {
      if (!this.validateEONAddress(address)) {
        return null;
      }

      const networkInfo = this.extractNetworkInfo(address);
      const checksum = this.calculateChecksum(address);
      
      return {
        address,
        valid: true,
        length: address.length,
        networkInfo,
        checksum,
        generated: new Date().toISOString()
      };
    } catch (error) {
      return {
        address,
        valid: false,
        error: error.message
      };
    }
  }

  /**
   * Calculate address checksum
   * @param {string} address - EON address
   * @returns {string} - Checksum
   */
  calculateChecksum(address) {
    const hash = CryptoJS.SHA256(address).toString();
    return hash.substring(0, 8);
  }
}

export default EONAddressGenerator; 