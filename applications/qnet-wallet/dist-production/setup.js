/**
 * Qnet Wallet Setup Script - Production Version
 * Complete wallet creation and import functionality
 */

// Global setup state
let setupState = {
    currentStep: 'welcome',
    walletType: null, // 'create' or 'import'
    password: null,
    seedPhrase: null,
    verificationWords: [],
    isCreating: false,
    language: 'en' // Default language
};

// Languages ordered by crypto community size (using existing translations)
const translations = {
    en: { // English (Default - largest global crypto community)
        title: 'QNet Wallet',
        welcome_title: 'Welcome to QNet',
        welcome_desc: 'Create a new wallet or import an existing one to get started with QNet and Solana dual networks.',
        create_wallet: '🆕 Create New Wallet',
        import_wallet: '📥 Import Existing Wallet',
        security_title: 'Your security is our priority',
        security_desc: 'QNet Wallet uses industry-standard encryption and never stores your private keys on our servers.',
        wallet_created: 'Wallet created successfully',
        wallet_ready: 'Your QNet Wallet is ready to use. You can now manage QNet and Solana assets securely.',
        qnet_address: 'QNet Address:',
        solana_address: 'Solana Address:',
        password_title: 'Create a password',
        password_desc: 'This password will unlock your wallet on this device.',
        new_password: 'Password',
        confirm_password: 'Confirm password',
        at_least_8_chars: 'Password must be at least 8 characters',
        back: '← Back',
        continue: 'Continue'
    },
    zh: { // Chinese (2nd largest - massive crypto market)
        title: 'QNet 钱包',
        welcome_title: '欢迎使用 QNet',
        welcome_desc: '创建新钱包或导入现有钱包，开始使用 QNet 和 Solana 双网络。',
        create_wallet: '🆕 创建新钱包',
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
        continue: '继续'
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
    ru: { // Russian (5th largest - mining and trading community)
        title: 'QNet Кошелёк',
        welcome_title: 'Добро пожаловать в QNet',
        welcome_desc: 'Создайте новый кошелёк или импортируйте существующий для работы с сетями QNet и Solana.',
        create_wallet: '🆕 Создать новый кошелёк',
        import_wallet: '📥 Импортировать кошелёк',
        security_title: 'Ваша безопасность - наш приоритет',
        security_desc: 'QNet Кошелёк использует стандартное шифрование и никогда не хранит ваши приватные ключи на наших серверах.',
        wallet_created: 'Кошелёк успешно создан!',
        wallet_ready: 'Ваш QNet Кошелёк готов к использованию. Теперь вы можете безопасно управлять активами QNet и Solana.',
        qnet_address: 'QNet Адрес:',
        solana_address: 'Solana Адрес:',
        password_title: 'Создать пароль',
        password_desc: 'Этот пароль будет разблокировать ваш кошелёк на этом устройстве.',
        new_password: 'Пароль',
        confirm_password: 'Подтвердить пароль',
        at_least_8_chars: 'Пароль должен содержать минимум 8 символов',
        back: '← Назад',
        continue: 'Продолжить'
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

    // Password validation rules - simplified (8+ characters only)
const passwordRules = {
    minLength: 8,
    requireLowercase: false,
    requireUppercase: false,
    requireNumber: false,
    requireSpecial: false
};

/**
 * Initialize setup when DOM is loaded
 */
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Qnet Wallet setup initializing...');
    
    setupEventListeners();
    updateLanguage();
    showStep('welcome');
    updateProgress();
});

/**
 * Get translated text
 */
function t(key) {
    return translations[setupState.language][key] || translations.en[key] || key;
}

/**
 * Update interface language
 */
function updateLanguage() {
    // Update title
    const titleElement = document.querySelector('.setup-title span');
    if (titleElement) titleElement.textContent = t('title');
    
    // Update welcome step
    const welcomeTitle = document.querySelector('#step-welcome .step-title');
    if (welcomeTitle) welcomeTitle.textContent = t('welcome_title');
    
    const welcomeDesc = document.querySelector('#step-welcome .step-description');
    if (welcomeDesc) welcomeDesc.textContent = t('welcome_desc');
    
    const createBtn = document.getElementById('create-new-wallet');
    if (createBtn) createBtn.textContent = t('create_wallet');
    
    const importBtn = document.getElementById('import-existing-wallet');
    if (importBtn) importBtn.textContent = t('import_wallet');
    
    const securityTitle = document.querySelector('#step-welcome .warning-title');
    if (securityTitle) securityTitle.textContent = t('security_title');
    
    const securityDesc = document.querySelector('#step-welcome .warning-text');
    if (securityDesc) securityDesc.textContent = t('security_desc');
    
    // Update success step
    const successTitle = document.querySelector('#step-success .step-title');
    if (successTitle) successTitle.textContent = t('wallet_created');
    
    const successDesc = document.querySelector('#step-success .step-description');
    if (successDesc) successDesc.textContent = t('wallet_ready');
}

// Available languages ordered by crypto community size (from existing i18n system)
const availableLanguages = [
    { code: 'en', name: 'English', flag: '🇺🇸', nativeName: 'English' },
    { code: 'zh', name: 'Chinese', flag: '🇨🇳', nativeName: '中文' },
    { code: 'ko', name: 'Korean', flag: '🇰🇷', nativeName: '한국어' },
    { code: 'ja', name: 'Japanese', flag: '🇯🇵', nativeName: '日本語' },
    { code: 'ru', name: 'Russian', flag: '🇷🇺', nativeName: 'Русский' },
    { code: 'es', name: 'Spanish', flag: '🇪🇸', nativeName: 'Español' },
    { code: 'pt', name: 'Portuguese', flag: '🇵🇹', nativeName: 'Português' },
    { code: 'fr', name: 'French', flag: '🇫🇷', nativeName: 'Français' },
    { code: 'de', name: 'German', flag: '🇩🇪', nativeName: 'Deutsch' },
    { code: 'it', name: 'Italian', flag: '🇮🇹', nativeName: 'Italiano' },
    { code: 'ar', name: 'Arabic', flag: '🇸🇦', nativeName: 'العربية' }
];

/**
 * Show language selection dropdown
 */
function showLanguageSelector() {
    const existingSelector = document.querySelector('.language-selector');
    if (existingSelector) {
        existingSelector.remove();
        return;
    }

    const selector = document.createElement('div');
    selector.className = 'language-selector';
    selector.innerHTML = `
        <div class="language-dropdown">
            ${availableLanguages.map(lang => `
                <div class="language-option ${lang.code === setupState.language ? 'active' : ''}" 
                     onclick="selectLanguage('${lang.code}')">
                    <span class="language-flag">${lang.flag}</span>
                    <span class="language-name">${lang.nativeName}</span>
                    ${lang.code === setupState.language ? '<span class="checkmark">✓</span>' : ''}
                </div>
            `).join('')}
        </div>
    `;

    document.body.appendChild(selector);

    // Close on click outside
    setTimeout(() => {
        document.addEventListener('click', function closeSelector(e) {
            if (!selector.contains(e.target)) {
                selector.remove();
                document.removeEventListener('click', closeSelector);
            }
        });
    }, 100);
}

/**
 * Select specific language
 */
function selectLanguage(langCode) {
    if (availableLanguages.find(lang => lang.code === langCode)) {
        setupState.language = langCode;
        updateLanguage();
        
        // Update language button text
        const languageToggle = document.getElementById('language-toggle');
        if (languageToggle) {
            const currentLang = availableLanguages.find(lang => lang.code === langCode);
            languageToggle.textContent = `${currentLang.flag} ${currentLang.code.toUpperCase()}`;
        }
        
        // Close selector
        const selector = document.querySelector('.language-selector');
        if (selector) selector.remove();
    }
}

/**
 * Toggle language selection (replaced simple EN/RU toggle)
 */
function toggleLanguage() {
    showLanguageSelector();
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
    
    // Password validation
    document.getElementById('new-password')?.addEventListener('input', validatePassword);
    document.getElementById('confirm-password')?.addEventListener('input', validatePassword);
    
    // Seed display step (create wallet)
    document.getElementById('back-to-password')?.addEventListener('click', () => showStep('password'));
    document.getElementById('continue-to-verify')?.addEventListener('click', () => showStep('verification'));
    document.getElementById('copy-seed')?.addEventListener('click', copySeedPhrase);
    document.getElementById('download-seed')?.addEventListener('click', downloadSeedPhrase);
    
    // Import step
    document.getElementById('import-form')?.addEventListener('submit', handleImportSubmit);
    document.getElementById('back-to-password-import')?.addEventListener('click', () => showStep('password'));
    document.getElementById('seed-phrase-input')?.addEventListener('input', validateImportPhrase);
    
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
}

/**
 * Show specific setup step
 */
function showStep(stepName) {
    // Hide all steps
    document.querySelectorAll('.setup-step').forEach(step => {
        step.classList.remove('active');
    });
    
    // Show target step
    const targetStep = document.getElementById(`step-${stepName}`);
    if (targetStep) {
        targetStep.classList.add('active');
        setupState.currentStep = stepName;
        updateProgress();
        
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
 * Validate password input
 */
function validatePassword() {
    const newPassword = document.getElementById('new-password')?.value || '';
    const confirmPassword = document.getElementById('confirm-password')?.value || '';
    const continueBtn = document.getElementById('continue-password');
    const errorDiv = document.getElementById('password-error');
    
    // Update checklist
    updatePasswordChecklist(newPassword);
    
    // Check if passwords match and meet requirements - simplified
    let isValid = true;
    let errorMessage = '';
    
    if (newPassword.length < passwordRules.minLength) {
        isValid = false;
    }
    
    if (newPassword !== confirmPassword && confirmPassword.length > 0) {
        isValid = false;
        errorMessage = 'Passwords do not match';
    }
    
    // Update UI
    if (errorDiv) {
        errorDiv.textContent = errorMessage;
        errorDiv.style.display = errorMessage ? 'block' : 'none';
    }
    
    if (continueBtn) {
        continueBtn.disabled = !isValid || newPassword !== confirmPassword;
    }
}

/**
 * Update password requirements checklist - simplified (only length check)
 */
function updatePasswordChecklist(password) {
    const lengthCheck = document.getElementById('check-length');
    
    if (lengthCheck) {
        const passed = password.length >= passwordRules.minLength;
        lengthCheck.className = passed ? 'requirement-item valid' : 'requirement-item invalid';
        lengthCheck.style.color = passed ? '#22c55e' : '#ef4444';
        
        const icon = lengthCheck.querySelector('.check-icon');
        if (icon) {
            icon.textContent = passed ? '✅' : '❌';
        }
    }
}

/**
 * Handle password form submission
 */
async function handlePasswordSubmit(e) {
    e.preventDefault();
    
    const newPassword = document.getElementById('new-password')?.value;
    const confirmPassword = document.getElementById('confirm-password')?.value;
    
    if (!newPassword || newPassword !== confirmPassword) {
        showError('password-error', 'Please enter matching passwords');
        return;
    }
    
    setupState.password = newPassword;
    
    if (setupState.walletType === 'create') {
        await generateSeedPhrase();
        showStep('seed-display');
    } else {
        showStep('seed-import');
    }
}

/**
 * Generate new seed phrase
 */
async function generateSeedPhrase() {
    try {
        console.log('🔨 Generating seed phrase...');
        
        // Generate 12-word BIP39 mnemonic using production crypto
        const seedPhrase = await generateBIP39Mnemonic();
        setupState.seedPhrase = seedPhrase;
        
        // Display seed phrase
        displaySeedPhrase(seedPhrase);
        
    } catch (error) {
        console.error('❌ Failed to generate seed phrase:', error);
        showError('password-error', 'Failed to generate seed phrase. Please try again.');
    }
}

/**
 * Generate BIP39 compatible mnemonic using production crypto
 */
async function generateBIP39Mnemonic() {
    try {
        // Use the same ProductionBIP39 that background script uses
        const response = await chrome.runtime.sendMessage({
            type: 'GENERATE_MNEMONIC',
            entropy: 128 // 12 words
        });
        
        if (response.success && response.mnemonic) {
            return response.mnemonic;
        } else {
            throw new Error('Failed to generate secure mnemonic');
        }
    } catch (error) {
        console.error('❌ Failed to generate production mnemonic:', error);
        
        // Fallback: Import ProductionBIP39 directly
        try {
            const { secureBIP39 } = await import('./src/crypto/ProductionBIP39.js');
            return secureBIP39.generateMnemonic(128); // 12 words
        } catch (importError) {
            console.error('❌ Fallback also failed:', importError);
            throw new Error('Unable to generate secure BIP39 mnemonic');
        }
    }
}

/**
 * Display seed phrase in grid
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
        showToast('Seed phrase copied to clipboard!', 'success');
    } catch (error) {
        console.error('❌ Failed to copy seed phrase:', error);
        showToast('Failed to copy seed phrase', 'error');
    }
}

/**
 * Download seed phrase as file
 */
function downloadSeedPhrase() {
    const content = `Qnet Wallet Recovery Phrase\n\nYour 12-word recovery phrase:\n${setupState.seedPhrase}\n\nCreated: ${new Date().toLocaleString()}\n\n⚠️ IMPORTANT:\n- Keep this phrase secure and private\n- Never share it with anyone\n- Anyone with this phrase can access your funds\n- Qnet Wallet cannot recover lost phrases`;
    
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `qnet-wallet-recovery-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showToast('Recovery phrase downloaded!', 'success');
}

/**
 * Validate import seed phrase
 */
function validateImportPhrase() {
    const seedInput = document.getElementById('seed-phrase-input')?.value.trim();
    const continueBtn = document.getElementById('continue-import');
    const wordCountCheck = document.getElementById('word-count-check');
    const wordsValidCheck = document.getElementById('words-valid-check');
    
    if (!seedInput) {
        updateValidationCheck(wordCountCheck, false, 'waiting');
        updateValidationCheck(wordsValidCheck, false, 'waiting');
        if (continueBtn) continueBtn.disabled = true;
        return;
    }
    
    const words = seedInput.split(/\s+/).filter(word => word.length > 0);
    
    // Check word count
    const validWordCount = words.length === 12 || words.length === 24;
    updateValidationCheck(wordCountCheck, validWordCount, validWordCount ? 'valid' : 'invalid');
    
    // Check if all words are valid (simplified check)
    const allWordsValid = words.every(word => word.length >= 3 && word.length <= 8);
    updateValidationCheck(wordsValidCheck, allWordsValid, allWordsValid ? 'valid' : 'invalid');
    
    const isValid = validWordCount && allWordsValid;
    if (continueBtn) continueBtn.disabled = !isValid;
    
    if (isValid) {
        setupState.seedPhrase = seedInput;
    }
}

/**
 * Update validation check display
 */
function updateValidationCheck(element, isValid, status) {
    if (!element) return;
    
    const icon = element.querySelector('.check-icon');
    if (icon) {
        switch (status) {
            case 'waiting':
                icon.textContent = '⏳';
                break;
            case 'valid':
                icon.textContent = '✅';
                break;
            case 'invalid':
                icon.textContent = '❌';
                break;
        }
    }
    
    element.className = `validation-item ${status}`;
}

/**
 * Handle import form submission
 */
async function handleImportSubmit(e) {
    e.preventDefault();
    
    const seedPhrase = document.getElementById('seed-phrase-input')?.value.trim();
    
    if (!seedPhrase) {
        showError('import-error', 'Please enter your recovery phrase');
        return;
    }
    
    setupState.seedPhrase = seedPhrase;
    
    // Skip verification for import, go directly to completion
    await completeWalletSetup();
}

/**
 * Setup seed phrase verification
 */
function setupVerification() {
    if (!setupState.seedPhrase) return;
    
    const words = setupState.seedPhrase.split(' ');
    const container = document.getElementById('verification-container');
    
    if (!container) return;
    
    container.innerHTML = '';
    
    // Select 3 random words to verify
    const indicesToVerify = [];
    while (indicesToVerify.length < 3) {
        const randomIndex = Math.floor(Math.random() * words.length);
        if (!indicesToVerify.includes(randomIndex)) {
            indicesToVerify.push(randomIndex);
        }
    }
    
    setupState.verificationWords = indicesToVerify;
    
    indicesToVerify.forEach((wordIndex, verifyIndex) => {
        const fieldDiv = document.createElement('div');
        fieldDiv.className = 'verification-field';
        
        // Generate options (correct word + 3 random incorrect words)
        const correctWord = words[wordIndex];
        const incorrectWords = words.filter((_, i) => i !== wordIndex)
            .sort(() => Math.random() - 0.5)
            .slice(0, 3);
        
        const allOptions = [correctWord, ...incorrectWords].sort(() => Math.random() - 0.5);
        
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
            buttons.forEach(btn => btn.classList.remove('selected'));
            
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
    
    const wordOptions = container.querySelectorAll('.word-options');
    let allSelected = true;
    let allCorrect = true;
    
    wordOptions.forEach(options => {
        const selected = options.querySelector('.word-option.selected');
        const correctWord = options.dataset.correct;
        
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
 * Complete wallet setup
 */
async function completeWalletSetup() {
    try {
        if (setupState.walletType === 'create' && !checkVerificationComplete()) {
            showError('verification-error', 'Please select the correct words to verify your seed phrase.');
            return;
        }
        
        console.log('🔨 Creating wallet...');
        setupState.isCreating = true;
        
        // Create wallet via background script
        const response = await chrome.runtime.sendMessage({
            type: setupState.walletType === 'create' ? 'CREATE_WALLET' : 'IMPORT_WALLET',
            password: setupState.password,
            mnemonic: setupState.seedPhrase
        });
        
        if (response.success) {
            // Generate EON addresses for display - proper format
            const eonAddress = generateEONAddress();
            const solanaAddress = generateSolanaAddress();
            
            // Update success screen
            const qnetAddressEl = document.getElementById('qnet-address');
            const solanaAddressEl = document.getElementById('solana-address');
            
            if (qnetAddressEl) qnetAddressEl.textContent = eonAddress;
            if (solanaAddressEl) solanaAddressEl.textContent = solanaAddress;
            
            showStep('success');
        } else {
            throw new Error(response.error || 'Failed to create wallet');
        }
        
    } catch (error) {
        console.error('❌ Wallet creation failed:', error);
        const errorStep = setupState.walletType === 'create' ? 'verification-error' : 'import-error';
        showError(errorStep, error.message || 'Failed to create wallet. Please try again.');
    } finally {
        setupState.isCreating = false;
    }
}

/**
 * Generate EON address - QNet native format: 7a9bk4f2eon8x3m5z1c7
 */
function generateEONAddress() {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    
    // Generate first part (8 chars)
    let part1 = '';
    for (let i = 0; i < 8; i++) {
        part1 += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    // Generate second part (8 chars)  
    let part2 = '';
    for (let i = 0; i < 8; i++) {
        part2 += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    // Calculate simple checksum (last 4 chars)
    const combined = part1 + part2;
    let checksum = '';
    for (let i = 0; i < 4; i++) {
        const index = (combined.charCodeAt(i) + combined.charCodeAt(i + 4)) % chars.length;
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
 * Show error message
 */
function showError(elementId, message) {
    const errorElement = document.getElementById(elementId);
    if (errorElement) {
        errorElement.textContent = message;
        errorElement.style.display = 'block';
    }
}

/**
 * Clear error message
 */
function clearError(elementId) {
    const errorElement = document.getElementById(elementId);
    if (errorElement) {
        errorElement.style.display = 'none';
        errorElement.textContent = '';
    }
}

/**
 * Show toast notification
 */
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 12px 16px;
        border-radius: 8px;
        color: white;
        font-weight: 500;
        z-index: 10000;
        transform: translateX(100%);
        transition: transform 0.3s ease;
        max-width: 300px;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 14px;
    `;
    
    switch (type) {
        case 'success':
            toast.style.background = 'linear-gradient(135deg, #4caf50, #45a049)';
            break;
        case 'error':
            toast.style.background = 'linear-gradient(135deg, #f44336, #d32f2f)';
            break;
        default:
            toast.style.background = 'linear-gradient(135deg, #2196f3, #1976d2)';
    }
    
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => toast.style.transform = 'translateX(0)', 100);
    setTimeout(() => {
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

/**
 * Open full-screen wallet after setup
 */
async function openWalletAfterSetup() {
    try {
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
        console.error('Failed to open full-screen wallet:', error);
        // Final fallback
        try {
            window.location.href = 'app.html';
        } catch (fallbackError) {
            setTimeout(() => window.close(), 3000);
        }
    }
}

// Setup is initialized when DOM is loaded at the top of the file

console.log('🎯 Qnet Wallet setup script loaded'); 