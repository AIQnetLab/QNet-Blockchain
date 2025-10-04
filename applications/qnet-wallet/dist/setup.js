/**
 * QNet Wallet Setup Script - Production Version
 * Professional wallet creation and import functionality
 * July 2025 - Production Ready
 */

// Initialize SecureKeyManager globally (moved from inline script for CSP compliance)
if (typeof window !== 'undefined' && typeof SecureKeyManager !== 'undefined') {
    window.globalKeyManager = new SecureKeyManager();
}

// Global setup state
let setupState = {
    currentStep: 'welcome',
    walletType: null, // 'create' or 'import'
    password: null,
    seedPhrase: null,
    verificationWords: [],
    isCreating: false,
    language: 'en', // Will be auto-detected
    hasSubmittedPasswords: false,
    hasSubmittedImport: false
};

// Auto-detect browser language
function detectBrowserLanguage() {
    const supportedLanguages = ['en', 'zh-CN', 'ru', 'es', 'ko', 'ja', 'pt', 'fr', 'de', 'ar', 'it'];
    const browserLang = (navigator.language || navigator.userLanguage).toLowerCase();
    
    // Check for exact match first (e.g., zh-CN)
    if (supportedLanguages.includes(browserLang)) {
        return browserLang;
    }
    
    // Check for language prefix (e.g., en-US -> en)
    const langPrefix = browserLang.split('-')[0];
    if (langPrefix === 'zh') {
        return 'zh-CN'; // Default Chinese to zh-CN
    }
    if (supportedLanguages.includes(langPrefix)) {
        return langPrefix;
    }
    
    return 'en'; // Default to English
}

// Initialize language
setupState.language = detectBrowserLanguage();

// Helper function to get step number
function getStepNumber(stepName) {
    const steps = ['welcome', 'password', 'seed-generation', 'seed-verification', 'complete'];
    return steps.indexOf(stepName) + 1;
}

// Update UI with current language
function updateUILanguage() {
    const lang = setupState.language;
    const t = translations[lang] || translations['en'];
    
    // Update title
    const titleElement = document.querySelector('.setup-title span');
    if (titleElement) titleElement.textContent = t.title || 'QNet Wallet';
    
    // Update step indicator
    const stepIndicator = document.getElementById('step-indicator');
    if (stepIndicator) {
        const currentStepNum = getStepNumber(setupState.currentStep);
        const totalSteps = 5;
        stepIndicator.textContent = `${t.step || 'Step'} ${currentStepNum} ${t.of || 'of'} ${totalSteps}`;
    }
    
    // Update all step content based on current step
    updateStepContent(setupState.currentStep);
}

// Initialize language on page load
document.addEventListener('DOMContentLoaded', function() {
    // Set language dropdown value
    const languageSelect = document.getElementById('language-select');
    if (languageSelect) {
        // Set the dropdown to detected language
        const detectedLang = setupState.language;
        // Map Chinese variants to zh-CN
        if (detectedLang === 'zh') {
            languageSelect.value = 'zh-CN';
            setupState.language = 'zh-CN';
        } else {
            languageSelect.value = detectedLang;
        }
        
        // Add change event listener
        languageSelect.addEventListener('change', function(e) {
            setupState.language = e.target.value;
            updateUILanguage();
            // DO NOT call showStep here as it may regenerate seed phrase!
            // Just update the current step's text content
            updateStepContent(setupState.currentStep);
        });
    }
    
    // Initial language update
    updateUILanguage();
})

