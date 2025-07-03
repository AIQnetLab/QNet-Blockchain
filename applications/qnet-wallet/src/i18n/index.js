/**
 * QNet Wallet Internationalization
 * Languages ordered by crypto community size (descending)
 * Auto-detects browser language with fallback to English
 */

let currentLanguage = 'en';

/**
 * Detect browser language and set appropriate language
 */
function detectBrowserLanguage() {
    const supportedLanguages = ['en', 'zh', 'ko', 'ja', 'ru', 'es', 'pt', 'fr', 'de', 'it', 'ar'];
    const browserLang = navigator.language || navigator.userLanguage;
    
    // Extract language code (e.g., 'en-US' -> 'en')
    const langCode = browserLang.split('-')[0].toLowerCase();
    
    // Return supported language or fallback to English
    return supportedLanguages.includes(langCode) ? langCode : 'en';
}

const translations = {
    en: {
        // Main interface
        'wallet.title': 'QNet Wallet',
        'wallet.unlock': 'Enter your password to unlock',
        'wallet.password': 'Password',
        'wallet.unlock.button': 'Unlock',
        'wallet.create': 'Create New Wallet',
        'wallet.import': 'Import Wallet',
        
        // Seed phrase
        'seed.save': 'Save Your Seed Phrase',
        'seed.warning': 'Never share your seed phrase with anyone!',
        'seed.recovery': 'QNet cannot recover lost seed phrases',
        'seed.copy': 'Copy to Clipboard',
        'seed.download': 'Download as File',
        'seed.confirmed': "I've Saved My Seed Phrase",
        'seed.verify': 'Verify Your Seed Phrase',
        'seed.verify.description': 'Please enter the following words from your seed phrase to confirm you saved it correctly:',
        'seed.verify.button': 'Verify & Complete Setup',
        'seed.back': 'Back to Seed Phrase',
        
        // Settings
        'settings.title': 'Settings',
        'settings.language': 'Language',
        'settings.autolock': 'Auto-Lock Timer',
        'settings.network': 'Network',
        'settings.currency': 'Currency Display',
        'settings.security': 'Security',
        'settings.mobile': 'Mobile Features',
        'settings.backup': 'Backup & Recovery',
        'settings.connected': 'Connected Sites',
        'settings.danger': 'Danger Zone',
        
        // Node activation
        'node.activation': 'Node Activation',
        'node.description': 'Activate your QNet node by burning 1DEV tokens',
        'node.required': 'Required',
        'node.available': 'Available',
        'node.type': 'Node Type',
        'node.activate': 'Activate Node',
        
        // Actions
        'action.send': 'Send',
        'action.receive': 'Receive',
        'action.swap': 'Swap',
        'action.copy': 'Copy',
        'action.cancel': 'Cancel',
        'action.confirm': 'Confirm',
        
        // Notifications
        'notification.copied': 'Copied to clipboard',
        'notification.saved': 'Settings saved successfully',
        'notification.error': 'An error occurred'
    },
    
    zh: {
        // Main interface
        'wallet.title': 'QNet 钱包',
        'wallet.unlock': '输入密码解锁',
        'wallet.password': '密码',
        'wallet.unlock.button': '解锁',
        'wallet.create': '创建新钱包',
        'wallet.import': '导入钱包',
        
        // Seed phrase
        'seed.save': '保存您的助记词',
        'seed.warning': '永远不要与任何人分享您的助记词！',
        'seed.recovery': 'QNet 无法恢复丢失的助记词',
        'seed.copy': '复制到剪贴板',
        'seed.download': '下载为文件',
        'seed.confirmed': '我已保存我的助记词',
        'seed.verify': '验证您的助记词',
        'seed.verify.description': '请输入助记词中的以下单词以确认您已正确保存：',
        'seed.verify.button': '验证并完成设置',
        'seed.back': '返回助记词',
        
        // Settings
        'settings.title': '设置',
        'settings.language': '语言',
        'settings.autolock': '自动锁定计时器',
        'settings.network': '网络',
        'settings.currency': '货币显示',
        'settings.security': '安全',
        'settings.mobile': '移动功能',
        'settings.backup': '备份和恢复',
        'settings.connected': '已连接网站',
        'settings.danger': '危险区域'
    },
    
    ko: {
        // Main interface
        'wallet.title': 'QNet 지갑',
        'wallet.unlock': '비밀번호를 입력하여 잠금 해제',
        'wallet.password': '비밀번호',
        'wallet.unlock.button': '잠금 해제',
        'wallet.create': '새 지갑 만들기',
        'wallet.import': '지갑 가져오기',
        
        // Seed phrase
        'seed.save': '시드 문구 저장',
        'seed.warning': '시드 문구를 누구와도 공유하지 마세요!',
        'seed.recovery': 'QNet은 분실된 시드 문구를 복구할 수 없습니다',
        'seed.copy': '클립보드에 복사',
        'seed.download': '파일로 다운로드',
        'seed.confirmed': '시드 문구를 저장했습니다',
        'seed.verify': '시드 문구 확인',
        'seed.verify.description': '올바르게 저장했는지 확인하기 위해 시드 문구의 다음 단어들을 입력하세요:',
        'seed.verify.button': '확인 및 설정 완료',
        'seed.back': '시드 문구로 돌아가기'
    },
    
    ja: {
        // Main interface
        'wallet.title': 'QNet ウォレット',
        'wallet.unlock': 'パスワードを入力してロック解除',
        'wallet.password': 'パスワード',
        'wallet.unlock.button': 'ロック解除',
        'wallet.create': '新しいウォレットを作成',
        'wallet.import': 'ウォレットをインポート',
        
        // Seed phrase
        'seed.save': 'シードフレーズを保存',
        'seed.warning': 'シードフレーズを誰とも共有しないでください！',
        'seed.recovery': 'QNetは失われたシードフレーズを復元できません',
        'seed.copy': 'クリップボードにコピー',
        'seed.download': 'ファイルとしてダウンロード',
        'seed.confirmed': 'シードフレーズを保存しました',
        'seed.verify': 'シードフレーズを確認',
        'seed.verify.description': '正しく保存されたことを確認するために、シードフレーズの次の単語を入力してください：',
        'seed.verify.button': '確認してセットアップを完了',
        'seed.back': 'シードフレーズに戻る'
    },
    
    ru: {
        // Main interface
        'wallet.title': 'QNet Кошелёк',
        'wallet.unlock': 'Введите пароль для разблокировки',
        'wallet.password': 'Пароль',
        'wallet.unlock.button': 'Разблокировать',
        'wallet.create': 'Создать новый кошелёк',
        'wallet.import': 'Импортировать кошелёк',
        
        // Seed phrase
        'seed.save': 'Сохраните вашу сид-фразу',
        'seed.warning': 'Никогда не делитесь сид-фразой ни с кем!',
        'seed.recovery': 'QNet не может восстановить утерянные сид-фразы',
        'seed.copy': 'Копировать в буфер',
        'seed.download': 'Скачать как файл',
        'seed.confirmed': 'Я сохранил мою сид-фразу',
        'seed.verify': 'Проверьте вашу сид-фразу',
        'seed.verify.description': 'Пожалуйста, введите следующие слова из вашей сид-фразы для подтверждения правильного сохранения:',
        'seed.verify.button': 'Проверить и завершить настройку',
        'seed.back': 'Вернуться к сид-фразе'
    },
    
    // Add other languages with minimal translations for now
    es: { 'wallet.title': 'QNet Billetera' },
    pt: { 'wallet.title': 'QNet Carteira' },
    fr: { 'wallet.title': 'QNet Portefeuille' },
    de: { 'wallet.title': 'QNet Geldbörse' },
    it: { 'wallet.title': 'QNet Portafoglio' },
    ar: { 'wallet.title': 'محفظة QNet' }
};

