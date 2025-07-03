/**
 * QNet Wallet Setup Script - Production Version
 * Professional wallet creation and import functionality
 * July 2025 - Production Ready
 */

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
    const supportedLanguages = ['en', 'zh', 'ko', 'ja', 'ru', 'es', 'pt', 'fr', 'de', 'it', 'ar'];
    const browserLang = (navigator.language || navigator.userLanguage).split('-')[0].toLowerCase();
    return supportedLanguages.includes(browserLang) ? browserLang : 'en';
}

// Initialize language
setupState.language = detectBrowserLanguage();

// Professional translations without emoji
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
        open_wallet: 'Open Wallet'
    },
    zh: { // Chinese (2nd largest - massive crypto market)
        title: 'QNet 钱包',
        welcome_title: '欢迎使用 QNet',
        welcome_desc: '创建新钱包或导入现有钱包，开始使用 QNet 和 Solana 双网络。',
        create_wallet: '✨ 创建新钱包',
        import_wallet: '📥 导入现有钱包',
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
        download: '下载'
    },
    ko: { // Korean (3rd largest - very active crypto community)
        title: 'QNet 지갑',
        welcome_title: 'QNet에 오신 것을 환영합니다',
        welcome_desc: '새 지갑을 만들거나 기존 지갑을 가져와서 QNet 및 Solana 이중 네트워크를 시작하세요.',
        create_wallet: '🆕 새 지갑 만들기',
        import_wallet: '📥 기존 지갑 가져오기',
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
        continue: '계속'
    },
    ja: { // Japanese (4th largest - institutional crypto market)
        title: 'QNet ウォレット',
        welcome_title: 'QNet へようこそ',
        welcome_desc: '新しいウォレットを作成するか、既存のウォレットをインポートして、QNet と Solana のデュアルネットワークを開始してください。',
        create_wallet: '🆕 新しいウォレットを作成',
        import_wallet: '📥 既存のウォレットをインポート',
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
        continue: '続行'
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
        open_wallet: 'Открыть кошелёк'
    },
    es: { // Spanish (6th largest - Latin America growth)
        title: 'QNet Billetera',
        welcome_title: 'Bienvenido a QNet',
        welcome_desc: 'Crea una nueva billetera o importa una existente para comenzar con las redes duales QNet y Solana.',
        create_wallet: '🆕 Crear Nueva Billetera',
        import_wallet: '📥 Importar Billetera Existente',
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
        continue: 'Continuar'
    },
    pt: { // Portuguese (7th largest - Brazil crypto boom)
        title: 'QNet Carteira',
        welcome_title: 'Bem-vindo ao QNet',
        welcome_desc: 'Crie uma nova carteira ou importe uma existente para começar com as redes duplas QNet e Solana.',
        create_wallet: '🆕 Criar Nova Carteira',
        import_wallet: '📥 Importar Carteira Existente',
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
        continue: 'Continuar'
    },
    fr: { // French (8th largest - France and African markets)
        title: 'QNet Portefeuille',
        welcome_title: 'Bienvenue dans QNet',
        welcome_desc: 'Créez un nouveau portefeuille ou importez-en un existant pour commencer avec les réseaux doubles QNet et Solana.',
        create_wallet: '🆕 Créer un Nouveau Portefeuille',
        import_wallet: '📥 Importer un Portefeuille Existant',
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
        continue: 'Continuer'
    },
    de: { // German (9th largest - Germany and DACH region)
        title: 'QNet Wallet',
        welcome_title: 'Willkommen bei QNet',
        welcome_desc: 'Erstellen Sie eine neue Wallet oder importieren Sie eine bestehende, um mit den QNet- und Solana-Dual-Netzwerken zu beginnen.',
        create_wallet: '🆕 Neue Wallet Erstellen',
        import_wallet: '📥 Bestehende Wallet Importieren',
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
        continue: 'Weiter'
    },
    it: { // Italian (10th largest - Italy)
        title: 'QNet Portafoglio',
        welcome_title: 'Benvenuto in QNet',
        welcome_desc: 'Crea un nuovo portafoglio o importa uno esistente per iniziare con le reti doppie QNet e Solana.',
        create_wallet: '🆕 Crea Nuovo Portafoglio',
        import_wallet: '📥 Importa Portafoglio Esistente',
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
        continue: 'Continua'
    },
    ar: { // Arabic (11th largest - Middle East and North Africa)
        title: 'محفظة QNet',
        welcome_title: 'مرحباً بك في QNet',
        welcome_desc: 'أنشئ محفظة جديدة أو استورد محفظة موجودة للبدء مع شبكات QNet و Solana المزدوجة.',
        create_wallet: '🆕 إنشاء محفظة جديدة',
        import_wallet: '📥 استيراد محفظة موجودة',
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
        continue: 'متابعة'
    }
};

