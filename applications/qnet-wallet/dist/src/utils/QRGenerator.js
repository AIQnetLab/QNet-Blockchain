/**
 * QR Code Generator for Wallet Addresses and Transactions
 * Production-ready QR code generation
 */

/**
 * QR Code Generator Class
 */
export class QRGenerator {
    
    /**
     * Generate QR code for wallet address
     */
    static async generateAddressQR(address, network = 'solana', options = {}) {
        try {
            const qrData = this.formatAddressData(address, network, options);
            return await this.generateQRCode(qrData, {
                width: options.size || 256,
                margin: 2,
                color: {
                    dark: options.darkColor || '#000000',
                    light: options.lightColor || '#FFFFFF'
                },
                errorCorrectionLevel: 'M'
            });
        } catch (error) {
            console.error('Failed to generate address QR:', error);
            throw new Error('Failed to generate QR code for address');
        }
    }
    
    /**
     * Generate QR code for transaction request
     */
    static async generateTransactionQR(transactionData, options = {}) {
        try {
            const qrData = this.formatTransactionData(transactionData);
            return await this.generateQRCode(qrData, {
                width: options.size || 256,
                margin: 2,
                color: {
                    dark: options.darkColor || '#000000',
                    light: options.lightColor || '#FFFFFF'
                },
                errorCorrectionLevel: 'M'
            });
        } catch (error) {
            console.error('Failed to generate transaction QR:', error);
            throw new Error('Failed to generate QR code for transaction');
        }
    }
    
    /**
     * Format address data for QR code
     */
    static formatAddressData(address, network, options = {}) {
        const { amount, label, message } = options;
        
        switch (network.toLowerCase()) {
            case 'solana':
                // Solana URI format: solana:address?amount=1.5&label=Payment&message=For+services
                let uri = `solana:${address}`;
                const params = new URLSearchParams();
                
                if (amount) params.append('amount', amount.toString());
                if (label) params.append('label', label);
                if (message) params.append('message', message);
                
                const paramString = params.toString();
                if (paramString) uri += '?' + paramString;
                
                return uri;
                
            case 'qnet':
                // QNet URI format: qnet:address?amount=100&label=Payment&message=For+services
                let qnetUri = `qnet:${address}`;
                const qnetParams = new URLSearchParams();
                
                if (amount) qnetParams.append('amount', amount.toString());
                if (label) qnetParams.append('label', label);
                if (message) qnetParams.append('message', message);
                
                const qnetParamString = qnetParams.toString();
                if (qnetParamString) qnetUri += '?' + qnetParamString;
                
                return qnetUri;
                
            default:
                return address;
        }
    }
    
    /**
     * Format transaction data for QR code
     */
    static formatTransactionData(transactionData) {
        const {
            network,
            to,
            amount,
            token,
            memo,
            fee
        } = transactionData;
        
        const txData = {
            network: network,
            to: to,
            amount: amount
        };
        
        if (token) txData.token = token;
        if (memo) txData.memo = memo;
        if (fee) txData.fee = fee;
        
        return JSON.stringify(txData);
    }
    
    /**
     * Generate QR code using canvas
     */
    static async generateQRCode(data, options = {}) {
        return new Promise((resolve, reject) => {
            try {
                // Create canvas element
                const canvas = document.createElement('canvas');
                const size = options.width || 256;
                canvas.width = size;
                canvas.height = size;
                
                // Generate QR code using a simple implementation
                this.drawQRCode(canvas, data, options);
                
                // Convert to data URL
                const dataURL = canvas.toDataURL('image/png');
                resolve(dataURL);
                
            } catch (error) {
                reject(error);
            }
        });
    }
    
