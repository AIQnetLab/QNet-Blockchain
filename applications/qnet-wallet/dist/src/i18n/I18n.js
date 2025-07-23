/**
 * I18n Class Wrapper for QNet Wallet
 * Wraps the i18n functions into a class interface
 */

import { setLanguage, t, getCurrentLanguage, getAvailableLanguages, initializeI18n } from './index.js';

export class I18n {
    constructor() {
        this.isInitialized = false;
    }

    async initialize() {
        try {
            // Initialize with auto-detection
            await initializeI18n();
            this.isInitialized = true;
            console.log('✅ I18n initialized with auto-detection');
        } catch (error) {
            console.error('❌ I18n initialization failed:', error);
            // Fallback to English
            await setLanguage('en');
            this.isInitialized = true;
        }
    }

    translate(key) {
        return t(key);
    }

    async setLanguage(languageCode) {
        const success = await setLanguage(languageCode);
        if (success) {
            localStorage.setItem('qnet_wallet_language', languageCode);
        }
        return success;
    }

    getCurrentLanguage() {
        return getCurrentLanguage();
    }

    getAvailableLanguages() {
        return getAvailableLanguages();
    }
} 