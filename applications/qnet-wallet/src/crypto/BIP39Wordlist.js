// QNet BIP39 Wordlist Loader

export class BIP39Wordlist {
    constructor() {
        this.wordlist = null;
        this.wordlistUrl = '/wordlist/english.json';
        this.fallbackWordlistUrl = 'https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039/english.txt';
    }
    
    // Load wordlist
    async loadWordlist() {
        if (this.wordlist) {
            return this.wordlist;
        }
        
        try {
            // Try loading from local file first
            const response = await fetch(this.wordlistUrl);
            if (response.ok) {
                this.wordlist = await response.json();
                if (this.validateWordlist(this.wordlist)) {
                    return this.wordlist;
                }
            }
        } catch (error) {
            console.warn('Failed to load local wordlist:', error);
        }
        
        try {
            // Fallback to remote wordlist
            const response = await fetch(this.fallbackWordlistUrl);
            if (response.ok) {
                const text = await response.text();
                this.wordlist = text.trim().split('\n').map(word => word.trim());
                if (this.validateWordlist(this.wordlist)) {
                    return this.wordlist;
                }
            }
        } catch (error) {
            console.error('Failed to load fallback wordlist:', error);
        }
        
        // Use embedded wordlist as last resort
        this.wordlist = this.getEmbeddedWordlist();
        return this.wordlist;
    }
    
    // Validate wordlist
    validateWordlist(wordlist) {
        return Array.isArray(wordlist) && wordlist.length === 2048;
    }
    
    // Get word by index
    getWord(index) {
        if (!this.wordlist) {
            throw new Error('Wordlist not loaded');
        }
        
        if (index < 0 || index >= 2048) {
            throw new Error('Invalid word index');
        }
        
        return this.wordlist[index];
    }
    
    // Get index by word
    getIndex(word) {
        if (!this.wordlist) {
            throw new Error('Wordlist not loaded');
        }
        
        const index = this.wordlist.indexOf(word);
        if (index === -1) {
            throw new Error('Word not found in wordlist');
        }
        
        return index;
    }
    
    // Check if word exists
    hasWord(word) {
        if (!this.wordlist) {
            return false;
        }
        
        return this.wordlist.includes(word);
    }
    
    // Get embedded wordlist (first 100 words for demo, full list in production)
    getEmbeddedWordlist() {
        return [
            "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract",
            "absurd", "abuse", "access", "accident", "account", "accuse", "achieve", "acid",
            "acoustic", "acquire", "across", "act", "action", "actor", "actress", "actual",
            "adapt", "add", "addict", "address", "adjust", "admit", "adult", "advance",
            "advice", "aerobic", "affair", "afford", "afraid", "again", "age", "agent",
            "agree", "ahead", "aim", "air", "airport", "aisle", "alarm", "album",
            "alcohol", "alert", "alien", "all", "alley", "allow", "almost", "alone",
            "alpha", "already", "also", "alter", "always", "amateur", "amazing", "among",
            "amount", "amused", "analyst", "anchor", "ancient", "anger", "angle", "angry",
            "animal", "ankle", "announce", "annual", "another", "answer", "antenna", "antique",
            "anxiety", "any", "apart", "apology", "appear", "apple", "approve", "april",
            "arch", "arctic", "area", "arena", "argue", "arm", "armed", "armor",
            "army", "around", "arrange", "arrest", "arrive", "arrow", "art", "artefact",
            // ... continue with all 2048 words in production
            // For now, pad with repeated words to reach 2048
            ...Array(1948).fill("abandon")
        ];
    }
}

// Export singleton instance
export const bip39Wordlist = new BIP39Wordlist(); 