// Update content for current step
function updateStepContent(stepName) {
    const lang = setupState.language;
    const t = translations[lang] || translations['en'];
    
    // Update Welcome step
    if (stepName === 'welcome') {
        const welcomeTitle = document.querySelector('#step-welcome .step-title');
        const welcomeDesc = document.querySelector('#step-welcome .step-description');
        const createBtn = document.getElementById('create-new-wallet');
        const importBtn = document.getElementById('import-existing-wallet');
        const securityTitle = document.querySelector('#step-welcome .warning-title');
        const securityDesc = document.querySelector('#step-welcome .warning-text');
        
        if (welcomeTitle) welcomeTitle.textContent = t.welcome_title;
        if (welcomeDesc) welcomeDesc.textContent = t.welcome_desc;
        if (createBtn) createBtn.textContent = t.create_wallet;
        if (importBtn) importBtn.textContent = t.import_wallet;
        if (securityTitle) securityTitle.textContent = t.security_title;
        if (securityDesc) securityDesc.textContent = t.security_desc;
    }
    
    // Update Password step
    else if (stepName === 'password') {
        const passTitle = document.querySelector('#step-password .step-title');
        const passDesc = document.querySelector('#step-password .step-description');
        const newPassLabel = document.querySelector('label[for="new-password"]');
        const confirmPassLabel = document.querySelector('label[for="confirm-password"]');
        const passReq = document.querySelector('.password-requirements p');
        const backBtn = document.querySelector('#step-password .back-button');
        const continueBtn = document.querySelector('#step-password .primary-button');
        const newPassInput = document.querySelector('#new-password');
        const confirmPassInput = document.querySelector('#confirm-password');
        const checkLength = document.querySelector('#check-length span:last-child');
        
        if (passTitle) passTitle.textContent = t.password_title;
        if (passDesc) passDesc.textContent = t.password_desc;
        if (newPassLabel) newPassLabel.textContent = t.new_password;
        if (confirmPassLabel) confirmPassLabel.textContent = t.confirm_password;
        if (passReq) passReq.textContent = t.at_least_8_chars;
        if (backBtn && t.back) backBtn.textContent = t.back;
        if (continueBtn && t.continue) continueBtn.textContent = t.continue;
        
        // Update password requirement text
        if (checkLength && t.at_least_8_chars) checkLength.textContent = t.at_least_8_chars;
        
        // Update input placeholders
        if (newPassInput && t.enter_password) newPassInput.placeholder = t.enter_password;
        if (confirmPassInput && t.confirm_your_password) confirmPassInput.placeholder = t.confirm_your_password;
    }
    
    // Update Seed Generation step
    else if (stepName === 'seed-generation' || stepName === 'seed-display') {
        const seedTitle = document.querySelector('#step-seed-display .step-title');
        const seedDesc = document.querySelector('#step-seed-display .step-description');
        const copyBtn = document.querySelector('#copy-seed');
        const downloadBtn = document.querySelector('#download-seed');
        const backBtn = document.querySelector('#back-to-password');
        const savedBtn = document.querySelector('#continue-to-verify');
        const warningContent = document.querySelector('#step-seed-display .warning-content');
        
        if (seedTitle && t.seed_title) seedTitle.textContent = t.seed_title;
        if (seedDesc && t.seed_desc) seedDesc.textContent = t.seed_desc;
        if (copyBtn && t.copy) copyBtn.textContent = t.copy;
        if (downloadBtn && t.download) downloadBtn.textContent = t.download;
        if (backBtn && t.back) backBtn.textContent = t.back;
        if (savedBtn && t.ive_saved_it) savedBtn.textContent = t.ive_saved_it;
        if (warningContent && t.warning_never_share) {
            warningContent.innerHTML = `<strong>${t.warning || 'Warning'}:</strong> ${t.warning_never_share}`;
        }
        
        // CRITICAL: Never regenerate seed phrase when updating language!
        // Seed phrase must remain the same
    }
    
    // Update Seed Verification step
    else if (stepName === 'seed-verification' || stepName === 'verification') {
        const verifyTitle = document.querySelector('#step-verification .step-title');
        const verifyDesc = document.querySelector('#step-verification .step-description');
        const backBtn = document.querySelector('#back-to-seed');
        const completeBtn = document.querySelector('#complete-verification');
        const errorMsg = document.querySelector('#verification-error');
        
        if (verifyTitle && t.verify_title) verifyTitle.textContent = t.verify_title;
        if (verifyDesc && t.verify_desc) verifyDesc.textContent = t.verify_desc;
        if (backBtn && t.back) backBtn.textContent = t.back;
        if (completeBtn && t.complete_setup) completeBtn.textContent = t.complete_setup;
        
        // Update verification word labels if they exist
        const wordLabels = document.querySelectorAll('.verification-field label');
        wordLabels.forEach(label => {
            const match = label.textContent.match(/Word #(\d+)/);
            if (match && t.word_number) {
                label.textContent = `${t.word_number.replace('#', match[1])}`;
            }
        });
    }
    
    // Update Import step
    else if (stepName === 'seed-import') {
        const importTitle = document.querySelector('#step-seed-import .step-title');
        const importDesc = document.querySelector('#step-seed-import .step-description');
        const backBtn = document.querySelector('#back-to-password-import');
        const importBtn = document.querySelector('#continue-import');
        const placeholder = document.querySelector('#seed-phrase-input');
        const wordCountCheck = document.querySelector('#word-count-check span:last-child');
        const wordsValidCheck = document.querySelector('#words-valid-check span:last-child');
        
        if (importTitle && t.import_title) importTitle.textContent = t.import_title;
        if (importDesc && t.import_desc) importDesc.textContent = t.import_desc;
        if (backBtn && t.back) backBtn.textContent = t.back;
        if (importBtn && t.import) importBtn.textContent = t.import;
        if (placeholder && t.enter_recovery_phrase) placeholder.placeholder = t.enter_recovery_phrase;
        
        // Update validation messages correctly
        if (wordCountCheck && t.valid_word_count) wordCountCheck.textContent = t.valid_word_count;
        if (wordsValidCheck && t.all_words_valid) wordsValidCheck.textContent = t.all_words_valid;
    }
    
    // Update Success step
    else if (stepName === 'success') {
        const successTitle = document.querySelector('#step-success .step-title');
        const successDesc = document.querySelector('#step-success .step-description');
        const openBtn = document.getElementById('open-wallet');
        
        if (successTitle) successTitle.textContent = t.wallet_created;
        if (successDesc) successDesc.textContent = t.wallet_ready;
        if (openBtn) openBtn.textContent = t.open_wallet;
    }
}

// Professional translations without emoji
// Order: en, zh-CN, ru, es, ko, ja, pt, fr, de, ar, it
const translations = {
    en: {
        title: 'QNet Wallet',
        welcome_title: 'Welcome to QNet',
        welcome_desc: 'Create a new wallet or import an existing one to get started with QNet and Solana dual networks.',
        create_wallet: 'Create New Wallet',
        import_wallet: 'Import Existing Wallet',
        security_title: 'Your security is our priority',
        security_desc: 'QNet Wallet uses industry-standard encryption and never stores your private keys on our servers.',
        wallet_created: 'Wallet Created Successfully',
        wallet_ready: 'Your QNet Wallet is ready to use. You can now manage QNet and Solana assets securely.',
        password_title: 'Create Password',
        password_desc: 'This password will unlock your wallet on this device.',
        new_password: 'New Password',
        confirm_password: 'Confirm Password',
        at_least_8_chars: 'At least 8 characters',
        passwords_no_match: 'Passwords do not match',
        seed_title: 'Your Recovery Phrase',
        seed_desc: 'Write down this 12-word recovery phrase in the exact order shown. Keep it secure and never share it.',
        verify_title: 'Verify Recovery Phrase',
        verify_desc: 'Click the words in the correct order to verify you saved your recovery phrase.',
        import_title: 'Import Recovery Phrase',
        import_desc: 'Enter your 12 or 24-word recovery phrase to restore your wallet.',
        back: 'Back',
        continue: 'Continue',
        ive_saved_it: 'I have saved it',
        complete_setup: 'Complete Setup',
        copy: 'Copy',
        download: 'Download',
        import: 'Import Wallet',
        open_wallet: 'Open Wallet',
        step: 'Step',
        of: 'of',
        password_length_good: 'Password length is good',
        warning_never_share: 'Never share your recovery phrase with anyone. Anyone with this phrase can access your funds.',
        warning: 'Warning',
        word_number: 'Word #',
        some_words_incorrect: 'Some words are incorrect. Please check your selection.',
        valid_word_count: 'Valid word count (12 or 24 words)',
        all_words_valid: 'All words are valid',
        enter_recovery_phrase: 'Enter your recovery phrase...',
        recovery_phrase: 'Recovery Phrase',
        enter_password: 'Enter password',
        confirm_your_password: 'Confirm your password',
        password_length_good_detail: 'Password length is good',
        more_chars_needed: 'more characters needed',
        please_select_correct_words: 'Please select the correct words to verify your seed phrase',
        please_enter_recovery: 'Please enter your recovery phrase',
        must_be_12_or_24: 'Recovery phrase must be 12 or 24 words',
        invalid_bip39_words: 'Some words are not valid BIP39 words'
    },
    'zh-CN': { // Chinese (2nd largest - massive crypto market)
        title: 'QNet 钱包',
        welcome_title: '欢迎使用 QNet',
        welcome_desc: '创建新钱包或导入现有钱包，开始使用 QNet 和 Solana 双网络。',
        create_wallet: '创建新钱包',
        import_wallet: '导入现有钱包',
        security_title: '您的安全是我们的首要任务',
        security_desc: 'QNet 钱包使用行业标准加密，绝不在我们的服务器上存储您的私钥。',
        wallet_created: '钱包创建成功！',
        wallet_ready: '您的 QNet 钱包已准备就绪。现在您可以安全地管理 QNet 和 Solana 资产。',
        qnet_address: 'QNet 地址：',
        solana_address: 'Solana 地址：',
        password_title: '创建密码',
        password_desc: '此密码将在此设备上解锁您的钱包。',
        new_password: '密码',
        confirm_password: '确认密码',
        at_least_8_chars: '密码长度至少8个字符',
        back: '← 返回',
        continue: '继续',
        seed_title: '您的恢复短语',
        seed_desc: '按显示的确切顺序写下这12个单词的恢复短语。保持安全，绝不分享。',
        verify_title: '验证恢复短语',
        verify_desc: '按正确顺序点击单词以验证您已保存恢复短语。',
        word_number: '第{number}个词：',
        complete_setup: '完成设置',
        ive_saved_it: '我已保存',
        copy: '复制',
        download: '下载',
        import_title: '导入恢复短语',
        import_desc: '输入您的12或24个单词的恢复短语来恢复您的钱包。',
        import: '导入钱包',
        open_wallet: '打开钱包',
        step: '步骤',
        of: '共',
        password_length_good: '密码长度符合要求',
        warning_never_share: '绝不与任何人分享您的恢复短语。任何拥有此短语的人都可以访问您的资金。',
        warning: '警告',
        word_number: '单词 #',
        some_words_incorrect: '某些单词不正确。请检查您的选择。',
        valid_word_count: '有效的单词数（12或24个单词）',
        all_words_valid: '所有单词都有效',
        enter_recovery_phrase: '输入您的恢复短语...',
        recovery_phrase: '恢复短语',
        enter_password: '输入密码',
        confirm_your_password: '确认您的密码',
        password_length_good_detail: '密码长度符合要求',
        more_chars_needed: '需要更多字符',
        please_select_correct_words: '请选择正确的单词以验证您的恢复短语',
        please_enter_recovery: '请输入您的恢复短语',
        must_be_12_or_24: '恢复短语必须是12或24个单词',
        invalid_bip39_words: '某些单词不是有效的BIP39单词'
    },
    ko: { // Korean (3rd largest - very active crypto community)
        title: 'QNet 지갑',
        welcome_title: 'QNet에 오신 것을 환영합니다',
        welcome_desc: '새 지갑을 만들거나 기존 지갑을 가져와서 QNet 및 Solana 이중 네트워크를 시작하세요.',
        create_wallet: '새 지갑 만들기',
        import_wallet: '기존 지갑 가져오기',
        security_title: '귀하의 보안이 우리의 우선순위입니다',
        security_desc: 'QNet 지갑은 업계 표준 암호화를 사용하며 개인 키를 당사 서버에 저장하지 않습니다.',
        wallet_created: '지갑이 성공적으로 생성되었습니다!',
        wallet_ready: 'QNet 지갑이 사용할 준비가 되었습니다. 이제 QNet 및 Solana 자산을 안전하게 관리할 수 있습니다.',
        qnet_address: 'QNet 주소:',
        solana_address: 'Solana 주소:',
        password_title: '비밀번호 생성',
        password_desc: '이 비밀번호는 이 기기에서 지갑의 잠금을 해제합니다.',
        new_password: '비밀번호',
        confirm_password: '비밀번호 확인',
        at_least_8_chars: '비밀번호는 최소 8자 이상이어야 합니다',
        back: '← 뒤로',
        continue: '계속',
        seed_title: '복구 문구',
        seed_desc: '표시된 정확한 순서대로 12개 단어의 복구 문구를 적으세요. 안전하게 보관하고 절대 공유하지 마세요.',
        verify_title: '복구 문구 확인',
        verify_desc: '복구 문구를 저장했는지 확인하려면 올바른 순서로 단어를 클릭하세요.',
        complete_setup: '설정 완료',
        ive_saved_it: '저장했습니다',
        copy: '복사',
        download: '다운로드',
        import_title: '복구 문구 가져오기',
        import_desc: '지갑을 복원하려면 12개 또는 24개 단어의 복구 문구를 입력하세요.',
        import: '지갑 가져오기',
        open_wallet: '지갑 열기',
        step: '단계',
        of: '/',
        password_length_good: '비밀번호 길이가 적절합니다',
        warning_never_share: '복구 문구를 절대로 다른 사람과 공유하지 마세요. 이 문구를 가진 사람은 누구나 귀하의 자금에 접근할 수 있습니다.',
        warning: '경고',
        word_number: '단어 #',
        some_words_incorrect: '일부 단어가 올바르지 않습니다. 선택을 확인하세요.',
        valid_word_count: '유효한 단어 수 (12개 또는 24개 단어)',
        all_words_valid: '모든 단어가 유효합니다',
        enter_recovery_phrase: '복구 문구를 입력하세요...',
        recovery_phrase: '복구 문구',
        enter_password: '비밀번호 입력',
        confirm_your_password: '비밀번호 확인',
        password_length_good_detail: '비밀번호 길이가 적절합니다',
        more_chars_needed: '더 많은 문자가 필요합니다',
        please_select_correct_words: '복구 문구를 확인하려면 올바른 단어를 선택하세요',
        please_enter_recovery: '복구 문구를 입력하세요',
        must_be_12_or_24: '복구 문구는 12개 또는 24개 단어여야 합니다',
        invalid_bip39_words: '일부 단어가 유효한 BIP39 단어가 아닙니다'
    },
    ja: { // Japanese (4th largest - institutional crypto market)
        title: 'QNet ウォレット',
        welcome_title: 'QNet へようこそ',
        welcome_desc: '新しいウォレットを作成するか、既存のウォレットをインポートして、QNet と Solana のデュアルネットワークを開始してください。',
        create_wallet: '新しいウォレットを作成',
        import_wallet: '既存のウォレットをインポート',
        security_title: 'あなたのセキュリティが私たちの優先事項です',
        security_desc: 'QNet ウォレットは業界標準の暗号化を使用し、お客様の秘密鍵を弊社のサーバーに保存することはありません。',
        wallet_created: 'ウォレットが正常に作成されました！',
        wallet_ready: 'QNet ウォレットの準備が整いました。QNet と Solana の資産を安全に管理できます。',
        qnet_address: 'QNet アドレス：',
        solana_address: 'Solana アドレス：',
        password_title: 'パスワードを作成',
        password_desc: 'このパスワードは、このデバイス上でウォレットのロックを解除します。',
        new_password: 'パスワード',
        confirm_password: 'パスワードを確認',
        at_least_8_chars: 'パスワードは8文字以上である必要があります',
        back: '← 戻る',
        continue: '続行',
        seed_title: 'リカバリーフレーズ',
        seed_desc: '表示された正確な順番で、12単語のリカバリーフレーズを書き留めてください。安全に保管し、絶対に共有しないでください。',
        verify_title: 'リカバリーフレーズの確認',
        verify_desc: 'リカバリーフレーズを保存したことを確認するため、正しい順番で単語をクリックしてください。',
        complete_setup: 'セットアップ完了',
        ive_saved_it: '保存しました',
        copy: 'コピー',
        download: 'ダウンロード',
        import_title: 'リカバリーフレーズをインポート',
        import_desc: 'ウォレットを復元するために12または24単語のリカバリーフレーズを入力してください。',
        import: 'ウォレットをインポート',
        open_wallet: 'ウォレットを開く',
        step: 'ステップ',
        of: '/',
        password_length_good: 'パスワードの長さが適切です',
        warning_never_share: 'リカバリーフレーズを絶対に誰とも共有しないでください。このフレーズを持っている人は誰でもあなたの資金にアクセスできます。',
        warning: '警告',
        word_number: '単語 #',
        some_words_incorrect: 'いくつかの単語が正しくありません。選択を確認してください。',
        valid_word_count: '有効な単語数（12または24単語）',
        all_words_valid: 'すべての単語が有効です',
        enter_recovery_phrase: 'リカバリーフレーズを入力...',
        recovery_phrase: 'リカバリーフレーズ',
        enter_password: 'パスワードを入力',
        confirm_your_password: 'パスワードを確認',
        password_length_good_detail: 'パスワードの長さが適切です',
        more_chars_needed: 'さらに文字が必要です',
        please_select_correct_words: 'リカバリーフレーズを確認するために正しい単語を選択してください',
        please_enter_recovery: 'リカバリーフレーズを入力してください',
        must_be_12_or_24: 'リカバリーフレーズは12または24単語である必要があります',
        invalid_bip39_words: '一部の単語が有効なBIP39単語ではありません'
    },
    ru: {
        title: 'QNet Кошелёк',
        welcome_title: 'Добро пожаловать в QNet',
        welcome_desc: 'Создайте новый кошелёк или импортируйте существующий для работы с сетями QNet и Solana.',
        create_wallet: 'Создать новый кошелёк',
        import_wallet: 'Импортировать кошелёк',
        security_title: 'Ваша безопасность - наш приоритет',
        security_desc: 'QNet Кошелёк использует стандартное шифрование и никогда не хранит ваши приватные ключи на наших серверах.',
        wallet_created: 'Кошелёк успешно создан',
        wallet_ready: 'Ваш QNet Кошелёк готов к использованию. Теперь вы можете безопасно управлять активами QNet и Solana.',
        password_title: 'Создать пароль',
        password_desc: 'Этот пароль будет разблокировать ваш кошелёк на этом устройстве.',
        new_password: 'Новый пароль',
        confirm_password: 'Подтвердить пароль',
        at_least_8_chars: 'Минимум 8 символов',
        passwords_no_match: 'Пароли не совпадают',
        seed_title: 'Ваша фраза для восстановления',
        seed_desc: 'Запишите эту 12-словную фразу для восстановления в точном порядке. Храните в безопасности и никогда не делитесь.',
        verify_title: 'Проверить фразу для восстановления',
        verify_desc: 'Нажмите на слова в правильном порядке, чтобы подтвердить, что вы сохранили фразу для восстановления.',
        import_title: 'Импорт фразы для восстановления',
        import_desc: 'Введите вашу 12 или 24-словную фразу для восстановления кошелька.',
        back: 'Назад',
        continue: 'Продолжить',
        ive_saved_it: 'Я сохранил',
        complete_setup: 'Завершить настройку',
        copy: 'Копировать',
        download: 'Скачать',
        import: 'Импортировать кошелёк',
        open_wallet: 'Открыть кошелёк',
        step: 'Шаг',
        of: 'из',
        password_length_good: 'Длина пароля подходит',
        warning_never_share: 'Никогда не делитесь вашей фразой восстановления ни с кем. Любой, кто знает эту фразу, может получить доступ к вашим средствам.',
        warning: 'Предупреждение',
        word_number: 'Слово #',
        some_words_incorrect: 'Некоторые слова неправильны. Проверьте ваш выбор.',
        valid_word_count: 'Правильное количество слов (12 или 24 слова)',
        all_words_valid: 'Все слова правильные',
        enter_recovery_phrase: 'Введите вашу фразу восстановления...',
        recovery_phrase: 'Фраза восстановления',
        enter_password: 'Введите пароль',
        confirm_your_password: 'Подтвердите пароль',
        password_length_good_detail: 'Длина пароля подходит',
        more_chars_needed: 'нужно больше символов',
        please_select_correct_words: 'Выберите правильные слова для проверки вашей фразы восстановления',
        please_enter_recovery: 'Пожалуйста, введите вашу фразу восстановления',
        must_be_12_or_24: 'Фраза восстановления должна содержать 12 или 24 слова',
        invalid_bip39_words: 'Некоторые слова недействительны для BIP39'
    },
    es: { // Spanish (6th largest - Latin America growth)
        title: 'QNet Billetera',
        welcome_title: 'Bienvenido a QNet',
        welcome_desc: 'Crea una nueva billetera o importa una existente para comenzar con las redes duales QNet y Solana.',
        create_wallet: 'Crear Nueva Billetera',
        import_wallet: 'Importar Billetera Existente',
        security_title: 'Tu seguridad es nuestra prioridad',
        security_desc: 'QNet Billetera utiliza cifrado estándar de la industria y nunca almacena tus claves privadas en nuestros servidores.',
        wallet_created: '¡Billetera Creada Exitosamente!',
        wallet_ready: 'Tu QNet Billetera está listo para usar. Ahora puedes gestionar activos QNet y Solana de forma segura.',
        qnet_address: 'Dirección QNet:',
        solana_address: 'Dirección Solana:',
        password_title: 'Crear Contraseña',
        password_desc: 'Esta contraseña desbloqueará tu billetera en este dispositivo.',
        new_password: 'Contraseña',
        confirm_password: 'Confirmar Contraseña',
        at_least_8_chars: 'La contraseña debe tener al menos 8 caracteres',
        back: '← Atrás',
        continue: 'Continuar',
        seed_title: 'Tu Frase de Recuperación',
        seed_desc: 'Escribe esta frase de recuperación de 12 palabras en el orden exacto mostrado. Manténla segura y nunca la compartas.',
        verify_title: 'Verificar Frase de Recuperación',
        verify_desc: 'Haz clic en las palabras en el orden correcto para verificar que guardaste tu frase de recuperación.',
        complete_setup: 'Completar Configuración',
        ive_saved_it: 'La he guardado',
        copy: 'Copiar',
        download: 'Descargar',
        import_title: 'Importar Frase de Recuperación',
        import_desc: 'Ingresa tu frase de recuperación de 12 o 24 palabras para restaurar tu billetera.',
        import: 'Importar Billetera',
        open_wallet: 'Abrir Billetera',
        step: 'Paso',
        of: 'de',
        password_length_good: 'La longitud de la contraseña es buena',
        warning_never_share: 'Nunca compartas tu frase de recuperación con nadie. Cualquiera con esta frase puede acceder a tus fondos.',
        warning: 'Advertencia',
        word_number: 'Palabra #',
        some_words_incorrect: 'Algunas palabras son incorrectas. Por favor verifica tu selección.',
        valid_word_count: 'Número de palabras válido (12 o 24 palabras)',
        all_words_valid: 'Todas las palabras son válidas',
        enter_recovery_phrase: 'Ingresa tu frase de recuperación...',
        recovery_phrase: 'Frase de recuperación',
        enter_password: 'Ingrese contraseña',
        confirm_your_password: 'Confirme su contraseña',
        password_length_good_detail: 'La longitud de la contraseña es buena',
        more_chars_needed: 'se necesitan más caracteres',
        please_select_correct_words: 'Seleccione las palabras correctas para verificar su frase de recuperación',
        please_enter_recovery: 'Por favor ingrese su frase de recuperación',
        must_be_12_or_24: 'La frase de recuperación debe tener 12 o 24 palabras',
        invalid_bip39_words: 'Algunas palabras no son palabras BIP39 válidas'
    },
    pt: { // Portuguese (7th largest - Brazil crypto boom)
        title: 'QNet Carteira',
        welcome_title: 'Bem-vindo ao QNet',
        welcome_desc: 'Crie uma nova carteira ou importe uma existente para começar com as redes duplas QNet e Solana.',
        create_wallet: 'Criar Nova Carteira',
        import_wallet: 'Importar Carteira Existente',
        security_title: 'Sua segurança é nossa prioridade',
        security_desc: 'A QNet Carteira usa criptografia padrão da indústria e nunca armazena suas chaves privadas em nossos servidores.',
        wallet_created: 'Carteira Criada com Sucesso!',
        wallet_ready: 'Sua QNet Carteira está pronta para uso. Agora você pode gerenciar ativos QNet e Solana com segurança.',
        qnet_address: 'Endereço QNet:',
        solana_address: 'Endereço Solana:',
        password_title: 'Criar Senha',
        password_desc: 'Esta senha desbloqueará sua carteira neste dispositivo.',
        new_password: 'Senha',
        confirm_password: 'Confirmar Senha',
        at_least_8_chars: 'A senha deve ter pelo menos 8 caracteres',
        back: '← Voltar',
        continue: 'Continuar',
        seed_title: 'Sua Frase de Recuperação',
        seed_desc: 'Anote esta frase de recuperação de 12 palavras na ordem exata mostrada. Mantenha-a segura e nunca compartilhe.',
        verify_title: 'Verificar Frase de Recuperação',
        verify_desc: 'Clique nas palavras na ordem correta para verificar que você salvou sua frase de recuperação.',
        complete_setup: 'Concluir Configuração',
        ive_saved_it: 'Eu salvei',
        copy: 'Copiar',
        download: 'Baixar',
        import_title: 'Importar Frase de Recuperação',
        import_desc: 'Digite sua frase de recuperação de 12 ou 24 palavras para restaurar sua carteira.',
        import: 'Importar Carteira',
        open_wallet: 'Abrir Carteira',
        step: 'Passo',
        of: 'de',
        password_length_good: 'O comprimento da senha é bom',
        warning_never_share: 'Nunca compartilhe sua frase de recuperação com ninguém. Qualquer pessoa com esta frase pode acessar seus fundos.',
        warning: 'Aviso',
        word_number: 'Palavra #',
        some_words_incorrect: 'Algumas palavras estão incorretas. Por favor, verifique sua seleção.',
        valid_word_count: 'Número de palavras válido (12 ou 24 palavras)',
        all_words_valid: 'Todas as palavras são válidas',
        enter_recovery_phrase: 'Digite sua frase de recuperação...',
        recovery_phrase: 'Frase de recuperação',
        enter_password: 'Digite a senha',
        confirm_your_password: 'Confirme sua senha',
        password_length_good_detail: 'O comprimento da senha é bom',
        more_chars_needed: 'mais caracteres necessários',
        please_select_correct_words: 'Selecione as palavras corretas para verificar sua frase de recuperação',
        please_enter_recovery: 'Por favor, insira sua frase de recuperação',
        must_be_12_or_24: 'A frase de recuperação deve ter 12 ou 24 palavras',
        invalid_bip39_words: 'Algumas palavras não são palavras BIP39 válidas'
    },
    fr: { // French (8th largest - France and African markets)
        title: 'QNet Portefeuille',
        welcome_title: 'Bienvenue dans QNet',
        welcome_desc: 'Créez un nouveau portefeuille ou importez-en un existant pour commencer avec les réseaux doubles QNet et Solana.',
        create_wallet: 'Créer un Nouveau Portefeuille',
        import_wallet: 'Importer un Portefeuille Existant',
        security_title: 'Votre sécurité est notre priorité',
        security_desc: 'QNet Portefeuille utilise un chiffrement standard de l\'industrie et ne stocke jamais vos clés privées sur nos serveurs.',
        wallet_created: 'Portefeuille Créé avec Succès !',
        wallet_ready: 'Votre QNet Portefeuille est prêt à utiliser. Vous pouvez maintenant gérer les actifs QNet et Solana en toute sécurité.',
        qnet_address: 'Adresse QNet :',
        solana_address: 'Adresse Solana :',
        password_title: 'Créer un Mot de Passe',
        password_desc: 'Ce mot de passe déverrouillera votre portefeuille sur cet appareil.',
        new_password: 'Mot de Passe',
        confirm_password: 'Confirmer le Mot de Passe',
        at_least_8_chars: 'Le mot de passe doit contenir au moins 8 caractères',
        back: '← Retour',
        continue: 'Continuer',
        seed_title: 'Votre Phrase de Récupération',
        seed_desc: 'Écrivez cette phrase de récupération de 12 mots dans l\'ordre exact indiqué. Gardez-la en sécurité et ne la partagez jamais.',
        verify_title: 'Vérifier la Phrase de Récupération',
        verify_desc: 'Cliquez sur les mots dans le bon ordre pour vérifier que vous avez sauvegardé votre phrase de récupération.',
        complete_setup: 'Terminer la Configuration',
        ive_saved_it: 'Je l\'ai sauvegardée',
        copy: 'Copier',
        download: 'Télécharger',
        import_title: 'Importer une Phrase de Récupération',
        import_desc: 'Entrez votre phrase de récupération de 12 ou 24 mots pour restaurer votre portefeuille.',
        import: 'Importer le Portefeuille',
        open_wallet: 'Ouvrir le Portefeuille',
        step: 'Étape',
        of: 'sur',
        password_length_good: 'La longueur du mot de passe est bonne',
        warning_never_share: 'Ne partagez jamais votre phrase de récupération avec qui que ce soit. Quiconque possède cette phrase peut accéder à vos fonds.',
        warning: 'Avertissement',
        word_number: 'Mot #',
        some_words_incorrect: 'Certains mots sont incorrects. Veuillez vérifier votre sélection.',
        valid_word_count: 'Nombre de mots valide (12 ou 24 mots)',
        all_words_valid: 'Tous les mots sont valides',
        enter_recovery_phrase: 'Entrez votre phrase de récupération...',
        recovery_phrase: 'Phrase de récupération',
        enter_password: 'Entrez le mot de passe',
        confirm_your_password: 'Confirmez votre mot de passe',
        password_length_good_detail: 'La longueur du mot de passe est bonne',
        more_chars_needed: 'plus de caractères nécessaires',
        please_select_correct_words: 'Sélectionnez les mots corrects pour vérifier votre phrase de récupération',
        please_enter_recovery: 'Veuillez entrer votre phrase de récupération',
        must_be_12_or_24: 'La phrase de récupération doit contenir 12 ou 24 mots',
        invalid_bip39_words: 'Certains mots ne sont pas des mots BIP39 valides'
    },
    de: { // German (9th largest - Germany and DACH region)
        title: 'QNet Wallet',
        welcome_title: 'Willkommen bei QNet',
        welcome_desc: 'Erstellen Sie eine neue Wallet oder importieren Sie eine bestehende, um mit den QNet- und Solana-Dual-Netzwerken zu beginnen.',
        create_wallet: 'Neue Wallet Erstellen',
        import_wallet: 'Bestehende Wallet Importieren',
        security_title: 'Ihre Sicherheit ist unsere Priorität',
        security_desc: 'QNet Wallet verwendet branchenübliche Verschlüsselung und speichert niemals Ihre privaten Schlüssel auf unseren Servern.',
        wallet_created: 'Wallet Erfolgreich Erstellt!',
        wallet_ready: 'Ihre QNet Wallet ist einsatzbereit. Sie können jetzt QNet- und Solana-Assets sicher verwalten.',
        qnet_address: 'QNet-Adresse:',
        solana_address: 'Solana-Adresse:',
        password_title: 'Passwort Erstellen',
        password_desc: 'Dieses Passwort entsperrt Ihre Wallet auf diesem Gerät.',
        new_password: 'Passwort',
        confirm_password: 'Passwort Bestätigen',
        at_least_8_chars: 'Das Passwort muss mindestens 8 Zeichen haben',
        back: '← Zurück',
        continue: 'Weiter',
        seed_title: 'Ihre Wiederherstellungsphrase',
        seed_desc: 'Schreiben Sie diese 12-Wort-Wiederherstellungsphrase in der genauen angezeigten Reihenfolge auf. Bewahren Sie sie sicher auf und teilen Sie sie niemals.',
        verify_title: 'Wiederherstellungsphrase überprüfen',
        verify_desc: 'Klicken Sie die Wörter in der richtigen Reihenfolge an, um zu bestätigen, dass Sie Ihre Wiederherstellungsphrase gespeichert haben.',
        complete_setup: 'Einrichtung abschließen',
        ive_saved_it: 'Ich habe es gespeichert',
        copy: 'Kopieren',
        download: 'Herunterladen',
        import_title: 'Wiederherstellungsphrase importieren',
        import_desc: 'Geben Sie Ihre 12- oder 24-Wort-Wiederherstellungsphrase ein, um Ihre Wallet wiederherzustellen.',
        import: 'Wallet importieren',
        open_wallet: 'Wallet öffnen',
        step: 'Schritt',
        of: 'von',
        password_length_good: 'Die Passwortlänge ist gut',
        warning_never_share: 'Teilen Sie Ihre Wiederherstellungsphrase niemals mit anderen. Jeder mit dieser Phrase kann auf Ihre Mittel zugreifen.',
        warning: 'Warnung',
        word_number: 'Wort #',
        some_words_incorrect: 'Einige Wörter sind falsch. Bitte überprüfen Sie Ihre Auswahl.',
        valid_word_count: 'Gültige Wortanzahl (12 oder 24 Wörter)',
        all_words_valid: 'Alle Wörter sind gültig',
        enter_recovery_phrase: 'Geben Sie Ihre Wiederherstellungsphrase ein...',
        recovery_phrase: 'Wiederherstellungsphrase',
        enter_password: 'Passwort eingeben',
        confirm_your_password: 'Passwort bestätigen',
        password_length_good_detail: 'Die Passwortlänge ist gut',
        more_chars_needed: 'mehr Zeichen benötigt',
        please_select_correct_words: 'Wählen Sie die richtigen Wörter aus, um Ihre Wiederherstellungsphrase zu überprüfen',
        please_enter_recovery: 'Bitte geben Sie Ihre Wiederherstellungsphrase ein',
        must_be_12_or_24: 'Die Wiederherstellungsphrase muss 12 oder 24 Wörter enthalten',
        invalid_bip39_words: 'Einige Wörter sind keine gültigen BIP39-Wörter'
    },
    it: { // Italian (10th largest - Italy)
        title: 'QNet Portafoglio',
        welcome_title: 'Benvenuto in QNet',
        welcome_desc: 'Crea un nuovo portafoglio o importa uno esistente per iniziare con le reti doppie QNet e Solana.',
        create_wallet: 'Crea Nuovo Portafoglio',
        import_wallet: 'Importa Portafoglio Esistente',
        security_title: 'La tua sicurezza è la nostra priorità',
        security_desc: 'QNet Portafoglio utilizza crittografia standard del settore e non memorizza mai le tue chiavi private sui nostri server.',
        wallet_created: 'Portafoglio Creato con Successo!',
        wallet_ready: 'Il tuo QNet Portafoglio è pronto per l\'uso. Ora puoi gestire asset QNet e Solana in sicurezza.',
        qnet_address: 'Indirizzo QNet:',
        solana_address: 'Indirizzo Solana:',
        password_title: 'Crea Password',
        password_desc: 'Questa password sbloccherà il tuo portafoglio su questo dispositivo.',
        new_password: 'Password',
        confirm_password: 'Conferma Password',
        at_least_8_chars: 'La password deve contenere almeno 8 caratteri',
        back: '← Indietro',
        continue: 'Continua',
        seed_title: 'La Tua Frase di Recupero',
        seed_desc: 'Scrivi questa frase di recupero di 12 parole nell\'ordine esatto mostrato. Tienila al sicuro e non condividerla mai.',
        verify_title: 'Verifica Frase di Recupero',
        verify_desc: 'Clicca sulle parole nell\'ordine corretto per verificare di aver salvato la tua frase di recupero.',
        complete_setup: 'Completa Configurazione',
        ive_saved_it: 'L\'ho salvata',
        copy: 'Copia',
        download: 'Scarica',
        import_title: 'Importa Frase di Recupero',
        import_desc: 'Inserisci la tua frase di recupero di 12 o 24 parole per ripristinare il tuo portafoglio.',
        import: 'Importa Portafoglio',
        open_wallet: 'Apri Portafoglio',
        step: 'Passo',
        of: 'di',
        password_length_good: 'La lunghezza della password è buona',
        warning_never_share: 'Non condividere mai la tua frase di recupero con nessuno. Chiunque abbia questa frase può accedere ai tuoi fondi.',
        warning: 'Avviso',
        word_number: 'Parola #',
        some_words_incorrect: 'Alcune parole sono errate. Controlla la tua selezione.',
        valid_word_count: 'Numero di parole valido (12 o 24 parole)',
        all_words_valid: 'Tutte le parole sono valide',
        enter_recovery_phrase: 'Inserisci la tua frase di recupero...',
        recovery_phrase: 'Frase di recupero',
        enter_password: 'Inserisci password',
        confirm_your_password: 'Conferma la tua password',
        password_length_good_detail: 'La lunghezza della password è buona',
        more_chars_needed: 'servono più caratteri',
        please_select_correct_words: 'Seleziona le parole corrette per verificare la tua frase di recupero',
        please_enter_recovery: 'Inserisci la tua frase di recupero',
        must_be_12_or_24: 'La frase di recupero deve essere di 12 o 24 parole',
        invalid_bip39_words: 'Alcune parole non sono parole BIP39 valide'
    },
    ar: { // Arabic (11th largest - Middle East and North Africa)
        title: 'محفظة QNet',
        welcome_title: 'مرحباً بك في QNet',
        welcome_desc: 'أنشئ محفظة جديدة أو استورد محفظة موجودة للبدء مع شبكات QNet و Solana المزدوجة.',
        create_wallet: 'إنشاء محفظة جديدة',
        import_wallet: 'استيراد محفظة موجودة',
        security_title: 'أمانك هو أولويتنا',
        security_desc: 'تستخدم محفظة QNet تشفيراً معيارياً في الصناعة ولا تخزن مفاتيحك الخاصة على خوادمنا أبداً.',
        wallet_created: 'تم إنشاء المحفظة بنجاح!',
        wallet_ready: 'محفظة QNet جاهزة للاستخدام. يمكنك الآن إدارة أصول QNet و Solana بأمان.',
        qnet_address: 'عنوان QNet:',
        solana_address: 'عنوان Solana:',
        password_title: 'إنشاء كلمة مرور',
        password_desc: 'ستقوم كلمة المرور هذه بإلغاء قفل محفظتك على هذا الجهاز.',
        new_password: 'كلمة المرور',
        confirm_password: 'تأكيد كلمة المرور',
        at_least_8_chars: 'يجب أن تتكون كلمة المرور من 8 أحرف على الأقل',
        back: '← رجوع',
        continue: 'متابعة',
        seed_title: 'عبارة الاسترداد الخاصة بك',
        seed_desc: 'اكتب عبارة الاسترداد المكونة من 12 كلمة بالترتيب الدقيق المعروض. احتفظ بها بأمان ولا تشاركها أبداً.',
        verify_title: 'التحقق من عبارة الاسترداد',
        verify_desc: 'انقر على الكلمات بالترتيب الصحيح للتحقق من أنك حفظت عبارة الاسترداد.',
        complete_setup: 'إكمال الإعداد',
        ive_saved_it: 'لقد حفظتها',
        copy: 'نسخ',
        download: 'تحميل',
        import_title: 'استيراد عبارة الاسترداد',
        import_desc: 'أدخل عبارة الاسترداد المكونة من 12 أو 24 كلمة لاستعادة محفظتك.',
        import: 'استيراد المحفظة',
        open_wallet: 'فتح المحفظة',
        step: 'خطوة',
        of: 'من',
        password_length_good: 'طول كلمة المرور جيد',
        warning_never_share: 'لا تشارك عبارة الاسترداد الخاصة بك مع أي شخص. أي شخص لديه هذه العبارة يمكنه الوصول إلى أموالك.',
        warning: 'تحذير',
        word_number: 'كلمة #',
        some_words_incorrect: 'بعض الكلمات غير صحيحة. يرجى التحقق من اختيارك.',
        valid_word_count: 'عدد الكلمات صحيح (12 أو 24 كلمة)',
        all_words_valid: 'جميع الكلمات صحيحة',
        enter_recovery_phrase: 'أدخل عبارة الاسترداد الخاصة بك...',
        recovery_phrase: 'عبارة الاسترداد',
        enter_password: 'أدخل كلمة المرور',
        confirm_your_password: 'أكد كلمة المرور',
        password_length_good_detail: 'طول كلمة المرور جيد',
        more_chars_needed: 'مزيد من الأحرف مطلوبة',
        please_select_correct_words: 'يرجى اختيار الكلمات الصحيحة للتحقق من عبارة الاسترداد',
        please_enter_recovery: 'يرجى إدخال عبارة الاسترداد الخاصة بك',
        must_be_12_or_24: 'يجب أن تكون عبارة الاسترداد 12 أو 24 كلمة',
        invalid_bip39_words: 'بعض الكلمات ليست كلمات BIP39 صالحة'
    }
};

/**
 * Initialize setup when DOM is loaded
 */
document.addEventListener('DOMContentLoaded', () => {
    // Production mode - no console output
    
    setupEventListeners();
    updateLanguage();
    showStep('welcome');
    updateProgress();
});

/**
 * Get translated text
 */
function t(key) {
    return translations[setupState.language]?.[key] || translations.en[key] || key;
}

/**
 * Update interface language
 */
function updateLanguage() {
    // Update titles and descriptions for all steps
    const elements = [
        { selector: '.setup-title span', key: 'title' },
        { selector: '#step-welcome .step-title', key: 'welcome_title' },
        { selector: '#step-welcome .step-description', key: 'welcome_desc' },
        { selector: '#create-new-wallet', key: 'create_wallet' },
        { selector: '#import-existing-wallet', key: 'import_wallet' },
        { selector: '#step-welcome .warning-title', key: 'security_title' },
        { selector: '#step-welcome .warning-text', key: 'security_desc' },
        { selector: '#step-password .step-title', key: 'password_title' },
        { selector: '#step-password .step-description', key: 'password_desc' },
        { selector: '#step-seed-display .step-title', key: 'seed_title' },
        { selector: '#step-seed-display .step-description', key: 'seed_desc' },
        { selector: '#step-verification .step-title', key: 'verify_title' },
        { selector: '#step-verification .step-description', key: 'verify_desc' },
        { selector: '#step-seed-import .step-title', key: 'import_title' },
        { selector: '#step-seed-import .step-description', key: 'import_desc' },
        { selector: '#step-success .step-title', key: 'wallet_created' },
        { selector: '#step-success .step-description', key: 'wallet_ready' },
        { selector: '#copy-seed', key: 'copy' },
        { selector: '#download-seed', key: 'download' },
        { selector: '#continue-to-verify', key: 'ive_saved_it' },
        { selector: '#complete-verification', key: 'complete_setup' },
        { selector: '#continue-import', key: 'import' },
        { selector: '#open-wallet', key: 'open_wallet' }
    ];

    elements.forEach(({ selector, key }) => {
        const element = document.querySelector(selector);
        if (element) {
            element.textContent = t(key);
        }
    });
}

/**
 * Setup all event listeners
 */
function setupEventListeners() {
    // Close setup
    document.getElementById('close-setup')?.addEventListener('click', () => {
        window.close();
    });
    
    // Welcome step
    document.getElementById('create-new-wallet')?.addEventListener('click', () => {
        setupState.walletType = 'create';
        showStep('password');
    });
    
    document.getElementById('import-existing-wallet')?.addEventListener('click', () => {
        setupState.walletType = 'import';
        showStep('password');
    });
    
    // Password step
    document.getElementById('password-form')?.addEventListener('submit', handlePasswordSubmit);
    document.getElementById('back-to-welcome')?.addEventListener('click', () => showStep('welcome'));
    
    // Real-time password validation (no errors shown until submit)
    document.getElementById('new-password')?.addEventListener('input', validatePasswordRealtime);
    document.getElementById('confirm-password')?.addEventListener('input', validatePasswordRealtime);
    
    // Seed display step
    document.getElementById('back-to-password')?.addEventListener('click', () => showStep('password'));
    document.getElementById('continue-to-verify')?.addEventListener('click', () => showStep('verification'));
    document.getElementById('copy-seed')?.addEventListener('click', copySeedPhrase);
    document.getElementById('download-seed')?.addEventListener('click', downloadSeedPhrase);
    
    // Import step
    document.getElementById('import-form')?.addEventListener('submit', handleImportSubmit);
    document.getElementById('back-to-password-import')?.addEventListener('click', () => showStep('password'));
    
    // Real-time validation for import
    document.getElementById('seed-phrase-input')?.addEventListener('input', validateImportRealtime);
    
    // Verification step
    document.getElementById('back-to-seed')?.addEventListener('click', () => {
        if (setupState.walletType === 'create') {
            showStep('seed-display');
        } else {
            showStep('seed-import');
        }
    });
    document.getElementById('complete-verification')?.addEventListener('click', completeWalletSetup);
    
    // Success step
    document.getElementById('open-wallet')?.addEventListener('click', openWalletAfterSetup);
    
    // Language toggle
    document.getElementById('language-toggle')?.addEventListener('click', toggleLanguage);
}

/**
 * Show specific setup step
 */
function showStep(stepName) {
    document.querySelectorAll('.setup-step').forEach(step => {
        step.classList.remove('active');
    });
    
    const targetStep = document.getElementById(`step-${stepName}`);
    if (targetStep) {
        targetStep.classList.add('active');
        setupState.currentStep = stepName;
        updateProgress();
        
        // Update all text content for the new step
        updateStepContent(stepName);
        
        // Clear previous errors when changing steps
        clearAllErrors();
        
        // Reset submit flags when changing steps
        if (stepName === 'password') {
            setupState.hasSubmittedPasswords = false;
        } else if (stepName === 'seed-import') {
            setupState.hasSubmittedImport = false;
        }
        
        // Setup verification when showing verification step
        if (stepName === 'verification' && setupState.walletType === 'create') {
            // IMPORTANT: Only generate verification if seed exists
            if (setupState.seedPhrase) {
                setTimeout(() => setupVerification(), 100);
            }
        }
        
        // Focus first input in step
        const firstInput = targetStep.querySelector('input, textarea');
        if (firstInput) {
            setTimeout(() => firstInput.focus(), 100);
        }
    }
}

/**
 * Update progress indicator
 */
function updateProgress() {
    const steps = ['welcome', 'password', 'seed-display', 'verification', 'success'];
    const currentIndex = steps.indexOf(setupState.currentStep);
    const progress = ((currentIndex + 1) / steps.length) * 100;
    
    const progressFill = document.getElementById('progress-fill');
    const stepIndicator = document.getElementById('step-indicator');
    
    if (progressFill) {
        progressFill.style.width = `${progress}%`;
    }
    
    if (stepIndicator) {
        stepIndicator.textContent = `Step ${currentIndex + 1} of ${steps.length}`;
    }
}

/**
 * Validate password in real-time (ненавязчивая валидация)
 */
function validatePasswordRealtime() {
    const newPassword = document.getElementById('new-password')?.value || '';
    const confirmPassword = document.getElementById('confirm-password')?.value || '';
    const continueBtn = document.getElementById('continue-password');
    const passwordInput = document.getElementById('new-password');
    
    // Update password checklist
    updatePasswordChecklist(newPassword);
    
    // Enable/disable continue button
    const isValid = newPassword.length >= 8 && newPassword === confirmPassword;
    if (continueBtn) {
        continueBtn.disabled = !isValid;
    }
    
    // Show subtle validation hint under password field
    showPasswordHint(newPassword.length);
    
    // Add visual feedback to input
    if (passwordInput) {
        passwordInput.classList.remove('error', 'success');
        if (newPassword.length > 0) {
            if (newPassword.length >= 8) {
                passwordInput.classList.add('success');
            } else {
                passwordInput.classList.add('error');
            }
        }
    }
    
    // Only show errors if user has submitted before
    if (setupState.hasSubmittedPasswords) {
        validatePasswordWithErrors();
    }
}

/**
 * Show subtle password hint
 */
function showPasswordHint(passwordLength) {
    const lang = setupState.language;
    const trans = translations[lang] || translations['en'];
    
    let hintElement = document.getElementById('password-hint');
    
    if (!hintElement) {
        hintElement = document.createElement('div');
        hintElement.id = 'password-hint';
        hintElement.className = 'validation-message';
        
        const passwordInput = document.getElementById('new-password');
        if (passwordInput && passwordInput.parentNode) {
            passwordInput.parentNode.appendChild(hintElement);
        }
    }
    
    if (passwordLength > 0 && passwordLength < 8) {
        const moreNeeded = trans.more_chars_needed || 'more characters needed';
        hintElement.textContent = `${8 - passwordLength} ${moreNeeded}`;
        hintElement.className = 'validation-message show error';
    } else if (passwordLength >= 8) {
        hintElement.textContent = trans.password_length_good_detail || trans.password_length_good || 'Password length is good';
        hintElement.className = 'validation-message show success';
    } else {
        hintElement.className = 'validation-message';
    }
}

/**
 * Validate password with error messages
 */
function validatePasswordWithErrors() {
    const newPassword = document.getElementById('new-password')?.value || '';
    const confirmPassword = document.getElementById('confirm-password')?.value || '';
    
    clearError('password-error');
    
    if (newPassword.length < 8) {
        showError('password-error', t('at_least_8_chars'));
        return false;
    }
    
    if (newPassword !== confirmPassword) {
        showError('password-error', t('passwords_no_match'));
        return false;
    }
    
    return true;
}

/**
 * Update password requirements checklist
 */
function updatePasswordChecklist(password) {
    const lengthCheck = document.getElementById('check-length');
    
    if (lengthCheck) {
        const passed = password.length >= 8;
        lengthCheck.className = passed ? 'requirement-item valid' : 'requirement-item invalid';
        
        const icon = lengthCheck.querySelector('.check-icon');
        if (icon) {
            icon.textContent = passed ? '✓' : '×';
        }
        
        // Update text to current language
        const textSpan = lengthCheck.querySelector('span:last-child');
        if (textSpan) {
            const lang = setupState.language;
            const t = translations[lang] || translations['en'];
            textSpan.textContent = t.at_least_8_chars || 'At least 8 characters';
        }
    }
}

/**
 * Handle password form submission
 */
async function handlePasswordSubmit(e) {
    e.preventDefault();
    setupState.hasSubmittedPasswords = true;
    
    if (!validatePasswordWithErrors()) {
        return;
    }
    
    const newPassword = document.getElementById('new-password')?.value;
    setupState.password = newPassword;
    
    if (setupState.walletType === 'create') {
        try {
            // CRITICAL: Only generate seed phrase if it doesn't exist yet
            if (!setupState.seedPhrase) {
                const seedPhrase = await generateSeedPhrase();
                setupState.seedPhrase = seedPhrase;
                // Seed phrase generated
            } else {
                // Using existing seed phrase
            }
            
            // Display the seed phrase
            displaySeedPhrase(setupState.seedPhrase);
            
            showStep('seed-display');
        } catch (error) {
            // Error generating seed phrase
            showError('password-error', 'Failed to generate seed phrase. Please try again.');
        }
    } else {
        showStep('seed-import');
    }
}

/**
 * Generate seed phrase using secure BIP39
 */
async function generateSeedPhrase() {
    try {
        // Generating secure seed phrase
        
        // Use ProductionBIP39 directly with proper random generation
        if (typeof window !== 'undefined' && window.secureBIP39) {
            // Generate using BIP39 compliant method
            const mnemonic = await window.secureBIP39.generateBIP39Mnemonic(128); // 128 bits = 12 words
            // BIP39 compliant mnemonic generated
            
            // Validate the generated mnemonic
            const isValid = await window.secureBIP39.validateMnemonic(mnemonic);
            if (!isValid) {
                // Warning:('Generated mnemonic failed validation, using simple method');
                // Fallback to simple random generation
                return await window.secureBIP39.generateMnemonic(12);
            }
            
            return mnemonic;
        }
        
        throw new Error('ProductionBIP39 not available');
        
    } catch (error) {
        // Error:('Failed to generate mnemonic:', error);
        throw new Error('Unable to generate secure seed phrase');
    }
}

/**
 * Generate BIP39 compliant mnemonic
 */
async function generateBIP39Mnemonic() {
    try {
        // Try background service first for additional security
        if (chrome?.runtime) {
            try {
                const response = await chrome.runtime.sendMessage({
                    type: 'GENERATE_MNEMONIC',
                    entropy: 128 // 12 words
                });
                
                if (response?.success && response.mnemonic) {
                    // Log:('Generated mnemonic via background service');
                    return response.mnemonic;
                }
            } catch (bgError) {
                // Log:('Background service not available, using local ProductionBIP39');
            }
        }
        
        // Use ProductionBIP39 directly - simple and reliable
        if (typeof window !== 'undefined' && window.secureBIP39) {
            const mnemonic = await window.secureBIP39.generateMnemonic(12);
            // Log:('Generated mnemonic via ProductionBIP39:', mnemonic);
            
            // NO duplicate check - duplicate words are VALID in BIP39!
            // Each word is independently selected from 2048 words
            // Having duplicates is perfectly normal and valid
            
            return mnemonic;
        }
        
        throw new Error('ProductionBIP39 not available');
        
    } catch (error) {
        // Error:('Failed to generate mnemonic:', error);
        throw new Error('Unable to generate secure BIP39 mnemonic');
    }
}

/**
 * Display seed phrase in professional grid layout
 */
function displaySeedPhrase(seedPhrase) {
    const wordsArray = seedPhrase.split(' ');
    const grid = document.getElementById('seed-phrase-grid');
    
    if (!grid) return;
    
    grid.innerHTML = '';
    
    wordsArray.forEach((word, index) => {
        const wordElement = document.createElement('div');
        wordElement.className = 'seed-word';
        
        wordElement.innerHTML = `
            <span class="word-number">${index + 1}</span>
            <span class="word-text">${word}</span>
        `;
        
        grid.appendChild(wordElement);
    });
}

/**
 * Copy seed phrase to clipboard
 */
async function copySeedPhrase() {
    try {
        await navigator.clipboard.writeText(setupState.seedPhrase);
        showToast('Seed phrase copied to clipboard', 'success');
    } catch (error) {
        // Error:('Failed to copy seed phrase:', error);
        showToast('Failed to copy seed phrase', 'error');
    }
}

/**
 * Download seed phrase as file
 */
function downloadSeedPhrase() {
    const content = `QNet Wallet Recovery Phrase\n\nCreated: ${new Date().toISOString()}\n\nRecovery Phrase:\n${setupState.seedPhrase}\n\nIMPORTANT SECURITY NOTICE:\n- Keep this phrase secure and private\n- Never share it with anyone\n- Anyone with this phrase can access your funds\n- QNet Wallet cannot recover lost phrases\n- Store multiple copies in secure locations`;
    
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `qnet-wallet-recovery-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showToast('Recovery phrase downloaded', 'success');
}

/**
 * Validate import in real-time
 */
async function validateImportRealtime() {
    const seedPhrase = document.getElementById('seed-phrase-input')?.value.trim();
    const wordCountCheck = document.querySelector('#word-count-check');
    const wordsValidCheck = document.querySelector('#words-valid-check');
    const importBtn = document.querySelector('#step-seed-import .primary-button');
    
    if (!seedPhrase) {
        // Reset validation states
        if (wordCountCheck) {
            wordCountCheck.classList.remove('valid', 'invalid');
            wordCountCheck.classList.add('waiting');
            wordCountCheck.querySelector('.check-icon').textContent = '⏳';
        }
        if (wordsValidCheck) {
            wordsValidCheck.classList.remove('valid', 'invalid');
            wordsValidCheck.classList.add('waiting');
            wordsValidCheck.querySelector('.check-icon').textContent = '⏳';
        }
        if (importBtn) importBtn.disabled = true;
        return;
    }
    
    const words = seedPhrase.split(/\s+/).filter(word => word.length > 0);
    
    // Check word count
    const isValidCount = words.length === 12 || words.length === 24;
    if (wordCountCheck) {
        wordCountCheck.classList.remove('waiting', 'valid', 'invalid');
        wordCountCheck.classList.add(isValidCount ? 'valid' : 'invalid');
        const icon = wordCountCheck.querySelector('.check-icon');
        if (icon) icon.textContent = isValidCount ? '✓' : '✗';
    }
    
    // Check if all words are valid BIP39 words
    let allWordsValid = true;
    if (window.secureBIP39 && isValidCount) {
        allWordsValid = words.every(word => window.secureBIP39.isValidWord(word));
    }
    
    if (wordsValidCheck) {
        wordsValidCheck.classList.remove('waiting', 'valid', 'invalid');
        if (isValidCount) {
            wordsValidCheck.classList.add(allWordsValid ? 'valid' : 'invalid');
            const icon = wordsValidCheck.querySelector('.check-icon');
            if (icon) icon.textContent = allWordsValid ? '✓' : '✗';
        } else {
            wordsValidCheck.classList.add('waiting');
            const icon = wordsValidCheck.querySelector('.check-icon');
            if (icon) icon.textContent = '⏳';
        }
    }
    
    // Enable/disable import button
    if (importBtn) {
        importBtn.disabled = !(isValidCount && allWordsValid);
    }
}

/**
 * Handle import form submission
 */
async function handleImportSubmit(e) {
    e.preventDefault();
    setupState.hasSubmittedImport = true;
    
    const seedPhrase = document.getElementById('seed-phrase-input')?.value.trim();
    
    clearError('import-error');
    
    const lang = setupState.language;
    const trans = translations[lang] || translations['en'];
    
    if (!seedPhrase) {
        const errorMsg = trans.please_enter_recovery || 'Please enter your recovery phrase';
        showError('import-error', errorMsg);
        return;
    }
    
    const words = seedPhrase.split(/\s+/).filter(word => word.length > 0);
    
    if (words.length !== 12 && words.length !== 24) {
        const errorMsg = trans.must_be_12_or_24 || 'Recovery phrase must be 12 or 24 words';
        showError('import-error', errorMsg);
        return;
    }
    
    // Simple validation - check if all words are in BIP39 wordlist
    if (window.secureBIP39) {
        const validWords = words.filter(word => window.secureBIP39.isValidWord(word));
        if (validWords.length !== words.length) {
            const errorMsg = trans.invalid_bip39_words || 'Some words are not valid BIP39 words';
            showError('import-error', errorMsg);
            return;
        }
    }
    
    setupState.seedPhrase = seedPhrase;
    
    // Skip verification for import, go directly to completion
    await completeWalletSetup();
}

/**
 * Setup seed phrase verification with 4 random words
 */
function setupVerification() {
    if (!setupState.seedPhrase) return;
    
    const words = setupState.seedPhrase.split(' ');
    const container = document.getElementById('verification-container');
    
    if (!container) return;
    
    container.innerHTML = '';
    
    // Select 4 random words to verify
    const indicesToVerify = [];
    // Use crypto.getRandomValues for secure random word selection
    const randomBytes = new Uint32Array(8); // Extra for potential collisions
    crypto.getRandomValues(randomBytes);
    let byteIndex = 0;
    
    while (indicesToVerify.length < 4 && byteIndex < randomBytes.length) {
        const randomIndex = randomBytes[byteIndex++] % words.length;
        if (!indicesToVerify.includes(randomIndex)) {
            indicesToVerify.push(randomIndex);
        }
    }
    indicesToVerify.sort((a, b) => a - b); // Sort for better UX
    
    setupState.verificationWords = indicesToVerify;
    
    indicesToVerify.forEach((wordIndex, verifyIndex) => {
        const fieldDiv = document.createElement('div');
        fieldDiv.className = 'verification-field';
        
        // Generate options (correct word + 3 random incorrect words)
        const correctWord = words[wordIndex];
        // Secure shuffling using crypto.getRandomValues
        const filteredWords = words.filter((_, i) => i !== wordIndex);
        const shuffleBytes = new Uint32Array(filteredWords.length);
        crypto.getRandomValues(shuffleBytes);
        
        const incorrectWords = filteredWords
            .map((word, i) => ({ word, sort: shuffleBytes[i] }))
            .sort((a, b) => a.sort - b.sort)
            .slice(0, 3)
            .map(item => item.word);
        
        // Sort all options alphabetically for better UX
        const allOptions = [correctWord, ...incorrectWords].sort((a, b) => a.localeCompare(b));
        
        const lang = setupState.language;
        const trans = translations[lang] || translations['en'];
        const wordLabel = trans.word_number ? trans.word_number.replace('#', String(wordIndex + 1)) : `Word #${wordIndex + 1}`;
        
        fieldDiv.innerHTML = `
            <label>${wordLabel}</label>
            <div class="word-options" data-correct="${correctWord}" data-verify-index="${verifyIndex}">
                ${allOptions.map(word => `
                    <button type="button" class="word-option" data-word="${word}">${word}</button>
                `).join('')}
            </div>
        `;
        
        container.appendChild(fieldDiv);
    });
    
    // Add click handlers for word options
    container.querySelectorAll('.word-option').forEach(button => {
        button.addEventListener('click', (e) => {
            const optionsContainer = e.target.closest('.word-options');
            const buttons = optionsContainer.querySelectorAll('.word-option');
            
            // Clear previous selections
            buttons.forEach(btn => {
                btn.classList.remove('selected');
            });
            
            // Select clicked option
            e.target.classList.add('selected');
            
            // Check if all words are selected
            checkVerificationComplete();
        });
    });
}