/**
 * Initialize i18n system with auto-detection
 */
export async function initializeI18n() {
    const savedLanguage = localStorage.getItem('qnet_wallet_language');
    const detectedLanguage = detectBrowserLanguage();
    
    // Use saved language or auto-detected language
    const languageToUse = savedLanguage || detectedLanguage;
    
    await setLanguage(languageToUse);
    console.log(`✅ Language initialized: ${languageToUse} (saved: ${savedLanguage}, detected: ${detectedLanguage})`);
}

/**
 * Set current language
 */
export async function setLanguage(languageCode) {
    if (translations[languageCode]) {
        currentLanguage = languageCode;
        localStorage.setItem('qnet_wallet_language', languageCode);
        updatePageTexts();
        return true;
    }
    return false;
}

/**
 * Get translation for key
 */
export function t(key) {
    const lang = translations[currentLanguage] || translations.en;
    return lang[key] || translations.en[key] || key;
}

/**
 * Update all page texts based on current language
 */
function updatePageTexts() {
    // Update common elements
    const elementsToUpdate = [
        { id: 'wallet-title', key: 'wallet.title' },
        { id: 'unlock-button', key: 'wallet.unlock.button' },
        { id: 'create-wallet-button', key: 'wallet.create' },
        { id: 'import-wallet-button', key: 'wallet.import' },
        { id: 'copy-seed-button', key: 'seed.copy' },
        { id: 'download-seed-button', key: 'seed.download' },
        { id: 'seed-confirmed-button', key: 'seed.confirmed' },
        { id: 'verify-seed-button', key: 'seed.verify.button' },
        { id: 'back-to-seed-button', key: 'seed.back' }
    ];
    
    elementsToUpdate.forEach(({ id, key }) => {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = t(key);
        }
    });
    
    // Update placeholders
    const passwordInput = document.getElementById('password-input');
    if (passwordInput) {
        passwordInput.placeholder = t('wallet.password');
    }
}

/**
 * Get current language
 */
export function getCurrentLanguage() {
    return currentLanguage;
}

/**
 * Get available languages in order of crypto community size
 */
export function getAvailableLanguages() {
    return [
        { code: 'en', name: 'English', nativeName: 'English' },
        { code: 'zh', name: 'Chinese', nativeName: '中文' },
        { code: 'ko', name: 'Korean', nativeName: '한국어' },
        { code: 'ja', name: 'Japanese', nativeName: '日本語' },
        { code: 'ru', name: 'Russian', nativeName: 'Русский' },
        { code: 'es', name: 'Spanish', nativeName: 'Español' },
        { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
        { code: 'fr', name: 'French', nativeName: 'Français' },
        { code: 'de', name: 'German', nativeName: 'Deutsch' },
        { code: 'it', name: 'Italian', nativeName: 'Italiano' },
        { code: 'ar', name: 'Arabic', nativeName: 'العربية' }
    ];
} 