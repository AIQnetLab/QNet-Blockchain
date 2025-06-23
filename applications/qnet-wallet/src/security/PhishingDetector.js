// QNet Phishing Detection Module

export class PhishingDetector {
    constructor() {
        // Official QNet domains
        this.trustedDomains = [
            'qnet.network',
            'wallet.qnet.network',
            'explorer.qnet.network',
            'docs.qnet.network'
        ];
        
        // Known phishing patterns
        this.phishingPatterns = [
            // Typosquatting
            /qn[e3]t\./, // qn3t, qn3t
            /q[mn]et\./, // qmet, qmet
            /qnet[s-z]\./, // qnets, qnetz
            /[qg]net\./, // gnet
            
            // Homograph attacks
            /[\u0400-\u04FF]/, // Non-Latin script detection
            /[αβγδεζηθικλμνξοπρστυφχψω]/, // Greek characters
            
            // Suspicious TLDs often used in phishing
            /\.(tk|ml|ga|cf|click|download|review)$/,
            
            // IP addresses (legitimate sites don't use raw IPs)
            /^https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
            
            // Suspicious subdomains
            /^https?:\/\/.*(-qnet|qnet-|wallet-qnet|qnet-wallet)\./
        ];
        
        // Suspicious keywords in URLs
        this.suspiciousKeywords = [
            'verify',
            'confirm',
            'update',
            'suspend',
            'secure',
            'account',
            'wallet',
            'private',
            'seed',
            'phrase',
            'recovery'
        ];
    }
    
    // Check if URL is potentially phishing
    async checkUrl(url) {
        try {
            const urlObj = new URL(url);
            const domain = urlObj.hostname.toLowerCase();
            const path = urlObj.pathname.toLowerCase();
            
            // Check if trusted domain
            if (this.isTrustedDomain(domain)) {
                return { safe: true, trusted: true };
            }
            
            // Check for localhost (development)
            if (domain === 'localhost' || domain === '127.0.0.1') {
                return { safe: true, trusted: false, reason: 'localhost' };
            }
            
            // Check phishing patterns
            for (const pattern of this.phishingPatterns) {
                if (pattern.test(domain)) {
                    return {
                        safe: false,
                        reason: 'suspicious_pattern',
                        pattern: pattern.toString()
                    };
                }
            }
            
            // Check for QNet-related terms in non-trusted domains
            if (this.containsQNetTerms(domain) && !this.isTrustedDomain(domain)) {
                return {
                    safe: false,
                    reason: 'qnet_impersonation',
                    domain
                };
            }
            
            // Check suspicious keywords in path
            const suspiciousCount = this.countSuspiciousKeywords(path);
            if (suspiciousCount >= 3) {
                return {
                    safe: false,
                    reason: 'suspicious_path',
                    keywords: suspiciousCount
                };
            }
            
            // Check URL shorteners
            if (this.isUrlShortener(domain)) {
                return {
                    safe: false,
                    reason: 'url_shortener',
                    domain
                };
            }
            
            // Default: unknown site, show warning
            return {
                safe: null,
                reason: 'unknown_site',
                domain
            };
            
        } catch (error) {
            // Invalid URL
            return {
                safe: false,
                reason: 'invalid_url',
                error: error.message
            };
        }
    }
    
    // Check if domain is trusted
    isTrustedDomain(domain) {
        // Remove www. prefix
        domain = domain.replace(/^www\./, '');
        
        // Check exact match
        if (this.trustedDomains.includes(domain)) {
            return true;
        }
        
        // Check subdomain of trusted domain
        for (const trusted of this.trustedDomains) {
            if (domain.endsWith('.' + trusted)) {
                return true;
            }
        }
        
        return false;
    }
    
    // Check if domain contains QNet-related terms
    containsQNetTerms(domain) {
        const qnetTerms = ['qnet', 'qnc', 'qna'];
        const lowerDomain = domain.toLowerCase();
        
        return qnetTerms.some(term => lowerDomain.includes(term));
    }
    
    // Count suspicious keywords
    countSuspiciousKeywords(path) {
        let count = 0;
        const lowerPath = path.toLowerCase();
        
        for (const keyword of this.suspiciousKeywords) {
            if (lowerPath.includes(keyword)) {
                count++;
            }
        }
        
        return count;
    }
    
    // Check if URL shortener
    isUrlShortener(domain) {
        const shorteners = [
            'bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly',
            'is.gd', 'buff.ly', 'adf.ly', 'bl.ink',
            'short.link', 'shorte.st', 't.co', 'tiny.cc'
        ];
        
        return shorteners.includes(domain.toLowerCase());
    }
    
    // Get warning message for user
    getWarningMessage(checkResult) {
        switch (checkResult.reason) {
            case 'suspicious_pattern':
                return '⚠️ This website may be impersonating QNet. The URL contains suspicious patterns.';
                
            case 'qnet_impersonation':
                return '🚨 Warning! This is NOT an official QNet website. Never enter your seed phrase here.';
                
            case 'suspicious_path':
                return '⚠️ This page is asking for sensitive information. Be very careful.';
                
            case 'url_shortener':
                return '⚠️ This is a shortened URL. Cannot verify the actual destination.';
                
            case 'invalid_url':
                return '❌ Invalid or malformed URL detected.';
                
            case 'unknown_site':
                return 'ℹ️ This website is not recognized. Only connect if you trust it.';
                
            default:
                return '⚠️ Potential security risk detected.';
        }
    }
    
    // Check if should block connection
    shouldBlock(checkResult) {
        const blockReasons = [
            'suspicious_pattern',
            'qnet_impersonation',
            'invalid_url'
        ];
        
        return blockReasons.includes(checkResult.reason);
    }
} 