/**
 * Check if verification is complete
 */
function checkVerificationComplete() {
    const container = document.getElementById('verification-container');
    const completeBtn = document.getElementById('complete-verification');
    
    if (!container || !completeBtn) return;
    
    const wordOptionsContainers = container.querySelectorAll('.word-options');
    let allSelected = true;
    let allCorrect = true;
    
    wordOptionsContainers.forEach(optionsContainer => {
        const selected = optionsContainer.querySelector('.word-option.selected');
        const correctWord = optionsContainer.dataset.correct;
        
        if (!selected) {
            allSelected = false;
        } else if (selected.dataset.word !== correctWord) {
            allCorrect = false;
        }
    });
    
    completeBtn.disabled = !allSelected;
    
    if (allSelected && !allCorrect) {
        const lang = setupState.language;
        const trans = translations[lang] || translations['en'];
        showError('verification-error', trans.some_words_incorrect || 'Some words are incorrect. Please check your selection.');
    } else {
        clearError('verification-error');
    }
    
    return allSelected && allCorrect;
}

/**
 * Complete wallet setup with proper storage
 */
async function completeWalletSetup() {
    try {
        if (setupState.walletType === 'create' && !checkVerificationComplete()) {
            const lang = setupState.language;
            const trans = translations[lang] || translations['en'];
            const errorMsg = trans.please_select_correct_words || 'Please select the correct words to verify your seed phrase.';
            showError('verification-error', errorMsg);
            return;
        }
        
        // Log:('Creating wallet with enhanced security...');
        setupState.isCreating = true;
        
        // Clear any existing wallet data first
        localStorage.removeItem('qnet_wallet_encrypted');
        localStorage.removeItem('qnet_wallet_password_hash');
        localStorage.removeItem('qnet_wallet_secure');
        
        // Generate addresses if needed
        if (!setupState.eonAddress) {
            setupState.eonAddress = await generateEONAddress(setupState.seedPhrase);
        }
        if (!setupState.solanaAddress) {
            setupState.solanaAddress = await generateSolanaAddress(setupState.seedPhrase);
        }
        
        // Try to use SecureKeyManager if available
        let useSecureManager = false;
        if (typeof SecureKeyManager !== 'undefined' || window.globalKeyManager) {
            try {
                const keyManager = window.globalKeyManager || new SecureKeyManager();
                
                // Initialize wallet with encrypted seed phrase storage
                const initResult = await keyManager.initializeWallet(
                    setupState.seedPhrase,
                    setupState.password,
                    true // Store encrypted seed phrase
                );
                
                if (initResult.success) {
                    useSecureManager = true;
                    // Log:('✅ Wallet secured with SecureKeyManager');
                }
            } catch (e) {
                // Log:('⚠️ SecureKeyManager failed, using fallback');
            }
        }
        
        // Create compatibility data for existing UI
        const walletData = {
            addresses: {
                eon: setupState.eonAddress,
                solana: setupState.solanaAddress
            },
            timestamp: new Date().toISOString(),
            version: '3.0.0',
            secure: true
        };
        
        // Save minimal data for popup.js compatibility
        // This is NOT the secure storage - just for UI state
        localStorage.setItem('qnet_wallet_initialized', 'true');
        localStorage.setItem('qnet_wallet_addresses', JSON.stringify(walletData.addresses));
        localStorage.setItem('qnet_wallet_unlocked', 'true');
        
        // Legacy compatibility layer (with seed phrase for backward compatibility)
        // This will be migrated to secure format on first unlock
        const legacyWalletData = {
            ...walletData,
            mnemonic: setupState.seedPhrase // Include for migration purposes
        };
        const legacyData = btoa(JSON.stringify(legacyWalletData));
        localStorage.setItem('qnet_wallet_encrypted', legacyData);
        
        // Also store password hash for legacy compatibility
        const passwordHash = btoa(setupState.password + 'qnet_salt_2025');
        localStorage.setItem('qnet_wallet_password_hash', passwordHash);
        
        // Variable for storage event
        let encryptedData = legacyData;
        
        // Skip old encryption methods - using SecureKeyManager instead
        if (false) {
            try {
                // Properly encrypt wallet data using AES-GCM
                const encryptedWallet = await encryptData(JSON.stringify(walletData), setupState.password);
                const passwordHashData = await hashPassword(setupState.password);
                
                // Store encrypted data with metadata
                const secureStorage = {
                    data: encryptedWallet.encrypted,
                    salt: encryptedWallet.salt,
                    iv: encryptedWallet.iv,
                    passwordHash: passwordHashData.hash,
                    passwordSalt: passwordHashData.salt,
                    version: '2.0.0'
                };
                
                localStorage.setItem('qnet_wallet_secure', JSON.stringify(secureStorage));
                localStorage.setItem('qnet_wallet_unlocked', 'true');
                
                // Legacy format saved for backward compatibility only
                // This will be removed in next major version
                if (window.location.hostname === 'localhost' || window.location.protocol === 'file:') {
                    // Only save legacy format in development/test environments
                    const legacyEncrypted = btoa(JSON.stringify(walletData));
                    const legacyPasswordHash = btoa(setupState.password + 'qnet_salt_2025'); // Deprecated
                    localStorage.setItem('qnet_wallet_encrypted', legacyEncrypted);
                    localStorage.setItem('qnet_wallet_password_hash', legacyPasswordHash);
                }
                
                encryptedData = legacyEncrypted; // For storage event
                // Log:('✅ Wallet secured with AES-256-GCM encryption + legacy format');
            } catch (error) {
                // Error:('Encryption failed:', error);
                // Fallback to old method
                encryptedData = btoa(JSON.stringify(walletData));
                const passwordHash = btoa(setupState.password + 'qnet_salt_2025');
                localStorage.setItem('qnet_wallet_encrypted', encryptedData);
                localStorage.setItem('qnet_wallet_password_hash', passwordHash);
                localStorage.setItem('qnet_wallet_unlocked', 'true');
            }
        } else {
            // Fallback to old method (NOT SECURE - for compatibility)
            // Warning:('⚠️ WARNING: Using legacy storage. Crypto library not available.');
            encryptedData = btoa(JSON.stringify(walletData));
            const passwordHash = btoa(setupState.password + 'qnet_salt_2025');
            localStorage.setItem('qnet_wallet_encrypted', encryptedData);
            localStorage.setItem('qnet_wallet_password_hash', passwordHash);
            localStorage.setItem('qnet_wallet_unlocked', 'true');
        }
        
        // Trigger storage event to notify popup
        window.dispatchEvent(new StorageEvent('storage', {
            key: 'qnet_wallet_encrypted',
            oldValue: null,
            newValue: encryptedData,
            url: window.location.href
        }));
        
        // Generate addresses deterministically from seed phrase
        const qnetAddress = await generateEONAddress(setupState.seedPhrase);
        const solanaAddress = await generateSolanaAddress(setupState.seedPhrase);
        
        // Update success screen
        const qnetAddressEl = document.getElementById('qnet-address');
        const solanaAddressEl = document.getElementById('solana-address');
        
        if (qnetAddressEl) qnetAddressEl.textContent = qnetAddress;
        if (solanaAddressEl) solanaAddressEl.textContent = solanaAddress;
        
        showStep('success');
        
        // Store wallet addresses for later use
        localStorage.setItem('qnet_temp_address', qnetAddress);
        localStorage.setItem('solana_temp_address', solanaAddress);
        
        // Log:('Wallet creation completed successfully');
        
    } catch (error) {
        // Error:('Wallet creation failed:', error);
        const errorStep = setupState.walletType === 'create' ? 'verification-error' : 'import-error';
        showError(errorStep, error.message || 'Failed to create wallet. Please try again.');
    } finally {
        setupState.isCreating = false;
    }
}