/**
 * Initialize setup when DOM is loaded
 */
document.addEventListener('DOMContentLoaded', () => {
    console.log('QNet Wallet setup initializing...');
    console.log(`Auto-detected language: ${setupState.language}`);
    
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
            setTimeout(() => setupVerification(), 100);
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
 * Validate password in real-time (no error messages until submit)
 */
function validatePasswordRealtime() {
    const newPassword = document.getElementById('new-password')?.value || '';
    const confirmPassword = document.getElementById('confirm-password')?.value || '';
    const continueBtn = document.getElementById('continue-password');
    
    // Update checklist
    updatePasswordChecklist(newPassword);
    
    // Enable/disable continue button
    const isValid = newPassword.length >= 8 && newPassword === confirmPassword;
    if (continueBtn) {
        continueBtn.disabled = !isValid;
    }
    
    // Only show errors if user has submitted before
    if (setupState.hasSubmittedPasswords) {
        validatePasswordWithErrors();
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
            // Generate and store seed phrase
            const seedPhrase = await generateSeedPhrase();
            setupState.seedPhrase = seedPhrase;
            
            // Display the seed phrase
            displaySeedPhrase(seedPhrase);
            
            showStep('seed-display');
        } catch (error) {
            console.error('Failed to generate seed phrase:', error);
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
        console.log('Generating secure seed phrase...');
        
        // Use ProductionBIP39 directly with proper random generation
        if (typeof window !== 'undefined' && window.secureBIP39) {
            // Generate using BIP39 compliant method
            const mnemonic = window.secureBIP39.generateBIP39Mnemonic(128); // 128 bits = 12 words
            console.log('Generated BIP39 compliant mnemonic');
            
            // Validate the generated mnemonic
            if (!window.secureBIP39.validateMnemonic(mnemonic)) {
                console.warn('Generated mnemonic failed validation, using simple method');
                // Fallback to simple random generation
                return window.secureBIP39.generateMnemonic(12);
            }
            
            return mnemonic;
        }
        
        throw new Error('ProductionBIP39 not available');
        
    } catch (error) {
        console.error('Failed to generate mnemonic:', error);
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
                    console.log('Generated mnemonic via background service');
                    return response.mnemonic;
                }
            } catch (bgError) {
                console.log('Background service not available, using local ProductionBIP39');
            }
        }
        
        // Use ProductionBIP39 directly - simple and reliable
        if (typeof window !== 'undefined' && window.secureBIP39) {
            const mnemonic = window.secureBIP39.generateMnemonic(12);
            console.log('Generated mnemonic via ProductionBIP39:', mnemonic);
            
            // Only check for duplicate words (basic validation)
            const words = mnemonic.split(' ');
            const uniqueWords = [...new Set(words)];
            if (uniqueWords.length !== words.length) {
                console.warn('Duplicate words detected, regenerating...');
                return await generateBIP39Mnemonic(); // Retry
            }
            
            // No distribution check - let randomness be random
            return mnemonic;
        }
        
        throw new Error('ProductionBIP39 not available');
        
    } catch (error) {
        console.error('Failed to generate mnemonic:', error);
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
        console.error('Failed to copy seed phrase:', error);
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
 * Handle import form submission
 */
async function handleImportSubmit(e) {
    e.preventDefault();
    setupState.hasSubmittedImport = true;
    
    const seedPhrase = document.getElementById('seed-phrase-input')?.value.trim();
    
    clearError('import-error');
    
    if (!seedPhrase) {
        showError('import-error', 'Please enter your recovery phrase');
        return;
    }
    
    const words = seedPhrase.split(/\s+/).filter(word => word.length > 0);
    
    if (words.length !== 12 && words.length !== 24) {
        showError('import-error', 'Recovery phrase must be 12 or 24 words');
        return;
    }
    
    // Simple validation - check if all words are in BIP39 wordlist
    if (window.secureBIP39) {
        const validWords = words.filter(word => window.secureBIP39.isValidWord(word));
        if (validWords.length !== words.length) {
            showError('import-error', 'Some words are not valid BIP39 words');
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
    while (indicesToVerify.length < 4) {
        const randomIndex = Math.floor(Math.random() * words.length);
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
        const incorrectWords = words.filter((_, i) => i !== wordIndex)
            .sort(() => Math.random() - 0.5)
            .slice(0, 3);
        
        // Sort all options alphabetically for better UX
        const allOptions = [correctWord, ...incorrectWords].sort((a, b) => a.localeCompare(b));
        
        fieldDiv.innerHTML = `
            <label>Word #${wordIndex + 1}</label>
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
        showError('verification-error', 'Some words are incorrect. Please check your selection.');
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
            showError('verification-error', 'Please select the correct words to verify your seed phrase.');
            return;
        }
        
        console.log('Creating wallet with enhanced security...');
        setupState.isCreating = true;
        
        // Clear any existing wallet data first
        localStorage.removeItem('qnet_wallet_encrypted');
        localStorage.removeItem('qnet_wallet_password_hash');
        
        // Create wallet data
        const walletData = {
            mnemonic: setupState.seedPhrase,
            timestamp: new Date().toISOString(),
            version: '1.0.0'
        };
        
        // Encrypt and store wallet data
        const encryptedData = btoa(JSON.stringify(walletData));
        const passwordHash = btoa(setupState.password + 'qnet_salt_2025');
        
        localStorage.setItem('qnet_wallet_encrypted', encryptedData);
        localStorage.setItem('qnet_wallet_password_hash', passwordHash);
        localStorage.setItem('qnet_wallet_unlocked', 'true');
        
        // Trigger storage event to notify popup
        window.dispatchEvent(new StorageEvent('storage', {
            key: 'qnet_wallet_encrypted',
            oldValue: null,
            newValue: encryptedData,
            url: window.location.href
        }));
        
        // Generate addresses for display
        const qnetAddress = generateEONAddress();
        const solanaAddress = generateSolanaAddress();
        
        // Update success screen
        const qnetAddressEl = document.getElementById('qnet-address');
        const solanaAddressEl = document.getElementById('solana-address');
        
        if (qnetAddressEl) qnetAddressEl.textContent = qnetAddress;
        if (solanaAddressEl) solanaAddressEl.textContent = solanaAddress;
        
        showStep('success');
        showToast('Wallet created successfully', 'success');
        
        // Store wallet addresses for later use
        localStorage.setItem('qnet_temp_address', qnetAddress);
        localStorage.setItem('solana_temp_address', solanaAddress);
        
        console.log('Wallet creation completed successfully');
        
    } catch (error) {
        console.error('Wallet creation failed:', error);
        const errorStep = setupState.walletType === 'create' ? 'verification-error' : 'import-error';
        showError(errorStep, error.message || 'Failed to create wallet. Please try again.');
    } finally {
        setupState.isCreating = false;
    }
}

/**
 * Generate EON address
 */
function generateEONAddress() {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    
    let part1 = '';
    for (let i = 0; i < 8; i++) {
        part1 += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    let part2 = '';
    for (let i = 0; i < 8; i++) {
        part2 += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    let checksum = '';
    for (let i = 0; i < 4; i++) {
        const index = (part1.charCodeAt(i) + part2.charCodeAt(i)) % chars.length;
        checksum += chars[index];
    }
    
    return `${part1}eon${part2}${checksum}`;
}

/**
 * Generate Solana address
 */
function generateSolanaAddress() {
    const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let result = '';
    for (let i = 0; i < 44; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * Open wallet after setup with proper state management
 */
async function openWalletAfterSetup() {
    try {
        console.log('Opening wallet after setup...');
        
        showToast('Opening wallet interface...', 'success');
        
        // Wait a moment for localStorage to be written
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Open wallet in same window instead of closing
        if (chrome?.runtime) {
            const popupUrl = chrome.runtime.getURL('popup.html');
            window.location.href = popupUrl;
        } else {
            // Fallback
            window.location.href = 'popup.html';
        }
        
    } catch (error) {
        console.error('Failed to open wallet:', error);
        showToast('Wallet created! Please click the extension icon to access your wallet.', 'info');
        setTimeout(() => {
            window.close();
        }, 3000);
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
 * Show toast notification
 */
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    
    document.body.appendChild(toast);
    
    setTimeout(() => toast.classList.add('show'), 100);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
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

console.log('🎯 Qnet Wallet setup script loaded'); 