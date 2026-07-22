import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ScrollView,
  Image,
  Platform,
  RefreshControl,
  TouchableWithoutFeedback,
  DeviceEventEmitter,
  Linking,
  AppState,
  Modal,
  Animated,
  Easing,
  Share,
  FlatList,
  KeyboardAvoidingView,
  BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Clipboard from '@react-native-clipboard/clipboard';
import WalletManager from '../components/WalletManager';
import QRCode from 'react-native-qrcode-svg';
import {
  checkNodeStatus,
  selfAttestIfNeeded,
  checkServerNodeStatus,
  getAllNodesByWallet,
  getPendingRewards,
  refreshFcmTokenOnServer,
  isTokenRefreshNeeded,
  teardownLightNode,
} from '../services/PushService';
import { getRandomGenesisNode } from '../config/nodes';

// 1DEV Burn Tracker Contract (same as browser extension)
const BURN_CONTRACT_PROGRAM_ID = 'CCZSessk1TbWie6Ye2JX2cNEWHTEWxCwe5sLz8JaFriw';

// Translations - All supported languages
const translations = {
  en: {
    // General
    qnet_wallet: 'QNet Wallet',
    unlock_wallet: 'Unlock your wallet',
    create_wallet: 'Create Wallet',
    import_wallet: 'Import Existing Wallet',
    enter_password: 'Enter password',
    password: 'Password',
    confirm_password: 'Confirm password',
    
    // Tabs
    assets: 'Assets',
    send: 'Send',
    receive: 'Receive',
    activate: 'Activate',
    node: 'Node',
    settings: 'Settings',
    
    // Settings sections
    general: 'General',
    security_options: 'Security Options',
    network: 'Network',
    danger_zone: 'Danger Zone',
    
    // Settings items
    auto_lock_timer: 'Auto-Lock Timer',
    auto_lock_subtitle: 'Lock wallet after inactivity',
    language: 'Language',
    language_subtitle: 'Wallet interface language',
    change_password: 'Change Password',
    export_recovery_phrase: 'Export Recovery Phrase',
    export_activation_code: 'Export Activation Code',
    current_network: 'Current Network',
    logout: 'Logout',
    delete_wallet: 'Delete Wallet',
    
    // Modals
    enter_current_password: 'Current password',
    enter_new_password: 'New password (min 8 characters)',
    confirm_new_password: 'Confirm new password',
    cancel: 'Cancel',
    change: 'Change',
    changing: 'Changing...',
    
    // Warnings
    recovery_phrase_warning: 'Your recovery phrase allows full access to your wallet. Never share it with anyone!',
    activation_code_warning: 'Your activation codes prove node ownership. Keep them secure!',
    enter_password_to_reveal: 'Enter password to reveal',
    enter_password_to_generate: 'Enter password to generate',
    show: 'Show',
    verifying: 'Verifying...',
    
    // Time options
    minute: 'minute',
    minutes: 'minutes',
    never: 'Never',
    select_inactivity_time: 'Select inactivity time before wallet locks',
    
    // Alerts
    error: 'Error',
    success: 'Success',
    incorrect_password: 'Incorrect password',
    wallet_locked: 'Wallet locked. Try again in',
    biometric_unlock: 'Unlock with Biometrics',
    enable_biometric: 'Biometric Unlock',
    biometric_enabled_msg: 'Biometric unlock enabled',
    biometric_disabled_msg: 'Biometric unlock disabled',
    biometric_unavailable: 'Biometric authentication not available on this device',
    password_changed: 'Password changed successfully!',
    wallet_deleted: 'Wallet deleted successfully',
    session_expired: 'Session Expired',
    wallet_locked: 'Wallet locked due to inactivity',
    
    // Confirmations
    logout_confirm: 'Are you sure you want to logout?',
    delete_wallet_confirm: 'Are you sure you want to delete this wallet? Make sure you have backed up your recovery phrase!',
    i_saved_it: 'I Saved It',
    
    // Terms of Service
    terms_of_service: 'Terms of Service',
    accept_terms: 'I accept the Terms of Service and Privacy Policy',
    read_terms: 'Read Terms of Service',
    terms_title: 'Terms of Service & Privacy Policy',
    terms_text: `QNET WALLET TERMS OF SERVICE AND USER AGREEMENT

By using this software, you acknowledge and agree to the following terms:

1. NO WARRANTY
This software is provided "as is" without warranty of any kind, express or implied. The developers make no representations or warranties regarding the software's functionality, security, or fitness for any particular purpose.

2. ASSUMPTION OF RISK
You acknowledge that:
• Cryptocurrency transactions are irreversible
• Private keys and seed phrases are your sole responsibility
• Loss of your seed phrase means permanent loss of access to your funds
• Software bugs, hacks, or technical failures may result in loss of funds
• The value of cryptocurrencies is highly volatile and may decrease to zero

3. NO LIABILITY
The developers, contributors, and affiliated parties shall not be liable for any direct, indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of funds, loss of data, or loss of profits.

4. YOUR RESPONSIBILITIES
You are solely responsible for:
• Securing your seed phrase and private keys
• Ensuring the legality of cryptocurrency use in your jurisdiction
• Paying any applicable taxes on cryptocurrency transactions
• Verifying transaction details before signing
• Maintaining the security of your device

5. PROHIBITED USE
You agree not to use this wallet for:
• Any illegal activities
• Money laundering or terrorist financing
• Violating any applicable laws or regulations
• Attempting to hack or disrupt the software

6. INDEMNIFICATION
You agree to indemnify and hold harmless the developers from any claims, damages, losses, or expenses arising from your use of this software.

7. CHANGES TO TERMS
These terms may be updated at any time without prior notice. Continued use of the software constitutes acceptance of the updated terms.

8. GOVERNING LAW
These terms shall be governed by the laws of the jurisdiction in which you reside.

By clicking "Accept", you confirm that you have read, understood, and agree to be bound by these terms.`,
    accept: 'Accept',
    decline: 'Decline',
  },
  'zh-CN': {
    qnet_wallet: 'QNet 钱包',
    unlock_wallet: '解锁您的钱包',
    create_wallet: '创建钱包',
    import_wallet: '导入现有钱包',
    enter_password: '输入密码',
    password: '密码',
    confirm_password: '确认密码',
    assets: '资产',
    send: '发送',
    receive: '接收',
    activate: '激活',
    node: '节点',
    settings: '设置',
    general: '常规',
    security_options: '安全选项',
    network: '网络',
    danger_zone: '危险区',
    auto_lock_timer: '自动锁定计时器',
    auto_lock_subtitle: '不活动后锁定钱包',
    language: '语言',
    language_subtitle: '钱包界面语言',
    change_password: '更改密码',
    export_recovery_phrase: '导出恢复短语',
    export_activation_code: '导出激活码',
    current_network: '当前网络',
    logout: '登出',
    delete_wallet: '删除钱包',
    enter_current_password: '当前密码',
    enter_new_password: '新密码（至少8个字符）',
    confirm_new_password: '确认新密码',
    cancel: '取消',
    change: '更改',
    changing: '更改中...',
    recovery_phrase_warning: '您的恢复短语允许完全访问您的钱包。永远不要与任何人分享！',
    activation_code_warning: '您的激活码证明节点所有权。请妥善保管！',
    enter_password_to_reveal: '输入密码以显示',
    enter_password_to_generate: '输入密码以生成',
    show: '显示',
    verifying: '验证中...',
    minute: '分钟',
    minutes: '分钟',
    never: '从不',
    select_inactivity_time: '选择钱包锁定前的不活动时间',
    error: '错误',
    success: '成功',
    incorrect_password: '密码不正确',
    wallet_locked: '钱包已锁定。请在后重试',
    biometric_unlock: '生物识别解锁',
    enable_biometric: '生物识别解锁',
    biometric_enabled_msg: '生物识别解锁已启用',
    biometric_disabled_msg: '生物识别解锁已禁用',
    biometric_unavailable: '此设备不支持生物识别认证',
    password_changed: '密码更改成功！',
    wallet_deleted: '钱包删除成功',
    session_expired: '会话已过期',
    wallet_locked: '由于不活动，钱包已锁定',
    logout_confirm: '您确定要登出吗？',
    delete_wallet_confirm: '您确定要删除此钱包吗？请确保您已备份恢复短语！',
    i_saved_it: '我已保存',
  },
  ru: {
    qnet_wallet: 'QNet Кошелёк',
    unlock_wallet: 'Разблокируйте кошелёк',
    create_wallet: 'Создать кошелёк',
    import_wallet: 'Импортировать существующий',
    enter_password: 'Введите пароль',
    password: 'Пароль',
    confirm_password: 'Подтвердите пароль',
    assets: 'Активы',
    send: 'Отправить',
    receive: 'Получить',
    activate: 'Активация',
    node: 'Нода',
    settings: 'Настройки',
    general: 'Общие',
    security_options: 'Параметры безопасности',
    network: 'Сеть',
    danger_zone: 'Опасная зона',
    auto_lock_timer: 'Таймер авто-блокировки',
    auto_lock_subtitle: 'Блокировать кошелёк после бездействия',
    language: 'Язык',
    language_subtitle: 'Язык интерфейса кошелька',
    change_password: 'Сменить пароль',
    export_recovery_phrase: 'Экспорт фразы восстановления',
    export_activation_code: 'Экспорт кода активации',
    current_network: 'Текущая сеть',
    logout: 'Выйти',
    delete_wallet: 'Удалить кошелёк',
    enter_current_password: 'Текущий пароль',
    enter_new_password: 'Новый пароль (мин 8 символов)',
    confirm_new_password: 'Подтвердите новый пароль',
    cancel: 'Отмена',
    change: 'Изменить',
    changing: 'Изменение...',
    recovery_phrase_warning: 'Ваша фраза восстановления предоставляет полный доступ к кошельку. Никогда не делитесь ею!',
    activation_code_warning: 'Ваши коды активации подтверждают владение нодой. Храните их в безопасности!',
    enter_password_to_reveal: 'Введите пароль для показа',
    enter_password_to_generate: 'Введите пароль для генерации',
    show: 'Показать',
    verifying: 'Проверка...',
    minute: 'минута',
    minutes: 'минут',
    never: 'Никогда',
    select_inactivity_time: 'Выберите время бездействия до блокировки кошелька',
    error: 'Ошибка',
    success: 'Успешно',
    incorrect_password: 'Неверный пароль',
    wallet_locked: 'Кошелёк заблокирован. Повторите через',
    biometric_unlock: 'Разблокировать биометрией',
    enable_biometric: 'Биометрическая разблокировка',
    biometric_enabled_msg: 'Биометрическая разблокировка включена',
    biometric_disabled_msg: 'Биометрическая разблокировка отключена',
    biometric_unavailable: 'Биометрическая аутентификация недоступна на этом устройстве',
    password_changed: 'Пароль успешно изменён!',
    wallet_deleted: 'Кошелёк успешно удалён',
    session_expired: 'Сессия истекла',
    wallet_locked: 'Кошелёк заблокирован из-за бездействия',
    logout_confirm: 'Вы уверены, что хотите выйти?',
    delete_wallet_confirm: 'Вы уверены, что хотите удалить этот кошелёк? Убедитесь, что вы сохранили фразу восстановления!',
    i_saved_it: 'Я сохранил',
  },
  es: {
    qnet_wallet: 'Cartera QNet',
    unlock_wallet: 'Desbloquear cartera',
    create_wallet: 'Crear Cartera',
    import_wallet: 'Importar Cartera Existente',
    enter_password: 'Ingresar contraseña',
    password: 'Contraseña',
    confirm_password: 'Confirmar contraseña',
    assets: 'Activos',
    send: 'Enviar',
    receive: 'Recibir',
    activate: 'Activar',
    node: 'Nodo',
    settings: 'Configuración',
    general: 'General',
    security_options: 'Opciones de Seguridad',
    network: 'Red',
    danger_zone: 'Zona de Peligro',
    auto_lock_timer: 'Temporizador de Bloqueo Automático',
    auto_lock_subtitle: 'Bloquear cartera después de inactividad',
    language: 'Idioma',
    language_subtitle: 'Idioma de la interfaz',
    change_password: 'Cambiar Contraseña',
    export_recovery_phrase: 'Exportar Frase de Recuperación',
    export_activation_code: 'Exportar Código de Activación',
    current_network: 'Red Actual',
    logout: 'Cerrar Sesión',
    delete_wallet: 'Eliminar Cartera',
    enter_current_password: 'Contraseña actual',
    enter_new_password: 'Nueva contraseña (mín 8 caracteres)',
    confirm_new_password: 'Confirmar nueva contraseña',
    cancel: 'Cancelar',
    change: 'Cambiar',
    changing: 'Cambiando...',
    recovery_phrase_warning: '¡Tu frase de recuperación permite acceso completo a tu cartera. Nunca la compartas!',
    activation_code_warning: '¡Tus códigos de activación prueban la propiedad del nodo. Manténlos seguros!',
    enter_password_to_reveal: 'Ingresar contraseña para revelar',
    enter_password_to_generate: 'Ingresar contraseña para generar',
    show: 'Mostrar',
    verifying: 'Verificando...',
    minute: 'minuto',
    minutes: 'minutos',
    never: 'Nunca',
    select_inactivity_time: 'Seleccionar tiempo de inactividad antes del bloqueo',
    error: 'Error',
    success: 'Éxito',
    incorrect_password: 'Contraseña incorrecta',
    wallet_locked: 'Billetera bloqueada. Inténtelo de nuevo en',
    biometric_unlock: 'Desbloquear con Biometría',
    enable_biometric: 'Desbloqueo Biométrico',
    biometric_enabled_msg: 'Desbloqueo biométrico activado',
    biometric_disabled_msg: 'Desbloqueo biométrico desactivado',
    biometric_unavailable: 'La autenticación biométrica no está disponible en este dispositivo',
    password_changed: '¡Contraseña cambiada con éxito!',
    wallet_deleted: 'Cartera eliminada con éxito',
    session_expired: 'Sesión Expirada',
    wallet_locked: 'Cartera bloqueada por inactividad',
    logout_confirm: '¿Estás seguro de que quieres cerrar sesión?',
    delete_wallet_confirm: '¿Estás seguro de que quieres eliminar esta cartera? ¡Asegúrate de haber respaldado tu frase de recuperación!',
    i_saved_it: 'Lo Guardé',
  },
  ko: {
    qnet_wallet: 'QNet 지갑',
    unlock_wallet: '지갑 잠금 해제',
    create_wallet: '지갑 생성',
    import_wallet: '기존 지갑 가져오기',
    enter_password: '비밀번호 입력',
    password: '비밀번호',
    confirm_password: '비밀번호 확인',
    assets: '자산',
    send: '보내기',
    receive: '받기',
    activate: '활성화',
    node: '노드',
    settings: '설정',
    general: '일반',
    security_options: '보안 옵션',
    network: '네트워크',
    danger_zone: '위험 구역',
    auto_lock_timer: '자동 잠금 타이머',
    auto_lock_subtitle: '비활성 후 지갑 잠금',
    language: '언어',
    language_subtitle: '지갑 인터페이스 언어',
    change_password: '비밀번호 변경',
    export_recovery_phrase: '복구 문구 내보내기',
    export_activation_code: '활성화 코드 내보내기',
    current_network: '현재 네트워크',
    logout: '로그아웃',
    delete_wallet: '지갑 삭제',
    enter_current_password: '현재 비밀번호',
    enter_new_password: '새 비밀번호 (최소 8자)',
    confirm_new_password: '새 비밀번호 확인',
    cancel: '취소',
    change: '변경',
    changing: '변경 중...',
    recovery_phrase_warning: '복구 문구는 지갑에 대한 전체 액세스를 허용합니다. 절대 누구와도 공유하지 마세요!',
    activation_code_warning: '활성화 코드는 노드 소유권을 증명합니다. 안전하게 보관하세요!',
    enter_password_to_reveal: '표시하려면 비밀번호 입력',
    enter_password_to_generate: '생성하려면 비밀번호 입력',
    show: '표시',
    verifying: '확인 중...',
    minute: '분',
    minutes: '분',
    never: '안 함',
    select_inactivity_time: '지갑 잠금 전 비활성 시간 선택',
    error: '오류',
    success: '성공',
    incorrect_password: '잘못된 비밀번호',
    wallet_locked: '지갑이 잠겼습니다. 다시 시도하세요',
    biometric_unlock: '생체 인식으로 잠금 해제',
    enable_biometric: '생체 인식 잠금 해제',
    biometric_enabled_msg: '생체 인식 잠금 해제가 활성화되었습니다',
    biometric_disabled_msg: '생체 인식 잠금 해제가 비활성화되었습니다',
    biometric_unavailable: '이 기기에서는 생체 인식 인증을 사용할 수 없습니다',
    password_changed: '비밀번호가 성공적으로 변경되었습니다!',
    wallet_deleted: '지갑이 성공적으로 삭제되었습니다',
    session_expired: '세션 만료',
    wallet_locked: '비활성으로 인해 지갑이 잠겼습니다',
    logout_confirm: '로그아웃하시겠습니까?',
    delete_wallet_confirm: '이 지갑을 삭제하시겠습니까? 복구 문구를 백업했는지 확인하세요!',
    i_saved_it: '저장했습니다',
  },
  ja: {
    qnet_wallet: 'QNet ウォレット',
    unlock_wallet: 'ウォレットのロックを解除',
    create_wallet: 'ウォレットを作成',
    import_wallet: '既存のウォレットをインポート',
    enter_password: 'パスワードを入力',
    password: 'パスワード',
    confirm_password: 'パスワードを確認',
    assets: '資産',
    send: '送信',
    receive: '受信',
    activate: 'アクティベート',
    node: 'ノード',
    settings: '設定',
    general: '一般',
    security_options: 'セキュリティオプション',
    network: 'ネットワーク',
    danger_zone: '危険ゾーン',
    auto_lock_timer: '自動ロックタイマー',
    auto_lock_subtitle: '非アクティブ後にウォレットをロック',
    language: '言語',
    language_subtitle: 'ウォレットインターフェース言語',
    change_password: 'パスワードを変更',
    export_recovery_phrase: 'リカバリーフレーズをエクスポート',
    export_activation_code: 'アクティベーションコードをエクスポート',
    current_network: '現在のネットワーク',
    logout: 'ログアウト',
    delete_wallet: 'ウォレットを削除',
    enter_current_password: '現在のパスワード',
    enter_new_password: '新しいパスワード（最小8文字）',
    confirm_new_password: '新しいパスワードを確認',
    cancel: 'キャンセル',
    change: '変更',
    changing: '変更中...',
    recovery_phrase_warning: 'リカバリーフレーズはウォレットへの完全なアクセスを許可します。絶対に誰とも共有しないでください！',
    activation_code_warning: 'アクティベーションコードはノードの所有権を証明します。安全に保管してください！',
    enter_password_to_reveal: '表示するにはパスワードを入力',
    enter_password_to_generate: '生成するにはパスワードを入力',
    show: '表示',
    verifying: '確認中...',
    minute: '分',
    minutes: '分',
    never: 'なし',
    select_inactivity_time: 'ウォレットがロックされるまでの非アクティブ時間を選択',
    error: 'エラー',
    success: '成功',
    incorrect_password: 'パスワードが正しくありません',
    wallet_locked: 'ウォレットがロックされています。後でもう一度お試しください',
    biometric_unlock: '生体認証でロック解除',
    enable_biometric: '生体認証ロック解除',
    biometric_enabled_msg: '生体認証ロック解除が有効になりました',
    biometric_disabled_msg: '生体認証ロック解除が無効になりました',
    biometric_unavailable: 'このデバイスでは生体認証を利用できません',
    password_changed: 'パスワードが正常に変更されました！',
    wallet_deleted: 'ウォレットが正常に削除されました',
    session_expired: 'セッション期限切れ',
    wallet_locked: '非アクティブによりウォレットがロックされました',
    logout_confirm: 'ログアウトしてもよろしいですか？',
    delete_wallet_confirm: 'このウォレットを削除してもよろしいですか？リカバリーフレーズをバックアップしたことを確認してください！',
    i_saved_it: '保存しました',
  },
  pt: {
    qnet_wallet: 'Carteira QNet',
    unlock_wallet: 'Desbloquear carteira',
    create_wallet: 'Criar Carteira',
    import_wallet: 'Importar Carteira Existente',
    enter_password: 'Digite a senha',
    password: 'Senha',
    confirm_password: 'Confirmar senha',
    assets: 'Ativos',
    send: 'Enviar',
    receive: 'Receber',
    activate: 'Ativar',
    node: 'Nó',
    settings: 'Configurações',
    general: 'Geral',
    security_options: 'Opções de Segurança',
    network: 'Rede',
    danger_zone: 'Zona de Perigo',
    auto_lock_timer: 'Temporizador de Bloqueio Automático',
    auto_lock_subtitle: 'Bloquear carteira após inatividade',
    language: 'Idioma',
    language_subtitle: 'Idioma da interface',
    change_password: 'Alterar Senha',
    export_recovery_phrase: 'Exportar Frase de Recuperação',
    export_activation_code: 'Exportar Código de Ativação',
    current_network: 'Rede Atual',
    logout: 'Sair',
    delete_wallet: 'Excluir Carteira',
    enter_current_password: 'Senha atual',
    enter_new_password: 'Nova senha (mín 8 caracteres)',
    confirm_new_password: 'Confirmar nova senha',
    cancel: 'Cancelar',
    change: 'Alterar',
    changing: 'Alterando...',
    recovery_phrase_warning: 'Sua frase de recuperação permite acesso total à sua carteira. Nunca a compartilhe!',
    activation_code_warning: 'Seus códigos de ativação provam a propriedade do nó. Mantenha-os seguros!',
    enter_password_to_reveal: 'Digite a senha para revelar',
    enter_password_to_generate: 'Digite a senha para gerar',
    show: 'Mostrar',
    verifying: 'Verificando...',
    minute: 'minuto',
    minutes: 'minutos',
    never: 'Nunca',
    select_inactivity_time: 'Selecione o tempo de inatividade antes do bloqueio',
    error: 'Erro',
    success: 'Sucesso',
    incorrect_password: 'Senha incorreta',
    wallet_locked: 'Carteira bloqueada. Tente novamente em',
    biometric_unlock: 'Desbloquear com Biometria',
    enable_biometric: 'Desbloqueio Biométrico',
    biometric_enabled_msg: 'Desbloqueio biométrico ativado',
    biometric_disabled_msg: 'Desbloqueio biométrico desativado',
    biometric_unavailable: 'Autenticação biométrica não disponível neste dispositivo',
    password_changed: 'Senha alterada com sucesso!',
    wallet_deleted: 'Carteira excluída com sucesso',
    session_expired: 'Sessão Expirada',
    logout_confirm: 'Tem certeza de que deseja sair?',
    delete_wallet_confirm: 'Tem certeza de que deseja excluir esta carteira? Certifique-se de ter feito backup da frase de recuperação!',
    i_saved_it: 'Eu Salvei',
  },
  fr: {
    qnet_wallet: 'Portefeuille QNet',
    unlock_wallet: 'Déverrouiller le portefeuille',
    create_wallet: 'Créer un Portefeuille',
    import_wallet: 'Importer un Portefeuille Existant',
    enter_password: 'Entrer le mot de passe',
    password: 'Mot de passe',
    confirm_password: 'Confirmer le mot de passe',
    assets: 'Actifs',
    send: 'Envoyer',
    receive: 'Recevoir',
    activate: 'Activer',
    node: 'Nœud',
    settings: 'Paramètres',
    general: 'Général',
    security_options: 'Options de Sécurité',
    network: 'Réseau',
    danger_zone: 'Zone Dangereuse',
    auto_lock_timer: 'Minuteur de Verrouillage Automatique',
    auto_lock_subtitle: 'Verrouiller le portefeuille après inactivité',
    language: 'Langue',
    language_subtitle: 'Langue de l\'interface',
    change_password: 'Changer le Mot de Passe',
    export_recovery_phrase: 'Exporter la Phrase de Récupération',
    export_activation_code: 'Exporter le Code d\'Activation',
    current_network: 'Réseau Actuel',
    logout: 'Déconnexion',
    delete_wallet: 'Supprimer le Portefeuille',
    enter_current_password: 'Mot de passe actuel',
    enter_new_password: 'Nouveau mot de passe (min 8 caractères)',
    confirm_new_password: 'Confirmer le nouveau mot de passe',
    cancel: 'Annuler',
    change: 'Changer',
    changing: 'Changement...',
    recovery_phrase_warning: 'Votre phrase de récupération permet un accès complet à votre portefeuille. Ne la partagez jamais!',
    activation_code_warning: 'Vos codes d\'activation prouvent la propriété du nœud. Gardez-les en sécurité!',
    enter_password_to_reveal: 'Entrer le mot de passe pour révéler',
    enter_password_to_generate: 'Entrer le mot de passe pour générer',
    show: 'Afficher',
    verifying: 'Vérification...',
    minute: 'minute',
    minutes: 'minutes',
    never: 'Jamais',
    select_inactivity_time: 'Sélectionner le temps d\'inactivité avant verrouillage',
    error: 'Erreur',
    success: 'Succès',
    incorrect_password: 'Mot de passe incorrect',
    wallet_locked: 'Portefeuille verrouillé. Réessayez dans',
    biometric_unlock: 'Déverrouiller par Biométrie',
    enable_biometric: 'Déverrouillage Biométrique',
    biometric_enabled_msg: 'Déverrouillage biométrique activé',
    biometric_disabled_msg: 'Déverrouillage biométrique désactivé',
    biometric_unavailable: 'L\'authentification biométrique n\'est pas disponible sur cet appareil',
    password_changed: 'Mot de passe changé avec succès!',
    wallet_deleted: 'Portefeuille supprimé avec succès',
    session_expired: 'Session Expirée',
    logout_confirm: 'Êtes-vous sûr de vouloir vous déconnecter?',
    delete_wallet_confirm: 'Êtes-vous sûr de vouloir supprimer ce portefeuille? Assurez-vous d\'avoir sauvegardé votre phrase de récupération!',
    i_saved_it: 'Je l\'ai Sauvegardé',
  },
  de: {
    qnet_wallet: 'QNet Wallet',
    unlock_wallet: 'Wallet entsperren',
    create_wallet: 'Wallet Erstellen',
    import_wallet: 'Vorhandenes Wallet Importieren',
    enter_password: 'Passwort eingeben',
    password: 'Passwort',
    confirm_password: 'Passwort bestätigen',
    assets: 'Vermögenswerte',
    send: 'Senden',
    receive: 'Empfangen',
    activate: 'Aktivieren',
    node: 'Knoten',
    settings: 'Einstellungen',
    general: 'Allgemein',
    security_options: 'Sicherheitsoptionen',
    network: 'Netzwerk',
    danger_zone: 'Gefahrenzone',
    auto_lock_timer: 'Automatischer Sperr-Timer',
    auto_lock_subtitle: 'Wallet nach Inaktivität sperren',
    language: 'Sprache',
    language_subtitle: 'Wallet-Schnittstellensprache',
    change_password: 'Passwort Ändern',
    export_recovery_phrase: 'Wiederherstellungsphrase Exportieren',
    export_activation_code: 'Aktivierungscode Exportieren',
    current_network: 'Aktuelles Netzwerk',
    logout: 'Abmelden',
    delete_wallet: 'Wallet Löschen',
    enter_current_password: 'Aktuelles Passwort',
    enter_new_password: 'Neues Passwort (mind. 8 Zeichen)',
    confirm_new_password: 'Neues Passwort bestätigen',
    cancel: 'Abbrechen',
    change: 'Ändern',
    changing: 'Wird geändert...',
    recovery_phrase_warning: 'Ihre Wiederherstellungsphrase ermöglicht vollen Zugriff auf Ihr Wallet. Teilen Sie sie niemals!',
    activation_code_warning: 'Ihre Aktivierungscodes beweisen den Knotenbesitz. Bewahren Sie sie sicher auf!',
    enter_password_to_reveal: 'Passwort eingeben zum Anzeigen',
    enter_password_to_generate: 'Passwort eingeben zum Generieren',
    show: 'Anzeigen',
    verifying: 'Überprüfung...',
    minute: 'Minute',
    minutes: 'Minuten',
    never: 'Nie',
    select_inactivity_time: 'Inaktivitätszeit vor Sperrung auswählen',
    error: 'Fehler',
    success: 'Erfolg',
    incorrect_password: 'Falsches Passwort',
    wallet_locked: 'Wallet gesperrt. Erneut versuchen in',
    biometric_unlock: 'Mit Biometrie entsperren',
    enable_biometric: 'Biometrisches Entsperren',
    biometric_enabled_msg: 'Biometrisches Entsperren aktiviert',
    biometric_disabled_msg: 'Biometrisches Entsperren deaktiviert',
    biometric_unavailable: 'Biometrische Authentifizierung auf diesem Gerät nicht verfügbar',
    password_changed: 'Passwort erfolgreich geändert!',
    wallet_deleted: 'Wallet erfolgreich gelöscht',
    session_expired: 'Sitzung Abgelaufen',
    logout_confirm: 'Sind Sie sicher, dass Sie sich abmelden möchten?',
    delete_wallet_confirm: 'Sind Sie sicher, dass Sie dieses Wallet löschen möchten? Stellen Sie sicher, dass Sie Ihre Wiederherstellungsphrase gesichert haben!',
    i_saved_it: 'Ich Habe Es Gespeichert',
  },
  ar: {
    qnet_wallet: 'محفظة QNet',
    unlock_wallet: 'فتح المحفظة',
    create_wallet: 'إنشاء محفظة',
    import_wallet: 'استيراد محفظة موجودة',
    enter_password: 'أدخل كلمة المرور',
    password: 'كلمة المرور',
    confirm_password: 'تأكيد كلمة المرور',
    assets: 'الأصول',
    send: 'إرسال',
    receive: 'استقبال',
    activate: 'تفعيل',
    node: 'عقدة',
    settings: 'الإعدادات',
    general: 'عام',
    security_options: 'خيارات الأمان',
    network: 'الشبكة',
    danger_zone: 'منطقة الخطر',
    auto_lock_timer: 'مؤقت القفل التلقائي',
    auto_lock_subtitle: 'قفل المحفظة بعد عدم النشاط',
    language: 'اللغة',
    language_subtitle: 'لغة واجهة المحفظة',
    change_password: 'تغيير كلمة المرور',
    export_recovery_phrase: 'تصدير عبارة الاسترداد',
    export_activation_code: 'تصدير رمز التفعيل',
    current_network: 'الشبكة الحالية',
    logout: 'تسجيل الخروج',
    delete_wallet: 'حذف المحفظة',
    enter_current_password: 'كلمة المرور الحالية',
    enter_new_password: 'كلمة المرور الجديدة (8 أحرف على الأقل)',
    confirm_new_password: 'تأكيد كلمة المرور الجديدة',
    cancel: 'إلغاء',
    change: 'تغيير',
    changing: 'جاري التغيير...',
    recovery_phrase_warning: 'عبارة الاسترداد الخاصة بك تسمح بالوصول الكامل إلى محفظتك. لا تشاركها أبدًا!',
    activation_code_warning: 'رموز التفعيل تثبت ملكية العقدة. احتفظ بها آمنة!',
    enter_password_to_reveal: 'أدخل كلمة المرور للكشف',
    enter_password_to_generate: 'أدخل كلمة المرور للإنشاء',
    show: 'عرض',
    verifying: 'جاري التحقق...',
    minute: 'دقيقة',
    minutes: 'دقائق',
    never: 'أبداً',
    select_inactivity_time: 'حدد وقت عدم النشاط قبل القفل',
    error: 'خطأ',
    success: 'نجح',
    incorrect_password: 'كلمة مرور غير صحيحة',
    wallet_locked: 'المحفظة مقفلة. حاول مرة أخرى خلال',
    biometric_unlock: 'فتح بالبيومترية',
    enable_biometric: 'فتح البيومتري',
    biometric_enabled_msg: 'تم تفعيل الفتح البيومتري',
    biometric_disabled_msg: 'تم تعطيل الفتح البيومتري',
    biometric_unavailable: 'المصادقة البيومترية غير متاحة على هذا الجهاز',
    password_changed: 'تم تغيير كلمة المرور بنجاح!',
    wallet_deleted: 'تم حذف المحفظة بنجاح',
    session_expired: 'انتهت الجلسة',
    logout_confirm: 'هل أنت متأكد أنك تريد تسجيل الخروج؟',
    delete_wallet_confirm: 'هل أنت متأكد أنك تريد حذف هذه المحفظة؟ تأكد من نسخ عبارة الاسترداد احتياطيًا!',
    i_saved_it: 'لقد حفظتها',
  },
  it: {
    qnet_wallet: 'Portafoglio QNet',
    unlock_wallet: 'Sblocca portafoglio',
    create_wallet: 'Crea Portafoglio',
    import_wallet: 'Importa Portafoglio Esistente',
    enter_password: 'Inserisci password',
    password: 'Password',
    confirm_password: 'Conferma password',
    assets: 'Risorse',
    send: 'Invia',
    receive: 'Ricevi',
    activate: 'Attiva',
    node: 'Nodo',
    settings: 'Impostazioni',
    general: 'Generale',
    security_options: 'Opzioni di Sicurezza',
    network: 'Rete',
    danger_zone: 'Zona Pericolosa',
    auto_lock_timer: 'Timer Blocco Automatico',
    auto_lock_subtitle: 'Blocca portafoglio dopo inattività',
    language: 'Lingua',
    language_subtitle: 'Lingua dell\'interfaccia',
    change_password: 'Cambia Password',
    export_recovery_phrase: 'Esporta Frase di Recupero',
    export_activation_code: 'Esporta Codice di Attivazione',
    current_network: 'Rete Corrente',
    logout: 'Disconnetti',
    delete_wallet: 'Elimina Portafoglio',
    enter_current_password: 'Password corrente',
    enter_new_password: 'Nuova password (min 8 caratteri)',
    confirm_new_password: 'Conferma nuova password',
    cancel: 'Annulla',
    change: 'Cambia',
    changing: 'Modifica in corso...',
    recovery_phrase_warning: 'La tua frase di recupero consente l\'accesso completo al tuo portafoglio. Non condividerla mai!',
    activation_code_warning: 'I tuoi codici di attivazione dimostrano la proprietà del nodo. Tienili al sicuro!',
    enter_password_to_reveal: 'Inserisci password per rivelare',
    enter_password_to_generate: 'Inserisci password per generare',
    show: 'Mostra',
    verifying: 'Verifica...',
    minute: 'minuto',
    minutes: 'minuti',
    never: 'Mai',
    select_inactivity_time: 'Seleziona tempo di inattività prima del blocco',
    error: 'Errore',
    success: 'Successo',
    incorrect_password: 'Password errata',
    wallet_locked: 'Portafoglio bloccato. Riprova tra',
    biometric_unlock: 'Sblocca con Biometria',
    enable_biometric: 'Sblocco Biometrico',
    biometric_enabled_msg: 'Sblocco biometrico abilitato',
    biometric_disabled_msg: 'Sblocco biometrico disabilitato',
    biometric_unavailable: 'Autenticazione biometrica non disponibile su questo dispositivo',
    password_changed: 'Password cambiata con successo!',
    wallet_deleted: 'Portafoglio eliminato con successo',
    session_expired: 'Sessione Scaduta',
    logout_confirm: 'Sei sicuro di voler disconnetterti?',
    delete_wallet_confirm: 'Sei sicuro di voler eliminare questo portafoglio? Assicurati di aver eseguito il backup della frase di recupero!',
    i_saved_it: 'L\'ho Salvata',
  }
};

// Module-level block height cache — shared across all renders, max 1 fetch per 60s.
// Prevents hammering the node API: no matter how many components re-render,
// only one actual network request goes out per minute.
const _blockHeightCache = { height: 0, fetchedAt: 0, inFlight: false };
let _tokenIconCache = null; // built once on first getTokenIconUrl call (multi-KB base64 set)

// Per-tab render isolation. Wraps a tab's JSX in a memo boundary keyed on the reactive values that
// tab actually reads (`deps`). The `render` thunk is recreated every parent render, but the custom
// comparator ignores it and re-renders ONLY when a dep changes — so an unrelated setState (balance /
// block-height / WS tick) no longer reconciles the active tab's subtree. `deps` must list every
// reactive value the tab reads (same contract as a useMemo dep array); a missing dep shows stale data
// but never crashes (the thunk still closes over live refs). A `key` per tab guarantees clean remount
// on tab switch, so no cross-tab output can leak.
const TabBox = React.memo(
  function TabBox({ render }) { return render(); },
  (prev, next) =>
    prev.deps.length === next.deps.length &&
    prev.deps.every((v, i) => Object.is(v, next.deps[i]))
);

// Format a u64 base-unit token amount by its decimals using string math (exact past 2^53 — a
// 0-decimal high-supply token can reach ~1.8e19, well beyond a JS float's safe integer range).
function fmtTokenBaseUnits(base, decimals) {
  const s = String(base == null ? '0' : base).replace(/[^0-9]/g, '') || '0';
  const d = Number(decimals) || 0;
  // Thousands-group an all-digit string directly (never via Number()) so no low-order digit is lost.
  const group = (digits) => digits.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (d <= 0) return group(s);
  const padded = s.padStart(d + 1, '0');
  const intPart = padded.slice(0, padded.length - d);
  const frac = padded.slice(padded.length - d).replace(/0+$/, '');
  const intFmt = group(intPart);
  return frac ? `${intFmt}.${frac}` : intFmt;
}

// 16px coin/token mark next to a history row's amount. Native QNC → the cyan "Q" brand; a QRC-20
// transfer → an emoji logo or a deterministic coloured-letter avatar (colour from the contract
// address) — the same icon model as the Assets list. Privacy: a node-supplied https logo is NEVER
// loaded as <Image> from the wallet (it would leak the device IP/timing to an attacker-controlled
// host); only inert emoji logos render as-is, everything else falls back to the letter avatar.
// Compact pill toggle: track hugs the knob (28px pill, 22px knob) — same on both platforms.
// Smoothly-animated pill switch: the knob glides (translateX) and the track color eases between
// states instead of snapping. Track 46×28, 3px padding, 22px knob ⇒ travel = 46 − 2·3 − 22 = 18px.
// useNativeDriver:false because the track backgroundColor is interpolated (color isn't native-driven).
const PillToggle = React.memo(function PillToggle({ value, onValueChange }) {
  const anim = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: value ? 1 : 0,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [value, anim]);
  const trackColor = anim.interpolate({ inputRange: [0, 1], outputRange: ['#33475b', '#00d4ff'] });
  const knobX = anim.interpolate({ inputRange: [0, 1], outputRange: [0, 18] });
  return (
    <TouchableOpacity activeOpacity={0.8} onPress={() => onValueChange(!value)}>
      <Animated.View style={{ width: 46, height: 28, borderRadius: 14, padding: 3, justifyContent: 'center',
                              backgroundColor: trackColor }}>
        <Animated.View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#ffffff',
                                transform: [{ translateX: knobX }] }} />
      </Animated.View>
    </TouchableOpacity>
  );
});

function TxCoinMark({ token }) {
  if (!token) {
    // Native QNC → the app's own brand icon.
    return (
      <Image source={require('../../assets/qnet_logo.png')}
        style={{ width: 16, height: 16, borderRadius: 8, marginRight: 5 }} resizeMode="contain" />
    );
  }
  const logo = typeof token.logo === 'string' ? token.logo.trim() : '';
  const isEmoji = logo.length > 0 && logo.length <= 8 && !logo.startsWith('http');
  let h = 0;
  const seed = String(token.contract || token.symbol || '?');
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const bg = isEmoji ? '#0b1a22' : `hsl(${h % 360}, 60%, 42%)`;
  return (
    <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', marginRight: 5 }}>
      <Text style={{ color: '#fff', fontSize: 9, fontWeight: '700' }}>
        {isEmoji ? logo : String(token.symbol || 'T').slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

// Memoized transaction-history row — skips re-render on unrelated parent setState (balance/height ticks).
// Canonical burn address (matches core CANONICAL_BURN_ADDR) — a transfer here is a 🔥 burn.
const CANONICAL_BURN_ADDR = '0000000000000000000eon00000000000000036877022';

const TxRow = React.memo(function TxRow({ tx, onCopy, hideAmounts }) {
  const isSend = tx.type === 'send';
  // Burn: a success-gated token burn event (kind), or a native/token transfer to the burn address.
  const isBurn = tx.tokenKind === 'burn' || (typeof tx.to === 'string' && tx.to === CANONICAL_BURN_ADDR);
  const counter = isSend ? tx.to : tx.from;
  const isToken = !!tx.tokenContract;
  const isNft = tx.tokenStd === 'qrc721';
  const amountLabel = isToken
    ? (isNft
        ? `${isSend ? '-' : '+'}${tx.tokenSymbol ? `${tx.tokenSymbol} ` : ''}#${tx.tokenId || '?'}`
        : `${isSend ? '-' : '+'}${tx.tokenAmountDisplay || '0'}${tx.tokenSymbol ? ` ${tx.tokenSymbol}` : ''}`)
    : `${tx.amount === 0 ? '0' : `${isSend ? '-' : '+'}${tx.amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: Math.abs(tx.amount) >= 1 ? 4 : 8 })}`} QNC`;
  const dateLabel = tx.status === 'pending'
    ? '⏳ Pending...'
    : (!tx.timestamp || tx.timestamp === 0 || tx.timestamp < 1000000)
      ? 'Genesis'
      : (() => {
          const d = new Date(tx.timestamp);
          const p = (n) => String(n).padStart(2, '0');
          return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        })();
  return (
    <TouchableOpacity
      style={{ backgroundColor: '#16213e', borderRadius: 12, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: tx.status === 'pending' ? '#ffaa00' : '#1a1a2e' }}
      onPress={() => onCopy(tx.hash)}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: isSend ? '#ff444420' : '#00ff8820', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
            <Text style={{ color: isSend ? '#ff4444' : '#00ff88', fontSize: 18 }}>{isBurn ? '🔥' : (isSend ? '↑' : '↓')}</Text>
          </View>
          <View>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>{isBurn ? '🔥 Burn' : (isSend ? 'Sent' : 'Received')}</Text>
            <Text style={{ color: '#666', fontSize: 12 }}>{dateLabel}</Text>
          </View>
        </View>
        <View style={{ alignItems: 'flex-end', flexShrink: 1, marginLeft: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {/* QNC brand mark for native rows; the token's own icon for a QRC-20 transfer. */}
            <TxCoinMark token={isToken ? { contract: tx.tokenContract, symbol: tx.tokenSymbol, logo: tx.tokenLogo } : null} />
            <Text style={{ color: isSend ? '#ff4444' : '#00ff88', fontSize: 16, fontWeight: '600' }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
              {hideAmounts ? '••••' : amountLabel}
            </Text>
            {/* Trust badge: a ✓ marks a token transfer proven against a committee-QC-anchored logs_root
                (verifyTokenTransferInclusion → 'verified') AND whose decimals/symbol are from the wallet's
                own added-token registry — so ✓ never backs a node-scaled magnitude for an un-added token. */}
            {!hideAmounts && isToken && tx.verified === true && tx.tokenMetaTrusted && (
              <Text style={{ color: '#00e5f0', fontSize: 12, fontWeight: '800', marginLeft: 4 }} accessibilityLabel="QC-verified">✓</Text>
            )}
          </View>
          {tx.fee > 0 && <Text style={{ color: '#666', fontSize: 11 }}>Fee: {hideAmounts ? '••••' : `${tx.fee.toFixed(5)} QNC`}</Text>}
        </View>
      </View>
      <View style={{ borderTopWidth: 1, borderTopColor: '#1a1a2e', paddingTop: 8 }}>
        <Text style={{ color: '#888', fontSize: 11 }}>
          {isSend ? 'To: ' : 'From: '}
          <Text style={{ color: '#00d4ff', fontFamily: 'monospace' }}>{counter?.slice(0, 12)}...{counter?.slice(-8)}</Text>
        </Text>
      </View>
    </TouchableOpacity>
  );
});

async function fetchCachedBlockHeight() {
  const now = Date.now();
  if (_blockHeightCache.height > 0 && now - _blockHeightCache.fetchedAt < 15_000) {
    return _blockHeightCache.height; // Cache hit — no network call
  }
  if (_blockHeightCache.inFlight) {
    // Another fetch is in progress — return stale value rather than duplicate request
    return _blockHeightCache.height;
  }
  _blockHeightCache.inFlight = true;
  try {
    const apiUrl = getRandomGenesisNode();
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`${apiUrl}/api/v1/height`, { method: 'GET', signal: controller.signal }).finally(() => clearTimeout(t));
    if (resp.ok) {
      const data = await resp.json();
      const h = data.height || data.network_height || data.current_height || data.local_height || 0;
      if (h > 0) {
        _blockHeightCache.height = h;
        _blockHeightCache.fetchedAt = Date.now();
      }
    }
  } catch (_) { /* silent — return cached/zero */ }
  finally { _blockHeightCache.inFlight = false; }
  return _blockHeightCache.height;
}

const WalletScreen = () => {
  const [walletManager] = useState(() => new WalletManager()); // lazy: construct once, not every render
  const [hasWallet, setHasWallet] = useState(false);
  const [wallet, setWallet] = useState(null);
  const [balance, setBalance] = useState(0);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showCreateOptions, setShowCreateOptions] = useState(false);
  const [seedPhrase, setSeedPhrase] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [activeTab, setActiveTab] = useState('assets');
  const [sendAddress, setSendAddress] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [selectedToken, setSelectedToken] = useState('qnc');
  
  // Send Screen state (triggered from Assets) - NOT modal, inline screen
  const [showSendScreen, setShowSendScreen] = useState(false);
  const [sendingToken, setSendingToken] = useState(null); // { symbol: 'QNC', balance: 100.0, network: 'qnet' }
  const [sendingTransaction, setSendingTransaction] = useState(false);
  const [txResult, setTxResult] = useState(null); // { success: true/false, txHash, error }
  const [selectedNetwork, setSelectedNetwork] = useState('qnet'); // 'qnet' or 'solana' - default to QNet
  const [isTestnet, setIsTestnet] = useState(true); // testnet by default (true = testnet RPC)
  const [tokenPrices, setTokenPrices] = useState({
    qnc: 0.0,
    sol: 0.0,
    '1dev': 0.0
  });
  const [tokenBalances, setTokenBalances] = useState({
    qnc: 0,
    sol: 0,
    '1dev': 0
  });
  // QRC-20 tokens: on-chain holdings (from /account/{addr}/tokens) merged with user-persisted
  // custom tokens (AsyncStorage 'qnet_custom_tokens'). Each entry:
  // { contract, name, symbol, decimals, balance (human string) }. Keyed/deduped by contract.
  const [qrcTokens, setQrcTokens] = useState([]); // held + custom, merged for the Assets list
  const [customTokens, setCustomTokens] = useState([]); // user-added (persisted), balances filled in on load
  const [hiddenTokens, setHiddenTokens] = useState(new Set()); // user-hidden token contracts (spam control)
  const [balancesHidden, setBalancesHidden] = useState(false); // privacy: mask all amounts (persisted)
  const [showHeaderMenu, setShowHeaderMenu] = useState(false); // header ⋮ dropdown
  const [showTokenManager, setShowTokenManager] = useState(false); // token visibility/search manager
  const [tokenMgrQuery, setTokenMgrQuery] = useState(''); // manager search filter
  // Add-Custom-Token modal
  const [showAddTokenModal, setShowAddTokenModal] = useState(false);
  const [addTokenAddress, setAddTokenAddress] = useState('');
  const [addTokenError, setAddTokenError] = useState('');
  const [addingToken, setAddingToken] = useState(false);
  // v3.29: Track pending TX with proper confirmation polling
  // { txHash, expectedQnc, previousQnc, timestamp, status: 'pending'|'confirmed'|'failed' }
  const pendingTxRef = useRef(null);
  const txPollingRef = useRef(null); // Interval ID for cleanup
  // v3.30: TX History with WebSocket real-time updates
  const [txHistory, setTxHistory] = useState([]); // Array of { hash, from, to, amount, status, timestamp, type }
  const wsRef = useRef(null); // WebSocket connection
  const wsShouldReconnectRef = useRef(true);  // false on unmount ⇒ no resurrecting reconnect
  const wsReconnectTimerRef = useRef(null);   // cancellable reconnect timer
  const wsBackoffRef = useRef(0);             // reconnect attempt count for exponential backoff
  const txHistoryDebounceRef = useRef(null);  // coalesce bursty history refreshes
  // v3.27: Track Merkle proof verification status for trustless display
  const [balanceVerified, setBalanceVerified] = useState(false);
  const [language, setLanguage] = useState('en');
  const [autoLockTime, setAutoLockTime] = useState('15');
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showExportSeed, setShowExportSeed] = useState(false);
  const [showExportActivation, setShowExportActivation] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [showAutoLockPicker, setShowAutoLockPicker] = useState(false);
  const [showLanguagePicker, setShowLanguagePicker] = useState(false);
  const [importStep, setImportStep] = useState(1); // 1 = password, 2 = seed phrase
  const [showSeedConfirm, setShowSeedConfirm] = useState(false);
  const [seedConfirmWords, setSeedConfirmWords] = useState({});
  const [showSplash, setShowSplash] = useState(true); // Show splash initially
  const [tempWallet, setTempWallet] = useState(null);
  const [wordChoices, setWordChoices] = useState({});
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [customAlert, setCustomAlert] = useState(null); // {title, message, buttons}
  const [nodeStatus, setNodeStatus] = useState(null); // v3.18: 'light' or 'super' only
  const [copiedAddress, setCopiedAddress] = useState(''); // Track which address was copied
  const [burnProgress, setBurnProgress] = useState('0.0'); // Real burn progress from blockchain
  const [activatingNode, setActivatingNode] = useState(false); // For node activation loading state
  const [verificationError, setVerificationError] = useState(''); // Error message for seed verification
  const [currentBlockHeight, setCurrentBlockHeight] = useState(0); // Cached network block height
  const [activatedNodeType, setActivatedNodeType] = useState(null); // Track which node type is activated
  const [activationCode, setActivationCode] = useState(null); // Store the activation code
  const [processingValidation, setProcessingValidation] = useState(false); // Track validation processing
  const [activationPricing, setActivationPricing] = useState(null); // Dynamic pricing info
  const [nodePseudonym, setNodePseudonym] = useState(''); // Pseudonym/alias for the node
  const [showActivationInput, setShowActivationInput] = useState(false); // Show activation code input modal
  const [activationInputCode, setActivationInputCode] = useState(''); // Input activation code
  const [lightNodeStatus, setLightNodeStatus] = useState(null); // Light node network status
  const [serverNodeStatus, setServerNodeStatus] = useState(null); // Super node network status
  const [allUserNodes, setAllUserNodes] = useState([]); // All nodes owned by this wallet (unified view)
  const [loadingAllNodes, setLoadingAllNodes] = useState(false); // Loading state for all nodes
  const [nodeInitializing, setNodeInitializing] = useState(true); // True until first load cycle completes
  const [reactivatingNode, setReactivatingNode] = useState(false); // Reactivation in progress
  const [nodeActivating, setNodeActivating] = useState(false); // Node activation in progress
  const [unlockError, setUnlockError] = useState(''); // Error message for unlock screen
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [biometricSupported, setBiometricSupported] = useState(false);
  const [showBiometricPasswordPrompt, setShowBiometricPasswordPrompt] = useState(false);
  const [biometricPassword, setBiometricPassword] = useState('');
  const [lockoutMs, setLockoutMs] = useState(0); // ms remaining in lockout
  const lockoutTimerRef = React.useRef(null);

  // Throttle helper to prevent too frequent updates
  const lastActivityEmit = React.useRef(0);
  
  // Function to emit user activity (throttled to once per 5 seconds)
  const handleUserActivity = React.useCallback(() => {
    const now = Date.now();
    if (now - lastActivityEmit.current > 5000) { // Only emit once per 5 seconds
      lastActivityEmit.current = now;
      DeviceEventEmitter.emit('userActivity');
    }
  }, []);

  // Helper function to show custom styled alerts
  const showAlert = (title, message, buttons = [{ text: 'OK', onPress: () => {} }], richContent = null) => {
    setCustomAlert({ title, message, buttons, richContent });
  };

  // Stable copy handler for TxRow — setCustomAlert is stable, so the FlatList rows never re-bind onPress.
  const handleCopyTxHash = React.useCallback((hash) => {
    if (!hash) return;
    Clipboard.setString(hash);
    setCustomAlert({ title: 'Copied', message: 'Transaction hash copied', buttons: [{ text: 'OK', onPress: () => {} }], richContent: null });
  }, []);


  // Helper function to copy address with visual feedback (no alert)
  const copyToClipboard = (text, addressType = '') => {
    try {
      Clipboard.setString(text);
      setCopiedAddress(addressType || text);
      // Clear the copied indication after 2 seconds
      setTimeout(() => {
        setCopiedAddress('');
      }, 2000);
    } catch (error) {
      // console.error('Failed to copy:', error);
    }
  };

  // Get token icon URL. Built once (module cache) instead of a multi-KB base64 object per call/render.
  const getTokenIconUrl = (symbol) => {
    if (!_tokenIconCache) _tokenIconCache = {
      // QNC - QNet app icon
      'QNC': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAPe0lEQVR42qWae6xcV3XGf2vvc84872uu347jRwyJYwNJE1IcCO8qTYvahFCUmkcLrVBbqCJA5Y9KlShCVR9AKyEBUgtFpY0QooBIKTQloSipEzkPnNZ27NiJH7Ed29f3Ne8z5+y9+secmTszd2yIOtKdc2fOzJnvW3uttdf61pGZmWuV0Yf0nwaO2auBl6qy6vwrfYgooNn1Rs+unOu/HHkEvwj4obeQDPjod17hQ4eNIKIZmUEiPQNlRGQ1iWA8eFn11ipry/+TgQxbduX6iggoOgBWhr+n4wiMgJeBpyGLy88BLVchM+QjcgUygqoiIqiMktDuceD94Io/KqAI9MCPA95jKb/gSvR/pwegdxx4X3okso+LjriUMuhLwThXkNEAHQUoPTAy7GxmwGd1wNFl8H3tY9CeNb0OA5QBt5JuoK8iIQKqBKsCtu/0YywrMsCh94/pAk8TtNWGNAFjIAi7R1VwKepSsAES5hAbdYF533VRI5l76cCKZ0RVunyvQCIYBa9D4GV4+WUQuHQBtluQxEhlPXb3XuzWPdg112BK0xibwyQpNGv4xQukLz1H59SzJJdPA2ByJRDpEslWSfsrMujr0k+5o6lWZirbVj4iAwE7SMDIsNWthaQDnRay85cI3nYvdsfroNOBi6fgwhl0Ya573gbY0izB7DVEa3YQFmZwl05Tf+p71J57GNRjozLq04Gk1LO+H0q5IjqSnbRLoBdbqmYseBn0fWOhUYP1Wwh+637MzpvQQ/tx+3+AP/0c2qiu+OhADldVJCoSrttG+cZ3MPWau6BR49J//i21F/cT5KczEH6EhA7EFIj4oVXoE+gHrYwGZWZ5yV7Xa8ib3oXd9ydw+Ancd7+Mnj8JYQ6JCmAtiqLqURRBEBEEA97jkxifNLHFGSq33ce62z7A8rPf5+yPP4cJcoix4AdI+IEdWUHQocwkldmuC6maYfDS/ZO+/ws065jf/jjmzXfjv/ZZ/IEfQa6EREUUR+KbqCqhyROZIoFEOE1JfItEW3j1hCaPNRHedXDNJfLrr2fH3Z/DVS9x4nufQL1DbDBCYqCk0Kz8UO0Gd2V2m3YjfThwpQeazG1aNcz7PoW5/S7cX/w++tIJmKwgXun4BoHJszm/m435GyiFFQSDV9e1PELLLXO5c4qzrf+hkV4mMkWMhLhOHUW5/p4vEkaTHP7WhxEx/TTZNa6OdSU0I7DK94XuRXoBW19G7vog9u6P4P78g+jFl5DSFN51SDVmR+mXedXEHcS+zoX288x3TtN2VZw6RAyRKTIdbmR97nomg/Wcbx/haPXHeFJCU8S7GJc02fPuv8fHdY782/3Y3MRVV6GL1COV2e2qo2mzF7jGQNxCduzGfvJLuL+7Hz32DFKewbk2RgLeUNlH3k5wqPofXIyP49VhJMBklu/+nsdriqJMBuu5cfJOynYtBxb/hWp6gZwp4dIYMcJt+77H2YMPcOaZfyDMT6PeZavgR3bvrivZfKHy6VVlgZgsiWS73Uf/Bj3wEP4n/wqTs6iLsRLw1rUfoemXeGz+6zTcAoHkCSQiMBHW9I4BRgKsBAQS0fFNTjefBDy3zezjcnyChpsjtEXSToP6pcPseuOfMnfyETrxcjeoB6uIkXLFjC1ZAMRCs4bZ+2tIoYx78KtQngZ1eDx3rPk95jsv8fj8AxnwPFYsuWCCQlihGM5SiCoUwlmKYYV8OI01EUYseTvNi80neGb52+yd/V0KdprUtwlzU8yffZyF04+y85Y/wiVNROwVAHb/Mavyfn9T8BDlCN7+XvzD30KbdYwNSVyDPVN34kh4Zum7FOwEoES2SCGaJQzLmDCHGvCa4sUjQUgYlCiEFfLBFOApmCleah7keP2/eP3MPpwmgCcIy5w8+FXWrr+ViZlX4Vx7BdOYWtGM7Qek6/tm581IfgJ34CGkWCb1babCTWwpvI6nFr9DYHIoSs6WyQWTEIR4dbh2DZ/LEVSuwRSniH2TmBZYkxGZQXEU7BTP138KCFtLtxG7OkFYpLp4nPrlo2zZ8eukSRMRk22mq7vEYGz7KIKmHexr70BPHUGXLmImZknTZXZO3c7L7eeopXPkTRlrIqKgjAYGTWN0cobi2z7GxJpdlGopU42A6OIcz594gEu1w+RtAUueSCeI0xpGLMdqj3D9xDs503yKLLvz8umH2X7dvRy1uW4Aw1Bq7cWEGete6pEoj712N3r0qaypceTMBJXoWk43f0YgOQAiW+7uvi6BNRspf+gvsbkyC498mVM/+WsOP/0FlmonuOeaz7Cr/JbuShghsiWMBASS43LnBQAq0TZS38YGBRbmniUfTlMsbcL7ZExpP9SR6crui4B3UJrClqZJzp1AwohUO6yNtuM0pppexIjFZtlGUdQayvd8Enf0Sao//gpamgAbQKI8WfsarfwJ7tj8B5w7fYJW+yKBCQltgTitk2rMUnKONdF1XI5PkLNlmo0L+E6dqckd1BsvYYMo232HG2MzNsJ9iplcg3jFL88jNsRrymSwjparkfgYg2BNCNbgOy2ina8nT4H6Yw/A1BrIl/BRhOZyFAsbOdR6lEP+KbZuvJPUxyCClSjzbEM1eZlysDbzFEOatkjjBsXC+qxSHd/tmXE5Sr1iCiWM99BudIMaJTIl2r7eXzEjQffzpJTW7UJOHSP1MRoEpAbS0OCs4IwnsgXOtA4ilc0YE2RNiunXWbGvEZnSwOanpHGVXDAxTk25iqzSdymD8YC6gXZVVgJqcMFEKCQhksZovwDsNXYr9VSHNo2cRzD9SrV/DfxQgwog3mF+Tp9txoIXg3baGBUkyvcjP9E2oSmstB0D2UHnzrLebgVRjFfEKzb1mNRjvMcsL2Gnt1B18+DSrjHwXb9WCKVA4ttDHWBkJkiT1islAGIsWpvHYDGlCupTRCyNdIG8ncRK1wWcpqj3BDbP3PnHuba9kevKe2m25whSxaYQdFJcYOj8xj7cdXuonn4MQwAKzidZpe8oB+tousV+428kIB+UacfziDHjZbkVAoNyh4IJ8PUlpN0imN2Cph0CE7GUnCNnShTtdHfD8jHqU4yEtOM5/veFr/Ou6fvZU34H2m6izSrSbBCWNrDzpo9x8/wm5NxRxIbgHalvZSAs0+FmFpPTGLE4n1DMrSFvyyzXT2FNbpzuOCYGMlFAjOCbddyFF8ltu4nmz36IlZBGukDTLbIhv4vj9ccwaum4JjljydkiR5cfoaMxe7a8j/XX/iqXZY52KSKeKNH6xmdYruwlefs+gof+CWeF1Hfw6iiHG8iZCebiE4QmT6fTYNPsrah3LDdOY02IZg3MKJGgrxMN7geZXNI+tp+pN32Q5XwJnENEOFk/wI2Td3KycQAQOq7RrTrJkzcFTlYf48zRp5mZvhEpVWj7OvHCcVz1InNzTyAzmwmMoZUsIhgSX+O64t3Mxc8T+ypFW8FpzLa1b+Hy0mHitEohrKC4sUKvGVZas5PeY3JFWs/vJwxLFLa/HtepE5kSL7eP0HZVrp94K21fxWBoJUs41wKv5ClhnbIw9zTzL/yI1sn9aKOKDaco1RLyJ47QdEuoehJtsTb3Kmaj7Txff5icKZO6mGJuLVsrt3P8/L9jTdRraca6kVktW/eoBaS1yzQOP0Jl7/tRn6JAIDkOLn2XrcVb2Zx/DW1XBYRmskicLOPTGHFCJCWiYAoblDFqIYmJtUHd1FHv8JoQSMRNU+/lUPX7JL6FlZA4XWL35nfTbi9wduEJoqCUZTtlnM5uxujdGVuPyZVZ3P8NipUdTO16J2lzEWsjmn6JJxe+ya3T97GxsIeWW8zcqUmjM08rmSfuLBEnS3Q6C7Q7CzSTedpJFbzS8U1Ck+eNsx/lZPNxzrefJWfKJK5NOb+Bm7f8Dgde/MrqmcCYOLaFwvSnGWnoe2qEsQFpYx5N2mx628dZOvQgLokJbYFqcoGF5Aw3T91LMZhmrnOCxLeyTcrhNMH5BKdJty/AkfoYpzGbCzdx6/QHeKHxU15s/JS8mQSg3Vngrtd8nmrzLAdOfolcOLWy1+hq/xfRgaZehsXbflNvDD6us/2ezxPmJjj2zY9gcxMYE9DxDfJmktdNvZtiUOFs6yAX2kdo+kWcj7Pd1WAlIGfKzEbXsaV4K5aIw9UHme+8QN5MgAj19gVu3/kJXrvpPXzj8d/Ea4LJduyVpp5VykSmCwmjjb30lOasBleUG+/7R5Kl8xx78BOYsIANCjgfk2ibdblXs7V4G+VgHanGdHwTrykihkDy3TrK1TjfPsi51kFACU0RVU8jnuOWrR9m7/Y/5ttPvZ+F1klCU0CzMmZIlRiwPqpIpbKtq+eukla6ilovpapPMGGR3Xd/CR83OPqjT9FpLRDmphEREt/CaULOTDIZrKcQzGAlRNXRdlVq6cVup6WrCWGJXR3nY9786k+xe+N7+M4zH+JS7Qj5YBKfaaXjrN9T59CrSosmk1fol7i9xuKGX/ksM+tv5vijf8XFFx8CsQRRt0FR0q7vk65UrVishN3qVZXENUlci7WTN/L2G/6MnJ3gB8/ez2LrFPlgKvsd+slktZzi+y+7BPpzsNWrMCypG1BPmjTYvOtedt7yh7QXT3Pq0D9z+eUnSTo1xFiMCTEmWCmN1eF8gtcEayJmJ27gtdfex47ZOzh2/of894kvdF3KFgYsnwWu6lAQD4JfLa+TSYxXJSGIGJL2MlFxDdt3v4/NW++ENGbx4kEW5p6lVj1N0qnifYKIJQpKTBQ2sXZqN5umb2Iy2sCFxad5+uTXmKs9Rz6c6mavvs+PgO+5znh5fav24ckVJPZRElnF6n1K0qmRy8+wbuMb2LDhTUxPbicXTGG8xbhuPW+84JI69cY5Xp5/kjNzj7LUPENoC5nVV8qEYVmdq0jr2luBrTo0mSSb0nClEdMAjWw11KekaRPvU2xQIIomCYMygc11SaYNOkmNTloDhDAoEpioW6D15wEDYK8EfmgzGyIwMtQGdHCTHpVezMqJ/gShNyLCo+q68wH13dmAGATbV9l6pYEOlcGjtc4A+N6QZNWWrFlnMTC+1IGutA9aR2a5fmW+OzDeGeDbBSvCkHWHfHzVqHU18MHbDcaBR69QTq889xdqIOxHiGW6vYqsEg507L0F40COqYgHnHnsFYcG3To4zx0msRLcA0REVw+2VUdIcjU2VwXevwFEr/C1gdUOVl9smEQXj664g8qqQFo16ddf8G4PHTfM92NO6xVuVxjTUq64yIqVtS+r9HQxWW0ReeV3qoy97Uav4HpXaGj+DzDA2yLaJ6DkAAAAAElFTkSuQmCC',
      // SOL - official Solana token
      'SOL': 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
      '1DEV': 'data:image/webp;base64,UklGRlwJAABXRUJQVlA4IFAJAADQJQCdASpAAEAAPhkIg0EhBv4rvwQAYSxAFOjeOHXy38bvyA+TGtv0z8Hb2iSnt8ndbZ3zE/sV+wHu7+h76M/h0/qvrFeqX+zPsAeXH7Iv+E/6/7Ae0bgAm4P7j+JPmD4VvSPtx6gOAPpn1AvlP3L/aeTHeD8AdQL2L/mfyq9rf4TsCs7/wfoBe0P2L/W+AhqBdy/RT/S/9V6Df3zwPvo3999gD+Yf3T/if3j3Vf6f/2/6Hza/S//k9wT9b/+n64frh/bb//+7j+wBh+KnsiC/V+OzkQZ9xnsPcb/R4BS9G6rCJUElCa2zpAn6yH1fLY2lk4C3m0NBCjbpYNw26lH01KHAdmXiig6rtgIpssbm3//428xJbrp4rg8PNVi0n1UBJaCTUtDZArp17P79TGWL1piPuMZ4kAD+/6oBwxZnprfB3Z04cTZir9TxW6M3b9YMLmR2Gu920U7y+zsz1AnnNLpBkuLva/iYMPFt8WA5AHFehPyR0iHg1YbYMjfOBEvkytnybjJV5nnbCpTIIXVR8fX//3p1/AjCKZ8CMP/9Ug4T25pe/WOjAkPcN/9aOJ7PJc1Xq0m+mhQJlb152HrEq3VYVPBda9GPgAm1QyzGtTbAQng5Dxesy/JRgu6uLiOB4ovEhyJrAGD9bHZrpHH93EyupT7x7/fWSHaAx+aHL5OpQfY3s0UCUsLfllULEQ/x3pTg+iUuJW7xCz5JkSlEbmpTlcHPnLFUBQ9dIYpsV8k9x6Bi7xMCzGsUBxFjt7S0hAbt0E7pLBvDPiNkDAsInRzJkyiqtB+fLRKtqJaxbR0Ih6KTaGJeCPCzwpjfVUe1ugK1lmulASfWU55zBIGfNXCf5L1qlKZ6hGFvDE1y10S84mVfaCXKDUJqou04vJ4BY3ycpSZJbI58BXCfFRS4i9CF5i6bmy6M1PutB77GjlbExU/kt3QwIQ5x/GyHnj5S2t4X4xp/xTrQCSJZAahoHuqWrE1NNHrYiYwaXX1LjkxC8WcouXpXbKZ+D2lOBLTBikhMFfMlPlNl3WEg6IHXDvF41P8FVzEBluEel9vpWp52AlazCalz3jI9+vyi8aloEmqMI/8C51CTxvS7fsxzT1tJQKlyEw2RV8hgNb+YTBfcUH1iCd8Y7oXAfXWvntqqDUr5R8e65JDm8A4vLFsSg9PuRd6WeaB6vHgwoxzQIhjApCVwqIg9vwsWmfDA5cn/DDvYO9rnjJ2ejGgsvg/0P1o62vLeslmbER15fwNHmv7s42+PzbEFsVIwvjKinRLW3cJ8SzjZrcaCejiTY/7p9mZNMAVCsDSPYlKTDg/dVdW8ZZ8RXGANXOcMNidank78eDNaaosmgoteewsu03q/Jz283R5jgokZHoQ17JphkRuG0Il1yBeNBBmD4ZrMBizwlmiPOvuOaSdOV6Xp5rhZGUxy6yigVAaLFHmTfLr3Oien3HHtDzH7HtU09ZIrubO9KJLNzAjxp2OBcEQFiP+F70D0UgLsFjUO9EQfjm6qHA0IGfr01Q47Kp5uc2PycLdHwraJmh5d5ChC80QEqudsrebzjcq7LiTy7SchubfLsQWBXULcu92pcGNIGtyTSNvwNPXd8iequ2STZIAbshQ0rmwyKqnAz/h41BbCy1VkBiRAmjMiusXdo5dikjWfrD66eNXxoo/pa9p+8T/NCminxf+YEBw7ab1TUsRsEPdzAWxW/eOdDK0Rh7e41y4L5NNhKN99ktKcs+FBgd4bR+YfwXWj+15tIHdcnfthSzDgOHyc143s5ChWxdbIlwxjEnxKVCex+hJBmdpln/QFn93+CoS3MpMxW8DTbtYjDfDP+bI9K8vZV5U3UQxEKYrZ9mglhwXYgsnI5RH4e2P7Pi3YHgyzt/raot15D4AVrFVKFJTMF1OYll7e0KILO01+MVNS+RP3FdXzV5bKaVBu0hGx+5WVYZwnzkDvRHuYARLh7XsBG6FbUYFqFJuQ11R8z+X6W0y4Ke19og3M8f5y+ODK2l9GvHkofeDcerCoqFuQZlWso8fu3kNndG1hT/SCjzbugqm+xHiclF3wHTXL2ova3Zr1lnAnWVaUNr030Zh6czayHPE7lY5Ue1bhqCH0jgj1KZ5bm6SLv9e/o6k+lh03vnmEvcPgN6xQKnoc/xR5y7V6rHjdVPYgCeKJDyHTnLKB/W1uiPPlh9v7MWyztQ42JrB3ngtLlaN7Qn2rrQ+bq73ldZDkbbUV85grcToYmG8IE/GI5gMyBUyBpApxsqoKdCjF/2lPGHseR/C72iSdsNQ9LsD+4mhOrk39PS7BmyGLAHqyoLQDhXd2gQhzA4byKDMGvsSmIjgXUj7QD/RB32HfzXSXJsGBU6aFeH9N0/+SneviUbr93ui+wKoSDNvgBNWHe5jn+gwLdjoVYMbbbLiHWL/+JsHS3A65XcHmZPfzrVBz8lmwKXwjijkGNoHGq+mR/taFOKbHVTbyWidaT7LxV2Ypj/ebQ9UXc5V/CSImRmlCVhCjct47pn5PosoOk7P5OWyFi92KwW6nWfJVAvWDNoJrRCP59I0q8mIZ/mi1DJsSb0MXCP8OYd5rikw98Efdjxj10DfXp7Hnn6e5F4XZpyyZtOCwtNpj6M1xvcQ3GSj6YjtryPz4Rjl8Kj8aC/fTzWz++RZQdlXTAFyy8/KyEv5oey9lOQjMTSs0RF+UJlb1c1K3Oe00xoYzXTXRM27ZdF2VnWA/nQ12RVYwCOUSwYdUjXZGmyhcsliYsXHrGS8Zg9ndSDP+3Jgmq//rS2bw7OxkRbPf0zc54jvD4vKy6xNyik6F9359RsD83cyxvM3LWWTCFHBtvUx9D+QbdzIQ0C+GZBHZAP3KRMs4eier71LX+OGDp+wWeuM96W3EaZWV+hs4w7VhCMw4Ej2loQwQ3eEXyVlCylxmIc+mje/pPUvcFpnL9v1SsAXnWV0DYM35U+P/G1fYuDY0JquMOpelQUBcI5DhB4iolkbc/LIkQcexaAInlEBqfbuaWiYeh9eUMC3F0Po5WYdcU+slUtVMTL+cUAA1cMiFukh1h4E4ifmGtdvsJXBtXUQfpaPsnmqgaF4rapu3V5/TVsMc2ARuKH3YK8m3LPURCDcec3oT9SvUt0kfS4U1A/roXNtPPY/656lEw2OOP+2f5aoliVljHdbdK/n7dPg6EXAAAA==',
      // USDC
      'USDC': 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png'
    };
    return _tokenIconCache[symbol.toUpperCase()] || null;
  };

  useEffect(() => {
    // Load wallet data in parallel
    checkWalletExists();
    loadSettings();
    // Biometric support check
    walletManager.isBiometricSupported().then(supported => setBiometricSupported(supported));
    walletManager.isBiometricEnabled().then(enabled => setBiometricEnabled(enabled));
    // Rate-limit state
    walletManager.getPasswordLockStatus().then(({ locked, remainingMs }) => {
      if (locked) _startLockoutCountdown(remainingMs);
    });
    // Run Dilithium BC compatibility test once on startup
    try {
      const { runCompatibilityTest } = require('../crypto/DilithiumCrypto');
      runCompatibilityTest();
    } catch (e) {}
    return () => {
      if (lockoutTimerRef.current) clearInterval(lockoutTimerRef.current);
    };
  }, []);

  // Load real burn progress when activation tab is selected
  // v4.10: Increased delay to 1500ms to stagger Solana RPC calls and avoid 429 rate limits
  useEffect(() => {
    if (activeTab === 'activate' && wallet) {
      const timer = setTimeout(() => {
        loadBurnProgress();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [activeTab, isTestnet, wallet]);
  
  // Background sync activation codes - check periodically until found
  useEffect(() => {
        if (wallet && wallet.publicKey && password) {
      let syncInterval;
      
      // Sync in background without blocking UI
      const backgroundSync = async () => {
        try {
          const mnemonic = await walletManager.getEncryptedMnemonic(password);
          if (!mnemonic) return;
          
          const syncedCodes = await walletManager.syncActivationCodes(
            wallet.publicKey,
            mnemonic,
            password
          );
          
          if (syncedCodes && Object.keys(syncedCodes).length > 0) {
            const nodeType = Object.keys(syncedCodes)[0];
            const codeData = syncedCodes[nodeType];
            const codeStr = typeof codeData === 'string' ? codeData : (codeData?.code || codeData?.nodeId || '');
            
            // CRITICAL: Don't show activation for:
            // 1. Hash-only codes (HASH:xxx) — not a real activation code
            // 2. Nodes with pending_activation status — not yet activated
            // 3. Nodes that needsCodeRecovery — code not available
            const isHashOnly = typeof codeStr === 'string' && codeStr.startsWith('HASH:');
            const isPending = codeData?.status === 'pending_activation';
            const needsRecovery = codeData?.needsCodeRecovery;
            
            if (!isHashOnly && !isPending && !needsRecovery && codeStr) {
            setActivatedNodeType(nodeType);
              setActivationCode(codeStr);
            
              // Stop syncing once we found valid activation
            if (syncInterval) {
              clearInterval(syncInterval);
              syncInterval = null;
              }
            }
          }
        } catch (error) {
          // Silent fail - background operation
        }
      };
      
      // Run sync immediately
      backgroundSync();
      
      // Only set interval if we don't have activation yet
      if (!activatedNodeType) {
        // Then sync every 30 seconds to catch new activations
        syncInterval = setInterval(backgroundSync, 30000);
      }
      
      // Cleanup
      return () => {
        if (syncInterval) clearInterval(syncInterval);
      };
    }
  }, [wallet, password]); // Run when wallet loads
  
  // Load node rewards when on node tab
  // Load node data when on node tab
  // ARCHITECTURE:
  // - Light nodes: App is the node, needs local rewards tracking + network ping status
  // - Super/Genesis: Server is the node, app just monitors via single API call
  // - NEW: Load ALL nodes owned by this wallet for unified display
  useEffect(() => {
    if (activeTab === 'node' && wallet) {
      // Fetch cached block height for "Next Rewards" display (max 1 req per 60s globally)
      // Fetch block height immediately, then refresh every 15s while on this tab.
      // fetchCachedBlockHeight has a module-level 15s TTL so actual network calls
      // are always at most 1 per 15s regardless of how many times this runs.
      fetchCachedBlockHeight().then(h => { if (h > 0) setCurrentBlockHeight(h); });
      const heightInterval = setInterval(() => {
        fetchCachedBlockHeight().then(h => { if (h > 0) setCurrentBlockHeight(h); });
      }, 15000);

      // Load ALL nodes + specific node data in parallel (not waterfall)
      const promises = [];
      
      // UNIFIED: Load ALL nodes for this wallet (Light + Full + Super + Genesis)
      promises.push(loadAllUserNodes());

      // Light-node status keys on the persisted qnet_light_node_info.nodeId, NOT the activationCode —
      // so when the code is absent (restored session, or an activation that didn't finish writing it)
      // load status here, else the gate below never fires and the badge sticks on CHECKING forever.
      if (activatedNodeType === 'light' && nodePseudonym && !activationCode) {
        loadLightNodeStatus();
      }

      // Also load specific node data if activated (runs in PARALLEL with loadAllUserNodes)
      if (activatedNodeType && activationCode) {
        if (activatedNodeType === 'light') {
          loadLightNodeStatus();
        }
        promises.push(loadServerNodeStatus());
        
        // On-chain verification: only clear if NO burn evidence exists
        // "Has activation code" (from Solana burn) != "Node activated on QNet chain"
        // User may have burned tokens and received code but not yet activated the node
        AsyncStorage.getItem('qnet_last_activated_node').then(savedStr => {
          const saved = savedStr ? JSON.parse(savedStr) : {};
          const currentAddr = wallet.qnetAddress || wallet.address;
          
          // CRITICAL: If saved state has no wallet tag or belongs to a different wallet, clear UI
          if (!saved.walletAddress || saved.walletAddress !== currentAddr) {
            console.log('[NODE TAB] Saved activation has no wallet tag or belongs to different wallet — clearing UI');
            setActivatedNodeType(null);
            setActivationCode(null);
            setNodePseudonym('');
            setLightNodeStatus(null);
            setServerNodeStatus(null);
            return;
          }
          
          if (!saved.burnTxHash && !saved.isGenesis) {
            // No burn evidence — check if this is truly stale from a previous chain.
            // isGenesis records never have a burn: the burn checks below would always
            // come back empty and wipe a legitimately linked genesis node.
            const qnetAddr = wallet.qnetAddress || wallet.address;
            walletManager.verifyActivationOnChain(qnetAddr).then(async (result) => {
              if (!result.verified && !result.networkError) {
                const solanaCheck = await walletManager.verifyActivationOnChain(wallet.publicKey);
                if (!solanaCheck.verified && !solanaCheck.networkError) {
                  // Last check: see if Solana has a burn TX
                  try {
                    const burnCheck = await walletManager.checkBlockchainForActivations(wallet.publicKey);
                    if (burnCheck && burnCheck.length > 0) {
                      console.log('[NODE TAB] No on-chain activation but Solana burn found — keeping code');
                      return;
                    }
                  } catch (e) {
                    console.log('[NODE TAB] Solana check failed — keeping state');
                    return;
                  }
                  console.log('[NODE TAB] No activation on-chain AND no burn — clearing stale state');
                  setActivatedNodeType(null);
                  setActivationCode(null);
                  setNodePseudonym('');
                  setLightNodeStatus(null);
                  setServerNodeStatus(null);
                  await AsyncStorage.removeItem('qnet_last_activated_node');
                  await AsyncStorage.removeItem('qnet_cached_server_status');
                  await AsyncStorage.removeItem('qnet_activation_codes');
                }
              }
            }).catch(() => { /* Network error — keep current state */ });
          } else {
            console.log('[NODE TAB] Burn evidence present — code is valid (node not yet activated on-chain is OK)');
          }
        }).catch(() => {});
      }
      
      // Ensure nodeInitializing is cleared even if no nodes found
      Promise.all(promises).finally(() => setNodeInitializing(false));

      // Status self-refresh while the tab stays open: a node that comes online
      // (finished syncing, reconnected) must flip the UI without leaving the tab.
      const statusInterval = setInterval(() => {
        if (activatedNodeType === 'light') {
          loadLightNodeStatus();
        } else if (activatedNodeType) {
          loadServerNodeStatus();
        }
      }, 30000);

      return () => { clearInterval(heightInterval); clearInterval(statusInterval); };
    }
  }, [activeTab, activatedNodeType, activationCode, wallet]); // load on tab open; NOT nodePseudonym (set here → self-retrigger)
  
  // Load dynamic pricing when on activate tab
  useEffect(() => {
    if (activeTab === 'activate' && wallet) {
      // Small delay to let UI render first
      const timer = setTimeout(() => {
        loadActivationPricing();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [activeTab, wallet, burnProgress]);

  const loadBurnProgress = async () => {
    let done = false;
    const fallbackTimer = setTimeout(function() {
      if (!done) { done = true; setBurnProgress('0.0'); }
    }, 8000);
    try {
      const progress = await walletManager.getBurnProgress(isTestnet);
      if (!done) { done = true; clearTimeout(fallbackTimer); if (progress != null) setBurnProgress(progress); }
    } catch (error) {
      if (!done) { done = true; clearTimeout(fallbackTimer); setBurnProgress('0.0'); }
    }
  };

  const _pricingFallback = {
    cost: 1500, currency: '1DEV', phase: 1, mechanism: 'burn',
    burnPercent: 0, baseCost: 1500,
    description: 'Burn 1500 1DEV for activation', isEstimate: true
  };

  // Load dynamic activation pricing
  const loadActivationPricing = async () => {
    let done = false;
    const fallbackTimer = setTimeout(function() {
      if (!done) { done = true; setActivationPricing(_pricingFallback); }
    }, 8000);
    try {
      const pricing = await walletManager.calculateActivationCost('light');
      if (!done) { done = true; clearTimeout(fallbackTimer); setActivationPricing(pricing); }
    } catch (error) {
      if (!done) { done = true; clearTimeout(fallbackTimer); setActivationPricing(_pricingFallback); }
    }
  };
  
  // Load Light node network status (for ping system)
  const loadLightNodeStatus = async () => {
    if (activatedNodeType !== 'light' || !nodePseudonym) return;
    
    try {
      const status = await checkNodeStatus();
      // needsReactivation is authoritative ONLY from the server, and ONLY for a genuinely
      // registered node (checkNodeStatus returns needs_reactivation on its registered:true branch).
      // A never-activated node (got code, not yet registered) and a reinstall both return
      // {registered:false} with no local ping identity; that is NOT a drop and must surface as
      // NOT ACTIVATED downstream, not as needs-reactivation. So we no longer synthesize the flag here.
      setLightNodeStatus(status);
      // Update cached block height if checkNodeStatus returned a fresh value
      if (status?.currentBlockHeight > 0) {
        setCurrentBlockHeight(status.currentBlockHeight);
        if (status.currentBlockHeight > _blockHeightCache.height) {
          _blockHeightCache.height = status.currentBlockHeight;
          _blockHeightCache.fetchedAt = Date.now();
        }
      }
      
      if (status.needsReactivation) {
        console.log('[Node] Light node needs reactivation');
      }
    } catch (error) {
      console.error('Failed to load Light node status:', error);
    }
  };
  
  // Load Server node (Super/Genesis) network status
  // This single API call returns ALL info: status, heartbeats, rewards
  const loadServerNodeStatus = async () => {
    if (!activationCode && !wallet) return;

    try {
      // QNet address only: a node's reward wallet is an EON address; never fall back to a Solana addr
      // for node resolution (it would query a wallet that backs no node).
      const walletAddress = wallet?.qnetAddress || null;
      // Resolve super/full nodes by WALLET (on-chain canonical) rather than a possibly-stale cached
      // pseudonym: a single lagging node can hold an old pre-registration id (e.g. activation_*) and
      // report the wrong name + "offline" while the rest of the network sees the node online under its
      // real id. Genesis (activation_code path) and Light (pseudonym) keep their own resolution.
      const preferWallet = !!walletAddress && activatedNodeType !== 'light';
      const nodeId = preferWallet ? null : (nodePseudonym || null);

      // Quorum: ask several nodes in parallel and keep the AUTHORITATIVE view (online beats offline,
      // then more heartbeats), so one node with a stale wallet→node_id record cannot pin the displayed
      // identity or liveness. Wallet-scoped queries converge because each node maps the wallet to ITS
      // own id and we keep the online one.
      const quorumN = 3;
      const responses = (await Promise.all(
        Array.from({ length: quorumN }, () =>
          checkServerNodeStatus(activationCode, nodeId, walletAddress, 1).catch(() => null))
      )).filter(r => r && r.success);
      let status;
      if (responses.length > 0) {
        responses.sort((a, b) => {
          if (!!b.isOnline !== !!a.isOnline) return b.isOnline ? 1 : -1;
          return (b.heartbeatCount || 0) - (a.heartbeatCount || 0);
        });
        status = responses[0];
      } else {
        // Nobody answered in the quorum — one plain attempt (its own retries) as a last resort.
        status = await checkServerNodeStatus(activationCode, nodeId, walletAddress);
      }

      // Claimable comes from the dedicated STATUS-INDEPENDENT endpoint (merkle reward-root) by the
      // resolved node_id, so earned rewards show + can be claimed even when the node is offline/banned.
      const resolvedId = status?.nodeId || nodeId;
      if (resolvedId) {
        // Quorum the claimable (max of a few nodes): a claim proof is re-verified on-chain against the
        // 2f+1 reward_root so no node can inflate it; an honest node only under-reports (local shard lag),
        // so max = the certified amount — routes around a lagging node and removes the pending flicker.
        const prs = (await Promise.all(
          Array.from({ length: 3 }, () => getPendingRewards(resolvedId).catch(() => ({ success: false })))
        )).filter(r => r && r.success && r.pendingRewards != null);
        if (prs.length > 0) {
          status.pendingRewards = prs.reduce((m, r) => Math.max(m, r.pendingRewards), 0);
        } else if (serverNodeStatus?.pendingRewards != null) {
          status.pendingRewards = serverNodeStatus.pendingRewards; // hiccup: keep last-known, don't shrink
        }
      }

      setServerNodeStatus(status);

      if (status.success) {
        AsyncStorage.setItem('qnet_cached_server_status', JSON.stringify({
          ...status,
          cachedAt: Date.now()
        })).catch(() => {});
        // Adopt the network-canonical id from an ONLINE (quorum-confirmed) response and OVERWRITE a
        // stale cached pseudonym — e.g. an old activation_* id that one lagging node still returns and
        // that the app previously latched onto — so the displayed name self-heals to the real one.
        if (status.nodeId && activatedNodeType !== 'light' &&
            status.nodeId !== nodePseudonym && (status.isOnline || !nodePseudonym)) {
          setNodePseudonym(status.nodeId);
          AsyncStorage.setItem(`node_pseudonym_${activationCode}`, status.nodeId).catch(() => {});
        }
      }

      if (activatedNodeType !== 'light') {
        await loadNodePseudonym(activationCode);
      }
    } catch (error) {
      setServerNodeStatus({ success: false, error: 'Network unavailable' });
    }
  };
  
  // Load ALL nodes owned by this wallet (unified view for Light + Full + Super + Genesis)
  // Battery optimization: runs once on tab open, no polling
  const loadAllUserNodes = async () => {
    if (!wallet || loadingAllNodes) return;
    
    // CRITICAL: Use QNet address for node lookup (not Solana address)
    const walletAddress = wallet.qnetAddress || wallet.address;
    if (!walletAddress) return; // Silent fail - no address
    
    setLoadingAllNodes(true);
    try {
      const result = await getAllNodesByWallet(walletAddress);
      
      if (result.success) {
        // CRITICAL: Filter out pending_activation nodes — they are NOT real activated nodes
        // Also filter HASH: codes — these are hash references, not activation codes
        const realNodes = (result.nodes || []).filter(n => 
          n.status !== 'pending_activation' && 
          !(n.activation_code && typeof n.activation_code === 'string' && n.activation_code.startsWith('HASH:'))
        );
        setAllUserNodes(realNodes);
        
        // AUTO-LINK: link server nodes found on-chain. Also fires when the type is
        // already set but the pseudonym is unresolved (server-activated super whose
        // name was never cached locally) so the node name resolves from the chain.
        const serverNodes = realNodes.filter(n => n.node_type !== 'light' && n.status === 'active');

        if (serverNodes.length > 0 && (!activatedNodeType || !nodePseudonym)) {
          // Priority 1: Check for Genesis nodes first (bootstrap nodes)
          const genesisNodes = serverNodes.filter(n => 
            n.node_id && n.node_id.startsWith('genesis_node_')
          );
          
          if (genesisNodes.length > 0) {
            // Auto-link first Genesis node found
            const genesisNode = genesisNodes[0];
            const bootstrapId = genesisNode.node_id.replace('genesis_node_', '');
            const genesisCode = `QNET-BOOT-${bootstrapId}-STRAP`;
            
            // Set activation state + fetch status immediately (single network call)
            setActivationCode(genesisCode);
            setActivatedNodeType('super'); // Genesis nodes are Super nodes
            setNodePseudonym(genesisNode.node_id);
            
            // Save to AsyncStorage (non-blocking)
            AsyncStorage.setItem(`node_pseudonym_${genesisCode}`, genesisNode.node_id).catch(() => {});
            AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
              nodeType: 'super',
              code: genesisCode,
              pseudonym: genesisNode.node_id,
              isGenesis: true,
              bootstrapId: bootstrapId,
              timestamp: Date.now(),
              // Genesis has no burn; truthy marker keeps the no-burn-evidence
              // cleanup from wiping the auto-linked record.
              burnTxHash: 'genesis',
              walletAddress: walletAddress
            })).catch(() => {});
            
            // Fetch server status inline (avoids separate render cycle)
            try {
              const status = await checkServerNodeStatus(genesisCode, genesisNode.node_id);
              setServerNodeStatus(status);
              if (status.success) {
                AsyncStorage.setItem('qnet_cached_server_status', JSON.stringify({
                  ...status, cachedAt: Date.now()
                })).catch(() => {});
              }
            } catch (e) {
              // Will show "Connecting to node..." in UI
            }
            return; // Don't process other nodes if Genesis found
          }
          
          // Priority 2: Auto-link other server nodes (Super)
          const otherServerNodes = serverNodes.filter(n => 
            !n.node_id || !n.node_id.startsWith('genesis_node_')
          );
          
          if (otherServerNodes.length > 0) {
            // Auto-link first active server node found
            const serverNode = otherServerNodes[0];
            const nodeActivationCode = serverNode.activation_code || serverNode.node_id;
            
            // Set activation state
            setActivationCode(nodeActivationCode);
            setActivatedNodeType(serverNode.node_type);
            setNodePseudonym(serverNode.node_id || serverNode.pseudonym);
            
            // Save to AsyncStorage (non-blocking)
            if (serverNode.node_id) {
              AsyncStorage.setItem(`node_pseudonym_${nodeActivationCode}`, serverNode.node_id).catch(() => {});
            }
            AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
              nodeType: serverNode.node_type,
              code: nodeActivationCode,
              pseudonym: serverNode.node_id || serverNode.pseudonym,
              timestamp: Date.now(),
              walletAddress: walletAddress
            })).catch(() => {});
            
            // Fetch server status inline
            try {
              const status = await checkServerNodeStatus(nodeActivationCode, serverNode.node_id);
              setServerNodeStatus(status);
              if (status.success) {
                AsyncStorage.setItem('qnet_cached_server_status', JSON.stringify({
                  ...status, cachedAt: Date.now()
                })).catch(() => {});
              }
            } catch (e) {
              // Will show "Connecting to node..." in UI
            }
            
            console.log(`[Nodes] Auto-linked ${serverNode.node_type} node`);
          }
        }
        
        // AUTO-LINK: Also check if wallet matches Genesis wallet (even if not in API response)
        if (!activatedNodeType && wallet) {
          // Pure-Dilithium genesis wallets: eon = SHA512(WALLET ML-DSA-65 pk),
          // byte-identical to generateQNetAddress and node GENESIS_WALLETS.
          const GENESIS_WALLETS = {
            '001': '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d',
            '002': 'c81f26da185fd05dcaeeona499b3d9e58d7ec75304f1b',
            '003': '006a5c220ca2fa77021eon2b5c6703999066d5411e2ff',
            '004': 'a60999a5a40637c1dd6eon975ca9618927edd7c19f38e',
            '005': '9dd783e0c65cf68467ceondfeaed5e1e47f0242f6aed9',
          };
          
          const userQNetAddress = (wallet.qnetAddress || wallet.address || '').toLowerCase();
          
          if (!userQNetAddress) {
            console.log('[Nodes] No QNet address available for Genesis check');
            return;
          }
          
          console.log(`[Nodes] Checking Genesis wallets. User QNet: ${userQNetAddress.substring(0, 20)}...`);
          console.log(`[Nodes] Full QNet address: ${userQNetAddress}`);
          
          // Check if wallet matches any Genesis wallet
          for (const [bootstrapId, genesisWallet] of Object.entries(GENESIS_WALLETS)) {
            const normalizedGenesis = genesisWallet.toLowerCase();
            
            // Strict equality only: app and node derive the identical pure-Dilithium
            // eon from one seed, so a legit operator matches exactly. A prefix/format
            // fallback could only false-positive (auto-link a non-genesis wallet).
            const isMatch = userQNetAddress === normalizedGenesis;
            if (isMatch) {
              console.log(`[Nodes] Exact match with Genesis ${bootstrapId}`);
            }

            if (isMatch) {
              // Wallet matches Genesis wallet - check if node is active via API
              const genesisNodeId = `genesis_node_${bootstrapId}`;
              const genesisCode = `QNET-BOOT-${bootstrapId}-STRAP`;
              
              console.log(`[Nodes] Wallet matches Genesis ${bootstrapId}, checking node status...`);
              
              try {
                // Check if Genesis node is active in network
                const status = await checkServerNodeStatus(genesisCode, genesisNodeId);
                
                if (status.success && status.isOnline) {
                  console.log(`[Nodes] Genesis node ${genesisNodeId} is active - auto-linking`);
                  
                  // Set ALL state at once to avoid intermediate renders
                  setActivationCode(genesisCode);
                  setActivatedNodeType('super');
                  setNodePseudonym(genesisNodeId);
                  // Reuse already-fetched status (no second network call needed)
                  setServerNodeStatus(status);
                  
                  // Save to AsyncStorage (parallel, non-blocking)
                  AsyncStorage.setItem(`node_pseudonym_${genesisCode}`, genesisNodeId).catch(() => {});
                  AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
                    nodeType: 'super',
                    code: genesisCode,
                    pseudonym: genesisNodeId,
                    isGenesis: true,
                    bootstrapId: bootstrapId,
                    timestamp: Date.now(),
                    walletAddress: wallet.qnetAddress || wallet.address
                  })).catch(() => {});
                  AsyncStorage.setItem('qnet_cached_server_status', JSON.stringify({
                    ...status,
                    cachedAt: Date.now()
                  })).catch(() => {});
                  
                  break; // Found matching Genesis node, stop checking
                }
              } catch (error) {
                console.log(`[Nodes] Genesis node ${genesisNodeId} check failed:`, error.message);
                // Continue checking other Genesis nodes
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to load all user nodes:', error);
    } finally {
      setLoadingAllNodes(false);
      setNodeInitializing(false);
    }
  };

  // Handle Light node reactivation ("I'm Back" button)
  const handleReactivateNode = async () => {
    if (reactivatingNode) return;

    setReactivatingNode(true);
    try {
      // If the local ping identity is gone (e.g. after a seed restore), a plain reactivate has no ping
      // key to sign with. Re-establish it first via registerNodeWithCode (restore-safe: re-finds the
      // burn on Solana, regenerates the ping delegation key signed by the restored wallet key, NO
      // re-burn), then refresh status.
      const localInfo = await AsyncStorage.getItem('qnet_light_node_info');
      if (!localInfo && activationCode && wallet) {
        // registerNodeWithCode returns {success:false,error} on failure (it does NOT throw), so we
        // MUST inspect the result — else a failed re-establish would falsely report Success and loop.
        // wallet_address MUST be the QNet EON (qnetAddress), never the Solana publicKey (server rejects).
        const res = await walletManager.registerNodeWithCode(activationCode, wallet.qnetAddress || wallet.address, password);
        if (res && res.success) {
          showAlert('Success', 'Node re-established on this device. Attestation will resume shortly.');
          await loadLightNodeStatus();
        } else {
          showAlert('Error', (res && res.error) || 'Could not re-establish node. Please try again.');
        }
        return;
      }
      // B: reactivation = self-attest. A forced self-attest records this-epoch eligibility on-chain, which
      // IS the return — no separate reactivate endpoint. Also refresh the FCM token (may have changed offline).
      const attested = await selfAttestIfNeeded(nodePseudonym, true);
      if (attested) {
        try {
          const nodeInfoStr = await AsyncStorage.getItem('qnet_light_node_info');
          if (nodeInfoStr) {
            const ni = JSON.parse(nodeInfoStr);
            if (ni.nodeId) await refreshFcmTokenOnServer(ni.nodeId);
          }
        } catch (_) { /* non-critical */ }
        showAlert('Success', 'Welcome back! Your node attested this epoch — it will show active shortly.');
        await loadLightNodeStatus();
      } else {
        showAlert('Error', 'Could not attest — check your connection and try again.');
      }
    } catch (error) {
      showAlert('Error', 'Network error. Please try again.');
    } finally {
      setReactivatingNode(false);
    }
  };
  
  // Load system-generated node pseudonym (read-only)
  const loadNodePseudonym = async (activationCode) => {
    if (!activationCode) return;
    
    try {
      const savedPseudonym = await AsyncStorage.getItem(`node_pseudonym_${activationCode}`);
      if (savedPseudonym) {
        setNodePseudonym(savedPseudonym);
      }
      // DO NOT auto-generate pseudonym - only set it after actual activation
    } catch (error) {
      // console.error('Failed to load node pseudonym:', error);
    }
  };
  
  // Handle node activation with code
  const handleNodeActivation = async () => {
    if (!activationInputCode || !activationInputCode.trim()) {
      showAlert('Error', 'Please enter activation code');
      return;
    }
    
    // Check if password is available (might be cleared after auto-lock)
    if (!password) {
      showAlert('Session Required', 'Please unlock your wallet first to activate the node');
      setShowActivationInput(false);
      return;
    }
    
    setNodeActivating(true);
    
    try {
      const code = activationInputCode.trim();
      
      // GENESIS NODE SUPPORT: Check if this is a Genesis bootstrap code
      // Format: QNET-BOOT-XXX-STRAP or QNET-BOOT-0XXX-STRAP (X = 1-5)
      // v2.66: Support both 3-digit (001) and 4-digit (0001) formats
      const genesisPattern = /^QNET-BOOT-0*([1-5])-STRAP$/;
      const genesisMatch = code.match(genesisPattern);
      
      if (genesisMatch) {
        // GENESIS NODE: Special handling
        const bootstrapId = genesisMatch[1].padStart(3, '0'); // "001", "002", etc.
        
        // SECURITY: Genesis nodes have PREDEFINED wallets
        // User's wallet MUST match the hardcoded wallet for this Genesis node
        // PRODUCTION: pure-Dilithium genesis wallets (19+3+15+8=45 chars).
        // eon = SHA512(WALLET ML-DSA-65 pk); MUST equal node GENESIS_WALLETS.
        const GENESIS_WALLETS = {
          '001': '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d',
          '002': 'c81f26da185fd05dcaeeona499b3d9e58d7ec75304f1b',
          '003': '006a5c220ca2fa77021eon2b5c6703999066d5411e2ff',
          '004': 'a60999a5a40637c1dd6eon975ca9618927edd7c19f38e',
          '005': '9dd783e0c65cf68467ceondfeaed5e1e47f0242f6aed9',
        };
        
        const expectedWallet = GENESIS_WALLETS[bootstrapId];
        
        // SECURITY: Get user's QNet address for comparison
        // QNet addresses contain "eon" marker and are 45 characters
        // Format: 19chars + "eon" + 15chars + 8char_checksum
        const userQNetAddress = wallet.qnetAddress || wallet.address;
        
        if (!userQNetAddress) {
          throw new Error('Wallet address not found. Please reload your wallet.');
        }
        
        // Normalize both for comparison (lowercase)
        const normalizedUser = userQNetAddress.toLowerCase();
        const normalizedExpected = expectedWallet.toLowerCase();
        
        // Node credits genesis rewards to GENESIS_WALLETS[id] via exact match,
        // so the app enforces the same. Node and app now derive the identical
        // pure-Dilithium eon from one seed, so a legit operator's address equals
        // the constant exactly; any mismatch is a different wallet — reject.
        if (normalizedUser !== normalizedExpected) {
          throw new Error(
            `This Genesis code belongs to a different wallet.\n\n` +
            `Expected: ${expectedWallet}\n` +
            `Your wallet: ${userQNetAddress}\n\n` +
            `Genesis nodes are cryptographically bound to specific wallets.\n` +
            `Only the original wallet owner can access this node.`
          );
        }
        
        console.log('[GENESIS] Wallet verification passed for node', bootstrapId);
        
        // Genesis node verified - set up as Super node
        setActivationCode(code);
        setActivatedNodeType('super'); // Genesis nodes are Super nodes
        setNodePseudonym(`genesis_node_${bootstrapId}`);
        
        // Save to AsyncStorage
        await AsyncStorage.setItem(`node_pseudonym_${code}`, `genesis_node_${bootstrapId}`);
        await AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
          nodeType: 'super',
          code: code,
          pseudonym: `genesis_node_${bootstrapId}`,
          isGenesis: true,
          bootstrapId: bootstrapId,
          timestamp: Date.now(),
          walletAddress: wallet.qnetAddress || wallet.address
        }));
        
        // Load server status immediately
        loadServerNodeStatus();
        
        showAlert(
          'Genesis Node Connected!',
          `Successfully connected to Genesis Node #${bootstrapId}.\n\n` +
          `Node ID: genesis_node_${bootstrapId}\n` +
          `Type: Super (Bootstrap)\n\n` +
          `You can now monitor your node and claim rewards.`,
          [{ text: 'OK', onPress: () => {
            setShowActivationInput(false);
            setActivationInputCode('');
          }}]
        );
        
        setNodeActivating(false);
        return;
      }
      
      // REGULAR NODE: Validate code format (QNET-XXXXXX-XXXXXX-XXXXXX)
      const codePattern = /^QNET-[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/;
      if (!codePattern.test(code)) {
        throw new Error('Invalid activation code format. Expected: QNET-XXXXXX-XXXXXX-XXXXXX');
      }
      
      // Register node with backend (system generates pseudonym automatically)
      // wallet_address = EON (for rewards), burn_wallet = Solana (for XOR verification)
      // Phase 1 codes are XOR-encrypted with SOLANA address, but rewards go to EON
      const walletAddress = wallet.qnetAddress || wallet.address;
      const result = await walletManager.registerNodeWithCode(
        activationInputCode.trim(),
        walletAddress,
        password
      );
      
      if (result.success) {
        // Store activation locally
        const nodeType = result.nodeType || 'light';
        // Note: 'code' already defined at start of try block
        setActivationCode(code);
        setActivatedNodeType(nodeType);
        setNodePseudonym(result.pseudonym); // Store system-generated pseudonym
        
        // Save pseudonym to AsyncStorage for persistence
        await AsyncStorage.setItem(`node_pseudonym_${code}`, result.pseudonym);
        
        // Save complete activation state for quick restore
        await AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
          nodeType: nodeType,
          code: code,
          pseudonym: result.pseudonym,
          timestamp: Date.now(),
          burnTxHash: result.burnTxHash || 'registered',
          walletAddress: wallet.qnetAddress || wallet.address
        }));

        if (result.alreadyRegistered) {
          // Already on-chain and durable. B: force a self-attest so it records this-epoch eligibility
          // now and starts earning immediately, instead of waiting for the next ping.
          try { await selfAttestIfNeeded(result.pseudonym, true); } catch (_) {}
          showAlert(
            'Node Restored!',
            `Your existing ${nodeType} node has been reactivated and restored.\n\nNode ID: ${activationInputCode.trim()}\nSystem ID: ${result.pseudonym}`,
            [{ text: 'OK', onPress: () => {
              setShowActivationInput(false);
              setActivationInputCode('');
            }}]
          );
        } else {
          showAlert(
            'Node Activated!',
            `Your ${nodeType} node has been successfully activated and registered in the network.\n\nNode ID: ${activationInputCode.trim()}\nSystem ID: ${result.pseudonym}`,
            [{ text: 'OK', onPress: () => {
              setShowActivationInput(false);
              setActivationInputCode('');
            }}]
          );
        }
      } else {
        throw new Error(result.error || 'Failed to activate node');
      }
    } catch (error) {
      const msg = (error.message || '').toLowerCase();
      
      // User-friendly error messages for known activation failures
      // PRIORITY: "wrong wallet" checks FIRST — catches all variations including wrapped Dilithium3 errors
      if (msg.includes('belongs to different wallet') || 
          msg.includes('invalid activation code') ||
          msg.includes('code belongs') ||
          msg.includes('not found or does not match')) {
        showAlert(
          'Code Mismatch',
          'This activation code does not belong to this wallet.\n\n' +
          'Each activation code is cryptographically bound to the wallet that burned 1DEV tokens. ' +
          'You can only activate a node using the same wallet that received the code.\n\n' +
          'If you lost access to the original wallet, you will need to burn tokens again from this wallet to get a new code.'
        );
      } else if (msg.includes('invalid') && msg.includes('format')) {
        showAlert(
          'Invalid Code Format',
          'The activation code format is incorrect.\n\nExpected format: QNET-XXXXXX-XXXXXX-XXXXXX\n\nPlease check your code and try again.'
        );
      } else if (msg.includes('already registered') || msg.includes('already activated') || msg.includes('already exists')) {
        showAlert(
          'Already Activated',
          'This activation code has already been used to register a node.\n\nEach code can only be used once.'
        );
      } else if (msg.includes('expired') || msg.includes('expir')) {
        showAlert(
          'Code Expired',
          'This activation code has expired.\n\nPlease burn tokens again to obtain a new activation code.'
        );
      } else if (
          msg.includes('burn transaction not found') ||
          msg.includes('not indexed yet') ||
          msg.includes('solana rpc') ||
          msg.includes('burn verification failed') ||
          msg.includes('insufficient amount on solana')
        ) {
        showAlert(
          'Burn Not Confirmed Yet',
          'The Solana network has not yet confirmed your burn transaction.\n\n' +
          'This usually resolves within 30–60 seconds. Please wait a moment and try activating again.\n\n' +
          'Your activation code is saved — no need to burn tokens again.'
        );
      } else if (msg.includes('network') || msg.includes('timeout') || msg.includes('fetch') || msg.includes('econnrefused')) {
        showAlert(
          'Network Error',
          'Could not connect to the QNet network.\n\nPlease check your internet connection and try again.'
        );
      } else if (msg.includes('dilithium') || msg.includes('quantum signature') || msg.includes('signature')) {
        const detail = error.message || '';
        showAlert(
          'Signature Error',
          'Failed to create quantum-secure signature for node registration.\n\n' +
          (detail ? `Details: ${detail}\n\n` : '') +
          'Please try again. If the problem persists, restart the app.'
        );
      } else {
        showAlert(
          'Activation Failed',
          error.message || 'Unable to activate node. Please check your code and try again.'
        );
      }
    } finally {
      setNodeActivating(false);
    }
  };
  
  // No automatic ping interval - user can manually refresh via pull-to-refresh
  
  // Get the correct wallet address for claims based on activation phase and node type
  // SECURITY: Different node types use different wallet address formats
  // - Genesis nodes: ALWAYS use QNet address (must match genesis_constants.rs)
  // Server validates EON format ({19}eon{15}{4 checksum}) for ALL reward claims.
  // Always return wallet.qnetAddress regardless of node type or activation phase.
  const getWalletAddressForClaim = async () => {
    const qnetAddr = wallet.qnetAddress;
    if (!qnetAddr) {
      throw new Error('QNet EON address required for reward claims');
    }
    console.log('[CLAIM] Using QNet EON address:', qnetAddr);
    return qnetAddr;
  };
  
  // Open Send Screen from Assets (click on token) - inline, not modal
  // Open the Send screen. For QRC-20 tokens, pass the extra `token` descriptor
  // { contract, decimals } so handleSendTransaction can route through qrc20Transfer and
  // scale the amount by the token's OWN decimals. Native QNC/SOL omit it (contract stays null).
  const openSendModal = (tokenSymbol, tokenBalance, network, token = null) => {
    setSendingToken({
      symbol: tokenSymbol,
      balance: tokenBalance,
      network: network,
      contract: token ? token.contract : null,
      decimals: token ? token.decimals : null,
    });
    setSendAddress('');
    setSendAmount('');
    setTxResult(null);
    setShowSendScreen(true);
  };
  
  // Open / close the Add-Custom-Token modal.
  const openAddTokenModal = () => {
    setAddTokenAddress('');
    setAddTokenError('');
    setAddingToken(false);
    setShowAddTokenModal(true);
  };
  const closeAddTokenModal = () => {
    setShowAddTokenModal(false);
    setAddTokenAddress('');
    setAddTokenError('');
    setAddingToken(false);
  };

  // Validate a pasted contract address, resolve its token metadata via getTokenInfo, persist it to
  // AsyncStorage 'qnet_custom_tokens' (deduped by contract_address), merge it into the Assets list,
  // and fetch its balance for the current wallet.
  const handleAddCustomToken = async (contractArg) => {
    if (addingToken) return;
    const contract = ((typeof contractArg === 'string' ? contractArg : '') || addTokenAddress || '').trim();
    if (!contract) { setAddTokenError('Enter a contract address'); return; }
    // QNet contract addresses are 64-char hex (derive_contract_address → SHA3-256 hex).
    if (!/^[0-9a-fA-F]{64}$/.test(contract)) {
      setAddTokenError('Invalid contract address (must be 64 hex characters)');
      return;
    }
    setAddingToken(true);
    setAddTokenError('');
    try {
      const info = await walletManager.getTokenInfo(contract);
      if (!info) {
        setAddTokenError('No token found at this address');
        setAddingToken(false);
        return;
      }
      const entry = {
        contract_address: contract,
        contract,
        name: info.name,
        symbol: info.symbol,
        decimals: info.decimals,
        logo: info.logo || '',
      };
      // Persist (dedupe by contract_address).
      let persisted = [];
      try {
        const raw = await AsyncStorage.getItem('qnet_custom_tokens');
        persisted = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(persisted)) persisted = [];
      } catch (_) { persisted = []; }
      if (!persisted.some((t) => (t.contract_address || t.contract) === contract)) {
        persisted.push(entry);
        await AsyncStorage.setItem('qnet_custom_tokens', JSON.stringify(persisted));
      }
      setCustomTokens(persisted);

      // Fetch this token's balance for the current wallet and merge into the Assets list.
      const qnetAddr = wallet?.qnetAddress || (await walletManager.getCurrentWallet())?.qnetAddress;
      let balanceStr = '0';
      if (qnetAddr) {
        const bal = await walletManager.getTokenBalanceOf(contract, qnetAddr, info.decimals);
        if (bal.balance != null) balanceStr = bal.balance;
      }
      setQrcTokens((prev) => {
        const next = prev.filter((t) => t.contract !== contract);
        next.push({ contract, name: info.name, symbol: info.symbol, decimals: info.decimals, balance: balanceStr, logo: info.logo || '' });
        return next;
      });
      setTokenMgrQuery('');   // clear search so the just-added token shows in the tracked list
      closeAddTokenModal();
    } catch (e) {
      setAddTokenError(e.message || 'Failed to add token');
      setAddingToken(false);
    }
  };

  // Close Send Screen and go back to assets
  const closeSendScreen = () => {
    setShowSendScreen(false);
    setSendingToken(null);
    setTxResult(null);
    setSendAddress('');
    setSendAmount('');
  };

  // Android hardware-back: dismiss the topmost open overlay/modal instead of exiting the app.
  // Returns true (handled) while anything is open; on the home tab returns false so the OS can exit.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const onBack = () => {
      if (customAlert) { setCustomAlert(null); return true; }
      if (showTermsModal) { setShowTermsModal(false); return true; }
      if (showBiometricPasswordPrompt) { setShowBiometricPasswordPrompt(false); return true; }
      if (showActivationInput) { setShowActivationInput(false); return true; }
      if (showChangePassword) { setShowChangePassword(false); return true; }
      if (showExportSeed) { setShowExportSeed(false); return true; }
      if (showExportActivation) { setShowExportActivation(false); return true; }
      if (showAutoLockPicker) { setShowAutoLockPicker(false); return true; }
      if (showLanguagePicker) { setShowLanguagePicker(false); return true; }
      if (showSeedConfirm) { setShowSeedConfirm(false); return true; }
      if (showAddTokenModal) { closeAddTokenModal(); return true; }
      if (showTokenManager) { setShowTokenManager(false); return true; }
      if (showHeaderMenu) { setShowHeaderMenu(false); return true; }
      if (showSendScreen) { closeSendScreen(); return true; }
      if (showSettings) { setShowSettings(false); return true; }
      // Pre-wallet onboarding full-screens: back steps in instead of exiting the app,
      // mirroring the in-form Back buttons (import step 2 → step 1, else → landing).
      if (showCreateOptions) {
        if (showCreateOptions === 'import' && importStep === 2) {
          setImportStep(1); setSeedPhrase(''); setPasswordError(''); setTermsAccepted(false);
        } else {
          setShowCreateOptions(false);
          setPassword(''); setConfirmPassword(''); setSeedPhrase('');
          setPasswordError(''); setTermsAccepted(false); setImportStep(1);
        }
        return true;
      }
      if (activeTab && activeTab !== 'assets') { setActiveTab('assets'); return true; }
      return false; // nothing open on the home tab → let the OS exit the app
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [
    customAlert, showTermsModal, showBiometricPasswordPrompt, showActivationInput,
    showChangePassword, showExportSeed, showExportActivation, showAutoLockPicker,
    showLanguagePicker, showSeedConfirm, showSendScreen, showSettings,
    showCreateOptions, importStep, activeTab, showAddTokenModal,
    showTokenManager, showHeaderMenu,
  ]);


  // v2.101: Validate amount input - international standard (dot separator, max 6 decimals)
  const validateAmountInput = (text) => {
    // Replace comma with dot (for locales that use comma)
    let normalized = text.replace(',', '.');
    
    // Remove any non-numeric characters except dot
    normalized = normalized.replace(/[^\d.]/g, '');
    
    // Ensure only one decimal point
    const parts = normalized.split('.');
    if (parts.length > 2) {
      normalized = parts[0] + '.' + parts.slice(1).join('');
    }
    
    // Limit decimal places (6 for display, blockchain uses 9 internally)
    if (parts.length === 2 && parts[1].length > 6) {
      normalized = parts[0] + '.' + parts[1].substring(0, 6);
    }
    
    // Prevent leading zeros (except for "0." pattern)
    if (normalized.length > 1 && normalized[0] === '0' && normalized[1] !== '.') {
      normalized = normalized.substring(1);
    }
    
    setSendAmount(normalized);
  };
  
  // Set amount as percentage of balance
  const setAmountPercentage = (percentage) => {
    if (!sendingToken) return;
    const amount = (sendingToken.balance * percentage / 100).toFixed(sendingToken.symbol === 'QNC' ? 5 : 6);
    setSendAmount(amount);
  };
  
  // QNet transaction fee constants (matching blockchain MIN_GAS_PRICE = BASE_FEE / TRANSFER_gas)
  const QNET_GAS_PRICE = 10; // nanoQNC/gas
  const QNET_GAS_LIMIT = 10000; // for transfers
  const QNET_TX_FEE = (QNET_GAS_PRICE * QNET_GAS_LIMIT) / 1_000_000_000; // 0.0001 QNC
  
  // v3.34: Poll TX status until confirmed
  // ARCHITECTURE: Polling only updates UI status (confirming → confirmed)
  // It does NOT clear pendingTxRef — that's loadBalance's job!
  // WHY: Polling may confirm TX on Node 1, but loadBalance queries Node 3
  // which hasn't received the block yet → stale balance without protection.
  // loadBalance clears pendingTxRef ONLY when the queried node's balance
  // actually reflects the TX (qncBalance <= expectedQnc).
  const startTxConfirmationPolling = (txHash, expectedBalance, previousBalance) => {
    // Clear any existing polling (clearTimeout also cancels a setInterval handle)
    if (txPollingRef.current) {
      clearTimeout(txPollingRef.current);
      txPollingRef.current = null;
    }

    // v3.31: Use discovered nodes (not hardcoded Genesis!)
    const allNodes = walletManager.getAvailableNodes();

    let attempts = 0;
    // Self-scheduling backoff: start at 2s, grow ×1.5 up to a 15s cap, and stop
    // at a wall-clock deadline. This avoids an endless fixed-cadence spinner and
    // spaces out requests as confirmation takes longer, instead of a hard 60s cliff.
    const baseDelayMs = 2000;
    const maxDelayMs = 15000;
    const deadline = Date.now() + 180000; // ~3 min total, then declare "still pending"

    const finishStillPending = () => {
      // Deadline reached without confirmation: don't hang the UI on an infinite
      // spinner. Drop the optimistic hold and surface an explicit pending state.
      pendingTxRef.current = null;
      txPollingRef.current = null;
      setTxResult(prev => prev?.txHash === txHash ? { ...prev, confirming: false, stillPending: true } : prev);
      updateTxStatus(txHash, 'pending');
      if (wallet?.publicKey) {
        loadBalance(wallet.publicKey);
      }
    };

    const poll = async () => {
      attempts++;

      // Rotate through nodes on each attempt for better reliability
      const nodeIndex = (attempts - 1) % allNodes.length;
      const apiUrl = allNodes[nodeIndex];

      try {
        // Check TX status via API
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(`${apiUrl}/api/v1/transaction/${txHash}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const txData = await response.json();

          // v3.34: FIX — Check transaction object AND status, not tx_hash!
          // BEFORE: txData.tx_hash was ALWAYS present (even when not_found) → false positive
          // NOW: Check that transaction object exists AND status is not "not_found"
          const txFound = txData && txData.transaction && txData.status !== 'not_found';
          if (txFound) {
            // v3.34: DON'T clear pendingTxRef here!
            // loadBalance will clear it when the queried node's balance catches up.
            // This prevents the bounce: polling confirms on Node 1, but loadBalance
            // queries Node 3 which still has old balance → stale data without protection.

            // Stop polling (TX is confirmed, no need to keep checking)
            txPollingRef.current = null;

            // Update txResult to show confirmed
            setTxResult(prev => prev?.txHash === txHash
              ? { ...prev, confirming: false, confirmed: true }
              : prev
            );

            // v3.30: Update TX history status
            updateTxStatus(txHash, 'confirmed');

            // Trigger balance refresh (loadBalance will handle pendingTxRef clearing)
            if (wallet?.publicKey) {
              loadBalance(wallet.publicKey);
            }

            // v3.35: Refresh full TX history from blockchain
            // This ensures the confirmed TX appears with correct block data
            loadTxHistory();
            return;
          }
        }
      } catch (error) {
        // Network error - will try next node on next reschedule
      }

      // TX not found yet — reschedule with backoff until the deadline.
      if (Date.now() >= deadline) {
        finishStillPending();
        return;
      }
      const nextDelay = Math.min(baseDelayMs * Math.pow(1.5, attempts - 1), maxDelayMs);
      txPollingRef.current = setTimeout(poll, nextDelay);
    };

    txPollingRef.current = setTimeout(poll, baseDelayMs);
  };
  
  // Send QNC transaction (real blockchain transaction)
  const handleSendTransaction = async () => {
    if (!sendAddress || !sendAmount || sendingTransaction) return;
    
    const amount = parseFloat(sendAmount);
    if (isNaN(amount) || amount <= 0) {
      setTxResult({ success: false, error: 'Please enter a valid amount' });
      return;
    }

    // QRC-20 gas is paid in QNC (separate balance), NOT in the token itself — so a token send only
    // needs `amount` of the token, while native QNC needs amount + fee. Guard each accordingly.
    const isTokenSend = sendingToken.network === 'qnet' && !!sendingToken.contract;
    if (isTokenSend) {
      if (amount > sendingToken.balance) {
        setTxResult({
          success: false,
          error: `Insufficient balance. Need ${amount} ${sendingToken.symbol}.\nYour balance: ${sendingToken.balance} ${sendingToken.symbol}`,
        });
        return;
      }
    } else {
      // Calculate total cost (amount + fee) for the native asset
      const totalCost = amount + QNET_TX_FEE;
      if (totalCost > sendingToken.balance) {
        setTxResult({
          success: false,
          error: `Insufficient balance. Need ${totalCost.toFixed(6)} ${sendingToken.symbol} (including fee).\nYour balance: ${sendingToken.balance.toFixed(6)} ${sendingToken.symbol}`,
        });
        return;
      }
    }
    
    // Validate address format for QNet EON: 45 chars, 'eon' marker at the fixed offset (matches the
    // strict positional check in sendQNC; the 8-char SHA3 checksum is re-verified there pre-signing).
    if (sendingToken.network === 'qnet') {
      const isValidEon = sendAddress.length === 45 && sendAddress.slice(19, 22) === 'eon';
      const isValidHex = /^[0-9a-fA-F]{64}$/.test(sendAddress);

      if (!isValidEon && !isValidHex) {
        setTxResult({
          success: false,
          error: 'Invalid address format.\nMust be EON (45 chars) or Hex (64 chars)'
        });
        return;
      }
    }
    
    setSendingTransaction(true);
    try {
      if (isTokenSend) {
        // QRC-20 transfer: scale the human amount by the TOKEN's decimals to u64 base units
        // (BigInt/string math, no float), then call the byte-correct qrc20Transfer SDK. Gas is
        // paid in QNC by the node; the token balance only drops by `amount`.
        const decimals = sendingToken.decimals || 0;
        const amountBaseUnits = walletManager.toBaseUnits(sendAmount, decimals); // string
        const result = await walletManager.qrc20Transfer(
          sendingToken.contract,
          sendAddress,
          amountBaseUnits,
          password
        );
        // buildContractCall returns the node's { tx_hash, success, ... } (or throws on non-accept).
        const txHash = result.tx_hash || result.txHash;
        setTxResult({
          success: true,
          txHash,
          amount,
          to: sendAddress,
          symbol: sendingToken.symbol,
          confirming: true,
        });
        // Show the transfer in history immediately as a pending TOKEN row (icon + amount + symbol).
        if (txHash) {
          addPendingTxToHistory(txHash, sendAddress, amount, 0, {
            contract: sendingToken.contract,
            symbol: sendingToken.symbol,
            logo: sendingToken.logo,
            decimals,
            rawBaseUnits: amountBaseUnits,
          });
        }
        // Optimistic balance update using the TOKEN's decimals (string math): subtract the sent
        // base units from the current base units, then merge back into the Assets list row.
        setQrcTokens((prev) => prev.map((t) => {
          if (t.contract !== sendingToken.contract) return t;
          try {
            const curBase = BigInt(walletManager.toBaseUnits(String(t.balance || '0'), decimals));
            const sentBase = BigInt(amountBaseUnits);
            const nextBase = curBase > sentBase ? (curBase - sentBase) : 0n;
            return { ...t, balance: walletManager._formatBaseUnits(nextBase.toString(), decimals) };
          } catch (_) {
            return t;
          }
        }));
        return;
      }

      // Get wallet address
      const fromAddress = sendingToken.network === 'qnet'
        ? (wallet.qnetAddress || wallet.address)
        : (wallet.solanaAddress || wallet.address);

      // Call WalletManager to send transaction
      const result = await walletManager.sendTransaction(
        fromAddress,
        sendAddress,
        amount,
        sendingToken.symbol,
        password
      );

      if (result.success) {
        const previousBalance = sendingToken.balance;
        const expectedBalance = sendingToken.symbol === 'QNC'
          ? Math.max(0, previousBalance - amount - QNET_TX_FEE)
          : previousBalance;

        // Show success with "confirming" status
        setTxResult({
          success: true,
          txHash: result.txHash,
          amount: amount,
          to: sendAddress,
          symbol: sendingToken.symbol,
          confirming: true // Shows "Confirming..." in UI
        });

        // v3.29: Set pending TX state
        if (sendingToken.symbol === 'QNC') {
          pendingTxRef.current = {
            txHash: result.txHash,
            expectedQnc: expectedBalance,
            previousQnc: previousBalance,
            timestamp: Date.now(),
            status: 'pending'
          };

          // Immediately show expected balance (optimistic update)
          setTokenBalances(prev => ({
            ...prev,
            qnc: expectedBalance
          }));

          // v3.30: Add to TX history with pending status
          addPendingTxToHistory(result.txHash, sendAddress, amount, QNET_TX_FEE);

          // Start polling for TX confirmation
          startTxConfirmationPolling(result.txHash, expectedBalance, previousBalance);
        }
      } else {
        // TX rejected by node - no pending state needed
        setTxResult({ success: false, error: result.error || 'Transaction failed' });
      }
    } catch (error) {
      // TX failed to send
      setTxResult({ success: false, error: error.message || 'Transaction failed' });
    } finally {
      setSendingTransaction(false);
    }
  };
  
  // Claim rewards for Server nodes (Super/Genesis) - uses server-side pending rewards
  const handleClaimServerNodeRewards = async () => {
    const pendingRewards = serverNodeStatus?.pendingRewards || 0;
    if (pendingRewards <= 0 || processingValidation) return;
    
    setProcessingValidation(true);
    try {
      // Get correct wallet address based on activation phase
      const walletAddress = await getWalletAddressForClaim();
      const actualNodeId = serverNodeStatus?.nodeId || nodePseudonym || null;
      const result = await walletManager.claimRewards(
        activatedNodeType, 
        activationCode, 
        walletAddress, 
        password,
        pendingRewards,
        actualNodeId
      );
      
      if (result.success) {
        const claimedAmount = (pendingRewards / 1e9).toFixed(4);
        
        // v2.80: Rich content with clickable transaction hash
        const richContent = (
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={[styles.modalContent, { textAlign: 'center', marginBottom: 16 }]}>
              Successfully claimed {claimedAmount} QNC rewards from your {activatedNodeType} node.
            </Text>
            <Text style={[styles.modalContent, { textAlign: 'center', marginBottom: 8, fontSize: 12, color: '#888' }]}>
              Transaction:
            </Text>
            <TouchableOpacity 
              onPress={() => {
                const explorerUrl = `https://explorer.qnet.network/tx/${result.txHash}`;
                Linking.openURL(explorerUrl).catch(() => {
                  Clipboard.setString(result.txHash);
                  showAlert('Copied', 'Transaction hash copied to clipboard');
                });
              }}
              style={{ backgroundColor: 'rgba(0, 255, 255, 0.1)', padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#00ffff40' }}
            >
              <Text style={{ color: '#00ffff', fontSize: 12, fontFamily: 'monospace', textAlign: 'center' }}>
                {result.txHash?.slice(0, 20)}...{result.txHash?.slice(-20)}
              </Text>
              <Text style={{ color: '#888', fontSize: 10, textAlign: 'center', marginTop: 4 }}>
                Tap to open in Explorer
              </Text>
            </TouchableOpacity>
          </View>
        );
        
        showAlert(
          'Rewards Claimed!',
          '', // Empty - using richContent
          [
            { text: 'Copy Hash', style: 'default', onPress: () => {
              Clipboard.setString(result.txHash);
              showAlert('Copied', 'Transaction hash copied to clipboard');
            }},
            { text: 'OK', onPress: () => {
              // Reload server node status (will show updated pending rewards)
              loadServerNodeStatus();
              // Reload balance
              if (wallet && wallet.publicKey) {
                loadBalance(wallet.publicKey);
              }
            }}
          ],
          richContent
        );
      } else {
        showAlert('Cannot Claim', result.message);
      }
    } catch (error) {
      showAlert('Error', 'Failed to claim rewards: ' + error.message);
    } finally {
      setProcessingValidation(false);
    }
  };

  // Translation function
  const t = (key) => {
    return translations[language]?.[key] || translations['en'][key] || key;
  };

  const loadSettings = async () => {
    try {
      const [savedAutoLockTime, savedLanguage] = await Promise.all([
        AsyncStorage.getItem('qnet_autolock_time'),
        AsyncStorage.getItem('qnet_language')
      ]);
      
      if (savedAutoLockTime) setAutoLockTime(savedAutoLockTime);
      if (savedLanguage) setLanguage(savedLanguage);
    } catch (error) {
      // Silent fail - use defaults
    }
  };

  const saveAutoLockTime = async (time) => {
    try {
      await AsyncStorage.setItem('qnet_autolock_time', time);
      setAutoLockTime(time);
      setShowAutoLockPicker(false);
    } catch (error) {
      showAlert(t('error'), 'Failed to save setting');
    }
  };

  const saveLanguage = async (lang) => {
    try {
      await AsyncStorage.setItem('qnet_language', lang);
      setLanguage(lang);
    } catch (error) {
      showAlert(t('error'), 'Failed to save language');
    }
  };

  // Auto-lock timer
  useEffect(() => {
    if (wallet && hasWallet && autoLockTime !== 'never') {
      // Use a ref to track last activity time to avoid re-creating the interval
      const lastActivityRef = { current: Date.now() };
      
      // Reset timer on any activity (local ref only — no setState, which would re-render the whole screen on every touch)
      const resetTimer = () => {
        lastActivityRef.current = Date.now();
      };

      // Add global touch listener for activity tracking
      const touchListener = () => resetTimer();
      
      // Subscribe to touch events
      const subscription = DeviceEventEmitter.addListener('userActivity', touchListener);

      // Start auto-lock check
      const checkAutoLock = setInterval(() => {
        const now = Date.now();
        const inactiveTime = now - lastActivityRef.current;
        const lockTimeMs = parseInt(autoLockTime) * 60 * 1000; // Convert minutes to ms

        if (inactiveTime >= lockTimeMs) {
          // Lock wallet silently
          setWallet(null);
          // Don't reset activatedNodeType and activationCode - they should persist
          // setActivatedNodeType(null);
          // setActivationCode(null);
          setPassword(''); // Clear password on auto-lock for security
          // Don't show alert - user will see unlock screen
        }
      }, 10000); // Check every 10 seconds

      return () => {
        clearInterval(checkAutoLock);
        subscription?.remove();
      };
    }
  }, [wallet, hasWallet, autoLockTime]);

  // Auto-refresh balance every 5 seconds when in assets tab
  useEffect(() => {
    if (wallet && wallet.publicKey && activeTab === 'assets') {
      // Load balance immediately
      loadBalance(wallet.publicKey);

      // Set up auto-refresh only for assets tab - less frequent to improve performance
      const balanceInterval = setInterval(() => {
        if (wallet && wallet.publicKey && activeTab === 'assets') {
          loadBalance(wallet.publicKey);
        }
      }, 15000); // Refresh every 15 seconds instead of 5

      return () => {
        clearInterval(balanceInterval);
        // v3.29: Also cleanup TX polling on tab change/unmount
        if (txPollingRef.current) {
          clearInterval(txPollingRef.current);
          txPollingRef.current = null;
        }
      };
    }
  }, [wallet, isTestnet, selectedNetwork, activeTab]); // Reload on any network or tab change

  // v3.35: Auto-refresh TX history when on History tab
  // Without this, TX history only refreshes on manual pull-to-refresh or tab click
  // With WebSocket fix (NewBlock events), most updates come via WS,
  // but this timer serves as a reliable fallback
  useEffect(() => {
    if (wallet?.qnetAddress && activeTab === 'history') {
      // Load immediately when switching to history tab
      loadTxHistory();
      
      const historyInterval = setInterval(() => {
        if (wallet?.qnetAddress && activeTab === 'history') {
          loadTxHistory();
        }
      }, 10000); // Refresh every 10 seconds when on History tab
      
      return () => clearInterval(historyInterval);
    }
  }, [wallet, activeTab]);

  // Check for existing activation codes when wallet is loaded
  useEffect(() => {
    const checkActivationStatus = async () => {
      if (wallet && wallet.address && password) {
        try {
          // Priority 1: Check qnet_last_activated_node (includes burn evidence)
          // CRITICAL: Must verify the saved state belongs to THIS wallet, not a different one
          const currentAddr = wallet.qnetAddress || wallet.address;
          const savedState = await AsyncStorage.getItem('qnet_last_activated_node');
          if (savedState) {
            const state = JSON.parse(savedState);
            if (state.nodeType && state.code) {
              // Verify wallet ownership — saved data must belong to current wallet
              // If walletAddress is missing (old data) or doesn't match — don't trust it
              if (!state.walletAddress || state.walletAddress !== currentAddr) {
                console.log('[checkActivationStatus] Saved activation has no wallet tag or belongs to different wallet, ignoring');
                // Don't load — user can recover via "Recover My Code"
              } else {
                setActivatedNodeType(state.nodeType);
                setActivationCode(state.code);
                if (state.pseudonym) setNodePseudonym(state.pseudonym);
                return; // Trust saved state — it includes burnTxHash evidence
              }
            }
          }
          
          // Priority 2: Check encrypted stored codes
          const storedCodes = await walletManager.getStoredActivationCodes(password);
          if (storedCodes && Object.keys(storedCodes).length > 0) {
            const nodeType = Object.keys(storedCodes)[0];
            const code = storedCodes[nodeType];
            const codeStr = code?.code || (typeof code === 'string' ? code : '');
            
            if (codeStr) {
                    setActivatedNodeType(nodeType);
              setActivationCode(codeStr);
              // Re-persist to qnet_last_activated_node for consistency
              await AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
                nodeType, code: codeStr, timestamp: Date.now(),
                burnTxHash: code?.burnTxHash || 'stored',
                walletAddress: currentAddr
              }));
              return;
            }
          }
          
          // No activation data found — state stays as-is (don't forcefully clear)
          // Other mechanisms (wallet unlock verify) will handle truly stale data
        } catch (error) {
          // On error, don't clear — keep current state to avoid data loss
          console.log('[checkActivationStatus] Error, keeping current state:', error.message);
        }
      }
    };
    
    checkActivationStatus();
  }, [wallet, password]);

  // Sync activation codes + auto-refresh FCM token on foreground
  useEffect(() => {
    const handleAppStateChange = async (nextAppState) => {
      if (nextAppState !== 'active' || !wallet || !wallet.publicKey || !password) return;

      // ── 1. Activation code sync ──
      try {
        const mnemonic = await walletManager.getEncryptedMnemonic(password);
        if (mnemonic) {
          const syncedCodes = await walletManager.syncActivationCodes(
            wallet.publicKey,
            mnemonic,
            password
          );
          if (syncedCodes && Object.keys(syncedCodes).length > 0) {
            const nodeType = Object.keys(syncedCodes)[0];
            const codeData = syncedCodes[nodeType];
            const codeStr = typeof codeData === 'string' ? codeData : (codeData?.code || '');
            const isHashOnly = typeof codeStr === 'string' && codeStr.startsWith('HASH:');
            const isPending = codeData?.status === 'pending_activation';
            if (!isHashOnly && !isPending && codeStr) {
              setActivatedNodeType(nodeType);
              setActivationCode(codeStr);
            }
          }
        }
      } catch (_) { /* silent */ }

      // ── 2. FCM token auto-refresh (debounced, lightweight) ──
      try {
        const needed = await isTokenRefreshNeeded();
        if (!needed) return;

        const nodeInfoStr = await AsyncStorage.getItem('qnet_light_node_info');
        if (!nodeInfoStr) return;
        const nodeInfo = JSON.parse(nodeInfoStr);
        if (!nodeInfo.nodeId) return;

        // Auth is rooted in the Dilithium ping-delegation key inside
        // refreshFcmTokenOnServer — no wallet-seed gossip keypair derivation needed.
        await refreshFcmTokenOnServer(nodeInfo.nodeId);
      } catch (_) { /* silent — next foreground will retry */ }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => { subscription.remove(); };
  }, [wallet, password]);

  // v3.31: Initialize node discovery + WebSocket + TX history when wallet ready
  useEffect(() => {
    if (wallet?.qnetAddress) {
      // Wallet switch: drop the previous wallet's history (incl. its pending TXs) immediately.
      setTxHistory([]);
      pendingTxRef.current = null;

      // Load cached nodes and trigger discovery for load balancing
      walletManager.loadNodesFromCache().then(() => {
        walletManager.refreshNodeDiscovery();
      });

      // Connect WebSocket for real-time notifications
      connectWebSocket();

      // Load TX history
      loadTxHistory();
      
      return () => {
        wsShouldReconnectRef.current = false; // stop any resurrecting reconnect
        if (wsReconnectTimerRef.current) { clearTimeout(wsReconnectTimerRef.current); wsReconnectTimerRef.current = null; }
        if (wsRef.current) {
          wsRef.current.onclose = null; wsRef.current.onerror = null; // teardown must not trigger a reconnect
          try { wsRef.current.close(); } catch (_) {}
          wsRef.current = null;
        }
      };
    }
  }, [wallet?.qnetAddress]);

  const checkWalletExists = async () => {
    try {
      const exists = await walletManager.walletExists();
      setHasWallet(exists);
      setLoading(false);
      // Hide splash if no wallet exists
      if (!exists) {
        setShowSplash(false);
      }
    } catch (error) {
      setLoading(false);
      setShowSplash(false);
    }
  };

  const validatePassword = () => {
    setPasswordError('');

    if (!password || password.length === 0) {
      setPasswordError('Password is required');
      return false;
    }

    if (password.length < 8) {
      setPasswordError(`Password must be at least 8 characters (${8 - password.length} more needed)`);
      return false;
    }

    if (!confirmPassword || confirmPassword.length === 0) {
      setPasswordError('Please confirm your password');
      return false;
    }

    if (password !== confirmPassword) {
      setPasswordError('Passwords do not match');
      return false;
    }

    return true;
  };

  const createWallet = async () => {
    // Check terms acceptance
    if (!termsAccepted) {
      setPasswordError('Please accept the Terms of Service');
      return;
    }
    
    if (!validatePassword()) {
      return;
    }

    // Show brief loading state
    setLoading(true);
    try {
      const newWallet = await walletManager.generateWallet();
      setLoading(false);
      
      // Store temporarily and show seed phrase
      setTempWallet({ ...newWallet, password });
      const words = newWallet.mnemonic.split(' ');
      
      // Select 3 random positions to verify from the 12-word mnemonic  
      const allPositions = [...Array(12).keys()]; // [0, 1, 2, ..., 11]
      const verifyPositions = [];
      
      // Randomly select 3 unique positions
      while (verifyPositions.length < 3) {
        const randomPos = Math.floor(Math.random() * 12);
        if (!verifyPositions.includes(randomPos)) {
          verifyPositions.push(randomPos);
        }
      }
      
      // Sort positions for display
      verifyPositions.sort((a, b) => a - b);
      
      const confirmWords = {};
      const choices = {};
      
      // Generate word choices for each position
      verifyPositions.forEach(pos => {
        confirmWords[pos] = '';
        
        // Get 3 random words from BIP39 list + correct word
        const allWords = walletManager.getBIP39WordList();
        const correctWord = words[pos];
        const randomWords = [];
        
        // Add 3 random incorrect words
        while (randomWords.length < 3) {
          const randomWord = allWords[Math.floor(Math.random() * allWords.length)];
          if (randomWord !== correctWord && !randomWords.includes(randomWord)) {
            randomWords.push(randomWord);
          }
        }
        
        // Mix correct word with random ones - randomize position
        const wordOptions = [...randomWords, correctWord].sort(() => Math.random() - 0.5);
        choices[pos] = wordOptions;
      });
      
      setSeedConfirmWords(confirmWords);
      setWordChoices(choices);
      
      // Show seed phrase and prepare for confirmation
      const formattedSeed = words.map((word, i) => `${i + 1}. ${word}`).join('\n');
      
      setLoading(false);
      
      // Show seed phrase with proper formatting
      setShowCreateOptions('show-seed');
    } catch (error) {
      setLoading(false);
      showAlert('Error', 'Failed to create wallet: ' + error.message);
    }
  };

  const importWallet = async () => {
    setPasswordError('');

    // Check terms acceptance  
    if (!termsAccepted) {
      setPasswordError('Please accept the Terms of Service');
      return;
    }

    if (!seedPhrase || seedPhrase.trim().length === 0) {
      setPasswordError('Please enter your seed phrase');
      return;
    }

    // Validate seed phrase word count
    const words = seedPhrase.trim().split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
      setPasswordError(`Invalid seed phrase. Must be 12 or 24 words (you entered ${words.length} words)`);
      return;
    }

    // Fast import without loading screen
    try {
      // Keep seed for import, clear after success
      const seedToImport = seedPhrase.trim();
      
      // Show brief loading state
      setLoading(true);
      
      const imported = await walletManager.importWallet(seedToImport);
      
      // Set UI state immediately for instant response
      setSeedPhrase('');
      setWallet(imported);
      setHasWallet(true);
      setShowCreateOptions(false);
      // Keep password in state for subsequent operations (like node activation)
      // setPassword(''); // DON'T clear password
      setConfirmPassword('');
      setImportStep(1); // Reset to step 1 for next time
      setLoading(false);
      
      // Clear activation and node state from previous wallet
      setActivatedNodeType(null);
      setActivationCode(null);
      setNodePseudonym('');
      setNodeStatus(null);
      setLightNodeStatus(null);
      setServerNodeStatus(null);
      
      // Clear stored activation data from AsyncStorage
      await AsyncStorage.removeItem('qnet_activation_codes');
      await AsyncStorage.removeItem('qnet_activation_meta_light');
      await AsyncStorage.removeItem('qnet_activation_meta_full');
      await AsyncStorage.removeItem('qnet_activation_meta_super');
      await AsyncStorage.removeItem('qnet_last_activated_node');
      // Clear cache for any previous wallet
      const keys = await AsyncStorage.getAllKeys();
      const blockchainCacheKeys = keys.filter(key => key.startsWith('blockchain_check_'));
      const pseudonymKeys = keys.filter(key => key.startsWith('node_pseudonym_'));
      const keysToRemove = [...blockchainCacheKeys, ...pseudonymKeys];
      if (keysToRemove.length > 0) {
        await AsyncStorage.multiRemove(keysToRemove);
      }
      
      // Switch directly to assets tab without alert
      setActiveTab('assets');
      // Force immediate balance load without delay
      loadBalance(imported.publicKey);
      
      // Save wallet before showing UI — with quick-crypto PBKDF2 is native (< 1s).
      // Must complete before UI advances: closing app mid-save loses the wallet.
      await walletManager.storeWallet(imported, password);
      // Sync activation codes after save
      (async () => {
        // After wallet is saved, sync activation codes
        try {
          const mnemonic = await walletManager.getEncryptedMnemonic(password);
          if (mnemonic) {
            const syncedCodes = await walletManager.syncActivationCodes(
              imported.publicKey,
              mnemonic,
              password
            );
            if (syncedCodes && Object.keys(syncedCodes).length > 0) {
              const nodeType = Object.keys(syncedCodes)[0];
              const codeData = syncedCodes[nodeType];
              const codeStr = typeof codeData === 'string' ? codeData : (codeData?.code || '');
              const isHashOnly = typeof codeStr === 'string' && codeStr.startsWith('HASH:');
              const isPending = codeData?.status === 'pending_activation';
              
              if (!isHashOnly && !isPending && codeStr) {
              setActivatedNodeType(nodeType);
              setActivationCode(codeStr);
              
              // Regenerate pseudonym for imported wallet (deterministic based on wallet address)
              const regeneratedPseudonym = await walletManager.generateLightNodePseudonym(imported.address);
              setNodePseudonym(regeneratedPseudonym);
              
              // Save regenerated pseudonym to AsyncStorage
              await AsyncStorage.setItem(`node_pseudonym_${codeStr}`, regeneratedPseudonym);
              
              // Save to AsyncStorage for persistence across app restarts
              await AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
                nodeType: nodeType,
                code: codeStr,
                pseudonym: regeneratedPseudonym,
                timestamp: Date.now(),
                walletAddress: imported.qnetAddress || imported.address
              }));

              // Restore-recovery: a light node's local ping identity (qnet_light_node_info + ping
              // delegation key) lives only on the old device, so after a seed restore the phone stops
              // attesting and the status shows a stale "ONLINE" with no way back. Re-establish it now.
              // registerNodeWithCode is restore-safe: it re-finds the burn on Solana, regenerates the
              // ping delegation key signed by the restored wallet key, and does NOT re-burn (unlike
              // activateLightNode). wallet_address MUST be the QNet EON (qnetAddress) — it derives the
              // pseudonym/node_id and is EON-format-validated server-side; the Solana publicKey is
              // rejected. A silent failure is fine here: the badge falls to OFFLINE and the user retries.
              if (nodeType === 'light') {
                try {
                  await walletManager.registerNodeWithCode(codeStr, imported.qnetAddress || imported.address, password);
                } catch (regErr) {
                  console.log('Light re-register on restore failed (will need manual reactivate):', regErr.message);
                }
              }
              } // end if (!isHashOnly && !isPending)
            }
          }
        } catch (error) {
          // Silent fail - activation sync is not critical
          console.log('Activation sync failed:', error.message);
        }
      })();
    } catch (error) {
      setLoading(false);
      showAlert('Error', 'Failed to import wallet: ' + error.message);
    }
  };

  const confirmSeedPhrase = async () => {
    // Clear previous error
    setVerificationError('');
    
    if (!tempWallet) {
      setVerificationError('Wallet data not found. Please try creating the wallet again.');
      return;
    }
    
    const words = tempWallet.mnemonic.split(' ');
    const positions = Object.keys(seedConfirmWords).map(Number);
    
    // Check if all required words are filled
    const emptyWords = positions.filter(pos => !seedConfirmWords[pos] || seedConfirmWords[pos].trim() === '');
    if (emptyWords.length > 0) {
      setVerificationError(`⚠️ Please select word #${emptyWords[0] + 1} to continue.`);
      return;
    }
    
    // Check if all words match
    const incorrectWords = [];
    for (const pos of positions) {
      if (words[pos].toLowerCase() !== seedConfirmWords[pos].toLowerCase().trim()) {
        incorrectWords.push(pos + 1);
      }
    }
    
    if (incorrectWords.length > 0) {
      const wordsList = incorrectWords.length === 1 
        ? `Word #${incorrectWords[0]}` 
        : `Words #${incorrectWords.join(', #')}`;
      setVerificationError(
        `❌ ${wordsList} ${incorrectWords.length === 1 ? 'is' : 'are'} incorrect. Please check your recovery phrase and try again.`
      );
      return;
    }
    
    // All words correct — save wallet FIRST, then show UI.
    // With react-native-quick-crypto PBKDF2 is native and takes < 1s.
    // We must not show the wallet before it's saved: if the user closes the
    // app before storeWallet completes, the vault is never written to AsyncStorage
    // and the wallet disappears on next launch ("seed phrase reset" bug).
    setLoading(true);
    const savedWallet = { ...tempWallet };
    delete savedWallet.password;
    try {
      await walletManager.storeWallet(tempWallet, tempWallet.password);
    } catch (error) {
      setLoading(false);
      showAlert('Error', 'Failed to save wallet: ' + (error.message || 'Unknown error'));
      return;
    }

    setShowSeedConfirm(false);
    setTempWallet(null);
    setLoading(false);
    setWallet(savedWallet);
    setHasWallet(true);
    setConfirmPassword('');
    setSeedConfirmWords({});
    setActivatedNodeType(null);
    setActivationCode(null);
    setNodePseudonym('');
    setNodeStatus(null);
    setLightNodeStatus(null);
    setServerNodeStatus(null);

    AsyncStorage.removeItem('qnet_activation_codes');
    AsyncStorage.removeItem('qnet_activation_meta_light');
    AsyncStorage.removeItem('qnet_activation_meta_full');
    AsyncStorage.removeItem('qnet_activation_meta_super');
    AsyncStorage.removeItem('qnet_last_activated_node');
    AsyncStorage.removeItem(`blockchain_check_${savedWallet.publicKey}`);

    setActiveTab('assets');
    loadBalance(savedWallet.publicKey);
  };

  const _startLockoutCountdown = (remainingMs) => {
    if (lockoutTimerRef.current) clearInterval(lockoutTimerRef.current);
    setLockoutMs(remainingMs);
    lockoutTimerRef.current = setInterval(() => {
      setLockoutMs(prev => {
        if (prev <= 1000) {
          clearInterval(lockoutTimerRef.current);
          lockoutTimerRef.current = null;
          return 0;
        }
        return prev - 1000;
      });
    }, 1000);
  };

  const handleBiometricUnlock = async () => {
    const pw = await walletManager.tryBiometricUnlock();
    if (!pw) return;
    await _doUnlock(pw);
  };

  const unlockWallet = async () => {
    if (lockoutMs > 0) return;
    if (!password) {
      setUnlockError(translations[language].incorrect_password);
      setTimeout(() => setUnlockError(''), 3000);
      return;
    }
    await _doUnlock(password);
  };

  const _doUnlock = async (pw) => {
    // Show loading immediately — PBKDF2 verification takes 1-3s
    setLoading(true);
    setUnlockError('');

    // Quick password check first (PBKDF2 decrypt to verify)
    const isValid = await walletManager.verifyPassword(pw);
    if (!isValid) {
      setLoading(false);
      const status = await walletManager.getPasswordLockStatus();
      if (status.locked) {
        _startLockoutCountdown(status.remainingMs);
        setUnlockError('');
      } else {
        setUnlockError(translations[language].incorrect_password);
        setTimeout(() => setUnlockError(''), 3000);
      }
      return;
    }

    // Password verified — hide splash, keep loading spinner visible
    setShowSplash(false);

    // Load wallet asynchronously (may trigger vault migration)
    walletManager.loadWallet(pw).then(loadedWallet => {
      setLoading(false);
      // Show migration notification if vault was upgraded
      if (loadedWallet._migrated) {
        const fromVersion = loadedWallet._migratedFromVersion || 1;
        const fromIterations = fromVersion === 2 ? '100,000' : '10,000';
        setTimeout(() => {
          Alert.alert(
            'Security Upgrade',
            `Your wallet has been automatically upgraded to enhanced security (PBKDF2 600,000 iterations instead of ${fromIterations}).\n\nYour funds and keys are safe — this is a one-time improvement.`,
            [{ text: 'OK', style: 'default' }]
          );
        }, 1000); // Small delay so main UI renders first
      }
      // Clean internal migration flags before storing in state
      delete loadedWallet._migrated;
      delete loadedWallet._migratedFromVersion;

      setWallet(loadedWallet);

      // Load balance in parallel
      loadBalance(loadedWallet.publicKey);

      // Retry a pending on-chain node registration if one was left unlanded. Password is available here;
      // the wallet ML-DSA key that signs the on-chain TX can't be decrypted on a background push wake, so
      // unlock is the retry point. Fire-and-forget — never blocks the UI.
      walletManager.retryPendingOnchainRegistration(pw).catch(() => {});

      // Restore activation state + cached server status from AsyncStorage immediately
      // Then verify on-chain in background — clear stale cache if not found
      Promise.all([
        AsyncStorage.getItem('qnet_last_activated_node'),
        AsyncStorage.getItem('qnet_cached_server_status'),
      ]).then(async ([savedState, cachedStatus]) => {
        if (savedState) {
          try {
            const state = JSON.parse(savedState);
            const currentWalletAddr = loadedWallet.qnetAddress || loadedWallet.address;
            
            // CRITICAL: Verify saved state belongs to THIS wallet
            // If walletAddress is missing (old data) or doesn't match — don't trust it
            if (!state.walletAddress || state.walletAddress !== currentWalletAddr) {
              console.log('[UNLOCK] Saved activation has no wallet tag or belongs to different wallet, skipping');
              // Don't load stale data — user can recover via "Recover My Code"
            } else if (state.nodeType && state.code) {
              // Show cached state immediately for UX (will be verified below)
              setActivatedNodeType(state.nodeType);
              setActivationCode(state.code);
              if (state.pseudonym) {
                setNodePseudonym(state.pseudonym);
              } else {
                const savedPseudonym = await AsyncStorage.getItem(`node_pseudonym_${state.code}`);
                if (savedPseudonym) {
                  setNodePseudonym(savedPseudonym);
                }
              }
              
              // Restore cached server status (show instantly, refresh in background)
              if (cachedStatus && state.nodeType !== 'light') {
                try {
                  const cached = JSON.parse(cachedStatus);
                  if (cached.success && cached.cachedAt && (Date.now() - cached.cachedAt < 600000)) {
                    setServerNodeStatus(cached);
                  }
                } catch (e) {
                  // Silent fail
                }
              }
              
              // Background on-chain verification
              // Only clear stale cache if there's NO burn evidence (burnTxHash).
              // If user burned tokens but hasn't activated node yet, keep the code!
              // "Has code" != "Node activated on-chain" — these are separate states.
              const hasBurnEvidence = !!state.burnTxHash;
              
              if (!hasBurnEvidence) {
                // No burn TX hash saved — this might be truly stale from a previous chain
                const qnetAddr = loadedWallet.qnetAddress || loadedWallet.address;
                walletManager.verifyActivationOnChain(qnetAddr).then(async (result) => {
                  if (!result.verified && !result.networkError) {
                    const solanaCheck = await walletManager.verifyActivationOnChain(loadedWallet.publicKey);
                    if (!solanaCheck.verified && !solanaCheck.networkError) {
                      // Last resort: check Solana for any burn TX before clearing
                      try {
                        const burnCheck = await walletManager.checkBlockchainForActivations(loadedWallet.publicKey);
                        if (burnCheck && burnCheck.length > 0) {
                          console.log('[VERIFY] No on-chain activation but Solana burn found — keeping code');
                          return; // Keep the code, user burned but hasn't activated yet
                        }
                      } catch (e) {
                        // If Solana check fails, keep state to be safe
                        console.log('[VERIFY] Solana check failed — keeping cached state');
                        return;
                      }
                      console.log('[VERIFY] No activation on-chain AND no Solana burn — clearing stale cache');
                      setActivatedNodeType(null);
                      setActivationCode(null);
                      setNodePseudonym('');
                      setServerNodeStatus(null);
                      await AsyncStorage.removeItem('qnet_last_activated_node');
                      await AsyncStorage.removeItem('qnet_cached_server_status');
                      await AsyncStorage.removeItem('qnet_activation_codes');
                      await AsyncStorage.removeItem('qnet_activation_meta_light');
                      await AsyncStorage.removeItem('qnet_activation_meta_super');
                    }
                  }
                }).catch(() => {
                  // Network error — keep cached state, will retry next time
                });
              } else {
                console.log('[VERIFY] Burn TX evidence found — keeping activation code (not yet activated on-chain is OK)');
              }
            }
          } catch (e) {
            // Silent fail
          }
        }
        setNodeInitializing(false);
      }).catch(() => {
        setNodeInitializing(false);
      });
      
      // Sync activation codes in background (non-blocking)
      setTimeout(() => {
        walletManager.syncActivationCodes(
          loadedWallet.publicKey,
          loadedWallet.mnemonic,
          password
        ).then(async syncedCodes => {
          if (syncedCodes && Object.keys(syncedCodes).length > 0) {
            const nodeType = Object.keys(syncedCodes)[0];
            const codeData = syncedCodes[nodeType];
            const codeStr = typeof codeData === 'string' ? codeData : (codeData?.code || '');
            const isHashOnly = typeof codeStr === 'string' && codeStr.startsWith('HASH:');
            const isPending = codeData?.status === 'pending_activation';
            
            if (isHashOnly || isPending || !codeStr) {
              console.log('[SYNC] Skipping hash-only or pending activation code');
              return;
            }
            
            const code = codeData;
            setActivatedNodeType(nodeType);
            setActivationCode(codeStr);
            
            // Try to load pseudonym
            const savedPseudonym = await AsyncStorage.getItem(`node_pseudonym_${codeStr}`);
            if (savedPseudonym) {
              setNodePseudonym(savedPseudonym);
            }
            
            // Save to AsyncStorage for quick restore (include burnTxHash to prevent clearing)
            await AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
              nodeType: nodeType,
              code: codeStr,
              pseudonym: savedPseudonym || undefined,
              timestamp: Date.now(),
              burnTxHash: codeData?.burnTxHash || 'synced',
              walletAddress: loadedWallet.qnetAddress || loadedWallet.address
            }));
          }
        }).catch(() => {
          // Silent fail
        });
      }, 100);
    }).catch(error => {
      setLoading(false);
      // Migration error — wallet is readable but re-encryption failed
      if (error.message && error.message.includes('Wallet migration failed')) {
        Alert.alert(
          'Security Upgrade Failed',
          `${error.message}\n\nYour wallet is still accessible. Please close the app and try again. If the problem persists, contact support.`,
          [{ text: 'OK', style: 'default' }]
        );
        // Show the splash again so user can retry
        setShowSplash(true);
        return;
      }
      // Check if it's a corrupted wallet issue
      if (error.message && (error.message.includes('Malformed UTF-8') || 
          error.message.includes('corrupted'))) {
        Alert.alert(
          'Wallet Error',
          'Your wallet data appears to be corrupted. Would you like to clear it and create a new wallet?',
          [
            {
              text: 'Cancel',
              style: 'cancel'
            },
            {
              text: 'Clear & Start Fresh',
              style: 'destructive',
              onPress: async () => {
                try {
                  await AsyncStorage.removeItem('qnet_wallet');
                  await AsyncStorage.removeItem('qnet_wallet_address');
                  setHasWallet(false);
                  setPassword('');
                  setActivatedNodeType(null);
                  setActivationCode(null);
                  setNodeStatus(null);
                  setLightNodeStatus(null);
                  setServerNodeStatus(null);
                  setNodePseudonym('');
                  // Clear ALL node-related AsyncStorage (both light and super)
                  const keysAll = await AsyncStorage.getAllKeys();
                  const nodeKeys = keysAll.filter(k =>
                    k.startsWith('blockchain_check_') ||
                    k.startsWith('node_pseudonym_') ||
                    k === 'qnet_activation_codes' ||
                    k === 'qnet_activation_meta_light' ||
                    k === 'qnet_activation_meta_full' ||
                    k === 'qnet_activation_meta_super' ||
                    k === 'qnet_last_activated_node' ||
                    k === 'qnet_cached_server_status'
                  );
                  if (nodeKeys.length > 0) await AsyncStorage.multiRemove(nodeKeys);
                  showAlert('Success', 'Wallet data cleared. You can now create a new wallet or import an existing one.');
                } catch (clearError) {
                  // console.error('Error clearing wallet:', clearError);
                  showAlert('Error', 'Failed to clear wallet data');
                }
              }
            }
          ]
        );
      } else {
        showAlert('Error', 'Wrong password');
      }
    });
  };

  // Load QRC-20 tokens for the Assets list: the account's on-chain holdings merged with the
  // user's persisted custom tokens (AsyncStorage 'qnet_custom_tokens'). Custom tokens not present
  // in holdings get their balance fetched individually. Deduped by contract address (held wins for
  // balance freshness). Runs in the SAME effect as balance loading (called from loadBalance).
  const loadQrcTokens = async (qnetAddress) => {
    if (!qnetAddress) return;
    try {
      // 1) On-chain holdings (already human-scaled by each token's decimals).
      const holdings = await walletManager.getTokenHoldings(qnetAddress);
      const byContract = new Map();
      for (const h of holdings) {
        if (h.contract) byContract.set(h.contract, { ...h });
      }

      // 2) Persisted custom tokens — merge in any not already present as a holding, and refresh
      //    their balances (a custom token the wallet has zero of won't appear in holdings).
      let persisted = [];
      try {
        const raw = await AsyncStorage.getItem('qnet_custom_tokens');
        persisted = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(persisted)) persisted = [];
      } catch (_) { persisted = []; }
      setCustomTokens(persisted);

      await Promise.all(persisted.map(async (c) => {
        const contract = c.contract_address || c.contract;
        if (!contract) return;
        if (byContract.has(contract)) return; // already a live holding — keep the holding row
        const dec = Number(c.decimals) || 0;
        const bal = await walletManager.getTokenBalanceOf(contract, qnetAddress, dec);
        byContract.set(contract, {
          contract,
          name: c.name || c.symbol || 'Token',
          symbol: c.symbol || '',
          decimals: dec,
          balance: bal.balance != null ? bal.balance : '0',
          logo: c.logo || '',
        });
      }));

      const list = Array.from(byContract.values());
      setQrcTokens(list);

      // Trustless upgrade: verify each held token's balance via its two-level proof against the
      // committee-QC-anchored state_root (same trust model as the native balance). Non-blocking — the
      // list shows node-trusted balances immediately, each row flips to `verified` + its proof-exact
      // balance as the proof lands. Skip hidden tokens (never shown) and cap concurrency so a
      // dust-heavy wallet can't open hundreds of simultaneous proof requests.
      const toProve = list.filter((tk) => tk.contract && !hiddenTokens.has(tk.contract));
      let proofIdx = 0;
      const proveWorker = async () => {
        while (proofIdx < toProve.length) {
          const tk = toProve[proofIdx++];
          try {
            const r = await walletManager.getTokenBalanceWithProof(tk.contract, qnetAddress, tk.decimals);
            if (r && r.ok && r.verified) {
              setQrcTokens((prev) => prev.map((t) => (t.contract === tk.contract
                ? { ...t, balance: r.balance, verified: true } : t)));
            }
          } catch (_) { /* keep the node-trusted balance */ }
        }
      };
      for (let w = 0; w < Math.min(5, toProve.length); w++) proveWorker();
    } catch (e) {
      // Non-fatal: keep the last-known token list rather than flashing empty.
      // console.warn('[QRC20] token list load failed:', e.message);
    }
  };

  // Per-token hide list (spam control): contract addresses persisted in AsyncStorage 'qnet_hidden_tokens'.
  // The Assets list filters these out; the token manager toggles them back on.
  const persistHiddenTokens = async (set) => {
    try { await AsyncStorage.setItem('qnet_hidden_tokens', JSON.stringify(Array.from(set))); } catch (_) {}
  };
  const hideToken = (contract) => {
    setHiddenTokens((prev) => { const next = new Set(prev); next.add(contract); persistHiddenTokens(next); return next; });
  };
  const unhideToken = (contract) => {
    setHiddenTokens((prev) => { const next = new Set(prev); next.delete(contract); persistHiddenTokens(next); return next; });
  };
  // Token manager Switch: on ⇒ visible (unhide), off ⇒ hidden.
  const setTokenVisible = (contract, visible) => { visible ? unhideToken(contract) : hideToken(contract); };

  // Privacy: mask every displayed amount when balances are hidden (persisted 'qnet_hide_balances').
  const maskAmt = (s) => (balancesHidden ? '••••' : s);
  const toggleBalancesHidden = () => {
    setBalancesHidden((prev) => {
      const next = !prev;
      AsyncStorage.setItem('qnet_hide_balances', next ? '1' : '0').catch(() => {});
      return next;
    });
  };

  // Token-manager search results: native QNC first (always listed so it's hideable, even at 0), then
  // held/custom QRC-20. Normalize the query once and memoize so a keystroke (or unrelated re-render)
  // doesn't re-scan the list. QNC's synthetic contract 'native:qnc' drives its hidden-set toggle.
  const tokenMgrResults = useMemo(() => {
    const qnc = {
      contract: 'native:qnc', symbol: 'QNC', name: 'QNet', decimals: 5, logo: '',
      balance: (Number(tokenBalances.qnc) || 0).toFixed(5),
    };
    const all = [qnc, ...qrcTokens];
    const raw = tokenMgrQuery.trim();
    if (!raw) return all;
    const q = raw.toLowerCase();
    const matches = all.filter((tk) =>
      (tk.symbol || '').toLowerCase().includes(q)
      || (tk.name || '').toLowerCase().includes(q)
      || (tk.contract || '').toLowerCase().includes(q));
    // Paste a 64-hex contract to track a token not in the list yet — its row toggle adds it.
    if (!matches.length && /^[0-9a-fA-F]{64}$/.test(raw) && !all.some((tk) => tk.contract === q)) {
      return [{ contract: q, symbol: '', name: '', decimals: 5, logo: '', balance: '0', _addable: true }];
    }
    return matches;
  }, [qrcTokens, tokenMgrQuery, tokenBalances]);

  // Load the persisted hidden-token set and the hide-balances preference on mount.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('qnet_hidden_tokens');
        if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr)) setHiddenTokens(new Set(arr)); }
      } catch (_) {}
      try {
        const hb = await AsyncStorage.getItem('qnet_hide_balances');
        if (hb === '1') setBalancesHidden(true);
      } catch (_) {}
    })();
  }, []);

  const loadBalance = async (publicKey) => {
    try {
      // Get current wallet reference (might be set after initial call)
      const currentWallet = wallet || await walletManager.getCurrentWallet();
      // Load QRC-20 token holdings in the SAME effect as balances (non-blocking).
      const qnetAddr = currentWallet?.qnetAddress;
      if (qnetAddr) loadQrcTokens(qnetAddr);
      
      // Load balances in parallel for better performance
      // v3.27: Use getQNCBalanceWithProof for trustless verification (TOP L1 pattern)
      const [bal, oneDevBalance, qncResult] = await Promise.all([
        walletManager.getBalance(publicKey, isTestnet),
        walletManager.getTokenBalance(
          currentWallet?.solanaAddress || currentWallet?.address || publicKey,
          isTestnet 
        ? '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ'  // Testnet/Devnet
            : '4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump', // Mainnet (pump.fun)
          isTestnet
        ),
        // v3.27: TRUSTLESS - Get balance WITH Merkle proof verification
        walletManager.getQNCBalanceWithProof(currentWallet?.qnetAddress, true)
      ]);
      
      const qncOk = !!qncResult?.ok;
      const isBalanceVerified = qncResult?.verified || false;
      setBalanceVerified && setBalanceVerified(qncOk && isBalanceVerified);

      // Resolve the QNC value to apply OUTSIDE the state updater (it mutates refs). The optimistic-send
      // guard holds the expected (lower) balance until the queried node has caught up to our TX.
      let qncToApply = null; // null ⇒ QNC fetch failed: keep last-known, never flash 0
      let optimistic = false;
      if (qncOk) {
        let q = qncResult.balance;
        if (pendingTxRef.current) {
          const { expectedQnc, timestamp } = pendingTxRef.current;
          const elapsed = Date.now() - timestamp;
          if (q <= expectedQnc || elapsed >= 120000) {
            pendingTxRef.current = null;
            if (txPollingRef.current) { clearInterval(txPollingRef.current); txPollingRef.current = null; }
          } else {
            q = expectedQnc; optimistic = true; // block not yet on this node — hold optimistic
          }
        }
        qncToApply = q;
      }

      // Merge: overwrite a token ONLY when its fetch succeeded (null/failed ⇒ keep last-known).
      setTokenBalances(prev => {
        const next = { ...prev };
        if (bal != null) next.sol = bal;
        if (oneDevBalance != null) next['1dev'] = oneDevBalance;
        if (qncToApply != null) {
          // Anti-zeroing: an UNVERIFIED node may not LOWER the displayed balance (keep last-known).
          next.qnc = (!optimistic && !isBalanceVerified && qncToApply < (prev.qnc || 0)) ? prev.qnc : qncToApply;
        }
        return next;
      });
      if (bal != null) setBalance(bal);

      await fetchTokenPrices();
    } catch (error) {
      // console.error('Error loading balance:', error);
      // Retry once after a delay if network error
      if (error.message && (error.message.includes('fetch') || error.message.includes('network'))) {
        // console.log('Network error, retrying balance fetch in 2 seconds...');
        setTimeout(() => {
          if (wallet && wallet.publicKey) {
            loadBalance(wallet.publicKey);
          }
        }, 2000);
      }
    }
  };

  // Cancellable, exponentially-backed-off WS reconnect. No-op after unmount (guard=false), and it
  // dedups its own timer so onerror→close→onclose can't stack reconnects or storm the node set.
  const scheduleWsReconnect = () => {
    if (!wsShouldReconnectRef.current) return;
    if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current);
    const delay = Math.min(30000, 1000 * Math.pow(2, wsBackoffRef.current++)) + Math.floor(Math.random() * 500);
    wsReconnectTimerRef.current = setTimeout(connectWebSocket, delay);
  };

  const connectWebSocket = () => {
    wsShouldReconnectRef.current = true; // (re-)arm; cleanup disarms on unmount/wallet-switch
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    // Get nodes from discovery system (not hardcoded!)
    const httpNodes = walletManager.getAvailableNodes();
    if (!httpNodes || httpNodes.length === 0) {
      scheduleWsReconnect(); // no nodes yet
      return;
    }
    const myAddress = wallet?.qnetAddress || '';
    
    // v3.35: Correct WS URL format: /ws/subscribe?channels=blocks,account:ADDRESS
    // BEFORE: /ws + JSON subscribe message (Rust ignores JSON messages, reads from URL params)
    // NOW: /ws/subscribe?channels=... (matches Rust warp route)
    const channels = myAddress 
      ? `blocks,account:${myAddress}` 
      : 'blocks';
    const wsNodes = httpNodes.map(url => {
      const wsBase = url.replace('http://', 'ws://').replace('https://', 'wss://');
      return `${wsBase}/ws/subscribe?channels=${encodeURIComponent(channels)}`;
    });
    const wsUrl = wsNodes[Math.floor(Math.random() * wsNodes.length)];
    
    if (!wsUrl) {
      scheduleWsReconnect();
      return;
    }

    try {
      wsRef.current = new WebSocket(wsUrl);

      wsRef.current.onopen = () => {
        wsBackoffRef.current = 0; // reset backoff on a good connection
        console.log('[WS] Connected to', wsUrl.replace(/channels=.*/, 'channels=...'));
      };
      
      wsRef.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          // v3.35: Handle NewBlock events from Rust node
          // Rust sends: { type: "NewBlock", data: { height, hash, timestamp, tx_count, producer } }
          // NOTE: NewBlock does NOT include individual TX data!
          // When block has TXs → refresh history from API to get confirmed TXs
          // NewBlock carries no per-TX data and isn't wallet-scoped; the account:${addr} BalanceUpdate
          // channel already signals OUR changes with new_balance, so here we only coalesce a debounced
          // history refresh (no balance re-poll — that was the random-node race that flashed 0).
          if (data.type === 'NewBlock' && data.data) {
            if ((data.data.tx_count || 0) > 0) {
              if (txHistoryDebounceRef.current) clearTimeout(txHistoryDebounceRef.current);
              txHistoryDebounceRef.current = setTimeout(() => { txHistoryDebounceRef.current = null; loadTxHistory(); }, 1500);
            }
          }

          // BalanceUpdate (account:${addr}) carries the authoritative post-block balance — apply it
          // DIRECTLY (the emitting node has the block) instead of re-polling a random node that may lag.
          if (data.type === 'BalanceUpdate' && data.data) {
            if ((data.data.address || '').toLowerCase() === myAddress.toLowerCase()) {
              const newBalanceQnc = (data.data.new_balance || 0) / 1e9;
              if (pendingTxRef.current?.txHash === data.data.tx_hash) {
                pendingTxRef.current = null;
                if (txPollingRef.current) { clearInterval(txPollingRef.current); txPollingRef.current = null; }
                setTxResult(prev => prev?.txHash === data.data.tx_hash ? { ...prev, confirming: false, confirmed: true } : prev);
                updateTxStatus(data.data.tx_hash, 'confirmed');
              }
              if (Number.isFinite(newBalanceQnc)) {
                setTokenBalances(prev => ({ ...prev, qnc: newBalanceQnc }));
              }
              if (txHistoryDebounceRef.current) clearTimeout(txHistoryDebounceRef.current);
              txHistoryDebounceRef.current = setTimeout(() => { txHistoryDebounceRef.current = null; loadTxHistory(); }, 1200);
            }
          }
          
          // v3.35: Handle PendingTx events (mempool channel — not subscribed by default)
          // Keep legacy block/microblock handler for backward compatibility
          if (data.type === 'block' || data.type === 'microblock') {
            const txs = data.transactions || data.block?.transactions || [];
            const myAddr = myAddress.toLowerCase();
            
            txs.forEach(tx => {
              const from = (tx.from || tx.sender || '').toLowerCase();
              const to = (tx.to || tx.recipient || '').toLowerCase();
              
              if (from === myAddr || to === myAddr) {
                const newTx = {
                  hash: tx.hash || tx.tx_hash,
                  from: tx.from || tx.sender,
                  to: tx.to || tx.recipient,
                  amount: (tx.amount || 0) / 1e9,
                  status: 'confirmed',
                  timestamp: tx.timestamp ? tx.timestamp * 1000 : Date.now(),
                  type: from === myAddr ? 'send' : 'receive',
                  fee: (tx.fee || tx.gas_used || 0) / 1e9
                };
                
                setTxHistory(prev => {
                  if (prev.some(t => t.hash === newTx.hash)) return prev;
                  return [newTx, ...prev].slice(0, 50);
                });
                
                if (wallet?.publicKey) {
                  loadBalance(wallet.publicKey);
                }
              }
            });
          }
        } catch (e) {
          // Parse error - ignore
        }
      };
      
      wsRef.current.onclose = () => {
        scheduleWsReconnect(); // guarded + backed-off; no-op after unmount
      };

      wsRef.current.onerror = () => {
        try { wsRef.current?.close(); } catch (_) {} // → onclose → scheduleWsReconnect (single schedule)
      };
    } catch (e) {
      // WS not available - polling will handle it
    }
  };

  // v3.35: Load TX history from API
  // FIX: Preserve pending TXs that haven't been confirmed yet
  // BEFORE: setTxHistory(formattedTxs) — REPLACED everything, pending TX disappeared
  // NOW: Merge — keep pending TXs that aren't yet in blockchain response
  const loadTxHistory = async () => {
    if (!wallet?.qnetAddress) return;

    try {
      const myAddress = wallet.qnetAddress.toLowerCase();

      // Fetch the native tx list (carries native QNC transfers) and the node-decoded token-transfer
      // events in parallel. Token transfers are no longer derived from client-side calldata parsing.
      const apiUrl = walletManager.getRandomBootstrapNode();
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const nativePromise = fetch(
        `${apiUrl}/api/v1/account/${wallet.qnetAddress}/transactions?limit=50`,
        { method: 'GET', headers: { 'Content-Type': 'application/json' }, signal: controller.signal }
      ).finally(() => clearTimeout(t));
      const tokenEventsPromise = walletManager.getAccountTokenTransfers(wallet.qnetAddress, 50);

      // Token rows first: node-decoded QRC-20/721 events, metadata embedded per row (no metadata fetch).
      // u64 amounts stay STRINGS. Direction: 'receive' iff the tokens land on me and I'm not the sender.
      // tokenLogIndex disambiguates multiple transfer logs sharing one tx_hash (unique React key + no
      // row collapse in the FlatList).
      const tokenEvents = await tokenEventsPromise;
      // Trusted per-contract display metadata: the QC-committed logs_root leaf binds base-units+parties
      // but NOT decimals/symbol, so a serving node's per-row decimals could otherwise inflate the shown
      // magnitude under the ✓ badge. Prefer the wallet's OWN added-token metadata (reviewed at add-time,
      // node-independent) keyed by contract; fall back to the node's per-row value only for tokens the
      // user hasn't added (where no magnitude is implied trustworthy anyway). Base units stay verbatim —
      // they are the value actually proven against the committed leaf.
      const trustedTokenMeta = new Map(
        (customTokens || []).map(ct => [String(ct.contract || '').toLowerCase(),
          { decimals: Number(ct.decimals) || 0, symbol: ct.symbol }])
      );
      const tokenTxs = (tokenEvents || [])
        // A malicious/buggy node may return rows unrelated to me — only display transfers I'm party to.
        .filter(ev => {
          const f = String(ev.from || '').toLowerCase(), t = String(ev.to || '').toLowerCase();
          return f === myAddress || t === myAddress;
        })
        .map(ev => {
          const tm = trustedTokenMeta.get(String(ev.contract || '').toLowerCase());
          const dec = tm ? tm.decimals : (Number(ev.decimals) || 0);
          const sym = tm ? tm.symbol : ev.symbol;
          return {
        hash: ev.tx_hash,
        tokenLogIndex: ev.log_index,
        from: ev.from,
        to: ev.to,
        amount: 0,
        status: 'pending', // promoted to 'confirmed' below only after a QC-anchored inclusion proof
        verified: false,
        timestamp: (ev.timestamp || 0) * 1000,
        type: (String(ev.to || '').toLowerCase() === myAddress && String(ev.from || '').toLowerCase() !== myAddress) ? 'receive' : 'send',
        fee: 0,
        tokenContract: ev.contract,
        tokenSymbol: sym,
        tokenLogo: ev.logo,
        tokenStd: ev.std,
        tokenId: ev.token_id,
        // True only when decimals/symbol came from the wallet's OWN added-token registry (node-independent).
        // The ✓ trust badge requires this so it never sits next to a node-scaled magnitude for a token the
        // user never added (a dust-airdrop-as-"1,000,000 USDC" phishing row): base units are proven, but the
        // human magnitude is only trustworthy for added tokens.
        tokenMetaTrusted: !!tm,
        // Raw fields (verbatim from the node) needed to recompute the logs_root leaf for the P4 binding.
        tokenKind: ev.kind,
        tokenRawAmount: String(ev.amount == null ? '' : ev.amount),
        tokenAmountDisplay: fmtTokenBaseUnits(String(ev.amount || '0'), dec),
          };
        });
      const tokenHashes = new Set(tokenTxs.map(t => t.hash));

      // Native rows: keep every native type; drop only a ContractCall a token event already represents
      // (avoids a duplicate "0 QNC" row). A non-transfer contract call (approve / WASM) stays visible.
      let nativeTxs = [];
      const response = await nativePromise;
      if (response.ok) {
        const data = await response.json();
        const transactions = data.transactions || data || [];
        nativeTxs = transactions
          .filter(tx => !(String(tx.tx_type) === 'ContractCall' && tokenHashes.has(tx.hash || tx.tx_hash)))
          .map(tx => ({
            hash: tx.hash || tx.tx_hash,
            from: tx.from || tx.sender,
            to: tx.to || tx.recipient,
            amount: (tx.amount || 0) / 1e9,
            status: 'confirmed',
            // v3.33: Convert Unix timestamp (seconds) to milliseconds for Date()
            timestamp: (tx.timestamp || 0) * 1000,
            type: (tx.from || tx.sender || '').toLowerCase() === myAddress ? 'send' : 'receive',
            fee: (tx.fee || tx.gas_used || 0) / 1e9,
          }));
      }

      // Merge + sort newest-first so native + token rows interleave chronologically (a native Transfer
      // and a token event never share a hash, so no further dedup is needed).
      const formattedTxs = [...nativeTxs, ...tokenTxs]
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      // MERGE with pending TXs instead of replacing, but ONLY pending sent from THIS wallet —
      // a pending TX from a previously opened wallet must never survive a wallet switch.
      setTxHistory(prev => {
        const confirmedHashes = new Set(formattedTxs.map(t => t.hash));
        const stillPending = prev.filter(t =>
          t.status === 'pending' &&
          (t.from || '').toLowerCase() === myAddress &&
          !confirmedHashes.has(t.hash)
        );
        return [...stillPending, ...formattedTxs];
      });

      // P4: verify each token transfer's inclusion against a committee-QC-anchored logs_root. 'verified'
      // → confirmed + trust badge; 'consistent' → confirmed but unverified (real on-chain row below the
      // trust floor, so it stops showing ⏳ forever); 'rejected'/'pending' → stay pending (never confirmed).
      if (tokenTxs.length) {
        const statuses = new Map();
        await Promise.all(tokenTxs.map(async t => {
          // Bind the proof to THIS row's own fields (contract/from/to/amount/kind/std/token_id).
          const row = {
            tx_hash: t.hash, log_index: t.tokenLogIndex, contract: t.tokenContract,
            from: t.from, to: t.to, amount: t.tokenRawAmount, kind: t.tokenKind,
            std: t.tokenStd, token_id: t.tokenId,
          };
          const s = await walletManager.verifyTokenTransferInclusion(row);
          if (s === 'verified' || s === 'consistent') statuses.set(t.hash + ':' + t.tokenLogIndex, s);
        }));
        if (statuses.size) {
          setTxHistory(prev => prev.map(t => {
            const s = t.tokenContract ? statuses.get(t.hash + ':' + t.tokenLogIndex) : undefined;
            return s ? { ...t, status: 'confirmed', verified: s === 'verified' } : t;
          }));
        }
      }
    } catch (e) {
      // API error - keep existing history
    }
  };

  // v3.30: Add pending TX to history
  // `token` (optional) = { contract, symbol, logo, decimals, rawBaseUnits } marks this pending row as a
  // QRC-20 transfer so it renders with the token's icon + amount + symbol (parity with the confirmed
  // row), instead of a native "QNC" row. On confirm, loadTxHistory replaces it with the enriched row.
  const addPendingTxToHistory = (txHash, to, amount, fee, token) => {
    const pendingTx = {
      hash: txHash,
      from: wallet?.qnetAddress || '',
      to: to,
      amount: token && token.contract ? 0 : amount,
      status: 'pending',
      timestamp: Date.now(),
      type: 'send',
      fee: fee
    };
    if (token && token.contract) {
      pendingTx.tokenContract = token.contract;
      pendingTx.tokenSymbol = token.symbol || '';
      pendingTx.tokenLogo = token.logo || '';
      pendingTx.tokenAmountDisplay = fmtTokenBaseUnits(token.rawBaseUnits, token.decimals);
    }

    setTxHistory(prev => [pendingTx, ...prev.filter(t => t.hash !== txHash)]);
  };

  // v3.30: Update TX status in history
  const updateTxStatus = (txHash, status) => {
    setTxHistory(prev => prev.map(tx => 
      tx.hash === txHash ? { ...tx, status } : tx
    ));
  };

  const fetchTokenPrices = async () => {
    // Set fallback prices ONLY if not already set (prevent resetting real prices)
    setTokenPrices(prev => {
      if (prev.sol === 0 || prev.sol === undefined) {
        return { qnc: 0.0125, sol: 150.00, '1dev': 0.0001 };
      }
      return prev; // Keep existing prices
    });
    
    // Fetch real prices (no delay needed)
    try {
      // Only fetch prices if wallet is loaded
      if (!wallet) return;
        
      // Helper function to fetch with timeout (2 seconds)
      const fetchWithTimeout = async (url, timeout = 2000) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        try {
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timeoutId);
          return response;
        } catch (error) {
          clearTimeout(timeoutId);
          throw error;
        }
      };
      
      // Fetch SOL price with timeout
      try {
        const solResponse = await fetchWithTimeout('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
        if (solResponse.ok) {
          const solData = await solResponse.json();
          const realPrice = solData.solana?.usd;
          if (realPrice && realPrice > 0) {
            setTokenPrices(prev => ({ ...prev, sol: realPrice }));
          }
        }
      } catch (e) {
        // Silently fail, keep existing price
      }
      
      // Fetch 1DEV price (if available) with timeout
      try {
        const devResponse = await fetchWithTimeout('https://api.coingecko.com/api/v3/simple/price?ids=1dev&vs_currencies=usd');
        if (devResponse.ok) {
          const devData = await devResponse.json();
          const devPrice = devData['1dev']?.usd;
          if (devPrice && devPrice > 0) {
            setTokenPrices(prev => ({ ...prev, '1dev': devPrice }));
          }
        }
      } catch (e) {
        // Silently fail, keep existing price
      }
    } catch (error) {
      // Silently fail, keep existing prices
    }
  };

  const generateActivationCode = async () => {
    // Prompt for password to generate/retrieve activation code
    Alert.prompt(
      'Enter Password',
      'Enter your wallet password to generate activation code:',
      async (password) => {
        if (!password) return;
        
        try {
          // Verify password
          const walletData = await walletManager.loadWallet(password);
          if (!walletData) {
            showAlert('Error', 'Incorrect password');
            return;
          }
          
          // v3.18: Generate code for super node (full removed)
          let code = await walletManager.loadActivationCode('super', password);
          if (!code) {
            code = walletManager.generateActivationCode('super', walletData.address);
            await walletManager.storeActivationCode(code, 'super', password);
          }
          
          showAlert(
            'Node Activation Code',
            code,
            [
              { text: 'OK' }
            ]
          );
        } catch (error) {
          showAlert('Error', 'Failed to generate activation code');
        }
      },
      'secure-text'
    );
  };

  const exportSeedPhrase = async () => {
    if (!exportPassword) {
      showAlert('Error', 'Please enter your password');
      return;
    }

    try {
      // Verify password
      const passwordValid = await walletManager.verifyPassword(exportPassword);
      if (!passwordValid) {
        setExportPassword('');
        showAlert('Error', 'Incorrect password');
        return;
      }
      
      // Get mnemonic from encrypted storage
      const mnemonic = await walletManager.getEncryptedMnemonic(exportPassword);
      
      if (!mnemonic) {
        setExportPassword('');
        showAlert('Error', 'Failed to retrieve seed phrase');
        return;
      }

      // Format seed phrase
      const words = mnemonic.split(' ');
      const formattedSeed = words.map((word, i) => `${i + 1}. ${word}`).join('\n');

      setShowExportSeed(false);
      setExportPassword('');
      
      showAlert(
        'Recovery Phrase',
        `${formattedSeed}\n\n Keep it safe and never share!`,
        [
          { text: 'Copy', onPress: () => {
            Clipboard.setString(mnemonic);
            // Use visual feedback instead of alert
            copyToClipboard(mnemonic, 'seed');
            // Clear sensitive data from clipboard after 10 seconds
            setTimeout(() => {
              Clipboard.setString('');
            }, 10000);
          }},
          { text: 'OK', style: 'default' }
        ]
      );
    } catch (error) {
      // console.error('Export seed error:', error);
      showAlert('Error', 'Failed to export seed phrase');
    } finally {
      setExportPassword('');
    }
  };

  const exportActivationCode = async () => {
    if (!exportPassword) {
      showAlert('Error', 'Please enter your password');
      return;
    }

    try {
      // Quick password verification
      const passwordValid = await walletManager.verifyPassword(exportPassword);
      if (!passwordValid) {
        setExportPassword('');
        showAlert('Error', 'Incorrect password');
        return;
      }

      // Get stored activation codes directly
      const storedCodes = await walletManager.getStoredActivationCodes(exportPassword);
      
      if (storedCodes && Object.keys(storedCodes).length > 0) {
        // v4.5: Show codes WITH burn_tx_hash + burn_amount (needed for Docker -e)
        // Code is self-contained: XOR(wallet, SHA3(burn_tx:type:amount))
        // User needs all 3 values to activate server node
        const codeEntries = [];
        for (const [type, data] of Object.entries(storedCodes)) {
          const code = data.code || data;
          let entry = `${type.toUpperCase()} Node:\n${code}`;
          
          // Get burn metadata from AsyncStorage
          try {
            const metaStr = await AsyncStorage.getItem(`qnet_activation_meta_${type}`);
            if (metaStr) {
              const meta = JSON.parse(metaStr);
              if (meta.burnTxHash) {
                entry += `\nBurn TX: ${meta.burnTxHash}`;
              }
              if (meta.burnAmount) {
                entry += `\nBurn Amount: ${meta.burnAmount}`;
              }
            }
          } catch (_) { /* best effort */ }
          
          codeEntries.push(entry);
        }
        const codesList = codeEntries.join('\n\n');

        // Only show Docker instructions if there's a Super node (Light nodes don't need Docker)
        const hasSuper = Object.keys(storedCodes).some(t => t.toLowerCase() === 'super');
        const dockerHint = hasSuper
          ? '\n\nFor server node Docker:\n-e QNET_ACTIVATION_CODE=<code>\n-e QNET_BURN_TX_HASH=<tx>\n-e QNET_BURN_AMOUNT=<amount>'
          : '';
      
      setShowExportActivation(false);
      setExportPassword('');
      
      showAlert(
          'Activation Data',
          codesList + dockerHint,
          [
            { text: 'Copy All', onPress: async () => {
              // Build full copy data with burn info
              const copyParts = [];
              for (const [type, data] of Object.entries(storedCodes)) {
                const code = data.code || data;
                let part = code;
                try {
                  const metaStr = await AsyncStorage.getItem(`qnet_activation_meta_${type}`);
                  if (metaStr) {
                    const meta = JSON.parse(metaStr);
                    if (meta.burnTxHash) part += `\nBURN_TX=${meta.burnTxHash}`;
                    if (meta.burnAmount) part += `\nBURN_AMOUNT=${meta.burnAmount}`;
                  }
                } catch (_) {}
                copyParts.push(part);
              }
              Clipboard.setString(copyParts.join('\n\n'));
              setTimeout(() => {
                Clipboard.setString('');
              }, 30000);
            }},
            { text: 'OK' }
          ]
        );
      } else {
        // No codes stored yet
        setShowExportActivation(false);
        setExportPassword('');
        showAlert('Info', 'No activation codes generated yet. Generate one from the Activation tab.');
      }
    } catch (error) {
      // console.error('Export activation error:', error);
      setExportPassword('');
      showAlert('Error', 'Failed to get activation codes');
    } finally {
      setExportPassword('');
    }
  };

  const handleChangePassword = async () => {
    if (!newPassword || newPassword.length < 8) {
      showAlert('Error', 'New password must be at least 8 characters');
      return;
    }

    if (newPassword !== confirmNewPassword) {
      showAlert('Error', 'New passwords do not match');
      return;
    }

    try {
      setLoading(true);
      
      // Verify current password by trying to unlock wallet
      const walletData = await walletManager.loadWallet(currentPassword);
      if (!walletData) {
        showAlert('Error', 'Current password is incorrect');
        setLoading(false);
        return;
      }

      // Re-encrypt wallet with new password
      await walletManager.storeWallet(walletData, newPassword);

      // Update Keychain if biometric unlock is enabled
      if (biometricEnabled) {
        await walletManager.enableBiometricUnlock(newPassword);
      }
      
      showAlert('Success', 'Password changed successfully!');
      setShowChangePassword(false);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
    } catch (error) {
      showAlert('Error', 'Failed to change password: ' + error.message);
    }
  };

  const handleToggleBiometric = async () => {
    if (!biometricSupported) {
      showAlert('Error', t('biometric_unavailable'));
      return;
    }
    if (biometricEnabled) {
      const ok = await walletManager.disableBiometricUnlock();
      if (ok) {
        setBiometricEnabled(false);
        showAlert('', t('biometric_disabled_msg'));
      }
    } else {
      // Prompt for password to store in Keychain
      setShowBiometricPasswordPrompt(true);
    }
  };

  const handleConfirmBiometricEnable = async () => {
    const valid = await walletManager.verifyPassword(biometricPassword);
    if (!valid) {
      showAlert('Error', t('incorrect_password'));
      setBiometricPassword('');
      return;
    }
    const ok = await walletManager.enableBiometricUnlock(biometricPassword);
    setBiometricPassword('');
    setShowBiometricPasswordPrompt(false);
    if (ok) {
      setBiometricEnabled(true);
      showAlert('', t('biometric_enabled_msg'));
    } else {
      showAlert('Error', t('biometric_unavailable'));
    }
  };

  const deleteWallet = async () => {
    showAlert(
      '⚠️ Delete Wallet',
      'Are you sure you want to delete this wallet? Make sure you have backed up your recovery phrase!',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              // Stop light-node attestation FIRST: cancels the background ping task, wipes the ping
              // signing key, and removes qnet_light_node_info / qnet_ping_node_id / last-attest epoch.
              // Otherwise the "deleted" device keeps attesting (and earning eligibility) for 1-2 epochs.
              await teardownLightNode();
              await AsyncStorage.removeItem('qnet_wallet');
              await AsyncStorage.removeItem('qnet_wallet_address');
              await walletManager.disableBiometricUnlock();
              setBiometricEnabled(false);
              setWallet(null);
              setHasWallet(false);
              setActivatedNodeType(null);
              setActivationCode(null);
              setNodeStatus(null);
              setLightNodeStatus(null);
              setServerNodeStatus(null);
              setNodePseudonym('');
              // Clear ALL node-related AsyncStorage (both light and super)
              const keysAll = await AsyncStorage.getAllKeys();
              const nodeKeys = keysAll.filter(k =>
                k.startsWith('blockchain_check_') ||
                k.startsWith('node_pseudonym_') ||
                k === 'qnet_activation_codes' ||
                k === 'qnet_activation_meta_light' ||
                k === 'qnet_activation_meta_full' ||
                k === 'qnet_activation_meta_super' ||
                k === 'qnet_last_activated_node' ||
                k === 'qnet_cached_server_status'
              );
              if (nodeKeys.length > 0) await AsyncStorage.multiRemove(nodeKeys);
              
            } catch (error) {
              showAlert('Error', 'Failed to delete wallet: ' + error.message);
            }
          }
        }
      ]
    );
  };

  // Terms of Service Modal
  const renderTermsModal = () => {
    if (!showTermsModal) return null;
    
    return (
      <Modal
        visible={showTermsModal}
        animationType="fade"
        transparent={true}
        onRequestClose={() => setShowTermsModal(false)}
      >
        <View style={styles.termsModal}>
          <View style={styles.termsModalContent}>
            <View style={styles.termsModalHeader}>
              <Text style={styles.termsModalTitle}>{t('terms_title')}</Text>
              <TouchableOpacity 
                style={styles.termsModalClose}
                onPress={() => setShowTermsModal(false)}
              >
                <Text style={styles.termsModalCloseText}>×</Text>
              </TouchableOpacity>
            </View>
            
            <ScrollView 
              style={styles.termsModalBody}
              showsVerticalScrollIndicator={true}
              bounces={true}
              scrollEnabled={true}
            >
              <Text style={styles.termsModalText}>{t('terms_text')}</Text>
            </ScrollView>
            
            <View style={styles.termsModalButtons}>
              <TouchableOpacity 
                style={[styles.termsModalButton, styles.termsModalDecline]}
                onPress={() => {
                  setShowTermsModal(false);
                  setTermsAccepted(false);
                }}
              >
                <Text style={[styles.termsModalButtonText, styles.termsModalDeclineText]}>
                  {t('decline')}
                </Text>
              </TouchableOpacity>
              
              <TouchableOpacity 
                style={[styles.termsModalButton, styles.termsModalAccept]}
                onPress={() => {
                  setShowTermsModal(false);
                  setTermsAccepted(true);
                }}
              >
                <Text style={[styles.termsModalButtonText, styles.termsModalAcceptText]}>
                  {t('accept')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centerContent}>
          <Text style={styles.title}>QNet Wallet</Text>
          <Text style={styles.subtitle}>Loading...</Text>
        </View>
        {renderTermsModal()}
      </SafeAreaView>
    );
  }

  // Seed phrase confirmation screen
  if (showSeedConfirm && tempWallet && tempWallet.mnemonic) {
    const words = tempWallet.mnemonic.split(' ');
    const positions = Object.keys(seedConfirmWords).map(Number).sort((a, b) => a - b);
    
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView 
          contentContainerStyle={styles.seedConfirmContent}
          showsVerticalScrollIndicator={true}
          bounces={true}
          scrollEnabled={true}
        >
          <Text style={styles.title}>Confirm Your Recovery Phrase</Text>
          <Text style={styles.subtitle}>
            Please enter the following words from your recovery phrase to confirm you've saved it correctly
          </Text>
          
          {positions.map(pos => (
            <View key={pos} style={styles.seedConfirmGroup}>
              <Text style={styles.label}>Select word #{pos + 1}</Text>
              <View style={styles.wordChoicesContainer}>
                {wordChoices[pos]?.map((word, idx) => (
                  <TouchableOpacity
                    key={idx}
                    style={[
                      styles.wordChoiceButton,
                      seedConfirmWords[pos] === word && styles.wordChoiceSelected
                    ]}
                    onPress={() => {
                      // Clear error when user makes a selection
                      setVerificationError('');
                      setSeedConfirmWords({
                        ...seedConfirmWords,
                        [pos]: word
                      });
                    }}
                  >
                    <Text style={[
                      styles.wordChoiceText,
                      seedConfirmWords[pos] === word && styles.wordChoiceTextSelected
                    ]}>
                      {word}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          ))}
          
          {/* Verification Error Message (like in browser extension) */}
          {verificationError ? (
            <View style={styles.verificationErrorBox}>
              <Text style={styles.verificationErrorText}>{verificationError}</Text>
            </View>
          ) : null}
          
          <TouchableOpacity 
            style={styles.button}
            onPress={confirmSeedPhrase}
            disabled={Boolean(loading || !Object.values(seedConfirmWords).every(w => w && w.length > 0))}
          >
            <Text style={styles.buttonText}>
              {loading ? 'Verifying...' : 'Confirm & Create Wallet'}
            </Text>
          </TouchableOpacity>
          
          <TouchableOpacity 
            style={[styles.button, styles.secondaryButton]}
            onPress={() => {
              // Clear error when going back
              setVerificationError('');
              // Direct action without modal for better UX
              setShowSeedConfirm(false);
              setShowCreateOptions('show-seed'); // Go back to seed display
            }}
          >
            <Text style={[styles.buttonText, styles.secondaryButtonText]}>Back</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (!hasWallet) {
    if (!showCreateOptions) {
      return (
        <SafeAreaView 
          style={[styles.container, Platform.OS === 'ios' && {paddingTop: 44}]} 
          edges={Platform.OS === 'ios' ? ['left', 'right'] : ['top', 'left', 'right']}
        >
          <View style={styles.centerContent}>
            <Text style={styles.title}>QNet Wallet</Text>
            <Text style={styles.subtitle}>Get started with QNet</Text>
            
            <TouchableOpacity 
              style={styles.button}
              onPress={() => {
                // Clear all password fields when starting create
                setPassword('');
                setConfirmPassword('');
                setPasswordError('');
                setTermsAccepted(false); // Reset terms
                setShowCreateOptions('create');
              }}
            >
              <Text style={styles.buttonText}>Create New Wallet</Text>
            </TouchableOpacity>

            <TouchableOpacity 
              style={[styles.button, styles.secondaryButton]}
              onPress={() => {
                // Clear all password fields when starting import
                setPassword('');
                setConfirmPassword('');
                setSeedPhrase('');
                setPasswordError('');
                setTermsAccepted(false); // Reset terms
                setImportStep(1);
                setShowCreateOptions('import');
              }}
            >
              <Text style={[styles.buttonText, styles.secondaryButtonText]}>Import Existing Wallet</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      );
    }

    if (showCreateOptions === 'create') {
      return (
        <SafeAreaView 
          style={[styles.container, Platform.OS === 'ios' && {paddingTop: 44}]} 
          edges={Platform.OS === 'ios' ? ['left', 'right'] : ['top', 'left', 'right']}
        >
          <ScrollView
            contentContainerStyle={styles.formContent}
            showsVerticalScrollIndicator={true}
            bounces={true}
            scrollEnabled={true}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.title}>Create Wallet</Text>
            <Text style={styles.subtitle}>Enter a strong password (min 8 characters)</Text>
            
            <TextInput
              style={[styles.input, passwordError && password.length > 0 && password.length < 8 ? styles.inputError : null]}
              placeholder="Enter password"
              placeholderTextColor="#888"
              secureTextEntry
              value={password}
              onChangeText={(text) => {
                setPassword(text);
                setPasswordError('');
              }}
            />

            {password.length > 0 && password.length < 8 && (
              <Text style={styles.passwordHint}>
                {8 - password.length} more character{8 - password.length > 1 ? 's' : ''} needed
              </Text>
            )}

            {password.length >= 8 && (
              <Text style={styles.passwordSuccess}>
                ✓ Password length is good
              </Text>
            )}

            <TextInput
              style={[styles.input, passwordError && confirmPassword.length > 0 && password !== confirmPassword ? styles.inputError : null]}
              placeholder="Confirm password"
              placeholderTextColor="#888"
              secureTextEntry
              value={confirmPassword}
              onChangeText={(text) => {
                setConfirmPassword(text);
                setPasswordError('');
              }}
            />

            {confirmPassword.length > 0 && password !== confirmPassword && (
              <Text style={styles.errorText}>
                Passwords do not match
              </Text>
            )}

            {confirmPassword.length > 0 && password === confirmPassword && password.length >= 8 && (
              <Text style={styles.passwordSuccess}>
                ✓ Passwords match
              </Text>
            )}

            {passwordError ? (
              <Text style={styles.errorText}>{passwordError}</Text>
            ) : null}
            
            {/* Terms of Service Checkbox */}
            <View style={styles.termsContainer}>
            <TouchableOpacity 
                style={styles.checkbox}
                onPress={() => setTermsAccepted(!termsAccepted)}
              >
                <View style={[styles.checkboxInner, termsAccepted && styles.checkboxChecked]}>
                  {termsAccepted && <Text style={styles.checkmark}>✓</Text>}
                </View>
              </TouchableOpacity>
              <View style={styles.termsTextContainer}>
                <Text style={styles.termsText}>I accept the </Text>
                <TouchableOpacity onPress={() => setShowTermsModal(true)}>
                  <Text style={styles.termsLink}>Terms of Service</Text>
                </TouchableOpacity>
              </View>
            </View>
            
            <TouchableOpacity 
              style={[styles.button, !termsAccepted && styles.buttonDisabled]}
              onPress={createWallet}
              disabled={loading || !termsAccepted}
            >
              <Text style={styles.buttonText}>
                {loading ? 'Creating...' : 'Create Wallet'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity 
              style={[styles.button, styles.secondaryButton]}
              onPress={() => {
                setShowCreateOptions(false);
                setPassword('');
                setConfirmPassword('');
                setPasswordError('');
                setTermsAccepted(false); // Reset terms
              }}
            >
              <Text style={[styles.buttonText, styles.secondaryButtonText]}>Back</Text>
            </TouchableOpacity>
          </ScrollView>
          {renderTermsModal()}
        </SafeAreaView>
      );
    }

    // Show seed phrase screen (beautiful grid like extension)
    if (showCreateOptions === 'show-seed' && tempWallet) {
      const words = tempWallet.mnemonic.split(' ');
      
      return (
        <SafeAreaView style={styles.container}>
          <ScrollView 
            contentContainerStyle={[styles.formContent, {paddingTop: 40, paddingBottom: 100}]}
            showsVerticalScrollIndicator={true}
            bounces={true}
            scrollEnabled={true}
          >
            <Text style={[styles.title, {fontSize: 18}]}>Save Your Recovery Phrase</Text>
            <Text style={[styles.subtitle, {fontSize: 13, marginBottom: 15}]}>
              Write down these 12 words in order. You'll need them to recover your wallet.
            </Text>
            
            <View style={[styles.seedGrid, {marginVertical: 10}]}>
              {words.map((word, index) => (
                <View key={index} style={[styles.seedWordContainer, {padding: 8, marginBottom: 6}]}>
                  <Text style={[styles.seedWordNumber, {fontSize: 11}]}>{index + 1}</Text>
                  <Text style={[styles.seedWordText, {fontSize: 13}]}>{word}</Text>
                </View>
              ))}
            </View>
            
            <TouchableOpacity 
              style={[styles.button, styles.secondaryButton, {marginVertical: 10, minHeight: 44}]}
              onPress={() => {
                try {
                  // Copy seed phrase to clipboard
                  const seedText = words.join(' ');
                  Clipboard.setString(seedText);
                  // Use visual feedback instead of alert
                  copyToClipboard(seedText, 'seed');
                  // Clear sensitive data from clipboard after 10 seconds
                  setTimeout(() => {
                    Clipboard.setString('');
                  }, 10000);
                } catch (error) {
                  showAlert('Error', 'Failed to copy to clipboard');
                }
              }}
            >
              <Text style={[styles.buttonText, styles.secondaryButtonText]}>Copy Recovery Phrase</Text>
            </TouchableOpacity>
            
            <Text style={[styles.warningText, {marginTop: 10, marginBottom: 15, fontSize: 13}]}>
              ⚠️ Never share this with anyone!
            </Text>
            
            <TouchableOpacity 
              style={[styles.button, {marginBottom: 20, minHeight: 44}]}
              onPress={() => {
                setShowSeedConfirm(true);
                setShowCreateOptions(false);
              }}
            >
              <Text style={styles.buttonText}>I Wrote It Down</Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      );
    }

    if (showCreateOptions === 'import') {
      // Step 1: Set password
      if (importStep === 1) {
        return (
          <SafeAreaView 
            style={[styles.container, Platform.OS === 'ios' && {paddingTop: 44}]} 
            edges={Platform.OS === 'ios' ? ['left', 'right'] : ['top', 'left', 'right']}
          >
            <ScrollView
              contentContainerStyle={styles.formContent}
              showsVerticalScrollIndicator={true}
              bounces={true}
              scrollEnabled={true}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={styles.title}>Import Wallet</Text>
              <Text style={styles.subtitle}>Step 1: Create password</Text>
              
              <TextInput
                style={[styles.input, passwordError && password.length > 0 && password.length < 8 ? styles.inputError : null]}
                placeholder="Enter password (min 8 characters)"
                placeholderTextColor="#888"
                secureTextEntry
                value={password}
                onChangeText={(text) => {
                  setPassword(text);
                  setPasswordError('');
                }}
              />

              {password.length > 0 && password.length < 8 && (
                <Text style={styles.passwordHint}>
                  {8 - password.length} more character{8 - password.length > 1 ? 's' : ''} needed
                </Text>
              )}

              {password.length >= 8 && (
                <Text style={styles.passwordSuccess}>
                  ✓ Password length is good
                </Text>
              )}

              <TextInput
                style={[styles.input, passwordError && confirmPassword.length > 0 && password !== confirmPassword ? styles.inputError : null]}
                placeholder="Confirm password"
                placeholderTextColor="#888"
                secureTextEntry
                value={confirmPassword}
                onChangeText={(text) => {
                  setConfirmPassword(text);
                  setPasswordError('');
                }}
              />

              {confirmPassword.length > 0 && password !== confirmPassword && (
                <Text style={styles.errorText}>
                  Passwords do not match
                </Text>
              )}

              {confirmPassword.length > 0 && password === confirmPassword && password.length >= 8 && (
                <Text style={styles.passwordSuccess}>
                  ✓ Passwords match
                </Text>
              )}

              {passwordError ? (
                <Text style={styles.errorText}>{passwordError}</Text>
              ) : null}
              
              <TouchableOpacity 
                style={styles.button}
                onPress={() => {
                  if (!validatePassword()) {
                    return;
                  }
                  setImportStep(2);
                }}
              >
                <Text style={styles.buttonText}>
                  Next
                </Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={[styles.button, styles.secondaryButton]}
                onPress={() => {
                  setShowCreateOptions(false);
                  setPassword('');
                  setConfirmPassword('');
                  setSeedPhrase('');
                  setPasswordError('');
                  setTermsAccepted(false); // Reset terms
                  setImportStep(1);
                }}
              >
                <Text style={[styles.buttonText, styles.secondaryButtonText]}>Back</Text>
              </TouchableOpacity>
            </ScrollView>
            {renderTermsModal()}
          </SafeAreaView>
        );
      }

      // Step 2: Enter seed phrase
      if (importStep === 2) {
        return (
          <SafeAreaView 
            style={[styles.container, Platform.OS === 'ios' && {paddingTop: 44}]} 
            edges={Platform.OS === 'ios' ? ['left', 'right'] : ['top', 'left', 'right']}
          >
            <ScrollView
              contentContainerStyle={styles.formContent}
              showsVerticalScrollIndicator={true}
              bounces={true}
              scrollEnabled={true}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={styles.title}>Import Wallet</Text>
              <Text style={styles.subtitle}>Step 2: Enter your seed phrase</Text>
              
              <TextInput
                style={[styles.input, styles.textArea]}
                placeholder="Enter 12 or 24 word seed phrase"
                placeholderTextColor="#888"
                multiline
                value={seedPhrase}
                onChangeText={(text) => {
                  setSeedPhrase(text);
                  setPasswordError('');
                }}
              />

              {seedPhrase.trim().length > 0 && (
                <Text style={
                  seedPhrase.trim().split(/\s+/).length === 12 || seedPhrase.trim().split(/\s+/).length === 24
                    ? styles.passwordSuccess
                    : styles.passwordHint
                }>
                  {seedPhrase.trim().split(/\s+/).length} words
                  {(seedPhrase.trim().split(/\s+/).length === 12 || seedPhrase.trim().split(/\s+/).length === 24) && ' ✓'}
                </Text>
              )}

              {passwordError ? (
                <Text style={styles.errorText}>{passwordError}</Text>
              ) : null}
              
              {/* Terms of Service Checkbox */}
              <View style={styles.termsContainer}>
              <TouchableOpacity 
                  style={styles.checkbox}
                  onPress={() => setTermsAccepted(!termsAccepted)}
                >
                  <View style={[styles.checkboxInner, termsAccepted && styles.checkboxChecked]}>
                    {termsAccepted && <Text style={styles.checkmark}>✓</Text>}
                  </View>
                </TouchableOpacity>
                <View style={styles.termsTextContainer}>
                  <Text style={styles.termsText}>I accept the </Text>
                  <TouchableOpacity onPress={() => setShowTermsModal(true)}>
                    <Text style={styles.termsLink}>Terms of Service</Text>
                  </TouchableOpacity>
                </View>
              </View>
              
              <TouchableOpacity 
                style={[styles.button, !termsAccepted && styles.buttonDisabled]}
                onPress={importWallet}
                disabled={loading || !termsAccepted}
              >
                <Text style={styles.buttonText}>
                  {loading ? 'Importing...' : 'Import Wallet'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={[styles.button, styles.secondaryButton]}
                onPress={() => {
                  setImportStep(1);
                  setSeedPhrase('');
                  setPasswordError('');
                  setTermsAccepted(false); // Reset terms
                }}
              >
                <Text style={[styles.buttonText, styles.secondaryButtonText]}>Back</Text>
              </TouchableOpacity>
            </ScrollView>
            {renderTermsModal()}
          </SafeAreaView>
        );
      }
    }
  }

  if (!wallet) {
    const lockoutSec = Math.ceil(lockoutMs / 1000);
    const lockoutMin = Math.floor(lockoutSec / 60);
    const lockoutDisplay = lockoutMin > 0
      ? `${lockoutMin}m ${lockoutSec % 60}s`
      : `${lockoutSec}s`;

    return (
      <SafeAreaView 
        style={[styles.container, Platform.OS === 'ios' && {paddingTop: 44}]} 
        edges={Platform.OS === 'ios' ? ['left', 'right'] : ['top', 'left', 'right']}
      >
        <View style={styles.centerContent}>
          <Text style={styles.title}>QNet Wallet</Text>
          <Text style={styles.subtitle}>{t('unlock_wallet')}</Text>

          {lockoutMs > 0 ? (
            <View style={styles.lockoutBanner}>
              <Text style={styles.lockoutText}>
                {t('wallet_locked')} {lockoutDisplay}
              </Text>
            </View>
          ) : (
            <>
              <TextInput
                style={styles.input}
                placeholder={t('enter_password')}
                placeholderTextColor="#888"
                secureTextEntry
                value={password}
                onChangeText={setPassword}
                onSubmitEditing={unlockWallet}
                returnKeyType="done"
              />

              <TouchableOpacity 
                style={styles.button}
                onPress={unlockWallet}
                disabled={loading}
              >
                <Text style={styles.buttonText}>
                  {loading ? 'Unlocking...' : t('unlock_wallet')}
                </Text>
              </TouchableOpacity>

              {biometricEnabled && (
                <TouchableOpacity
                  style={[styles.button, { backgroundColor: '#1a1a2e', marginTop: 12 }]}
                  onPress={handleBiometricUnlock}
                >
                  <Text style={styles.buttonText}>{t('biometric_unlock')}</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>

        {/* Error Toast */}
        {unlockError ? (
          <View style={styles.errorToast}>
            <Text style={styles.errorToastText}>{unlockError}</Text>
          </View>
        ) : null}
      </SafeAreaView>
    );
  }

  const renderTabContent = () => {
    switch(activeTab) {
      case 'assets':
        // Show Send Screen (inline, same size as assets)
        if (showSendScreen && sendingToken) {
          // Transaction Result Screen
          if (txResult) {
            return (
              <TabBox key="assets-result" deps={[txResult]} render={() => (
              <ScrollView
                style={styles.content}
                contentContainerStyle={[styles.scrollContentContainer, styles.sendScreenContainer]}
              >
                {/* No header on the result screen: the ✓/✕ icon + title convey the outcome and the
                    Done button dismisses — the redundant "← Back / Success" bar is removed. */}
                <View style={styles.txResultContainer}>
                  {txResult.success ? (
                    <>
                      <View style={styles.txSuccessIcon}>
                        <Text style={styles.txSuccessIconText}>✓</Text>
                      </View>
                      <Text style={styles.txResultTitle}>Transaction Sent!</Text>
                      <Text style={styles.txResultAmount}>
                        {txResult.amount} {txResult.symbol}
                      </Text>
                      <Text style={styles.txResultTo}>
                        To: {txResult.to?.substring(0, 12)}...{txResult.to?.substring(txResult.to.length - 8)}
                      </Text>
                      <TouchableOpacity
                        style={styles.txHashContainer}
                        activeOpacity={0.7}
                        onPress={() => {
                          if (txResult.txHash) {
                            Clipboard.setString(txResult.txHash);
                            showAlert('Copied', 'Transaction hash copied to clipboard');
                          }
                        }}
                      >
                        <Text style={styles.txHashLabel}>Transaction Hash (tap to copy)</Text>
                        <Text style={styles.txHashValue}>{txResult.txHash?.substring(0, 24)}...</Text>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <>
                      <View style={styles.txErrorIcon}>
                        <Text style={styles.txErrorIconText}>✕</Text>
                      </View>
                      <Text style={styles.txResultTitle}>Transaction Failed</Text>
                      <Text style={styles.txErrorMessage}>{txResult.error}</Text>
                    </>
                  )}
                  
                  <TouchableOpacity 
                    style={styles.txDoneButton}
                    onPress={closeSendScreen}
                  >
                    <Text style={styles.txDoneButtonText}>Done</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
              )} />
            );
          }

          // Send Form Screen
          return (
            <TabBox key="assets-send" deps={[showSendScreen, sendingToken, sendAddress, sendAmount, sendingTransaction, balancesHidden]} render={() => (
            <KeyboardAvoidingView
              style={{ flex: 1 }}
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
            <ScrollView
              style={styles.content}
              contentContainerStyle={[styles.scrollContentContainer, styles.sendScreenContainer]}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.sendScreenHeader}>
                <TouchableOpacity onPress={closeSendScreen} style={styles.backButton}>
                  <Text style={styles.backButtonText}>← Back</Text>
                </TouchableOpacity>
                <Text style={styles.sendScreenTitle}>Send {sendingToken.symbol}</Text>
                <View style={{width: 60}} />
              </View>
              
              {/* Balance Info */}
              <View style={styles.sendBalanceInfo}>
                <Text style={styles.sendBalanceLabel}>Available Balance</Text>
                <Text style={styles.sendBalanceAmount}>{maskAmt(sendingToken.balance.toFixed(5))} {sendingToken.symbol}</Text>
              </View>
              
              {/* Recipient Address */}
              <View style={styles.formGroup}>
                <Text style={styles.label}>To Address</Text>
                <TextInput
                  style={styles.input}
                  placeholder={sendingToken.network === 'qnet' ? 'Enter EON address' : 'Enter address'}
                  placeholderTextColor="#888"
                  value={sendAddress}
                  onChangeText={setSendAddress}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              
              {/* Amount Input */}
              <View style={styles.formGroup}>
                <Text style={styles.label}>Amount</Text>
                <TextInput
                  style={styles.input}
                  placeholder="0.00"
                  placeholderTextColor="#888"
                  keyboardType="decimal-pad"
                  value={sendAmount}
                  onChangeText={validateAmountInput}
                  maxLength={20}
                />
                
                {/* Percentage Buttons */}
                <View style={styles.percentageButtons}>
                  <TouchableOpacity 
                    style={styles.percentButton}
                    onPress={() => setAmountPercentage(25)}
                  >
                    <Text style={styles.percentButtonText}>25%</Text>
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={styles.percentButton}
                    onPress={() => setAmountPercentage(50)}
                  >
                    <Text style={styles.percentButtonText}>50%</Text>
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={styles.percentButton}
                    onPress={() => setAmountPercentage(75)}
                  >
                    <Text style={styles.percentButtonText}>75%</Text>
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={styles.percentButton}
                    onPress={() => setAmountPercentage(100)}
                  >
                    <Text style={styles.percentButtonText}>MAX</Text>
                  </TouchableOpacity>
                </View>
              </View>
              
              {/* Network Fee */}
              <View style={styles.sendFeeContainer}>
                <Text style={styles.sendFeeLabel}>Network Fee</Text>
                <Text style={styles.sendFeeValue}>
                  {sendingToken.network === 'qnet' ? '0.00001 QNC' : '~0.00025 SOL'}
                </Text>
              </View>
              
              {/* Total Cost */}
              {sendAmount && parseFloat(sendAmount) > 0 && (
                <View style={styles.sendTotalContainer}>
                  <Text style={styles.sendTotalLabel}>Total</Text>
                  <Text style={styles.sendTotalValue}>
                    {(parseFloat(sendAmount) + (sendingToken.network === 'qnet' ? 0.00001 : 0.00025)).toFixed(6)} {sendingToken.symbol}
                  </Text>
                </View>
              )}
              
              {/* Send Button */}
              <TouchableOpacity 
                style={[styles.button, (!sendAddress || !sendAmount || sendingTransaction) && styles.buttonDisabled]}
                onPress={handleSendTransaction}
                disabled={!sendAddress || !sendAmount || sendingTransaction}
              >
                <Text style={styles.buttonText}>
                  {sendingTransaction ? 'Sending...' : 'Send Transaction'}
                </Text>
              </TouchableOpacity>
            </ScrollView>
            </KeyboardAvoidingView>
            )} />
          );
        }

        // Normal Assets View
        return (
          <TabBox key="assets-normal" deps={[refreshing, wallet, selectedNetwork, tokenBalances, balance, tokenPrices, copiedAddress, qrcTokens, hiddenTokens, balancesHidden]} render={() => (
          <ScrollView
            style={styles.content}
            contentContainerStyle={styles.scrollContentContainer}
            onScroll={handleUserActivity}
            scrollEventThrottle={500}
            showsVerticalScrollIndicator={true}
            bounces={true}
            scrollEnabled={true}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={async () => {
                  setRefreshing(true);
                  try {
                    await loadBalance(wallet.publicKey);
                    await fetchTokenPrices();
                  } catch (error) {
                    // console.error('Error refreshing:', error);
                  } finally {
                    setRefreshing(false);
                  }
                }}
                colors={['#00d4ff']}
                tintColor="#00d4ff"
                titleColor="#00d4ff"
                title="Pull to refresh"
              />
            }
          >
            {/* Network Selector */}
            <View style={styles.networkSelector}>
              <TouchableOpacity 
                style={[styles.networkTab, selectedNetwork === 'qnet' && styles.networkTabActive]}
                onPress={() => {
                  setSelectedNetwork('qnet');
                  // Refresh balance for QNet network
                  if (wallet && wallet.publicKey) {
                    loadBalance(wallet.publicKey);
                  }
                }}
              >
                <Text style={[styles.networkTabText, selectedNetwork === 'qnet' && styles.networkTabTextActive]}>QNet</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.networkTab, selectedNetwork === 'solana' && styles.networkTabActive]}
                onPress={() => {
                  setSelectedNetwork('solana');
                  // Refresh balance for Solana network
                  if (wallet && wallet.publicKey) {
                    loadBalance(wallet.publicKey);
                  }
                }}
              >
                <Text style={[styles.networkTabText, selectedNetwork === 'solana' && styles.networkTabTextActive]}>Solana</Text>
              </TouchableOpacity>
            </View>

            {/* Address Display (above balance like in extension) */}
            <TouchableOpacity 
              style={styles.addressContainer}
              onPress={() => {
                const currentAddress = selectedNetwork === 'qnet' 
                  ? (wallet.qnetAddress || wallet.address)
                  : (wallet.solanaAddress || wallet.address);
                const addressType = selectedNetwork === 'qnet' ? 'qnet' : 'solana';
                copyToClipboard(currentAddress, addressType);
              }}
            >
              <View style={styles.addressRow}>
                <Text style={[
                  styles.addressText,
                  copiedAddress === (selectedNetwork === 'qnet' ? 'qnet' : 'solana') && styles.addressTextCopied
                ]}>
                  {selectedNetwork === 'qnet' 
                    ? (wallet.qnetAddress || wallet.address)
                    : (wallet.solanaAddress || wallet.address)}
              </Text>
              </View>
              <Text style={[
                styles.copyHint,
                copiedAddress === (selectedNetwork === 'qnet' ? 'qnet' : 'solana') && { color: '#00ff00' }
              ]}>
                {copiedAddress === (selectedNetwork === 'qnet' ? 'qnet' : 'solana') 
                  ? '✓ Copied' 
                  : 'Tap to copy'}
              </Text>
            </TouchableOpacity>

            {/* Token List based on selected network */}
            {selectedNetwork === 'qnet' ? (
              <View style={styles.tokenList}>
                {/* QNC Token - Clickable to open Send screen. Hidden if toggled off in the token manager. */}
                {!hiddenTokens.has('native:qnc') && (
                <TouchableOpacity
                  style={styles.tokenItemClickable}
                  onPress={() => openSendModal('QNC', tokenBalances.qnc, 'qnet')}
                  activeOpacity={0.6}
                >
                  <View style={styles.tokenInfo}>
                    <View style={styles.tokenIcon}>
                        <Image
                        source={require('../../assets/qnet_logo.png')}
                          style={styles.tokenIconImage}
                          resizeMode="contain"
                        />
                    </View>
                    <View style={styles.tokenDetails}>
                      <Text style={styles.tokenName}>QNC</Text>
                    </View>
                  </View>
                  <View style={styles.tokenBalance}>
                    <Text style={styles.tokenAmount}>{maskAmt(tokenBalances.qnc.toFixed(5))}</Text>
                  </View>
                </TouchableOpacity>
                )}

                {/* QRC-20 holdings + custom tokens (deduped, hidden filtered via ⋮ manager); tap=Send, long-press=hide. */}
                {qrcTokens.filter((tk) => !hiddenTokens.has(tk.contract)).map((tk) => {
                  return (
                  <TouchableOpacity
                    key={tk.contract}
                    style={styles.tokenItemClickable}
                    onPress={() => openSendModal(
                      tk.symbol || tk.name || 'Token',
                      parseFloat(tk.balance) || 0,
                      'qnet',
                      { contract: tk.contract, decimals: tk.decimals }
                    )}
                    onLongPress={() => {
                      const label = tk.symbol || tk.name || 'Token';
                      Alert.alert('Hide token', label, [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Hide', style: 'destructive', onPress: () => hideToken(tk.contract) },
                      ]);
                    }}
                    activeOpacity={0.6}
                  >
                    <View style={styles.tokenInfo}>
                      {(() => {
                        // Token icon: an inert emoji logo, else a deterministic coloured-circle letter
                        // avatar (colour from the contract address). Privacy: a node-supplied https logo
                        // is never loaded as <Image> here — it would leak the device IP/timing to an
                        // attacker-controlled host — so a URL logo falls through to the letter avatar.
                        const logo = typeof tk.logo === 'string' ? tk.logo.trim() : '';
                        const isEmoji = logo.length > 0 && logo.length <= 8 && !logo.startsWith('http');
                        let h = 0;
                        const seed = String(tk.contract || tk.symbol || '?');
                        for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
                        const bg = isEmoji ? '#0b1a22' : `hsl(${h % 360}, 60%, 42%)`;
                        return (
                          <View style={[styles.tokenIcon, { backgroundColor: bg, borderRadius: 20 }]}>
                            <Text style={[styles.tokenIconText, { color: '#ffffff' }]}>
                              {isEmoji ? logo : (tk.symbol || tk.name || 'T').slice(0, 1).toUpperCase()}
                            </Text>
                          </View>
                        );
                      })()}
                      <View style={styles.tokenDetails}>
                        <Text style={styles.tokenName}>{tk.symbol || tk.name || 'Token'}</Text>
                        {!!tk.name && tk.name !== tk.symbol && (
                          <Text style={styles.tokenPrice}>{tk.name}</Text>
                        )}
                      </View>
                    </View>
                    <View style={styles.tokenBalance}>
                      <Text style={styles.tokenAmount}>
                        {maskAmt(`${tk.balance}${tk.verified ? ' ✓' : ''}`)}
                      </Text>
                    </View>
                  </TouchableOpacity>
                  );
                })}
              </View>
            ) : (
              <View style={styles.tokenList}>
                {/* SOL Token */}
                <View style={styles.tokenItem}>
                  <View style={styles.tokenInfo}>
                    <View style={styles.tokenIcon}>
                      {getTokenIconUrl('SOL') ? (
                        <Image 
                          source={{uri: getTokenIconUrl('SOL')}} 
                          style={styles.tokenIconImage}
                          resizeMode="contain"
                        />
                      ) : (
                      <Text style={styles.tokenIconText}>S</Text>
                      )}
                    </View>
                    <View style={styles.tokenDetails}>
                      <Text style={styles.tokenName}>SOL</Text>
                      <Text style={styles.tokenPrice}>${tokenPrices.sol.toFixed(2)}</Text>
                    </View>
                  </View>
                  <View style={styles.tokenBalance}>
                    <Text style={styles.tokenAmount}>{maskAmt(balance.toFixed(4))}</Text>
                    <Text style={styles.tokenValue}>{maskAmt(`$${(balance * tokenPrices.sol).toFixed(2)}`)}</Text>
                  </View>
                </View>
                {/* 1DEV Token */}
                <View style={styles.tokenItem}>
                  <View style={styles.tokenInfo}>
                    <View style={styles.tokenIcon}>
                      {getTokenIconUrl('1DEV') ? (
                        <Image 
                          source={{uri: getTokenIconUrl('1DEV')}} 
                          style={styles.tokenIconImage}
                          resizeMode="contain"
                        />
                      ) : (
                      <Text style={styles.tokenIconText}>D</Text>
                      )}
                    </View>
                    <View style={styles.tokenDetails}>
                      <Text style={styles.tokenName}>1DEV</Text>
                      <Text style={styles.tokenPrice}>${tokenPrices['1dev'].toFixed(4)}</Text>
                    </View>
                  </View>
                  <View style={styles.tokenBalance}>
                    <Text style={styles.tokenAmount}>{maskAmt(tokenBalances['1dev'].toFixed(4))}</Text>
                    <Text style={styles.tokenValue}>{maskAmt(`$${(tokenBalances['1dev'] * tokenPrices['1dev']).toFixed(2)}`)}</Text>
                  </View>
                </View>
              </View>
            )}

          </ScrollView>
          )} />
        );

      // NOTE: the legacy standalone 'send' tab was removed — sending is handled by the inline
      // Send screen (openSendModal → handleSendTransaction), which supports native QNC and QRC-20.

      case 'receive':
        const currentReceiveAddress = selectedNetwork === 'qnet' 
          ? (wallet.qnetAddress || wallet.address)
          : (wallet.solanaAddress || wallet.address);

        return (
          <TabBox key="receive" deps={[selectedNetwork, wallet, copiedAddress]} render={() => (
          <ScrollView
            style={styles.content} 
            contentContainerStyle={styles.scrollContentContainer}
            onScroll={handleUserActivity} 
            scrollEventThrottle={500}
            showsVerticalScrollIndicator={true}
            bounces={true}
            scrollEnabled={true}
          >
            <Text style={styles.tabTitle}>Receive Tokens</Text>
            
            <View style={styles.receiveContent}>
              {/* REAL QR Code */}
              <View style={styles.qrContainer}>
                <View style={styles.qrWrapper}>
                  <QRCode
                    value={currentReceiveAddress || 'No Address'}
                    size={200}
                    color='black'
                    backgroundColor='white'
                  />
                </View>
                <Text style={styles.qrLabel}>
                  Scan to send {selectedNetwork === 'qnet' ? 'QNet' : 'Solana'} tokens
                </Text>
              </View>

              {/* Clickable Address Display - like Assets tab */}
              <View style={styles.addressDisplay}>
                <Text style={styles.label}>
                  {selectedNetwork === 'qnet' ? 'Your QNet Address' : 'Your Solana Address'}
                </Text>
                
                <TouchableOpacity 
                  style={[
                    styles.addressItem,
                    copiedAddress.includes('receive') && styles.addressItemCopied
                  ]}
                  onPress={() => {
                    const addressType = selectedNetwork === 'qnet' ? 'qnet-receive' : 'solana-receive';
                    copyToClipboard(currentReceiveAddress, addressType);
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={styles.addressText} numberOfLines={1} ellipsizeMode="middle">
                    {currentReceiveAddress}
                  </Text>
                  <Text style={styles.tapToCopy}>
                    {copiedAddress.includes('receive') ? '✓ Copied!' : 'Tap to copy'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
          )} />
        );

      case 'activate':
        return (
          <TabBox key="activate" deps={[activationPricing, burnProgress, loading, nodeStatus, activatedNodeType, activatingNode, wallet, password, isTestnet]} render={() => (
          <ScrollView
            style={styles.content}
            contentContainerStyle={styles.scrollContentContainer}
            onScroll={handleUserActivity}
            scrollEventThrottle={500}
            showsVerticalScrollIndicator={true}
            bounces={true}
            scrollEnabled={true}
          >
            <Text style={styles.tabTitle}>Node Activation</Text>
            
            {/* Phase Indicator */}
            <View style={styles.phaseCard}>
              <Text style={styles.phaseTitle}>
                {activationPricing?.phase === 2 ? 'Phase 2: QNC Transfer Activation' : 'Phase 1: 1DEV Burn Activation'}
              </Text>
              <Text style={styles.phaseSubtitle}>
                {activationPricing 
                  ? activationPricing.phase === 2 
                    ? `Active Nodes: ${(activationPricing.networkSize/1000).toFixed(0)}K • ${activationPricing.multiplier}x multiplier • ${activationPricing.cost} QNC`
                    : `Dynamic pricing: ${activationPricing.cost} 1DEV`
                  : 'Loading pricing...'}
              </Text>
              <View style={styles.phaseProgress}>
                <Text style={styles.progressText}>
                  Network Progress: {burnProgress}% burned {loading && '(updating...)'}
                </Text>
                <View style={styles.progressBar}>
                  <View style={[styles.progressFill, {width: `${burnProgress}%`}]} />
                </View>
              </View>
            </View>

            {/* Node Types */}
            <View style={styles.nodeTypesContainer}>
              <Text style={styles.sectionTitle}>Select Node Type</Text>
                {!nodeStatus && (
                  <View style={styles.warningBox}>
                    <Text style={styles.warningText}>
                      💡 You can generate activation codes for all node types
                    </Text>
                    <Text style={styles.warningSubtext}>
                      Each wallet can generate one activation code
                    </Text>
                  </View>
                )}
                
                {nodeStatus === 'light' && (
                  <View style={[styles.warningBox, {backgroundColor: 'rgba(0, 255, 127, 0.1)', borderColor: 'rgba(0, 255, 127, 0.3)'}]}>
                    <Text style={[styles.warningText, {color: '#00ff7f'}]}>
                      💡 Light nodes can be activated directly from QNet Mobile App
                    </Text>
                  </View>
                )}
                
                {/* Node types: Light and Super only */}
                
                {nodeStatus === 'super' && (
                  <View style={[styles.warningBox, {backgroundColor: 'rgba(255, 170, 0, 0.1)', borderColor: 'rgba(255, 170, 0, 0.3)'}]}>
                    <Text style={[styles.warningText, {color: '#ffaa00'}]}>
                      ⚠️ Super nodes require server activation after code generation
                    </Text>
                    
                  </View>
                )}
              
              <TouchableOpacity 
                style={[
                  styles.nodeTypeCard, 
                  nodeStatus === 'light' && !activatedNodeType && styles.nodeTypeActive,
                  activatedNodeType === 'light' && styles.nodeTypeActivated
                ]}
                onPress={() => !activatedNodeType && setNodeStatus('light')}
                disabled={Boolean(activatedNodeType)}
              >
                <View style={styles.nodeTypeInfo}>
                  <Text style={styles.nodeTypeName}>
                    Light Node
                  </Text>
                  <Text style={styles.nodeTypeDesc}>
                    {activatedNodeType === 'light' 
                      ? 'Code received • Ready to use'
                      : 'Mobile wallet user, own TX history.'}
                  </Text>
                </View>
                <Text style={styles.nodeTypePrice}>
                  {activatedNodeType === 'light' ? 'CODE RECEIVED' : 
                   activationPricing ? 
                   `${activationPricing.cost} ${activationPricing.currency}` : 
                   '...'}
                </Text>
              </TouchableOpacity>

              {/* Node types: Light and Super only */}

              <TouchableOpacity 
                style={[
                  styles.nodeTypeCard, 
                  nodeStatus === 'super' && !activatedNodeType && styles.nodeTypeActive,
                  activatedNodeType === 'super' && styles.nodeTypeActivated
                ]}
                onPress={() => !activatedNodeType && setNodeStatus('super')}
                disabled={Boolean(activatedNodeType)}
              >
                <View style={styles.nodeTypeInfo}>
                  <Text style={styles.nodeTypeName}>
                    Super Node
                  </Text>
                  <Text style={styles.nodeTypeDesc}>
                    {activatedNodeType === 'super' 
                      ? 'Code received • Ready to use'
                      : 'High-performance network backbone.'}
                  </Text>
                </View>
                <Text style={styles.nodeTypePrice}>
                  {activatedNodeType === 'super' ? 'CODE RECEIVED' :
                   activationPricing ? 
                   `${activationPricing.cost} ${activationPricing.currency}` : 
                   '...'}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Activation Button */}
            
            
            <TouchableOpacity 
              style={[styles.button, (!nodeStatus || activatedNodeType || activatingNode) && styles.buttonDisabled]}
              disabled={Boolean(!nodeStatus || activatedNodeType || activatingNode)}
              onPress={async () => {
                if (!nodeStatus) {
                  showAlert('Select Node Type', 'Please select a node type to activate');
                  return;
                }
                
                if (activatedNodeType) {
                  showAlert('Code Already Received', `This wallet has already received an activation code for ${activatedNodeType} node. One wallet can only get one activation code.`);
                  return;
                }
                
                // Show confirmation with appropriate warnings
                const nodeTypeName = nodeStatus.charAt(0).toUpperCase() + nodeStatus.slice(1) + ' Node';
                
                // Different messages for each node type with dynamic pricing
                const activationCost = activationPricing ? `${activationPricing.cost} ${activationPricing.currency}` : '...';
                
                // v3.18: Only Light and Super nodes
                const nodeMessages = {
                  light: `Get ${nodeTypeName} Code\n\n• No token burn required\n• Instant code generation\n• Mobile wallet user`,
                  super: `Get ${nodeTypeName} Code\n\n• Server activation required\n• ${activationCost} burn required\n• Enterprise grade node`
                };
                
                const warningMessage = nodeMessages[nodeStatus];
                
                // Node detailed specifications (like in browser extension)
                const nodeSpecs = {
                  light: {
                    platform: 'Mobile',
                    storage: 'Own TX history only',
                    rewards: 'Pool 1',
                    uptime: 'Flexible',
                    role: 'Wallet user',
                    activation: '✓ Instant activation in Mobile App'
                  },
                  super: {
                    platform: 'High-end server',
                    storage: '2TB+',
                    rewards: 'Block fees',
                    uptime: '90% required',
                    role: 'Network backbone',
                    activation: '⚠️ Requires server activation'
                  }
                };
                
                const specs = nodeSpecs[nodeStatus];
                
                // Create rich content for confirmation modal (compact version)
                const confirmRichContent = (
                  <ScrollView 
                    style={{ maxHeight: 350 }} 
                    showsVerticalScrollIndicator={true}
                    bounces={true}
                    scrollEnabled={true}
                  >
                    <View style={{ paddingHorizontal: 15, paddingVertical: 10 }}>
                      <Text style={[styles.modalContent, { fontSize: 15, fontWeight: 'bold', marginBottom: 10 }]}>
                        {nodeTypeName} Activation
                      </Text>
                    
                    {/* Can be activated banner */}
                    <View style={{ 
                      backgroundColor: nodeStatus === 'light' ? 'rgba(52, 199, 89, 0.1)' : 'rgba(255, 170, 0, 0.1)', 
                      borderRadius: 6, 
                      padding: 8, 
                      marginBottom: 12,
                      borderWidth: 1,
                      borderColor: nodeStatus === 'light' ? 'rgba(52, 199, 89, 0.3)' : 'rgba(255, 170, 0, 0.3)'
                    }}>
                      <Text style={[styles.modalContent, { 
                        textAlign: 'center', 
                        fontSize: 13, 
                        fontWeight: '600',
                        color: nodeStatus === 'light' ? '#34c759' : '#ffaa00'
                      }]}>
                        {specs.activation}
                      </Text>
                    </View>
                    
                    {/* Specifications - bigger text */}
                    <View style={{ marginBottom: 12 }}>
                      <Text style={[styles.modalContent, { textAlign: 'left', fontSize: 13, marginBottom: 6, lineHeight: 20 }]}>
                        • Platform: {specs.platform}{'\n'}
                        • Storage: {specs.storage}{'\n'}
                        • Rewards: {specs.rewards}{'\n'}
                        • Uptime: {specs.uptime}{'\n'}
                        • Role: {specs.role}
                      </Text>
                    </View>
                    
                    {/* Activation cost - smaller block */}
                    <View style={{ backgroundColor: 'rgba(128, 128, 128, 0.1)', borderRadius: 6, padding: 6, marginTop: 5 }}>
                      <Text style={[styles.modalContent, { textAlign: 'center', fontSize: 11, marginBottom: 2, opacity: 0.8 }]}>
                        Activation Cost
                      </Text>
                      <Text style={[styles.modalContent, { 
                        textAlign: 'center', 
                        fontSize: 18, 
                        fontWeight: 'bold',
                        color: '#00d4ff',
                        marginVertical: 2
                      }]}>
                        {activationPricing ? `${activationPricing.cost} ${activationPricing.currency}` : '...'}
                      </Text>
                      {nodeStatus !== 'light' && (
                        <Text style={[styles.modalContent, { textAlign: 'center', fontSize: 9, marginTop: 2, color: 'rgba(255, 255, 255, 0.5)' }]}>
                          Tokens will be burned permanently
                        </Text>
                      )}
                    </View>
                    </View>
                  </ScrollView>
                );
                
                showAlert(
                  'Confirm Activation',
                  '', // Empty message since we use richContent
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { 
                      text: 'Get Code', 
                      style: 'default',
                      onPress: async () => {
                        setActivatingNode(true);
                        try {
                          // Quick local check for existing activation (no slow RPC calls)
                          const existingCodes = await walletManager.getStoredActivationCodes(password);
                          if (existingCodes && Object.keys(existingCodes).length > 0) {
                            setActivatingNode(false);
                            Alert.alert(
                              'Already Activated',
                              'This wallet already has an activated node. One wallet can only activate one node.',
                              [{ text: 'OK' }]
                            );
                            return;
                          }
                          
                          let burnResult = null;
                          let code = null;
                          
                          // ALL nodes require REAL 1DEV burn for activation
                          let result = null;
                          
                          // Check balances first for better error messages - use publicKey as everywhere else
                          const [solBalance] = await Promise.all([
                            walletManager.getBalance(wallet.publicKey, isTestnet)
                          ]);
                          // null = RPC unavailable (not a genuine 0) — fail closed with a clear message, never .toFixed(null).
                          if (solBalance == null) {
                            throw new Error('Could not verify SOL balance (network unavailable). Please retry.');
                          }
                          const minSolRequired = 0.001;
                          if (solBalance < minSolRequired) {
                            throw new Error(`Insufficient SOL for transaction fees.\nNeed at least 0.001 SOL, have: ${solBalance.toFixed(4)}`);
                          }
                          
                          const oneDevMint = isTestnet 
                            ? '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ'
                            : '4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump';
                          
                          const oneDevBalance = await walletManager.getTokenBalance(wallet.publicKey, oneDevMint, isTestnet);
                          if (oneDevBalance == null) {
                            throw new Error('Could not verify 1DEV balance (network unavailable). Please retry.');
                          }
                          // v4.10: Dynamic pricing — fetch from server if not cached
                          let requiredAmount = activationPricing?.cost;
                          if (!requiredAmount) {
                            const freshPricing = await walletManager.calculateActivationCost(selectedNodeType || 'light');
                            requiredAmount = freshPricing.cost;
                          }
                          
                          if (oneDevBalance < requiredAmount) {
                            throw new Error(`Insufficient 1DEV tokens.\nNeed: ${requiredAmount} 1DEV\nHave: ${oneDevBalance} 1DEV`);
                          }
                          
                          if (nodeStatus === 'light') {
                            // Light Node - direct activation with burn
                            result = await walletManager.activateLightNode(wallet.publicKey, password);
                            code = result.activationCode;
                          } else {
                            // Super nodes: burn 1DEV → get code from SERVER (XOR-encrypted)
                            // Code contains wallet prefix encrypted with SHA3(burn_tx:type:amount)
                            // This enables STATELESS verification on any node without in-memory state
                            const burnResult = await walletManager.burnTokensForNode(
                              nodeStatus, 
                              requiredAmount, 
                              isTestnet, 
                              password
                            );
                            
                            if (!burnResult || !burnResult.signature) {
                              throw new Error('Failed to burn tokens for activation');
                            }
                            
                            // Generate code LOCALLY — deterministic XOR, no server dependency.
                            // Validation (burn TX, amount, 1-wallet-1-node) happens at registration.
                            const solanaAddress = wallet.publicKey || wallet.address;
                            code = walletManager.generateActivationCodeLocally(
                              nodeStatus,
                              solanaAddress,        // Solana address (XOR key uses burn wallet)
                              burnResult.signature, // burn TX hash
                              requiredAmount        // exact burned amount
                            );
                            
                            // Store the code with ALL burn metadata (burnAmount included for stateless XOR)
                            // storeActivationCode now saves burnAmount — no duplicate write needed
                            await walletManager.storeActivationCode(code, nodeStatus, password, {
                              burnTxHash: burnResult.signature,
                              burnAmount: requiredAmount,
                              phase: 1,
                              // Use the in-scope qnet wallet address; the bare identifier was undeclared here (ReferenceError on super activation).
                              walletAddress: wallet.qnetAddress || wallet.address
                            });
                          
                            // Create result with REAL transaction signature
                            result = {
                              activationCode: code,
                              signature: burnResult.signature,
                              nodeType: nodeStatus,
                              burned: requiredAmount
                            };
                          }
                            
                            // Update activation status immediately after tx sent
                            setActivatedNodeType(nodeStatus);
                            setActivationCode(code);
                            setNodeStatus(null);
                            // Clear stale node status from previous wallet sessions
                            setLightNodeStatus(null);
                            setServerNodeStatus(null);

                            // Persist activation state for restore on re-login
                            const burnWalletAddr = wallet.qnetAddress || wallet.address;
                            const burnPseudonym = walletManager.generateLightNodePseudonym(burnWalletAddr);
                            setNodePseudonym(burnPseudonym); // ← set in state immediately, not just AsyncStorage
                            AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
                              nodeType: nodeStatus,
                              code: code,
                              pseudonym: burnPseudonym,
                              timestamp: Date.now(),
                              burnTxHash: result.signature,
                              walletAddress: burnWalletAddr
                            })).catch(() => {});
                            AsyncStorage.setItem(`node_pseudonym_${code}`, burnPseudonym).catch(() => {});
                            
                            // Create detailed activation message
                            const nodeTypeName = nodeStatus.charAt(0).toUpperCase() + nodeStatus.slice(1) + ' Node';
                            const contract = BURN_CONTRACT_PROGRAM_ID;
                            const transaction = result.signature || '2tY9K8hr...cJLuXFC3';
                            
                            // Different status messages based on node type
                            const burnedAmount = result.burned || requiredAmount;
                            // v3.18: Only Light and Super nodes
                            const statusMessages = {
                              light: `Paid (${burnedAmount} 1DEV burned)`,
                              super: `Paid (${burnedAmount} 1DEV burned) • Server activation required`
                            };
                            
                            // Create rich content for the modal
                            const richContent = (
                              <ScrollView 
                                style={{ maxHeight: 400 }} 
                                showsVerticalScrollIndicator={true}
                                bounces={true}
                                scrollEnabled={true}
                              >
                                <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                                  <Text style={[styles.modalContent, { textAlign: 'left', marginBottom: 8, fontSize: 13 }]}>
                                    <Text style={{ fontWeight: 'bold' }}>Activation Code:</Text>
                                  </Text>
                                  <TouchableOpacity
                                    onPress={() => {
                                      Clipboard.setString(code);
                                      showAlert('Copied', 'Activation code copied to clipboard');
                                    }}
                                    style={{ backgroundColor: 'rgba(0, 212, 255, 0.1)', borderRadius: 8, padding: 10, marginBottom: 12 }}
                                  >
                                    <Text style={{ fontFamily: 'monospace', color: '#00d4ff', fontSize: 13, textAlign: 'center', lineHeight: 20 }}>
                                      {code}
                                    </Text>
                                    <Text style={{ color: '#888', fontSize: 10, textAlign: 'center', marginTop: 4 }}>
                                      Tap to copy
                                    </Text>
                                  </TouchableOpacity>
                                  
                                  <Text style={[styles.modalContent, { textAlign: 'left', marginBottom: 12, fontSize: 13 }]}>
                                    <Text style={{ fontWeight: 'bold' }}>Node Type:</Text> {nodeTypeName}{'\n'}
                                    <Text style={{ fontWeight: 'bold' }}>Status:</Text> {statusMessages[nodeStatus]}
                                  </Text>
                                  
                                  <Text style={[styles.modalContent, { textAlign: 'left', marginBottom: 8, fontSize: 12 }]} numberOfLines={2} ellipsizeMode="middle">
                                    <Text style={{ fontWeight: 'bold' }}>Contract:</Text> {contract}
                                  </Text>
                                  
                                  <TouchableOpacity 
                                    onPress={() => {
                                      const explorerUrl = `https://explorer.solana.com/tx/${transaction}?cluster=${isTestnet ? 'devnet' : 'mainnet-beta'}`;
                                      Linking.openURL(explorerUrl);
                                    }}
                                    style={{ marginTop: 8 }}
                                  >
                                    <Text style={[styles.modalContent, { textAlign: 'left', color: '#00d4ff', textDecorationLine: 'underline', fontSize: 12 }]} numberOfLines={3} ellipsizeMode="middle">
                                      <Text style={{ fontWeight: 'bold' }}>Transaction:</Text> {transaction}
                                    </Text>
                                  </TouchableOpacity>
                                </View>
                              </ScrollView>
                            );
                            
                            showAlert(
                              `${nodeTypeName} Activation Complete`,
                              '', // Empty message since we use richContent
                              [
                                { text: 'Copy Code', style: 'default', onPress: () => {
                                  Clipboard.setString(code);
                                  showAlert('Copied', 'Activation code copied to clipboard');
                                  // Clear sensitive data from clipboard after 10 seconds
                                  setTimeout(() => {
                                    Clipboard.setString('');
                                  }, 10000);
                                }},
                                { text: 'OK', style: 'default' }
                              ],
                              richContent
                            );
                        } catch (error) {
                          // Enhanced error handling with clear messages
                          let errorTitle = 'Activation Failed';
                          let errorMessage = error.message || 'Unknown error occurred';
                          
                          // Customize error messages
                          if (errorMessage.includes('Insufficient SOL')) {
                            errorTitle = 'Insufficient SOL Balance';
                          } else if (errorMessage.includes('Insufficient 1DEV')) {
                            errorTitle = 'Insufficient 1DEV Balance';
                          } else if (errorMessage.includes('Failed to burn')) {
                            errorTitle = 'Transaction Failed';
                            errorMessage = 'Failed to burn tokens. Please check your balance and try again.';
                          } else if (errorMessage.includes('Network request failed')) {
                            errorTitle = 'Network Error';
                            errorMessage = 'Please check your internet connection and try again.';
                          }
                          
                          showAlert(errorTitle, errorMessage);
                        } finally {
                          setActivatingNode(false);
                        }
                      }
                    }
                  ],
                  confirmRichContent
                );
              }}
            >
              <Text style={styles.buttonText}>
                {activatingNode 
                  ? 'Processing Transaction...' 
                  : activatedNodeType 
                  ? 'Code Already Received' 
                  : 'Get Activation Code'}
              </Text>
            </TouchableOpacity>

            {/* Recover Code button — for users who already burned 1DEV but lost their code */}
            {!activatedNodeType && !activatingNode && (
              <TouchableOpacity
                style={[styles.button, styles.secondaryButton, { marginTop: 12 }]}
                onPress={async () => {
                  if (!wallet || !password) {
                    showAlert('Error', 'Please unlock your wallet first');
                    return;
                  }
                  
                  setActivatingNode(true);
                  let bridgeSuperId = null;
                  try {
                    // Step 0: On-chain wallet-bridge first. Genesis wallets never burn (the
                    // burn steps below can't find them); a server-activated super is already
                    // registered on-chain — link its live identity now, recover the code below.
                    try {
                      const eonAddr = wallet.qnetAddress || wallet.address;
                      const gStatus = await checkServerNodeStatus(null, null, eonAddr, 1);
                      const gid = gStatus?.nodeId || '';
                      if (gStatus?.success && gid.startsWith('super_node_')) {
                        bridgeSuperId = gid;
                        setNodePseudonym(gid);
                        setServerNodeStatus(gStatus);
                      }
                      if (gStatus?.success && gid.startsWith('genesis_node_')) {
                        const bootstrapId = gid.replace('genesis_node_', '');
                        const genesisCode = `QNET-BOOT-${bootstrapId}-STRAP`;
                        setActivatedNodeType('super'); // Genesis nodes are Super nodes
                        setActivationCode(genesisCode);
                        setNodePseudonym(gid);
                        setServerNodeStatus(gStatus);
                        AsyncStorage.setItem(`node_pseudonym_${genesisCode}`, gid).catch(() => {});
                        await AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
                          nodeType: 'super', code: genesisCode, pseudonym: gid,
                          isGenesis: true, bootstrapId, timestamp: Date.now(),
                          // No burn exists for genesis; truthy marker keeps the
                          // no-burn-evidence cleanup from wiping this record.
                          burnTxHash: 'genesis',
                          walletAddress: eonAddr
                        }));
                        showAlert(
                          'Genesis Node Linked',
                          `This wallet backs ${gid}.\n\nActivation code: ${genesisCode}\nThe node is now linked in the Node tab.`,
                          [{ text: 'OK' }]
                        );
                        return;
                      }
                    } catch (_) { /* bridge unreachable — fall through to burn paths */ }

                    // Step 1: Check local storage first (fastest path)
                    // Don't gate on on-chain verification — user may have a code from burn
                    // but hasn't activated the node on QNet chain yet
                    const localCodes = await walletManager.getStoredActivationCodes(password);
                    if (localCodes && Object.keys(localCodes).length > 0) {
                      const firstType = Object.keys(localCodes)[0];
                      const firstCode = localCodes[firstType];
                      const codeStr = typeof firstCode === 'string' ? firstCode : firstCode?.code || '';
                      if (codeStr) {
                        setActivatedNodeType(firstType);
                        setActivationCode(codeStr);
                        
                        // Re-persist to ensure qnet_last_activated_node is set (no pseudonym — not yet registered on network)
                        await AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
                          nodeType: firstType, code: codeStr, timestamp: Date.now(),
                          burnTxHash: firstCode?.burnTxHash || 'recovered',
                          walletAddress: wallet.qnetAddress || wallet.address
                        }));
                        
                        showAlert('Code Found', `Your ${firstType} node activation code was found in local storage.`);
                        return;
                      }
                    }

                    // Step 2: Fetch burn TX directly from Solana via raw RPC (most reliable)
                    // This is independent of checkBlockchainForActivations — uses raw fetch, not @solana/web3.js
                    console.log('[RECOVER] Fetching burn TX directly from Solana RPC...');
                    try {
                      const burnTimeout = new Promise(function(resolve) { setTimeout(function() { resolve(null); }, 12000); });
                      const burnInfo = await Promise.race([walletManager.findBurnTransactionOnSolana(wallet.publicKey), burnTimeout]);
                      if (burnInfo && burnInfo.burnTxHash) {
                        console.log('[RECOVER] Found burn TX on Solana:', burnInfo.burnTxHash, 'type:', burnInfo.nodeType);
                        const nodeType = burnInfo.nodeType || 'light';
                        
                        // Ensure we have QNet EON address (45 chars) for Phase 1 — NOT Solana address (44 chars)
                        const qnetEonAddress = wallet.qnetAddress || walletManager.generateQNetAddressFromSolana(wallet.publicKey);
                        
                        // Regenerate code LOCALLY — no server needed, fully deterministic.
                        // Same algorithm as burn → guaranteed identical code.
                        if (burnInfo.burnAmount && burnInfo.burnAmount > 0) {
                          const code = walletManager.generateActivationCodeLocally(
                            nodeType,
                            wallet.publicKey,       // Solana address (burn wallet)
                            burnInfo.burnTxHash,
                            burnInfo.burnAmount
                          );
                          setActivatedNodeType(nodeType);
                          setActivationCode(code);
                          
                          await walletManager.storeActivationCode(code, nodeType, password, { recovered: true, burnTxHash: burnInfo.burnTxHash, burnAmount: burnInfo.burnAmount });
                          AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
                            nodeType, code, timestamp: Date.now(),
                            burnTxHash: burnInfo.burnTxHash,
                            walletAddress: qnetEonAddress
                          })).catch(() => {});
                          
                          const richRecovered2 = (
                            <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                              <Text style={[styles.modalContent, { textAlign: 'left', marginBottom: 8, fontSize: 13 }]}>
                                <Text style={{ fontWeight: 'bold' }}>Activation Code:</Text>
                              </Text>
                              <TouchableOpacity
                                onPress={() => { Clipboard.setString(nodeType === 'super' ? `${code}\nBurn TX: ${burnInfo.burnTxHash}` : code); }}
                                style={{ backgroundColor: 'rgba(0, 212, 255, 0.1)', borderRadius: 8, padding: 10, marginBottom: 12 }}
                              >
                                <Text style={{ fontFamily: 'monospace', color: '#00d4ff', fontSize: 13, textAlign: 'center', lineHeight: 20 }}>
                                  {code}
                                </Text>
                                <Text style={{ color: '#888', fontSize: 10, textAlign: 'center', marginTop: 4 }}>
                                  Tap to copy
                                </Text>
                              </TouchableOpacity>
                              <Text style={[styles.modalContent, { textAlign: 'left', fontSize: 13 }]}>
                                <Text style={{ fontWeight: 'bold' }}>Node Type:</Text> {nodeType.toUpperCase()}{'\n'}
                                {nodeType === 'super' && <><Text style={{ fontWeight: 'bold' }}>Burn TX:</Text> {burnInfo.burnTxHash.substring(0, 20)}...</>}
                              </Text>
                            </View>
                          );
                          showAlert(
                            'Code Recovered',
                            '',
                            [
                              { text: 'Copy Code', style: 'default', onPress: () => { Clipboard.setString(nodeType === 'super' ? `${code}\nBurn TX: ${burnInfo.burnTxHash}` : code); } },
                              { text: 'OK', style: 'default' }
                            ],
                            richRecovered2
                          );
                          return;
                        }
                        
                        // burnAmount not found in TX — show what we have
                        showAlert(
                          'Burn Transaction Found',
                          `Found burn TX: ${burnInfo.burnTxHash.substring(0, 20)}...\nType: ${nodeType}\nAmount: ${burnInfo.burnAmount || 'unknown'}\n\nCould not read burn amount from Solana. Please try again.`,
                          [{ text: 'OK' }]
                        );
                        return;
                      }
                    } catch (solanaErr) { console.log('[RECOVER] Solana burn lookup failed:', solanaErr.message); }

                    // Step 3: Try full sync (queries QNet registry + Solana + server)
                    const syncResult = await walletManager.syncActivationCodes(wallet.publicKey, null, password);
                    if (syncResult && Object.keys(syncResult).length > 0) {
                      const firstType = Object.keys(syncResult)[0];
                      const value = syncResult[firstType];
                      const code = typeof value === 'string' ? value : value?.code || '';
                      
                      const isHash = typeof code === 'string' && code.startsWith('HASH:');
                      const isPend = value?.status === 'pending_activation';
                      if (code && !value?.needsCodeRecovery && !isHash && !isPend) {
                        setActivatedNodeType(firstType);
                        setActivationCode(code);
                        
                        // No pseudonym — node may not be registered on network yet
                        AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
                          nodeType: firstType, code, timestamp: Date.now(),
                          burnTxHash: value?.burnTxHash || 'synced',
                          walletAddress: wallet.qnetAddress || wallet.address
                        })).catch(() => {});
                        
                        const richRecovered3 = (
                          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                            <Text style={[styles.modalContent, { textAlign: 'left', marginBottom: 8, fontSize: 13 }]}>
                              <Text style={{ fontWeight: 'bold' }}>Activation Code:</Text>
                            </Text>
                            <TouchableOpacity
                              onPress={() => { Clipboard.setString(firstType === 'super' ? `${code}\nBurn TX: ${value?.burnTxHash || ''}` : code); }}
                              style={{ backgroundColor: 'rgba(0, 212, 255, 0.1)', borderRadius: 8, padding: 10, marginBottom: 12 }}
                            >
                              <Text style={{ fontFamily: 'monospace', color: '#00d4ff', fontSize: 13, textAlign: 'center', lineHeight: 20 }}>
                                {code}
                              </Text>
                              <Text style={{ color: '#888', fontSize: 10, textAlign: 'center', marginTop: 4 }}>
                                Tap to copy
                              </Text>
                            </TouchableOpacity>
                            <Text style={[styles.modalContent, { textAlign: 'left', fontSize: 13 }]}>
                              <Text style={{ fontWeight: 'bold' }}>Node Type:</Text> {firstType.toUpperCase()}
                              {firstType === 'super' && <>{'\n'}<Text style={{ fontWeight: 'bold' }}>Burn TX:</Text> {(value?.burnTxHash || '').substring(0, 20)}...</>}
                            </Text>
                          </View>
                        );
                        showAlert(
                          'Code Recovered',
                          '',
                          [
                            { text: 'Copy Code', style: 'default', onPress: () => { Clipboard.setString(firstType === 'super' ? `${code}\nBurn TX: ${value?.burnTxHash || ''}` : code); } },
                            { text: 'OK', style: 'default' }
                          ],
                          richRecovered3
                        );
                        return;
                      }
                    }

                    // Step 4a: bridge-resolved super whose code could not be recovered from
                    // burn history — link it anyway (node_id stands in for the code, same as
                    // the Node-tab auto-link); the node is registered on-chain, that is the truth.
                    if (bridgeSuperId) {
                      setActivatedNodeType('super');
                      setActivationCode(bridgeSuperId);
                      AsyncStorage.setItem(`node_pseudonym_${bridgeSuperId}`, bridgeSuperId).catch(() => {});
                      await AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
                        nodeType: 'super', code: bridgeSuperId, pseudonym: bridgeSuperId,
                        timestamp: Date.now(), burnTxHash: 'onchain',
                        walletAddress: wallet.qnetAddress || wallet.address
                      }));
                      showAlert(
                        'Node Linked',
                        `This wallet backs ${bridgeSuperId} (registered on-chain).\n\nThe node is now linked in the Node tab.`,
                        [{ text: 'OK' }]
                      );
                      return;
                    }

                    // Step 4: Nothing found
                    showAlert(
                      'No Activation Found',
                      'No 1DEV burn transaction or activation code was found for this wallet address.\n\nIf you recently burned tokens, please wait a few minutes and try again.',
                      [{ text: 'OK' }]
                    );
                  } catch (error) {
                    console.error('Code recovery error:', error);
                    showAlert('Recovery Failed', error.message || 'Failed to recover activation code. Please try again.');
                  } finally {
                    setActivatingNode(false);
                  }
                }}
              >
                <Text style={[styles.buttonText, styles.secondaryButtonText]}>
                  Recover Activation Code
                </Text>
              </TouchableOpacity>
            )}
          </ScrollView>
          )} />
        );

      case 'history':
        return (
          <TabBox key="history" deps={[txHistory, refreshing, balancesHidden]} render={() => (
          <FlatList
            key="history-tab"
            style={styles.content}
            contentContainerStyle={[
              styles.scrollContentContainer,
              Platform.OS === 'ios' && { paddingBottom: 50 }
            ]}
            data={txHistory}
            extraData={balancesHidden}
            keyExtractor={(tx, index) => tx.tokenContract ? `${tx.hash}-${tx.tokenLogIndex ?? index}` : (tx.hash || String(index))}
            renderItem={({ item }) => <TxRow tx={item} onCopy={handleCopyTxHash} hideAmounts={balancesHidden} />}
            ListHeaderComponent={<Text style={[styles.sectionTitle, { marginBottom: 16 }]}>Transaction History</Text>}
            ListEmptyComponent={
              <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                <Text style={{ color: '#666', fontSize: 16 }}>No transactions yet</Text>
              </View>
            }
            showsVerticalScrollIndicator={true}
            onScroll={handleUserActivity}
            scrollEventThrottle={500}
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={7}
            removeClippedSubviews={true}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={async () => {
                  setRefreshing(true);
                  await loadTxHistory();
                  setRefreshing(false);
                }}
                colors={['#00d4ff']}
                tintColor="#00d4ff"
              />
            }
          />
          )} />
        );

      case 'node':
        return (
          <TabBox key="node" deps={[refreshing, activatedNodeType, loadingAllNodes, nodeInitializing, allUserNodes, wallet, copiedAddress, nodePseudonym, lightNodeStatus, serverNodeStatus, currentBlockHeight, reactivatingNode, processingValidation, balancesHidden]} render={() => (
          <ScrollView
            key="node-tab"
            style={styles.content}
            contentContainerStyle={[
              styles.scrollContentContainer,
              Platform.OS === 'ios' && { paddingBottom: 50 }
            ]}
            showsVerticalScrollIndicator={true}
            bounces={true}
            scrollEnabled={true}
            onScroll={handleUserActivity}
            scrollEventThrottle={500}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={async () => {
                  setRefreshing(true);
                  try {
                    // Reload all node data
                    await loadAllUserNodes();
                    if (activatedNodeType === 'light') {
                      await loadLightNodeStatus();
                    }
                    if (activatedNodeType) {
                      await loadServerNodeStatus();
                    }
                  } catch (error) {
                    console.error('Error refreshing node data:', error);
                  } finally {
                    setRefreshing(false);
                  }
                }}
                colors={['#00d4ff']}
                tintColor="#00d4ff"
                titleColor="#00d4ff"
                title="Pull to refresh"
              />
            }
          >
            <Text style={styles.tabTitle}>Node Monitoring</Text>
            
            {/* Loading state - shown while initializing (prevents flash of "Get Activation Code") */}
            {(nodeInitializing || loadingAllNodes) && !activatedNodeType && (
              <View style={[styles.nodeMonitoringCard, {marginBottom: 16, alignItems: 'center', paddingVertical: 32}]}>
                <Text style={[styles.nodeMonitoringLabel, {color: '#00d4ff', fontSize: 14}]}>
                  Loading node data...
                </Text>
              </View>
            )}
            
            {/* No node yet - show how to activate (only after loading completes) */}
            {!nodeInitializing && !loadingAllNodes && allUserNodes.length === 0 && !activatedNodeType && (
              <View style={[styles.nodeMonitoringCard, {marginBottom: 16}]}>
                <Text style={[styles.nodeMonitoringLabel, {marginBottom: 8}]}>
                  No Node Active
                </Text>
                <Text style={[styles.nodeMonitoringLabel, {fontSize: 12, color: '#888', marginBottom: 12}]}>
                  Activate a Light node here, or use your EON address when setting up a Super node on a server.
                </Text>
                
                {/* Copy QNet EON address for server activation */}
                <View style={{padding: 10, backgroundColor: '#1a1a2e', borderRadius: 8}}>
                  <Text style={[styles.nodeMonitoringLabel, {fontSize: 11, color: '#888'}]}>
                    Your QNet Address (for server node activation):
                  </Text>
                  <TouchableOpacity 
                    onPress={() => {
                      const qnetAddr = wallet?.qnetAddress || wallet?.address;
                      if (qnetAddr) {
                        Clipboard.setString(qnetAddr);
                        setCopiedAddress(qnetAddr);
                        setTimeout(() => setCopiedAddress(''), 2000);
                      }
                    }}
                    style={{marginTop: 6}}
                  >
                    <Text style={[styles.nodeMonitoringLabel, {fontSize: 11, color: '#007AFF'}]}>
                      {copiedAddress === (wallet?.qnetAddress || wallet?.address) ? 'Copied!' : `Copy: ${(wallet?.qnetAddress || wallet?.address)?.substring(0, 20)}...`}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
            
            {activatedNodeType ? (
              <View>
                {/* Node Status Card */}
                <View style={styles.nodeMonitoringCard}>
                  <View style={styles.nodeMonitoringHeader}>
                    <View style={{flex: 1}}>
                      {nodePseudonym ? (
                        <>
                          <Text style={styles.nodeMonitoringLabel}>Node name:</Text>
                          <Text style={styles.nodeMonitoringValue}>
                          {nodePseudonym}
                        </Text>
                          <View style={{marginTop: 12}}>
                            <Text style={styles.nodeMonitoringLabel}>Type of node:</Text>
                    <Text style={styles.nodeMonitoringValue}>
                              {activatedNodeType.charAt(0).toUpperCase() + activatedNodeType.slice(1)} Node
                    </Text>
                  </View>
                        </>
                      ) : (
                        <Text style={styles.nodeMonitoringTitle}>
                          {activatedNodeType.charAt(0).toUpperCase() + activatedNodeType.slice(1)} Node
                    </Text>
                      )}
                    </View>
                    <View style={[
                      styles.statusBadge,
                      activatedNodeType === 'light'
                        ? (!lightNodeStatus || (lightNodeStatus.registered === false && lightNodeStatus.error)
                            ? styles.statusBadgeActive                                         // Yellow — CHECKING (loading or transient poll error: never falsely offline)
                            : lightNodeStatus.registered === false
                              ? styles.statusBadgeActive                                       // Yellow — NOT ACTIVATED (fresh or reinstall)
                              : lightNodeStatus.needsReactivation
                                ? styles.statusBadgeInactive                                   // Red   — OFFLINE (was active, dropped)
                                : styles.statusBadgeActivated)                                 // Green — ONLINE
                        : (!serverNodeStatus?.success
                            ? styles.statusBadgeActive                                         // Yellow — CODE RECEIVED
                            : serverNodeStatus.isOnline
                              ? styles.statusBadgeActivated                                    // Green — ONLINE
                              : styles.statusBadgeInactive)                                    // Red   — OFFLINE
                    ]}>
                      <Text style={[
                        styles.statusBadgeText,
                        (activatedNodeType === 'light'
                          ? (!lightNodeStatus || lightNodeStatus.registered === false)
                          : (!serverNodeStatus?.success)) && styles.statusBadgeTextActive,
                        ((activatedNodeType === 'light' && lightNodeStatus?.registered && lightNodeStatus?.needsReactivation) ||
                         (activatedNodeType !== 'light' && serverNodeStatus?.success && !serverNodeStatus?.isOnline)) && {color: '#ff3b30'}
                      ]}>
                        {activatedNodeType === 'light'
                          ? (!lightNodeStatus || (lightNodeStatus.registered === false && lightNodeStatus.error)
                              ? 'CHECKING...'
                              : lightNodeStatus.registered === false
                                ? 'NOT ACTIVATED'
                                : lightNodeStatus.needsReactivation ? 'OFFLINE' : 'ONLINE')
                          : (!serverNodeStatus?.success
                              ? 'CODE RECEIVED'
                              : serverNodeStatus.isOnline ? 'ONLINE' : 'OFFLINE')}
                      </Text>
                    </View>
                  </View>
                  
                  {/* Action Button based on node type. Light gates key on ACTUAL registration
                      (lightNodeStatus.registered), not nodePseudonym (which is set at code-receipt,
                      before the node is registered). */}
                  {activatedNodeType === 'light' ? (
                    (lightNodeStatus?.registered && lightNodeStatus?.needsReactivation) ? (
                      <>
                        {/* ONLY reached when a registered node WAS active and dropped (ejected /
                            missed pings). Notice + reactivate button. */}
                        <View style={[styles.serverActivationNotice, {backgroundColor: '#ff3b3020', borderColor: '#ff3b30', marginBottom: 12}]}>
                          <Text style={[styles.serverActivationText, {color: '#ff3b30'}]}>
                            Node Inactive - Reactivation needed
                          </Text>
                          <Text style={styles.serverActivationSubtext}>
                            Your node was offline and needs reactivation
                          </Text>
                        </View>
                        {/* marginTop separates the button from the notice card (they were glued together) */}
                        <TouchableOpacity
                          style={[styles.button, styles.primaryButton, {marginTop: 12}, reactivatingNode && styles.buttonDisabled]}
                          onPress={handleReactivateNode}
                          disabled={reactivatingNode}
                        >
                          <Text style={styles.buttonText}>
                            {reactivatingNode ? 'Reactivating...' : "I'm Back - Reactivate Node"}
                          </Text>
                        </TouchableOpacity>
                      </>
                    ) : lightNodeStatus?.registered ? (
                      <TouchableOpacity
                        style={[styles.button, styles.buttonDisabled]}
                        disabled={true}
                      >
                        <Text style={styles.buttonText}>
                          Activated
                        </Text>
                      </TouchableOpacity>
                    ) : (lightNodeStatus && lightNodeStatus.registered === false && !lightNodeStatus.error) ? (
                    <TouchableOpacity
                      style={[styles.button, styles.secondaryButton]}
                      onPress={() => {
                        setShowActivationInput(true);
                        setActivationInputCode(''); // Don't pre-fill the code!
                      }}
                    >
                      <Text style={[styles.buttonText, styles.secondaryButtonText]}>
                        Activate Node
                      </Text>
                    </TouchableOpacity>
                    ) : (
                    // null (first load) or transient poll error — neutral placeholder, never flash
                    // "Activate Node" on an already-registered node before the first status arrives.
                    <TouchableOpacity style={[styles.button, styles.buttonDisabled]} disabled={true}>
                      <Text style={styles.buttonText}>Checking…</Text>
                    </TouchableOpacity>
                    )
                  ) : (
                    <>
                      {/* Server Node Status - only show activation notice for truly unlinked nodes */}
                      {!serverNodeStatus?.success && !nodePseudonym && (
                        <View style={styles.serverActivationNotice}>
                          <Text style={styles.serverActivationText}>
                            Super nodes require server activation
                          </Text>
                          <Text style={styles.serverActivationSubtext}>
                            Use your activation code on a dedicated server
                          </Text>
                        </View>
                      )}
                    </>
                  )}
                </View>
                
                {/* Status Section */}
                <View style={styles.rewardsCard}>
                  <Text style={styles.rewardsTitle}>Status</Text>
                  
                  <View style={styles.rewardItem}>
                    <Text style={styles.rewardLabel}>Node:</Text>
                    <Text style={[styles.rewardValue, {
                      // Light-node status keys off ACTUAL registration (see loadLightNodeStatus),
                      // never off nodePseudonym. Super-node branch is unchanged.
                      color: activatedNodeType === 'light'
                        ? ((!lightNodeStatus || (lightNodeStatus.registered === false && lightNodeStatus.error))
                            ? '#ff9500'  // Orange - checking / transient poll error (never falsely offline)
                            : lightNodeStatus.registered === false
                              ? '#ff9500'  // Orange - not activated (fresh or reinstall)
                              : lightNodeStatus.needsReactivation
                                ? '#ff9500'  // Orange - was active, dropped -> needs reactivation
                                : '#34c759') // Green - active
                        : (activatedNodeType !== 'light' && serverNodeStatus?.success && serverNodeStatus?.registered === false)
                            ? '#ff9500'  // Orange - not registered on-chain yet (NOT banned)
                          : (activatedNodeType !== 'light' && serverNodeStatus?.success && !serverNodeStatus?.isOnline)
                            ? '#ff3b30'  // Red - Server offline
                            : (activatedNodeType !== 'light' && !serverNodeStatus?.success)
                              ? '#ff9500'  // Orange - connecting (status not loaded yet)
                              : '#34c759'  // Green - active
                    }]}>
                      {activatedNodeType === 'light'
                        ? ((!lightNodeStatus || (lightNodeStatus.registered === false && lightNodeStatus.error))
                            ? 'Connecting…'
                            : lightNodeStatus.registered === false
                              ? 'Not Activated'
                              : lightNodeStatus.needsReactivation
                                ? 'Needs Reactivation'
                                : 'Active')
                        : (activatedNodeType !== 'light' && serverNodeStatus?.success && serverNodeStatus?.registered === false)
                            ? 'Not Activated'
                          : (activatedNodeType !== 'light' && serverNodeStatus?.success && !serverNodeStatus?.isOnline)
                            ? 'Server Offline'
                            : (activatedNodeType !== 'light' && !serverNodeStatus?.success)
                              ? 'Connecting…'
                              : 'Active'}
                    </Text>
                  </View>
                  
                  {/* ALL NODES: Unified reward display (light/super/genesis) */}
                  {serverNodeStatus?.success && (
                    <>
                      <View style={styles.rewardItem}>
                        <Text style={styles.rewardLabel}>Next Rewards:</Text>
                        <Text style={[styles.rewardValue, { color: '#34c759' }]}>
                          {(() => {
                            const EMISSION_INTERVAL = 14400;
                            const h = currentBlockHeight || serverNodeStatus.currentBlockHeight || 0;
                            if (h === 0) return 'Loading...';
                            const blocksUntil = EMISSION_INTERVAL - (h % EMISSION_INTERVAL);
                            const minutes = Math.floor(blocksUntil / 60);
                            const hours = Math.floor(minutes / 60);
                            const mins = minutes % 60;
                            if (hours > 0) {
                              return `${blocksUntil.toLocaleString()} blocks (~${hours}h ${mins}m)`;
                            }
                            return `${blocksUntil.toLocaleString()} blocks (~${mins}m)`;
                          })()}
                        </Text>
                      </View>

                      {/* Reputation is binary: good standing (already implied by Active/ONLINE) or
                          permanent ban for cryptographically-proven equivocation. Surface ONLY the
                          bad state — no constant "Good standing" row that duplicates the status. */}
                      {activatedNodeType !== 'light' && serverNodeStatus.reputation != null && serverNodeStatus.reputation < 70 && (
                        <View style={styles.rewardItem}>
                          <Text style={styles.rewardLabel}>Reputation:</Text>
                          <Text style={[styles.rewardValue, { color: '#ff3b30' }]}>
                            ⚠ Banned (equivocation)
                          </Text>
                        </View>
                      )}

                      <View style={styles.rewardItem}>
                        <Text style={styles.rewardLabel}>Pending Rewards:</Text>
                        <Text style={[styles.rewardValue, {
                          color: (serverNodeStatus.pendingRewards || 0) > 0 ? '#34c759' : '#00d4ff'
                        }]}>
                          {(() => {
                            if (balancesHidden) return '••••';
                            const rewards = (serverNodeStatus.pendingRewards || 0) / 1e9;
                            if (rewards === 0) return '0 QNC';
                            return `${rewards.toFixed(6).replace(/\.?0+$/, '')} QNC`;
                          })()}
                        </Text>
                      </View>
                    </>
                  )}

                  {/* ALL NODES: Unified claim button */}
                  {serverNodeStatus?.success && (
                    <TouchableOpacity 
                      style={[
                        styles.button,
                        ((serverNodeStatus.pendingRewards || 0) <= 0 || processingValidation) && styles.buttonDisabled
                      ]}
                      disabled={Boolean((serverNodeStatus.pendingRewards || 0) <= 0 || processingValidation)}
                      onPress={handleClaimServerNodeRewards}
                    >
                      <Text style={styles.buttonText}>
                        {processingValidation ? 'Claiming...' :
                         (serverNodeStatus.pendingRewards || 0) <= 0 ? 'Claim Rewards' :
                         balancesHidden ? 'Claim Rewards' :
                         (() => {
                           const rewards = (serverNodeStatus.pendingRewards || 0) / 1e9;
                           return `Claim ${rewards.toFixed(6).replace(/\.?0+$/, '')} QNC`;
                         })()}
                      </Text>
                    </TouchableOpacity>
                  )}
                  
                </View>
              </View>
            ) : (
            <View style={styles.emptyState}>
                <Text style={styles.emptyText}>No validator nodes configured</Text>
                <Text style={styles.emptySubtext}>
                  Get an activation code to run a validator node and support the network
                </Text>
                
                <TouchableOpacity
                  style={[styles.button, styles.primaryButton, { marginTop: 20 }]}
                  onPress={() => {
                    setActiveTab('activate');
                  }}
                >
                  <Text style={styles.buttonText}>
                    Get Activation Code
                  </Text>
                </TouchableOpacity>
            </View>
            )}
          </ScrollView>
          )} />
        );

      case 'settings':
        return (
          <TabBox key="settings" deps={[autoLockTime, language, isTestnet, wallet, biometricSupported, biometricEnabled]} render={() => (
          <ScrollView
            style={styles.content}
            contentContainerStyle={styles.scrollContentContainer}
            showsVerticalScrollIndicator={true}
            bounces={true}
            scrollEnabled={true}
          >
            <Text style={styles.tabTitle}>{t('settings')}</Text>
            
            {/* General Settings */}
            <View style={styles.settingGroup}>
              <Text style={styles.settingGroupTitle}>{t('general')}</Text>
              
              <View style={styles.settingItem}>
                <View style={styles.settingInfo}>
                  <Text style={styles.settingTitle}>{t('auto_lock_timer')}</Text>
                  <Text style={styles.settingSubtitle}>{t('auto_lock_subtitle')}</Text>
                </View>
                <TouchableOpacity 
                  style={styles.settingDropdown}
                  onPress={() => setShowAutoLockPicker(true)}
                >
                  <Text style={styles.settingValue}>
                    {autoLockTime === 'never' ? t('never') : `${autoLockTime} ${t(autoLockTime === '1' ? 'minute' : 'minutes')}`}
                  </Text>
                </TouchableOpacity>
              </View>

              <View style={styles.settingItem}>
                <View style={styles.settingInfo}>
                  <Text style={styles.settingTitle}>{t('language')}</Text>
                  <Text style={styles.settingSubtitle}>{t('language_subtitle')}</Text>
                </View>
                <TouchableOpacity 
                  style={styles.settingDropdown}
                  onPress={() => setShowLanguagePicker(true)}
                >
                  <Text style={styles.settingValue}>
                    {language === 'en' ? 'English' : 
                     language === 'zh-CN' ? '中文' :
                     language === 'ru' ? 'Русский' :
                     language === 'es' ? 'Español' :
                     language === 'ko' ? '한국어' :
                     language === 'ja' ? '日本語' :
                     language === 'pt' ? 'Português' :
                     language === 'fr' ? 'Français' :
                     language === 'de' ? 'Deutsch' :
                     language === 'ar' ? 'العربية' :
                     language === 'it' ? 'Italiano' : 'English'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Network Settings */}
            <View style={styles.settingGroup}>
              <Text style={styles.settingGroupTitle}>Network</Text>
              
              <View style={styles.settingItem}>
                <View style={styles.settingInfo}>
                  <Text style={styles.settingTitle}>Network Mode</Text>
                  <Text style={styles.settingSubtitle}>{isTestnet ? 'Testnet (for testing)' : 'Mainnet (real funds)'}</Text>
                </View>
                <TouchableOpacity 
                  style={[styles.settingDropdown, {backgroundColor: isTestnet ? '#ff9800' : '#4caf50'}]}
                  onPress={async () => {
                    const newTestnet = !isTestnet;
                    setIsTestnet(newTestnet);
                    // Save to AsyncStorage for persistence
                    await AsyncStorage.setItem('qnet_testnet', newTestnet.toString());
                    showAlert('Network Changed', `Switched to ${newTestnet ? 'Testnet' : 'Mainnet'}. Reloading balances...`);
                    // Reload balances with new network
                    if (wallet && wallet.publicKey) {
                      await loadBalance(wallet.publicKey);
                    }
                  }}
                >
                  <Text style={[styles.settingValue, {color: '#ffffff'}]}>
                    {isTestnet ? 'Testnet' : 'Mainnet'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Security Settings - Lazy loaded */}
            {activeTab === 'settings' && (
              <View style={styles.settingGroup}>
                <Text style={styles.settingGroupTitle}>{t('security_options')}</Text>
                
                <TouchableOpacity 
                  style={styles.actionButton}
                  onPress={() => setShowChangePassword(true)}
                >
                  <Text style={styles.actionButtonText}>{t('change_password')}</Text>
                </TouchableOpacity>

                {biometricSupported && (
                  <TouchableOpacity
                    style={[styles.actionButton, biometricEnabled && { borderColor: '#4caf50', borderWidth: 1 }]}
                    onPress={handleToggleBiometric}
                  >
                    <Text style={styles.actionButtonText}>
                      {biometricEnabled ? '✓ ' : ''}{t('enable_biometric')}
                    </Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity 
                  style={styles.actionButton}
                  onPress={() => setShowExportSeed(true)}
                >
                  <Text style={styles.actionButtonText}>{t('export_recovery_phrase')}</Text>
                </TouchableOpacity>

                <TouchableOpacity 
                  style={styles.actionButton}
                  onPress={() => setShowExportActivation(true)}
                >
                  <Text style={styles.actionButtonText}>
                    {t('export_activation_code')}
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Network Settings */}
            <View style={styles.settingGroup}>
              <Text style={styles.settingGroupTitle}>{t('network')}</Text>
              
              <View style={styles.settingItem}>
                <View style={styles.settingInfo}>
                  <Text style={styles.settingTitle}>{t('current_network')}</Text>
                  <Text style={styles.settingSubtitle}>QNet {isTestnet ? 'Testnet' : 'Mainnet'}</Text>
                </View>
              </View>
            </View>

            {/* Danger Zone */}
            <View style={styles.settingGroup}>
              <Text style={[styles.settingGroupTitle, {color: '#ff4444'}]}>{t('danger_zone')}</Text>
              
              <TouchableOpacity 
                style={[styles.actionButton, {backgroundColor: '#16213e', borderColor: '#ff4444'}]}
                onPress={() => {
                  showAlert(
                    t('logout'),
                    t('logout_confirm'),
                    [
                      {text: t('cancel'), style: 'cancel'},
                      {text: t('logout'), style: 'destructive', onPress: () => {
                        // Just lock the wallet, don't delete it
                        setWallet(null);
                        setActiveTab('assets');
                        // Wallet data remains in AsyncStorage, user just needs to unlock again
                      }}
                    ]
                  );
                }}
              >
                <Text style={[styles.actionButtonText, {color: '#ff4444'}]}>{t('logout')}</Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={[styles.actionButton, {backgroundColor: '#16213e', borderColor: '#ff4444'}]}
                onPress={deleteWallet}
              >
                <Text style={[styles.actionButtonText, {color: '#ff4444'}]}>{t('delete_wallet')}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
          )} />
        );

      default:
        return null;
    }
  };

  // Show splash screen after unlock while loading wallet
  if (hasWallet && !wallet && showSplash) {
    return (
      <SafeAreaView 
        style={[styles.container, Platform.OS === 'ios' && {paddingTop: 44}]} 
        edges={Platform.OS === 'ios' ? ['left', 'right'] : ['top', 'left', 'right']}
      >
        <View style={styles.centerContent}>
          <View style={styles.logoContainer}>
            <View style={styles.logoOuter}>
              <View style={styles.logoMiddle}>
                <View style={styles.logoInner}>
                  <Text style={styles.logoText}>Q</Text>
                </View>
              </View>
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView 
      style={[styles.container, Platform.OS === 'ios' && {paddingTop: 44}]} 
      edges={Platform.OS === 'ios' ? ['left', 'right'] : ['top', 'left', 'right']}
    >
      <View style={styles.header}>
        <Text style={styles.title}>QNet Wallet</Text>
        {/* Overflow menu: token manager / hide balances / wallet settings */}
        <TouchableOpacity
          style={styles.headerMenuBtn}
          onPress={() => setShowHeaderMenu((v) => !v)}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          activeOpacity={0.6}
        >
          <Text style={styles.headerMenuIcon}>⋮</Text>
        </TouchableOpacity>
      </View>

      {/* Tab Navigation */}
      <View style={styles.tabNav}>
        <TouchableOpacity 
          style={[styles.tab, activeTab === 'assets' && styles.activeTab]}
          onPress={() => {
            setActiveTab('assets');
            setNodeStatus(null); // Reset node selection when leaving activate tab
            // Immediate balance refresh when switching to assets
            if (wallet && wallet.publicKey) {
              // console.log('User switched to assets tab, refreshing balance');
              loadBalance(wallet.publicKey);
            }
          }}
        >
          <Text style={[styles.tabText, activeTab === 'assets' && styles.activeTabText]}>Assets</Text>
        </TouchableOpacity>
        
        {/* Send tab hidden - use Assets to send tokens */}
        
        <TouchableOpacity 
          style={[styles.tab, activeTab === 'receive' && styles.activeTab]}
          onPress={() => {
            setActiveTab('receive');
            setNodeStatus(null); // Reset node selection when leaving activate tab
          }}
        >
          <Text style={[styles.tabText, activeTab === 'receive' && styles.activeTabText]}>Receive</Text>
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={[styles.tab, activeTab === 'activate' && styles.activeTab]}
          onPress={() => {
            setActiveTab('activate');
            setNodeStatus(null); // Reset node selection when switching tabs
          }}
        >
          <Text style={[styles.tabText, activeTab === 'activate' && styles.activeTabText]}>Activate</Text>
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={[styles.tab, activeTab === 'history' && styles.activeTab]}
          onPress={() => {
            setActiveTab('history');
            loadTxHistory(); // Refresh history when tab opened
          }}
        >
          <Text style={[styles.tabText, activeTab === 'history' && styles.activeTabText]}>History</Text>
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={[styles.tab, activeTab === 'node' && styles.activeTab]}
          onPress={() => {
            setActiveTab('node');
            setNodeStatus(null); // Reset node selection when leaving activate tab
          }}
        >
          <Text style={[styles.tabText, activeTab === 'node' && styles.activeTabText]}>Node</Text>
        </TouchableOpacity>
      </View>

      {/* Tab Content */}
      <View style={styles.tabContentContainer}>
        {renderTabContent()}
      </View>

      {/* Change Password Modal */}
      {showChangePassword && (
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>{t('change_password')}</Text>
            
            <TextInput
              style={styles.input}
              placeholder={t('enter_current_password')}
              placeholderTextColor="#888"
              secureTextEntry
              value={currentPassword}
              onChangeText={setCurrentPassword}
            />

            <TextInput
              style={styles.input}
              placeholder={t('enter_new_password')}
              placeholderTextColor="#888"
              secureTextEntry
              value={newPassword}
              onChangeText={setNewPassword}
            />

            <TextInput
              style={styles.input}
              placeholder={t('confirm_new_password')}
              placeholderTextColor="#888"
              secureTextEntry
              value={confirmNewPassword}
              onChangeText={setConfirmNewPassword}
            />

            <View style={styles.modalActions}>
              <TouchableOpacity 
                style={[styles.modalButton, styles.modalButtonSecondary, {flex: 1}]}
                onPress={() => {
                  setShowChangePassword(false);
                  setCurrentPassword('');
                  setNewPassword('');
                  setConfirmNewPassword('');
                }}
              >
                <Text style={[styles.modalButtonText, styles.modalButtonTextSecondary]}>{t('cancel')}</Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={[styles.modalButton, styles.modalButtonPrimary, {flex: 1}]}
                onPress={handleChangePassword}
                disabled={loading}
              >
                <Text style={styles.modalButtonText}>{loading ? t('changing') : t('change')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* Header ⋮ overflow menu */}
      {showHeaderMenu && (
        <>
          <TouchableOpacity style={styles.menuBackdrop} activeOpacity={1} onPress={() => setShowHeaderMenu(false)} />
          <View style={[styles.menuCard, { top: Platform.OS === 'ios' ? 104 : 62 }]}>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => { setShowHeaderMenu(false); setTokenMgrQuery(''); setShowTokenManager(true); }}
              activeOpacity={0.6}
            >
              <Text style={styles.menuItemText}>Manage tokens</Text>
              <Text style={styles.menuItemHint}>›</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <View style={styles.menuItem}>
              <Text style={styles.menuItemText}>Hide balances</Text>
              <PillToggle value={balancesHidden} onValueChange={toggleBalancesHidden} />
            </View>
            <View style={styles.menuDivider} />
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => { setShowHeaderMenu(false); setActiveTab('settings'); }}
              activeOpacity={0.6}
            >
              <Text style={styles.menuItemText}>Wallet settings</Text>
              <Text style={styles.menuItemHint}>›</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* Token manager: search + per-token visibility + add-by-address; local view only, never touches balances. */}
      {showTokenManager && (
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, styles.mgrBox]}>
            <View style={styles.mgrHeader}>
              <Text style={styles.modalTitle}>Manage tokens</Text>
              <TouchableOpacity onPress={() => { setShowTokenManager(false); setAddTokenError(''); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={styles.mgrClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.mgrSearch}
              placeholder="Search or paste token address"
              placeholderTextColor="#888"
              value={tokenMgrQuery}
              onChangeText={(t) => { setTokenMgrQuery(t); if (addTokenError) setAddTokenError(''); }}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {/* Toggle-add feedback (the add-token modal is not used from here). */}
            {addingToken && <Text style={styles.mgrHint}>Adding token…</Text>}
            {!!addTokenError && <Text style={styles.mgrError}>{addTokenError}</Text>}
            <FlatList
              data={tokenMgrResults}
              keyExtractor={(tk) => tk.contract}
              keyboardShouldPersistTaps="handled"
              style={styles.mgrList}
              ListEmptyComponent={<Text style={styles.mgrEmpty}>No tokens. Tokens you receive appear here automatically; add one by address to watch it.</Text>}
              renderItem={({ item: tk }) => {
                const isQnc = tk.contract === 'native:qnc';
                const addable = !!tk._addable;
                const visible = !addable && !hiddenTokens.has(tk.contract);
                // Inert letter/emoji avatar (never load a node-supplied URL logo); QNC = app icon.
                const logo = typeof tk.logo === 'string' ? tk.logo.trim() : '';
                const isEmoji = logo.length > 0 && logo.length <= 8 && !logo.startsWith('http');
                let h = 0; const seed = String(tk.contract || tk.symbol || '?');
                for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
                const bg = isEmoji ? '#0b1a22' : `hsl(${h % 360}, 60%, 42%)`;
                const title = addable ? `${tk.contract.slice(0, 10)}…${tk.contract.slice(-6)}` : (tk.symbol || tk.name || 'Token');
                return (
                  <View style={styles.mgrRow}>
                    <View style={[styles.tokenIcon, { backgroundColor: isQnc ? 'transparent' : bg, borderRadius: 18, width: 36, height: 36, marginRight: 10 }]}>
                      {isQnc ? (
                        <Image source={require('../../assets/qnet_logo.png')} style={{ width: 36, height: 36 }} resizeMode="contain" />
                      ) : (
                        <Text style={[styles.tokenIconText, { color: '#ffffff', fontSize: 15 }]}>
                          {isEmoji ? logo : (tk.symbol || tk.name || 'T').slice(0, 1).toUpperCase()}
                        </Text>
                      )}
                    </View>
                    <View style={styles.mgrRowInfo}>
                      <Text style={styles.mgrRowSym} numberOfLines={1}>{title}</Text>
                      <Text style={styles.mgrRowBal} numberOfLines={1}>{addable ? 'Not tracked — toggle to add' : maskAmt(tk.balance)}</Text>
                    </View>
                    <PillToggle
                      value={addable ? false : visible}
                      onValueChange={(v) => addable ? (v && handleAddCustomToken(tk.contract)) : setTokenVisible(tk.contract, v)}
                    />
                  </View>
                );
              }}
            />
          </View>
        </View>
      )}

      {/* Add Custom QRC-20 Token Modal */}
      {showAddTokenModal && (
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Add token</Text>
            <Text style={styles.modalContent}>
              Enter the QRC-20 contract address (64 hex characters).
            </Text>
            <TextInput
              style={styles.input}
              placeholder="Contract address"
              placeholderTextColor="#888"
              value={addTokenAddress}
              onChangeText={(txt) => { setAddTokenAddress(txt.trim()); setAddTokenError(''); }}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {!!addTokenError && (
              <Text style={[styles.modalContent, { color: '#ff5555' }]}>{addTokenError}</Text>
            )}
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonSecondary, { flex: 1 }]}
                onPress={closeAddTokenModal}
                disabled={addingToken}
              >
                <Text style={[styles.modalButtonText, styles.modalButtonTextSecondary]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonPrimary, { flex: 1 }]}
                onPress={handleAddCustomToken}
                disabled={addingToken}
              >
                <Text style={styles.modalButtonText}>{addingToken ? 'Adding...' : 'Add'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* Biometric Enable Password Prompt */}
      {showBiometricPasswordPrompt && (
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>{t('enable_biometric')}</Text>
            <TextInput
              style={styles.input}
              placeholder={t('enter_current_password')}
              placeholderTextColor="#888"
              secureTextEntry
              value={biometricPassword}
              onChangeText={setBiometricPassword}
              onSubmitEditing={handleConfirmBiometricEnable}
              returnKeyType="done"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonSecondary, {flex: 1}]}
                onPress={() => { setShowBiometricPasswordPrompt(false); setBiometricPassword(''); }}
              >
                <Text style={[styles.modalButtonText, styles.modalButtonTextSecondary]}>{t('cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonPrimary, {flex: 1}]}
                onPress={handleConfirmBiometricEnable}
              >
                <Text style={styles.modalButtonText}>{t('enable_biometric')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* Export Seed Phrase Modal */}
      {showExportSeed && (
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>{t('export_recovery_phrase')}</Text>
            <Text style={styles.modalWarning}>
              {t('recovery_phrase_warning')}
            </Text>
            
            <TextInput
              style={styles.input}
              placeholder={t('enter_password_to_reveal')}
              placeholderTextColor="#888"
              secureTextEntry
              value={exportPassword}
              onChangeText={setExportPassword}
            />

            <View style={styles.modalActions}>
              <TouchableOpacity 
                style={[styles.modalButton, styles.modalButtonSecondary, {flex: 1}]}
                onPress={() => {
                  setShowExportSeed(false);
                  setExportPassword('');
                }}
              >
                <Text style={[styles.modalButtonText, styles.modalButtonTextSecondary]}>{t('cancel')}</Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={[styles.modalButton, styles.modalButtonPrimary, {flex: 1}]}
                onPress={exportSeedPhrase}
                disabled={loading}
              >
                <Text style={styles.modalButtonText}>{loading ? t('verifying') : t('show')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* Export Activation Code Modal */}
      {showExportActivation && (
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>{t('export_activation_code')}</Text>
            <Text style={styles.modalWarning}>
              {t('activation_code_warning')}
            </Text>
            
            <TextInput
              style={styles.input}
              placeholder={t('enter_password_to_generate')}
              placeholderTextColor="#888"
              secureTextEntry
              value={exportPassword}
              onChangeText={setExportPassword}
            />

            <View style={styles.modalActions}>
              <TouchableOpacity 
                style={[styles.modalButton, styles.modalButtonSecondary, {flex: 1}]}
                onPress={() => {
                  setShowExportActivation(false);
                  setExportPassword('');
                }}
              >
                <Text style={[styles.modalButtonText, styles.modalButtonTextSecondary]}>{t('cancel')}</Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={[styles.modalButton, styles.modalButtonPrimary, {flex: 1}]}
                onPress={exportActivationCode}
                disabled={loading}
              >
                <Text style={styles.modalButtonText}>{loading ? t('verifying') : t('show')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* Auto-Lock Time Picker Modal */}
      {showAutoLockPicker && (
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>{t('auto_lock_timer')}</Text>
            <Text style={styles.modalSubtitle}>{t('select_inactivity_time')}</Text>
            
            {['1', '5', '15', '30', '60', 'never'].map((time) => (
              <TouchableOpacity
                key={time}
                style={[
                  styles.timeOption,
                  autoLockTime === time && styles.timeOptionActive
                ]}
                onPress={() => saveAutoLockTime(time)}
              >
                <Text style={[
                  styles.timeOptionText,
                  autoLockTime === time && styles.timeOptionTextActive
                ]}>
                  {time === 'never' ? t('never') : `${time} ${t(time === '1' ? 'minute' : 'minutes')}`}
                </Text>
                {autoLockTime === time && <Text style={styles.checkmark}>✓</Text>}
              </TouchableOpacity>
            ))}

            <TouchableOpacity 
              style={[styles.button, styles.secondaryButton, {marginTop: 10}]}
              onPress={() => setShowAutoLockPicker(false)}
            >
              <Text style={[styles.buttonText, styles.secondaryButtonText]}>{t('cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Language Picker Modal */}
      {showLanguagePicker && (
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>{t('language')}</Text>
            <Text style={styles.modalSubtitle}>{t('language_subtitle')}</Text>
            
            <ScrollView 
              style={{maxHeight: 400}} 
              onScroll={handleUserActivity} 
              scrollEventThrottle={1000}
              showsVerticalScrollIndicator={true}
              bounces={true}
              scrollEnabled={true}
            >
              {[
                {code: 'en', name: 'English'},
                {code: 'zh-CN', name: '中文'},
                {code: 'ru', name: 'Русский'},
                {code: 'es', name: 'Español'},
                {code: 'ko', name: '한국어'},
                {code: 'ja', name: '日本語'},
                {code: 'pt', name: 'Português'},
                {code: 'fr', name: 'Français'},
                {code: 'de', name: 'Deutsch'},
                {code: 'ar', name: 'العربية'},
                {code: 'it', name: 'Italiano'}
              ].map((lang) => (
                <TouchableOpacity
                  key={lang.code}
                  style={[
                    styles.timeOption,
                    language === lang.code && styles.timeOptionActive
                  ]}
                  onPress={() => {
                    saveLanguage(lang.code);
                    setShowLanguagePicker(false);
                  }}
                >
                  <Text style={[
                    styles.timeOptionText,
                    language === lang.code && styles.timeOptionTextActive
                  ]}>
                    {lang.name}
                  </Text>
                  {language === lang.code && <Text style={styles.checkmark}>✓</Text>}
                </TouchableOpacity>
              ))}
            </ScrollView>

            <TouchableOpacity 
              style={[styles.button, styles.secondaryButton, {marginTop: 10}]}
              onPress={() => setShowLanguagePicker(false)}
            >
              <Text style={[styles.buttonText, styles.secondaryButtonText]}>{t('cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Node Activation Input Modal */}
      {showActivationInput && (
        <Animated.View style={[styles.modalOverlay, {
          opacity: showActivationInput ? 1 : 0
        }]}>
          <Animated.View style={[
            styles.modalBox, 
            { 
              maxWidth: 350,
              transform: [{
                scale: showActivationInput ? 1 : 0.9
              }]
            }
          ]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                Node Activation
              </Text>
            </View>
            
            <Text style={styles.modalContent}>
              Enter your activation code to register the node in the network
            </Text>
            
            <TextInput
              style={[styles.alertInput, {marginTop: 15}]}
              placeholder="QNET-XXXXXX-XXXXXX-XXXXXX"
              placeholderTextColor="#666"
              value={activationInputCode}
              onChangeText={(text) => setActivationInputCode(text.toUpperCase())}
              autoCapitalize="characters"
              maxLength={25}
            />
            
            <View style={{flexDirection: 'row', justifyContent: 'space-between', marginTop: 25, marginHorizontal: 20, gap: 12}}>
              <TouchableOpacity 
                style={[styles.button, styles.secondaryButton, {flex: 1, minHeight: 38, paddingVertical: 10, elevation: 1}]}
                onPress={() => {
                  setShowActivationInput(false);
                  setActivationInputCode('');
                }}
              >
                <Text style={[styles.buttonText, styles.secondaryButtonText, {fontSize: 14}]}>Cancel</Text>
              </TouchableOpacity>
              
              <TouchableOpacity 
                style={[styles.button, styles.primaryButton, nodeActivating && styles.buttonDisabled, {flex: 1, minHeight: 38, paddingVertical: 10, elevation: 1}]}
                onPress={handleNodeActivation}
                disabled={Boolean(nodeActivating || !activationInputCode.trim())}
              >
                <Text style={[styles.buttonText, {fontSize: 14}]}>
                  {nodeActivating ? 'Activating...' : 'Activate'}
                </Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        </Animated.View>
      )}

      {/* Custom Alert Modal (styled like extension) */}
      {customAlert && (
        <Animated.View style={[styles.modalOverlay, {
          opacity: customAlert ? 1 : 0
        }]}>
          <Animated.View style={[
            styles.modalBox, 
            { 
              maxWidth: 350,
              transform: [{
                scale: customAlert ? 1 : 0.9
              }]
            }
          ]}>
            {/* Modal Header with icon */}
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {customAlert.title}
              </Text>
            </View>
            
            {/* Modal Content */}
            {customAlert.richContent ? (
              <View style={styles.modalContentContainer}>
                {customAlert.richContent}
              </View>
            ) : (
            <Text style={styles.modalContent}>
              {customAlert.message}
            </Text>
            )}
            
            {/* Modal Actions */}
            <View style={styles.modalActions}>
              {customAlert.buttons.map((button, index) => (
                <TouchableOpacity
                  key={index}
                  style={[
                    styles.modalButton,
                    button.style === 'destructive' ? 
                      styles.modalButtonDanger : 
                      button.style === 'cancel' ? 
                        styles.modalButtonSecondary : 
                        styles.modalButtonPrimary,
                    { flex: 1 }
                  ]}
                  onPress={() => {
                    setCustomAlert(null);
                    if (button.onPress) button.onPress();
                  }}
                >
                  <Text style={[
                    styles.modalButtonText,
                    button.style === 'destructive' && styles.modalButtonTextDanger,
                    button.style === 'cancel' && styles.modalButtonTextSecondary
                  ]}>
                    {button.text}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </Animated.View>
        </Animated.View>
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 100,
  },
  loadingText: {
    color: '#8e8e93',
    fontSize: 16,
    marginTop: 10,
    fontFamily: 'Courier New',
  },
  container: {
    flex: 1,
    backgroundColor: '#11131f', // Same as splash screen background for smooth transition
  },
  centerContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#0f0f1a', // Same as container for consistency
  },
  formContent: {
    flexGrow: 1,
    justifyContent: 'flex-start',
    alignItems: 'center',
    padding: 20,
    paddingTop: 80,
    backgroundColor: '#0f0f1a',
  },
  content: {
    flex: 1,
    padding: 20,
  },
  scrollContentContainer: {
    paddingBottom: Platform.OS === 'ios' ? 20 : 20,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#00d4ff',
    textAlign: 'center',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 16,
    color: '#b0b0b0',
    textAlign: 'center',
    marginBottom: 30,
  },
  input: {
    width: '100%',
    height: 50,
    backgroundColor: 'rgba(22, 33, 62, 0.8)',
    borderRadius: 10,
    paddingHorizontal: 15,
    color: '#ffffff',
    fontSize: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.5)',
  },
  button: {
    width: '100%',
    height: 50,
    backgroundColor: '#00d4ff',
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 15,
  },
  secondaryButton: {
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: '#00d4ff',
  },
  buttonText: {
    color: '#1a1a2e',
    fontSize: 18,
    fontWeight: 'bold',
  },
  secondaryButtonText: {
    color: '#00d4ff',
  },
  textArea: {
    height: 100,
    textAlignVertical: 'top',
    paddingTop: 15,
  },
  inputError: {
    borderColor: '#ff4444',
    borderWidth: 2,
  },
  passwordHint: {
    color: '#ffaa00',
    fontSize: 14,
    marginTop: -15,
    marginBottom: 15,
    alignSelf: 'flex-start',
  },
  passwordSuccess: {
    color: '#00ff88',
    fontSize: 14,
    marginTop: -15,
    marginBottom: 15,
    alignSelf: 'flex-start',
  },
  errorText: {
    color: '#ff4444',
    fontSize: 14,
    marginTop: -15,
    marginBottom: 15,
    alignSelf: 'flex-start',
  },
  balanceCard: {
    backgroundColor: '#16213e',
    borderRadius: 15,
    padding: 20,
    marginBottom: 20,
    alignItems: 'center',
  },
  balanceLabel: {
    color: '#b0b0b0',
    fontSize: 16,
    marginBottom: 5,
  },
  balanceAmount: {
    color: '#00d4ff',
    fontSize: 32,
    fontWeight: 'bold',
  },
  addressCard: {
    backgroundColor: '#16213e',
    borderRadius: 15,
    padding: 20,
    marginBottom: 20,
  },
  addressLabel: {
    color: '#b0b0b0',
    fontSize: 16,
    marginBottom: 5,
  },
  addressText: {
    color: '#ffffff',
    fontSize: 14,
    fontFamily: 'monospace',
  },
  actionButton: {
    backgroundColor: '#16213e',
    borderRadius: 10,
    padding: 15,
    marginBottom: 15,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#00d4ff',
  },
  actionButtonText: {
    color: '#00d4ff',
    fontSize: 16,
    fontWeight: '600',
  },
  header: {
    paddingVertical: 15,
    backgroundColor: '#16213e',
    borderBottomWidth: 1,
    borderBottomColor: '#00d4ff',
  },
  tabNav: {
    flexDirection: 'row',
    backgroundColor: '#16213e',
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: '#00d4ff',
  },
  tab: {
    flex: 1,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  activeTab: {
    borderBottomColor: '#00d4ff',
  },
  tabText: {
    color: '#b0b0b0',
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 18,
    includeFontPadding: false,
  },
  activeTabText: {
    color: '#00d4ff',
  },
  tabContentContainer: {
    flex: 1,
    marginBottom: Platform.OS === 'ios' ? 10 : 60, // Space to ensure content is scrollable above tab nav
  },
  tabTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#00d4ff',
    marginBottom: 20,
  },
  formGroup: {
    marginBottom: 20,
  },
  seedConfirmContent: {
    flexGrow: 1,
    justifyContent: 'flex-start',
    alignItems: 'stretch',
    padding: 20,
    paddingTop: 40,
    backgroundColor: '#0f0f1a',
  },
  seedConfirmGroup: {
    marginBottom: 24,
    width: '100%',
  },
  label: {
    color: '#b0b0b0',
    fontSize: 14,
    marginBottom: 8,
    fontWeight: '600',
  },
  feeText: {
    color: '#00d4ff',
    fontSize: 16,
    fontWeight: '600',
  },
  receiveContent: {
    alignItems: 'center',
  },
  qrPlaceholder: {
    width: 200,
    height: 200,
    backgroundColor: '#16213e',
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 30,
    borderWidth: 2,
    borderColor: '#00d4ff',
  },
  qrContainer: {
    alignItems: 'center',
    marginBottom: 30,
  },
  qrWrapper: {
    backgroundColor: '#ffffff',
    padding: 20,
    borderRadius: 15,
    marginBottom: 15,
    elevation: 5,
    shadowColor: '#00d4ff',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  qrLabel: {
    color: '#aaa',
    fontSize: 14,
    textAlign: 'center',
  },
  addressBox: {
    backgroundColor: '#16213e',
    borderRadius: 10,
    padding: 15,
    marginVertical: 15,
    borderWidth: 1,
    borderColor: '#00d4ff20',
  },
  addressText: {
    color: '#ffffff',
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  receiveButtons: {
    flexDirection: 'row',
    marginTop: 10,
  },
  tapToCopy: {
    color: '#00d4ff',
    fontSize: 12,
    marginTop: 10,
    fontStyle: 'italic',
    textAlign: 'center',
  },
  qrText: {
    color: '#00d4ff',
    fontSize: 20,
    fontWeight: 'bold',
  },
  qrSubtext: {
    color: '#888',
    fontSize: 14,
    marginTop: 5,
  },
  addressDisplay: {
    width: '100%',
    backgroundColor: '#16213e',
    borderRadius: 15,
    padding: 20,
  },
  addressDisplayText: {
    color: '#ffffff',
    fontSize: 12,
    marginBottom: 15,
    padding: 10,
    backgroundColor: '#1a1a2e',
    borderRadius: 8,
  },
  activateCard: {
    backgroundColor: '#16213e',
    borderRadius: 15,
    padding: 20,
    marginBottom: 20,
  },
  phaseText: {
    color: '#00d4ff',
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  statusText: {
    color: '#888',
    fontSize: 14,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyText: {
    color: '#888',
    fontSize: 16,
  },
  amountInputGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  amountInput: {
    flex: 1,
    marginBottom: 0,
  },
  tokenSelector: {
    flexDirection: 'row',
    gap: 5,
  },
  tokenButton: {
    paddingHorizontal: 15,
    paddingVertical: 10,
    backgroundColor: '#16213e',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#00d4ff',
  },
  tokenButtonActive: {
    backgroundColor: '#00d4ff',
  },
  tokenButtonText: {
    color: '#00d4ff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  tokenButtonTextActive: {
    color: '#1a1a2e',
  },
  settingGroup: {
    marginBottom: 30,
  },
  settingGroupTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#00d4ff',
    marginBottom: 15,
  },
  settingItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#16213e',
    borderRadius: 12,
    padding: 15,
    marginBottom: 10,
  },
  settingInfo: {
    flex: 1,
  },
  settingTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  settingSubtitle: {
    color: '#888',
    fontSize: 13,
  },
  settingDropdown: {
    backgroundColor: '#1a1a2e',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#00d4ff',
  },
  settingValue: {
    color: '#00d4ff',
    fontSize: 14,
    fontWeight: '600',
  },
  modalOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.9)', // Darker overlay for better contrast
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    zIndex: 9999,
  },
  modalBox: {
    backgroundColor: '#1a1a2e', // Like extension modal background
    borderRadius: 20, // Smoother corners
    padding: 0, // Content padding handled separately
    width: '90%', // Reduced from 100% to add margin from edges
    maxWidth: 360, // Slightly reduced for better mobile view
    maxHeight: '80%', // Limit height for small screens
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.3)', // Slightly brighter border
    shadowColor: '#00d4ff',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 25,
    overflow: 'hidden',
  },
  modalHeader: {
    backgroundColor: 'rgba(0, 212, 255, 0.1)', // Subtle header background
    paddingVertical: 20,
    paddingHorizontal: 24,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0, 212, 255, 0.2)',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#00d4ff',
    textAlign: 'center',
    letterSpacing: 0.5,
  },
  modalContent: {
    color: '#ffffff',
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 16,
    paddingVertical: 12,
    textAlign: 'center',
  },
  modalContentContainer: {
    paddingHorizontal: 4,
    paddingVertical: 10,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 20,
    paddingBottom: 20,
    paddingTop: 5,
  },
  modalButton: {
    paddingVertical: 11,
    paddingHorizontal: 18,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 42,
  },
  modalButtonPrimary: {
    backgroundColor: '#00d4ff',
    shadowColor: '#00d4ff',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  modalButtonSecondary: {
    backgroundColor: 'rgba(0, 212, 255, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.3)',
  },
  modalButtonDanger: {
    backgroundColor: '#ff4444',
    shadowColor: '#ff4444',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  modalButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1a1a2e',
    letterSpacing: 0.3,
  },
  modalButtonTextSecondary: {
    color: '#00d4ff',
  },
  modalButtonTextDanger: {
    color: '#ffffff',
  },
  modalWarning: {
    color: '#ffaa00',
    fontSize: 14,
    marginBottom: 15,
    textAlign: 'center',
    lineHeight: 20,
  },
  modalSubtitle: {
    color: '#b0b0b0',
    fontSize: 14,
    marginBottom: 20,
    textAlign: 'center',
  },
  timeOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#1a1a2e',
    padding: 15,
    borderRadius: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#00d4ff',
  },
  timeOptionActive: {
    backgroundColor: '#00d4ff',
    borderColor: '#00d4ff',
  },
  timeOptionText: {
    color: '#ffffff',
    fontSize: 16,
  },
  timeOptionTextActive: {
    color: '#1a1a2e',
    fontWeight: 'bold',
  },
  checkmark: {
    color: '#1a1a2e',
    fontSize: 18,
    fontWeight: 'bold',
  },
  seedGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    width: '100%',
    marginVertical: 15,
    paddingHorizontal: 5,
  },
  seedWordContainer: {
    width: '48%',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(22, 33, 62, 0.8)',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.3)',
  },
  seedWordNumber: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#00d4ff',
    marginRight: 10,
    minWidth: 20,
  },
  seedWordText: {
    fontSize: 14,
    color: '#ffffff',
    flex: 1,
  },
  warningText: {
    color: '#ffaa00',
    fontSize: 14,
    marginBottom: 20,
    textAlign: 'center',
    fontWeight: '600',
  },
  wordChoicesContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 10,
  },
  wordChoiceButton: {
    backgroundColor: 'rgba(22, 33, 62, 0.8)',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.3)',
    width: '48%',
  },
  wordChoiceSelected: {
    backgroundColor: 'rgba(0, 212, 255, 0.2)',
    borderColor: '#00d4ff',
    borderWidth: 2,
  },
  wordChoiceText: {
    color: '#ffffff',
    fontSize: 14,
    textAlign: 'center',
  },
  wordChoiceTextSelected: {
    color: '#00d4ff',
    fontWeight: 'bold',
  },
  networkSelector: {
    flexDirection: 'row',
    backgroundColor: '#16213e',
    borderRadius: 12,
    padding: 4,
    marginBottom: 20,
  },
  networkTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 8,
  },
  networkTabActive: {
    backgroundColor: '#00d4ff',
  },
  networkTabText: {
    color: '#888',
    fontWeight: '600',
  },
  networkTabTextActive: {
    color: '#1a1a2e',
  },
  addressContainer: {
    backgroundColor: '#16213e',
    borderRadius: 12,
    padding: 10,
    paddingHorizontal: 5,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.2)',
  },
  addressText: {
    color: '#ffffff',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    marginVertical: 2,
    letterSpacing: 0.5,
    width: '100%',
    textAlign: 'center',
    lineHeight: 17,
    paddingHorizontal: 0,
    transform: [{ scaleX: 0.88 }],
  },
  copyHint: {
    color: '#00d4ff',
    fontSize: 11,
    textAlign: 'center',
  },
  tokenList: {
    marginBottom: 20,
  },
  tokenItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#16213e',
    borderRadius: 12,
    padding: 15,
    marginBottom: 10,
  },
  tokenInfo: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  tokenIcon: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  tokenIconText: {
    color: '#1a1a2e',
    fontSize: 18,
    fontWeight: 'bold',
  },
  tokenIconEmoji: {
    fontSize: 24,
  },
  tokenIconImage: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    position: 'relative',
  },
  addressTextCopied: {
    color: '#00d4ff',
  },
  checkMark: {
    color: '#00ff00',
    fontSize: 12,
    marginLeft: 6,
    fontWeight: 'bold',
    position: 'absolute',
    right: 10,
    top: '50%',
    transform: [{ translateY: -6 }],
  },
  tokenDetails: {
    justifyContent: 'center',
  },
  tokenName: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  tokenPrice: {
    color: '#888',
    fontSize: 12,
  },
  tokenBalance: {
    alignItems: 'flex-end',
  },
  tokenAmount: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  tokenValue: {
    color: '#888',
    fontSize: 12,
  },
  tokenItemClickable: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#16213e',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.2)',
  },
  tokenSendHint: {
    color: '#00d4ff',
    fontSize: 24,
    fontWeight: '300',
    marginLeft: 8,
  },
  // Header overflow (⋮) menu
  headerMenuBtn: {
    position: 'absolute',
    right: 14,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  headerMenuIcon: {
    color: '#00d4ff',
    fontSize: 30,
    fontWeight: '700',
    lineHeight: 32,
  },
  menuBackdrop: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 10000,
  },
  menuCard: {
    position: 'absolute',
    right: 10,
    minWidth: 210,
    backgroundColor: '#16213e',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.3)',
    paddingVertical: 4,
    zIndex: 10001,
    elevation: 30,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    paddingHorizontal: 16,
  },
  menuItemText: {
    color: '#e6f6ff',
    fontSize: 15,
    fontWeight: '600',
  },
  menuItemHint: {
    color: '#00d4ff',
    fontSize: 15,
    fontWeight: '700',
    marginLeft: 24,
  },
  menuDivider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.07)',
    marginHorizontal: 8,
  },
  // Token manager modal
  mgrBox: {
    width: '92%',
    maxWidth: 420,
    height: '78%',
    maxHeight: '78%',
  },
  mgrHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingHorizontal: 18,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0, 212, 255, 0.2)',
    backgroundColor: 'rgba(0, 212, 255, 0.08)',
  },
  mgrClose: {
    color: '#8aa0b3',
    fontSize: 20,
    fontWeight: '700',
  },
  mgrSearch: {
    height: 44,
    marginHorizontal: 14,
    marginTop: 14,
    marginBottom: 8,
    backgroundColor: 'rgba(22, 33, 62, 0.9)',
    borderRadius: 10,
    paddingHorizontal: 14,
    color: '#ffffff',
    fontSize: 15,
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.35)',
  },
  mgrAddBtn: {
    marginHorizontal: 14,
    marginBottom: 8,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.4)',
    borderStyle: 'dashed',
  },
  mgrAddText: {
    color: '#00d4ff',
    fontSize: 14,
    fontWeight: '600',
  },
  mgrList: {
    flex: 1,
    paddingHorizontal: 14,
  },
  mgrRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.05)',
  },
  mgrRowInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  mgrRowSym: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  mgrRowBal: {
    color: '#8aa0b3',
    fontSize: 12,
    marginTop: 2,
  },
  mgrEmpty: {
    color: '#8aa0b3',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 30,
    paddingHorizontal: 10,
    lineHeight: 19,
  },
  mgrHint: {
    color: '#8aa0b3',
    fontSize: 12,
    paddingHorizontal: 4,
    marginBottom: 8,
  },
  mgrError: {
    color: '#ff5555',
    fontSize: 12,
    paddingHorizontal: 4,
    marginBottom: 8,
  },
  // Send Modal Styles
  sendBalanceInfo: {
    backgroundColor: 'rgba(0, 212, 255, 0.1)',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
    alignItems: 'center',
  },
  sendBalanceLabel: {
    color: '#888',
    fontSize: 12,
    marginBottom: 4,
  },
  sendBalanceAmount: {
    color: '#00d4ff',
    fontSize: 20,
    fontWeight: '700',
  },
  percentageButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
    gap: 8,
  },
  percentButton: {
    flex: 1,
    backgroundColor: 'rgba(0, 212, 255, 0.15)',
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.3)',
  },
  percentButtonText: {
    color: '#00d4ff',
    fontSize: 12,
    fontWeight: '600',
  },
  sendFeeContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
    marginTop: 8,
    marginBottom: 16,
  },
  sendFeeLabel: {
    color: '#888',
    fontSize: 14,
  },
  sendFeeValue: {
    color: '#ffaa00',
    fontSize: 14,
    fontWeight: '600',
  },
  sendTotalContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(0, 212, 255, 0.1)',
    borderRadius: 8,
    marginBottom: 16,
  },
  sendTotalLabel: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  sendTotalValue: {
    color: '#00d4ff',
    fontSize: 16,
    fontWeight: '700',
  },
  // Send Screen Styles (inline, not modal)
  sendScreenContainer: {
    paddingTop: 0,
  },
  sendScreenHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
    marginBottom: 20,
  },
  sendScreenTitle: {
    color: '#00d4ff',
    fontSize: 18,
    fontWeight: '600',
  },
  backButton: {
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  backButtonText: {
    color: '#00d4ff',
    fontSize: 16,
  },
  // Transaction Result Styles
  txResultContainer: {
    alignItems: 'center',
    paddingVertical: 40,
    paddingHorizontal: 20,
  },
  txSuccessIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(0, 255, 136, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  txSuccessIconText: {
    color: '#00ff88',
    fontSize: 40,
    fontWeight: '700',
  },
  txErrorIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255, 68, 68, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  txErrorIconText: {
    color: '#ff4444',
    fontSize: 40,
    fontWeight: '700',
  },
  txResultTitle: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 16,
  },
  txResultAmount: {
    color: '#00d4ff',
    fontSize: 32,
    fontWeight: '700',
    marginBottom: 8,
  },
  txResultTo: {
    color: '#888',
    fontSize: 14,
    marginBottom: 24,
  },
  txHashContainer: {
    backgroundColor: 'rgba(0, 212, 255, 0.1)',
    borderRadius: 12,
    padding: 16,
    width: '100%',
    marginBottom: 24,
  },
  txHashLabel: {
    color: '#888',
    fontSize: 12,
    marginBottom: 8,
  },
  txHashValue: {
    color: '#00d4ff',
    fontSize: 14,
    fontFamily: 'monospace',
  },
  txErrorMessage: {
    color: '#ff6b6b',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 24,
    paddingHorizontal: 20,
  },
  txDoneButton: {
    backgroundColor: '#00d4ff',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 60,
    marginTop: 20,
  },
  txDoneButtonText: {
    color: '#0a0a1a',
    fontSize: 16,
    fontWeight: '700',
  },
  phaseCard: {
    backgroundColor: '#16213e',
    borderRadius: 15,
    padding: 20,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.2)',
  },
  phaseTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#00d4ff',
    marginBottom: 8,
  },
  phaseSubtitle: {
    fontSize: 14,
    color: '#888',
    marginBottom: 15,
  },
  phaseProgress: {
    marginTop: 10,
  },
  progressText: {
    fontSize: 12,
    color: '#888',
    marginBottom: 8,
  },
  progressBar: {
    height: 8,
    backgroundColor: 'rgba(0, 212, 255, 0.1)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#00d4ff',
  },
  nodeTypesContainer: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
    marginBottom: 15,
  },
  sectionSubtitle: {
    fontSize: 13,
    color: '#ffa500',
    marginBottom: 15,
    textAlign: 'center',
    fontStyle: 'italic',
  },
  warningBox: {
    backgroundColor: 'rgba(74, 144, 226, 0.1)',
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(74, 144, 226, 0.3)',
  },
  warningText: {
    fontSize: 12,
    color: '#ffffff',
    marginBottom: 2,
    fontWeight: '500',
  },
  warningSubtext: {
    fontSize: 11,
    color: '#888888',
    marginTop: 2,
    textAlign: 'center',
  },
  nodeTypeCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#16213e',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.2)',
  },
  nodeTypeActive: {
    borderColor: '#00d4ff',
    backgroundColor: 'rgba(0, 212, 255, 0.1)',
  },
  nodeTypeActivated: {
    borderColor: 'rgba(0, 212, 255, 0.6)',
    backgroundColor: 'rgba(0, 212, 255, 0.08)',
    opacity: 0.95,
  },
  nodeTypeDisabled: {
    opacity: 0.5,
    borderColor: 'rgba(128, 128, 128, 0.3)',
    backgroundColor: 'rgba(128, 128, 128, 0.05)',
  },
  nodeTypeDisabledText: {
    color: '#666666',
  },
  nodeTypeInfo: {
    flex: 1,
  },
  nodeTypeName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#ffffff',
    marginBottom: 3,
  },
  nodeTypeDesc: {
    fontSize: 11,
    color: '#888',
  },
  nodeTypePrice: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#00d4ff',
  },
  activationStatus: {
    backgroundColor: 'rgba(0, 255, 127, 0.1)',
    borderRadius: 10,
    padding: 15,
    marginVertical: 15,
    borderWidth: 1,
    borderColor: 'rgba(0, 255, 127, 0.3)',
    alignItems: 'center',
  },
  activationStatusTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#00ff7f',
    marginBottom: 8,
  },
  activationStatusCode: {
    fontSize: 13,
    color: '#ffffff',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    marginBottom: 8,
  },
  activationStatusInfo: {
    fontSize: 11,
    color: '#888888',
    fontStyle: 'italic',
  },
  nodeMonitoringCard: {
    backgroundColor: '#16213e',
    borderRadius: 15,
    padding: 20,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.2)',
  },
  nodeMonitoringHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 20,
  },
  nodeMonitoringTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#ffffff',
  },
  alertInput: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    padding: 10,
    marginTop: 10,
    color: '#ffffff',
    backgroundColor: '#1a1a2a',
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusBadgeActive: {
    backgroundColor: 'rgba(255, 170, 0, 0.2)',
  },
  statusBadgeActivated: {
    backgroundColor: 'rgba(52, 199, 89, 0.2)',
  },
  statusBadgeInactive: {
    backgroundColor: 'rgba(255, 59, 48, 0.2)',
    borderColor: '#ff3b30',
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#00ff7f',
  },
  statusBadgeTextActive: {
    color: '#ffaa00',
  },
  nodeMonitoringInfo: {
    marginBottom: 12,
  },
  nodeMonitoringLabel: {
    fontSize: 12,
    color: '#888888',
    marginBottom: 4,
  },
  nodeMonitoringCode: {
    fontSize: 14,
    color: '#00d4ff',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    fontWeight: '500',
  },
  nodeMonitoringValue: {
    fontSize: 14,
    color: '#00d4ff',
    fontWeight: '500',
  },
  serverActivationNotice: {
    backgroundColor: 'rgba(255, 170, 0, 0.1)',
    borderRadius: 10,
    padding: 15,
    marginTop: 15,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 170, 0, 0.3)',
  },
  serverActivationIcon: {
    fontSize: 24,
    marginBottom: 8,
  },
  serverActivationText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffaa00',
    marginBottom: 4,
    textAlign: 'center',
  },
  serverActivationSubtext: {
    fontSize: 12,
    color: '#888888',
    textAlign: 'center',
  },
  rewardsCard: {
    backgroundColor: '#16213e',
    borderRadius: 15,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.2)',
  },
  rewardsTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#ffffff',
    marginBottom: 20,
  },
  rewardItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.05)',
  },
  rewardLabel: {
    fontSize: 14,
    color: '#888888',
  },
  rewardValue: {
    fontSize: 16,
    fontWeight: '600',
    color: '#00d4ff',
  },
  validatorNote: {
    fontSize: 12,
    color: '#888888',
    marginTop: 15,
    paddingTop: 15,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.05)',
    lineHeight: 18,
  },
  emptySubtext: {
    fontSize: 13,
    color: '#888888',
    marginTop: 8,
    textAlign: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  qncTokenIcon: {
    borderWidth: 2,
    borderColor: '#6B46C1',
    backgroundColor: 'rgba(107, 70, 193, 0.1)',
  },
  qncIconInner: {
    width: '100%',
    height: '100%',
    borderRadius: 20,
    backgroundColor: '#0f0f1a',
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Verification error styles (like in browser extension)
  verificationErrorBox: {
    backgroundColor: 'rgba(255, 59, 48, 0.1)',
    borderRadius: 8,
    padding: 15,
    marginTop: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 59, 48, 0.3)',
    width: '100%',
  },
  verificationErrorText: {
    color: '#ff3b30',
    fontSize: 14,
    textAlign: 'center',
    fontWeight: '500',
  },
  // Terms of Service styles
  termsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 15,
    paddingHorizontal: 20,
  },
  checkbox: {
    width: 24,
    height: 24,
    marginRight: 10,
  },
  checkboxInner: {
    width: 24,
    height: 24,
    borderWidth: 2,
    borderColor: '#00d4ff',
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  checkboxChecked: {
    backgroundColor: '#00d4ff',
  },
  checkmark: {
    color: '#000000',
    fontSize: 16,
    fontWeight: 'bold',
  },
  termsTextContainer: {
    flexDirection: 'row',
    flex: 1,
    flexWrap: 'wrap',
  },
  termsText: {
    fontSize: 14,
    color: '#ffffff',
  },
  termsLink: {
    fontSize: 14,
    color: '#00d4ff',
    textDecorationLine: 'underline',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  termsModal: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.9)',
  },
  termsModalContent: {
    flex: 1,
    margin: 20,
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 20,
  },
  termsModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  termsModalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#ffffff',
  },
  termsModalClose: {
    padding: 5,
  },
  termsModalCloseText: {
    fontSize: 24,
    color: '#888888',
  },
  termsModalBody: {
    flex: 1,
  },
  termsModalText: {
    fontSize: 14,
    color: '#cccccc',
    lineHeight: 20,
  },
  termsModalButtons: {
    flexDirection: 'row',
    marginTop: 20,
    gap: 10,
  },
  termsModalButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  termsModalAccept: {
    backgroundColor: '#00d4ff',
  },
  termsModalDecline: {
    backgroundColor: '#333333',
  },
  termsModalButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  termsModalAcceptText: {
    color: '#000000',
  },
  termsModalDeclineText: {
    color: '#ffffff',
  },
  errorToast: {
    position: 'absolute',
    bottom: 40,
    left: 20,
    right: 20,
    backgroundColor: '#ff4444',
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
    zIndex: 1000,
  },
  errorToastText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  lockoutBanner: {
    backgroundColor: '#2a1a1a',
    borderWidth: 1,
    borderColor: '#ff4444',
    borderRadius: 12,
    paddingVertical: 20,
    paddingHorizontal: 24,
    marginTop: 16,
    alignItems: 'center',
  },
  lockoutText: {
    color: '#ff6b6b',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
});

export default WalletScreen;