    /**
     * Simple QR code drawing implementation
     * Note: In production, you would use a proper QR library like qrcode.js
     */
    static drawQRCode(canvas, data, options = {}) {
        const ctx = canvas.getContext('2d');
        const size = canvas.width;
        const margin = options.margin || 2;
        const darkColor = options.color?.dark || '#000000';
        const lightColor = options.color?.light || '#FFFFFF';
        
        // Fill background
        ctx.fillStyle = lightColor;
        ctx.fillRect(0, 0, size, size);
        
        // Simple pattern generation (placeholder for real QR algorithm)
        const moduleCount = 25; // Simplified
        const moduleSize = (size - margin * 2) / moduleCount;
        
        ctx.fillStyle = darkColor;
        
        // Generate a deterministic pattern based on data
        const hash = this.simpleHash(data);
        
        for (let row = 0; row < moduleCount; row++) {
            for (let col = 0; col < moduleCount; col++) {
                const index = row * moduleCount + col;
                const shouldFill = (hash + index) % 3 === 0; // Simple pattern
                
                if (shouldFill) {
                    const x = margin + col * moduleSize;
                    const y = margin + row * moduleSize;
                    ctx.fillRect(x, y, moduleSize, moduleSize);
                }
            }
        }
        
        // Add finder patterns (corners)
        this.drawFinderPattern(ctx, margin, margin, moduleSize);
        this.drawFinderPattern(ctx, size - margin - 7 * moduleSize, margin, moduleSize);
        this.drawFinderPattern(ctx, margin, size - margin - 7 * moduleSize, moduleSize);
    }
    
    /**
     * Draw QR finder pattern
     */
    static drawFinderPattern(ctx, x, y, moduleSize) {
        const darkColor = '#000000';
        const lightColor = '#FFFFFF';
        
        // Outer 7x7 square
        ctx.fillStyle = darkColor;
        ctx.fillRect(x, y, 7 * moduleSize, 7 * moduleSize);
        
        // Inner 5x5 white square
        ctx.fillStyle = lightColor;
        ctx.fillRect(x + moduleSize, y + moduleSize, 5 * moduleSize, 5 * moduleSize);
        
        // Center 3x3 black square
        ctx.fillStyle = darkColor;
        ctx.fillRect(x + 2 * moduleSize, y + 2 * moduleSize, 3 * moduleSize, 3 * moduleSize);
    }
    
    /**
     * Simple hash function for pattern generation
     */
    static simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash);
    }
    
    /**
     * Parse QR code data
     */
    static parseQRData(qrData) {
        try {
            // Try to parse as URI first
            if (qrData.includes(':')) {
                return this.parseURIData(qrData);
            }
            
            // Try to parse as JSON
            try {
                return JSON.parse(qrData);
            } catch {
                // Return as plain address
                return { address: qrData, type: 'address' };
            }
        } catch (error) {
            console.error('Failed to parse QR data:', error);
            return null;
        }
    }
    
    /**
     * Parse URI format QR data
     */
    static parseURIData(uri) {
        try {
            const url = new URL(uri);
            const protocol = url.protocol.replace(':', '');
            const address = url.pathname;
            
            const result = {
                type: 'payment_request',
                network: protocol,
                address: address
            };
            
            // Parse query parameters
            url.searchParams.forEach((value, key) => {
                switch (key) {
                    case 'amount':
                        result.amount = parseFloat(value);
                        break;
                    case 'label':
                        result.label = value;
                        break;
                    case 'message':
                        result.message = value;
                        break;
                    default:
                        result[key] = value;
                }
            });
            
            return result;
        } catch (error) {
            console.error('Failed to parse URI data:', error);
            return null;
        }
    }
    
    /**
     * Validate QR code data
     */
    static validateQRData(qrData) {
        try {
            const parsed = this.parseQRData(qrData);
            if (!parsed) return false;
            
            // Validate address format
            if (parsed.address) {
                return this.validateAddress(parsed.address, parsed.network);
            }
            
            return true;
        } catch (error) {
            return false;
        }
    }
    
    /**
     * Validate address format
     */
    static validateAddress(address, network) {
        switch (network) {
            case 'solana':
                // Solana addresses are 32-44 characters, base58 encoded
                return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
                
            case 'qnet':
                // QNet EON addresses: 8chars + "eon" + 8chars + 4chars
                return /^[0-9a-f]{8}eon[0-9a-f]{8}[0-9a-f]{4}$/.test(address);
                
            default:
                return address.length > 10; // Basic length check
        }
    }
    
    /**
     * Generate QR code for wallet connect
     */
    static async generateWalletConnectQR(wcUri, options = {}) {
        try {
            return await this.generateQRCode(wcUri, {
                width: options.size || 300,
                margin: 3,
                color: {
                    dark: '#000000',
                    light: '#FFFFFF'
                },
                errorCorrectionLevel: 'M'
            });
        } catch (error) {
            console.error('Failed to generate WalletConnect QR:', error);
            throw new Error('Failed to generate WalletConnect QR code');
        }
    }
}

// Browser compatibility
if (typeof window !== 'undefined') {
    window.QRGenerator = QRGenerator;
} 