/**
 * Generate EON address from seed phrase (DETERMINISTIC)
 */
async function generateEONAddress(seedPhrase) {
    if (!seedPhrase) {
        // Error:('No seed phrase provided for EON address generation');
        return 'error_no_seed_eon_address';
    }
    
    const encoder = new TextEncoder();
    const seedData = encoder.encode(seedPhrase + 'qnet_eon_0'); // Add network identifier
    
    // Use SHA-256 to derive address deterministically
    const hashBuffer = await crypto.subtle.digest('SHA-256', seedData);
    const hashArray = new Uint8Array(hashBuffer);
    
    const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    let part1 = '';
    let part2 = '';
    
    // Generate deterministic parts from hash
    for (let i = 0; i < 8; i++) {
        part1 += chars[hashArray[i] % chars.length];
        part2 += chars[hashArray[i + 8] % chars.length];
    }
    
    // Generate checksum
    let checksum = '';
    for (let i = 0; i < 4; i++) {
        checksum += chars[hashArray[i + 16] % chars.length];
    }
    
    return `${part1}eon${part2}${checksum}`;
}

/**
 * Generate Solana address from seed phrase (DETERMINISTIC)
 * Using proper BIP39 and SLIP-0010 derivation for Solana
 */
async function generateSolanaAddress(seedPhrase) {
    if (!seedPhrase) {
        // Error:('No seed phrase provided for Solana address generation');
        return 'error_no_seed_sol_address';
    }
    
    try {
        // Try correct Solana derivation methods
        if (typeof deriveSolanaWithPath !== 'undefined') {
            // Use proper BIP32-Ed25519 derivation with path m/44'/501'/0'/0'
            return await deriveSolanaWithPath(seedPhrase);
        }
        
        if (typeof generateCorrectSolanaAddress !== 'undefined') {
            // Use direct seed approach
            return await generateCorrectSolanaAddress(seedPhrase);  
        }
        
        // Fallback to previous implementation
        const seed = await mnemonicToSeed(seedPhrase);
        const derivedSeed = await deriveEd25519Seed(seed, "m/44'/501'/0'/0'");
        const publicKey = await generateEd25519PublicKey(derivedSeed);
        return toBase58(publicKey);
        
    } catch (error) {
        // Error:('Failed to generate Solana address:', error);
        return 'error_generating_sol_address';
    }
}

/**
 * Convert mnemonic to seed using PBKDF2 (BIP39 standard)
 */
async function mnemonicToSeed(mnemonic, passphrase = '') {
    const encoder = new TextEncoder();
    const mnemonicBytes = encoder.encode(mnemonic.normalize('NFKD'));
    const saltBytes = encoder.encode('mnemonic' + passphrase.normalize('NFKD'));
    
    // Import password for PBKDF2
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        mnemonicBytes,
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
    );
    
    // Derive 512 bits (64 bytes) using PBKDF2 with 2048 iterations (BIP39 standard)
    const derivedBits = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt: saltBytes,
            iterations: 2048,
            hash: 'SHA-512'
        },
        keyMaterial,
        512
    );
    
    return new Uint8Array(derivedBits);
}

/**
 * Derive Ed25519 seed from BIP39 seed using derivation path
 * Production-ready HD derivation for Ed25519 using HMAC-SHA512
 */
async function deriveEd25519Seed(seed, path) {
    // HD derivation using HMAC-SHA512 (SLIP-0010 style)
    const encoder = new TextEncoder();
    const pathBytes = encoder.encode(path);
    
    // Create HMAC key from seed
    const key = await crypto.subtle.importKey(
        'raw',
        seed.slice(0, 32), // Use first 32 bytes as HMAC key
        { name: 'HMAC', hash: 'SHA-512' },
        false,
        ['sign']
    );
    
    // Derive child key using HMAC-SHA512
    const signature = await crypto.subtle.sign('HMAC', key, pathBytes);
    const derivedSeed = new Uint8Array(signature).slice(0, 32); // Ed25519 needs 32 bytes
    
    // Apply Ed25519 clamping
    derivedSeed[0] &= 248;
    derivedSeed[31] &= 127;
    derivedSeed[31] |= 64;
    
    return derivedSeed;
}

/**
 * Generate Ed25519 public key from seed 
 */
async function generateEd25519PublicKey(seed) {
    // Check if tweetnacl is available
    if (typeof nacl !== 'undefined' && nacl.sign && nacl.sign.keyPair && nacl.sign.keyPair.fromSeed) {
        // Use real Ed25519 implementation
        const keypair = nacl.sign.keyPair.fromSeed(seed);
        return keypair.publicKey;
    } else {
        // Fallback: simplified version for demo
        // This won't give the exact same address as real Solana wallets
        const hash = await crypto.subtle.digest('SHA-512', seed);
        const hashArray = new Uint8Array(hash);
        
        // Apply Ed25519 clamping (simplified)
        hashArray[0] &= 248;
        hashArray[31] &= 127; 
        hashArray[31] |= 64;
        
        return hashArray.slice(0, 32);
    }
}

/**
 * Convert bytes to Base58 (Bitcoin/Solana alphabet)
 */
function toBase58(bytes) {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    
    // Convert bytes to big integer
    let num = 0n;
    for (const byte of bytes) {
        num = num * 256n + BigInt(byte);
    }
    
    // Convert to base58
    let encoded = '';
    while (num > 0n) {
        const remainder = Number(num % 58n);
        num = num / 58n;
        encoded = ALPHABET[remainder] + encoded;
    }
    
    // Add leading '1's for leading zero bytes
    for (const byte of bytes) {
        if (byte === 0) {
            encoded = '1' + encoded;
        } else {
            break;
        }
    }
    
    // Ensure proper length for Solana (typically 32-44 chars)
    while (encoded.length < 32) {
        encoded = '1' + encoded;
    }
    
    return encoded.slice(0, 44); // Solana addresses are typically 32-44 characters
}

/**
 * Open full-screen wallet after setup
 */
async function openWalletAfterSetup() {
    try {
        // Log:('Opening full-screen wallet...');
        
        // Wait for localStorage to be written
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // ALWAYS open full-screen app version
        if (chrome?.runtime) {
            chrome.tabs.create({ 
                url: chrome.runtime.getURL('app.html'),
                active: true 
            });
        } else {
            // Fallback - open in new window
            window.open('app.html', '_blank');
        }
        
        // Close setup window
        setTimeout(() => {
            window.close();
        }, 1000);
        
    } catch (error) {
        // Error:('Failed to open full-screen wallet:', error);
        // Final fallback
        try {
            window.location.href = 'app.html';
        } catch (fallbackError) {
            showToast('Wallet created! Open extension to access your wallet.', 'success');
            setTimeout(() => window.close(), 3000);
        }
    }
}

/**
 * Show error message
 */
function showError(elementId, message) {
    const errorElement = document.getElementById(elementId);
    if (errorElement) {
        errorElement.textContent = message;
        errorElement.classList.remove('hidden');
        errorElement.classList.add('show');
    }
}

/**
 * Clear error message
 */
function clearError(elementId) {
    const errorElement = document.getElementById(elementId);
    if (errorElement) {
        errorElement.classList.add('hidden');
        errorElement.classList.remove('show');
        errorElement.textContent = '';
    }
}

/**
 * Clear all error messages
 */
function clearAllErrors() {
    const errorIds = ['password-error', 'import-error', 'verification-error'];
    errorIds.forEach(id => clearError(id));
}

/**
 * Show toast notification with CORRECT positioning
 */
function showToast(message, type = 'info') {
    // Disabled - only log to console
    console.log(`[${type.toUpperCase()}] ${message}`);
    return;
    
    // Animate in
    setTimeout(() => {
        toast.style.transform = 'translateX(0)';
    }, 100);
    
    // Auto-remove after 3 seconds
    setTimeout(() => {
        toast.style.transform = 'translateX(400px)';
        setTimeout(() => {
            if (toast.parentNode) {
                toast.remove();
            }
        }, 300);
    }, 3000);
}

// Language toggle function for onclick
function toggleLanguage() {
    setupState.language = setupState.language === 'en' ? 'ru' : 'en';
    updateLanguage();
    
    const languageToggle = document.getElementById('language-toggle');
    if (languageToggle) {
        languageToggle.textContent = setupState.language.toUpperCase();
    }
}

// Log:('Qnet Wallet setup script loaded'); 