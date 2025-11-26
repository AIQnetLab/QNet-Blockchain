import React, { useState, useEffect } from 'react';
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
  Share
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Clipboard from '@react-native-clipboard/clipboard';
import WalletManager from '../components/WalletManager';
import QRCode from 'react-native-qrcode-svg';
import { 
  checkNodeStatus, 
  reactivateNode, 
  checkServerNodeStatus
} from '../services/PushService';

// 1DEV Burn Tracker Contract (same as browser extension)
const BURN_CONTRACT_PROGRAM_ID = 'D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7';

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
    password_changed: 'Senha alterada com sucesso!',
    wallet_deleted: 'Carteira excluída com sucesso',
    session_expired: 'Sessão Expirada',
    wallet_locked: 'Carteira bloqueada por inatividade',
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
    password_changed: 'Mot de passe changé avec succès!',
    wallet_deleted: 'Portefeuille supprimé avec succès',
    session_expired: 'Session Expirée',
    wallet_locked: 'Portefeuille verrouillé en raison de l\'inactivité',
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
    password_changed: 'Passwort erfolgreich geändert!',
    wallet_deleted: 'Wallet erfolgreich gelöscht',
    session_expired: 'Sitzung Abgelaufen',
    wallet_locked: 'Wallet wegen Inaktivität gesperrt',
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
    password_changed: 'تم تغيير كلمة المرور بنجاح!',
    wallet_deleted: 'تم حذف المحفظة بنجاح',
    session_expired: 'انتهت الجلسة',
    wallet_locked: 'تم قفل المحفظة بسبب عدم النشاط',
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
    password_changed: 'Password cambiata con successo!',
    wallet_deleted: 'Portafoglio eliminato con successo',
    session_expired: 'Sessione Scaduta',
    wallet_locked: 'Portafoglio bloccato per inattività',
    logout_confirm: 'Sei sicuro di voler disconnetterti?',
    delete_wallet_confirm: 'Sei sicuro di voler eliminare questo portafoglio? Assicurati di aver eseguito il backup della frase di recupero!',
    i_saved_it: 'L\'ho Salvata',
  }
};

const WalletScreen = () => {
  const [walletManager] = useState(new WalletManager());
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
  const [selectedToken, setSelectedToken] = useState('sol');
  const [selectedNetwork, setSelectedNetwork] = useState('solana'); // 'qnet' or 'solana'
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
  const [language, setLanguage] = useState('en');
  const [autoLockTime, setAutoLockTime] = useState('15');
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showExportSeed, setShowExportSeed] = useState(false);
  const [showExportActivation, setShowExportActivation] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [lastActivityTime, setLastActivityTime] = useState(Date.now());
  const [autoLockTimer, setAutoLockTimer] = useState(null);
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
  const [nodeStatus, setNodeStatus] = useState(null); // 'light', 'full', or 'super'
  const [copiedAddress, setCopiedAddress] = useState(''); // Track which address was copied
  const [burnProgress, setBurnProgress] = useState('0.0'); // Real burn progress from blockchain
  const [activatingNode, setActivatingNode] = useState(false); // For node activation loading state
  const [verificationError, setVerificationError] = useState(''); // Error message for seed verification
  const [activatedNodeType, setActivatedNodeType] = useState(null); // Track which node type is activated
  const [activationCode, setActivationCode] = useState(null); // Store the activation code
  const [nodeRewards, setNodeRewards] = useState(null); // Store validator metrics data
  const [processingValidation, setProcessingValidation] = useState(false); // Track validation processing
  const [activationPricing, setActivationPricing] = useState(null); // Dynamic pricing info
  const [nodePseudonym, setNodePseudonym] = useState(''); // Pseudonym/alias for the node
  const [showActivationInput, setShowActivationInput] = useState(false); // Show activation code input modal
  const [activationInputCode, setActivationInputCode] = useState(''); // Input activation code
  const [lightNodeStatus, setLightNodeStatus] = useState(null); // Light node network status
  const [serverNodeStatus, setServerNodeStatus] = useState(null); // Full/Super node network status
  const [reactivatingNode, setReactivatingNode] = useState(false); // Reactivation in progress
  const [nodeActivating, setNodeActivating] = useState(false); // Node activation in progress
  const [unlockError, setUnlockError] = useState(''); // Error message for unlock screen

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

  // Get token icon URL like in extension
  const getTokenIconUrl = (symbol) => {
    const icons = {
      // QNC - QNet app icon
      'QNC': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAPe0lEQVR42qWae6xcV3XGf2vvc84872uu347jRwyJYwNJE1IcCO8qTYvahFCUmkcLrVBbqCJA5Y9KlShCVR9AKyEBUgtFpY0QooBIKTQloSipEzkPnNZ27NiJH7Ed29f3Ne8z5+y9+secmTszd2yIOtKdc2fOzJnvW3uttdf61pGZmWuV0Yf0nwaO2auBl6qy6vwrfYgooNn1Rs+unOu/HHkEvwj4obeQDPjod17hQ4eNIKIZmUEiPQNlRGQ1iWA8eFn11ipry/+TgQxbduX6iggoOgBWhr+n4wiMgJeBpyGLy88BLVchM+QjcgUygqoiIqiMktDuceD94Io/KqAI9MCPA95jKb/gSvR/pwegdxx4X3okso+LjriUMuhLwThXkNEAHQUoPTAy7GxmwGd1wNFl8H3tY9CeNb0OA5QBt5JuoK8iIQKqBKsCtu/0YywrMsCh94/pAk8TtNWGNAFjIAi7R1VwKepSsAES5hAbdYF533VRI5l76cCKZ0RVunyvQCIYBa9D4GV4+WUQuHQBtluQxEhlPXb3XuzWPdg112BK0xibwyQpNGv4xQukLz1H59SzJJdPA2ByJRDpEslWSfsrMujr0k+5o6lWZirbVj4iAwE7SMDIsNWthaQDnRay85cI3nYvdsfroNOBi6fgwhl0Ya573gbY0izB7DVEa3YQFmZwl05Tf+p71J57GNRjozLq04Gk1LO+H0q5IjqSnbRLoBdbqmYseBn0fWOhUYP1Wwh+637MzpvQQ/tx+3+AP/0c2qiu+OhADldVJCoSrttG+cZ3MPWau6BR49J//i21F/cT5KczEH6EhA7EFIj4oVXoE+gHrYwGZWZ5yV7Xa8ib3oXd9ydw+Ancd7+Mnj8JYQ6JCmAtiqLqURRBEBEEA97jkxifNLHFGSq33ce62z7A8rPf5+yPP4cJcoix4AdI+IEdWUHQocwkldmuC6maYfDS/ZO+/ws065jf/jjmzXfjv/ZZ/IEfQa6EREUUR+KbqCqhyROZIoFEOE1JfItEW3j1hCaPNRHedXDNJfLrr2fH3Z/DVS9x4nufQL1DbDBCYqCk0Kz8UO0Gd2V2m3YjfThwpQeazG1aNcz7PoW5/S7cX/w++tIJmKwgXun4BoHJszm/m435GyiFFQSDV9e1PELLLXO5c4qzrf+hkV4mMkWMhLhOHUW5/p4vEkaTHP7WhxEx/TTZNa6OdSU0I7DK94XuRXoBW19G7vog9u6P4P78g+jFl5DSFN51SDVmR+mXedXEHcS+zoX288x3TtN2VZw6RAyRKTIdbmR97nomg/Wcbx/haPXHeFJCU8S7GJc02fPuv8fHdY782/3Y3MRVV6GL1COV2e2qo2mzF7jGQNxCduzGfvJLuL+7Hz32DFKewbk2RgLeUNlH3k5wqPofXIyP49VhJMBklu/+nsdriqJMBuu5cfJOynYtBxb/hWp6gZwp4dIYMcJt+77H2YMPcOaZfyDMT6PeZavgR3bvrivZfKHy6VVlgZgsiWS73Uf/Bj3wEP4n/wqTs6iLsRLw1rUfoemXeGz+6zTcAoHkCSQiMBHW9I4BRgKsBAQS0fFNTjefBDy3zezjcnyChpsjtEXSToP6pcPseuOfMnfyETrxcjeoB6uIkXLFjC1ZAMRCs4bZ+2tIoYx78KtQngZ1eDx3rPk95jsv8fj8AxnwPFYsuWCCQlihGM5SiCoUwlmKYYV8OI01EUYseTvNi80neGb52+yd/V0KdprUtwlzU8yffZyF04+y85Y/wiVNROwVAHb/Mavyfn9T8BDlCN7+XvzD30KbdYwNSVyDPVN34kh4Zum7FOwEoES2SCGaJQzLmDCHGvCa4sUjQUgYlCiEFfLBFOApmCleah7keP2/eP3MPpwmgCcIy5w8+FXWrr+ViZlX4Vx7BdOYWtGM7Qek6/tm581IfgJ34CGkWCb1babCTWwpvI6nFr9DYHIoSs6WyQWTEIR4dbh2DZ/LEVSuwRSniH2TmBZYkxGZQXEU7BTP138KCFtLtxG7OkFYpLp4nPrlo2zZ8eukSRMRk22mq7vEYGz7KIKmHexr70BPHUGXLmImZknTZXZO3c7L7eeopXPkTRlrIqKgjAYGTWN0cobi2z7GxJpdlGopU42A6OIcz594gEu1w+RtAUueSCeI0xpGLMdqj3D9xDs503yKLLvz8umH2X7dvRy1uW4Aw1Bq7cWEGete6pEoj712N3r0qaypceTMBJXoWk43f0YgOQAiW+7uvi6BNRspf+gvsbkyC498mVM/+WsOP/0FlmonuOeaz7Cr/JbuShghsiWMBASS43LnBQAq0TZS38YGBRbmniUfTlMsbcL7ZExpP9SR6crui4B3UJrClqZJzp1AwohUO6yNtuM0pppexIjFZtlGUdQayvd8Enf0Sao//gpamgAbQKI8WfsarfwJ7tj8B5w7fYJW+yKBCQltgTitk2rMUnKONdF1XI5PkLNlmo0L+E6dqckd1BsvYYMo232HG2MzNsJ9iplcg3jFL88jNsRrymSwjparkfgYg2BNCNbgOy2ina8nT4H6Yw/A1BrIl/BRhOZyFAsbOdR6lEP+KbZuvJPUxyCClSjzbEM1eZlysDbzFEOatkjjBsXC+qxSHd/tmXE5Sr1iCiWM99BudIMaJTIl2r7eXzEjQffzpJTW7UJOHSP1MRoEpAbS0OCs4IwnsgXOtA4ilc0YE2RNiunXWbGvEZnSwOanpHGVXDAxTk25iqzSdymD8YC6gXZVVgJqcMFEKCQhksZovwDsNXYr9VSHNo2cRzD9SrV/DfxQgwog3mF+Tp9txoIXg3baGBUkyvcjP9E2oSmstB0D2UHnzrLebgVRjFfEKzb1mNRjvMcsL2Gnt1B18+DSrjHwXb9WCKVA4ttDHWBkJkiT1islAGIsWpvHYDGlCupTRCyNdIG8ncRK1wWcpqj3BDbP3PnHuba9kevKe2m25whSxaYQdFJcYOj8xj7cdXuonn4MQwAKzidZpe8oB+tousV+428kIB+UacfziDHjZbkVAoNyh4IJ8PUlpN0imN2Cph0CE7GUnCNnShTtdHfD8jHqU4yEtOM5/veFr/Ou6fvZU34H2m6izSrSbBCWNrDzpo9x8/wm5NxRxIbgHalvZSAs0+FmFpPTGLE4n1DMrSFvyyzXT2FNbpzuOCYGMlFAjOCbddyFF8ltu4nmz36IlZBGukDTLbIhv4vj9ccwaum4JjljydkiR5cfoaMxe7a8j/XX/iqXZY52KSKeKNH6xmdYruwlefs+gof+CWeF1Hfw6iiHG8iZCebiE4QmT6fTYNPsrah3LDdOY02IZg3MKJGgrxMN7geZXNI+tp+pN32Q5XwJnENEOFk/wI2Td3KycQAQOq7RrTrJkzcFTlYf48zRp5mZvhEpVWj7OvHCcVz1InNzTyAzmwmMoZUsIhgSX+O64t3Mxc8T+ypFW8FpzLa1b+Hy0mHitEohrKC4sUKvGVZas5PeY3JFWs/vJwxLFLa/HtepE5kSL7eP0HZVrp94K21fxWBoJUs41wKv5ClhnbIw9zTzL/yI1sn9aKOKDaco1RLyJ47QdEuoehJtsTb3Kmaj7Txff5icKZO6mGJuLVsrt3P8/L9jTdRraca6kVktW/eoBaS1yzQOP0Jl7/tRn6JAIDkOLn2XrcVb2Zx/DW1XBYRmskicLOPTGHFCJCWiYAoblDFqIYmJtUHd1FHv8JoQSMRNU+/lUPX7JL6FlZA4XWL35nfTbi9wduEJoqCUZTtlnM5uxujdGVuPyZVZ3P8NipUdTO16J2lzEWsjmn6JJxe+ya3T97GxsIeWW8zcqUmjM08rmSfuLBEnS3Q6C7Q7CzSTedpJFbzS8U1Ck+eNsx/lZPNxzrefJWfKJK5NOb+Bm7f8Dgde/MrqmcCYOLaFwvSnGWnoe2qEsQFpYx5N2mx628dZOvQgLokJbYFqcoGF5Aw3T91LMZhmrnOCxLeyTcrhNMH5BKdJty/AkfoYpzGbCzdx6/QHeKHxU15s/JS8mQSg3Vngrtd8nmrzLAdOfolcOLWy1+hq/xfRgaZehsXbflNvDD6us/2ezxPmJjj2zY9gcxMYE9DxDfJmktdNvZtiUOFs6yAX2kdo+kWcj7Pd1WAlIGfKzEbXsaV4K5aIw9UHme+8QN5MgAj19gVu3/kJXrvpPXzj8d/Ea4LJduyVpp5VykSmCwmjjb30lOasBleUG+/7R5Kl8xx78BOYsIANCjgfk2ibdblXs7V4G+VgHanGdHwTrykihkDy3TrK1TjfPsi51kFACU0RVU8jnuOWrR9m7/Y/5ttPvZ+F1klCU0CzMmZIlRiwPqpIpbKtq+eukla6ilovpapPMGGR3Xd/CR83OPqjT9FpLRDmphEREt/CaULOTDIZrKcQzGAlRNXRdlVq6cVup6WrCWGJXR3nY9786k+xe+N7+M4zH+JS7Qj5YBKfaaXjrN9T59CrSosmk1fol7i9xuKGX/ksM+tv5vijf8XFFx8CsQRRt0FR0q7vk65UrVishN3qVZXENUlci7WTN/L2G/6MnJ3gB8/ez2LrFPlgKvsd+slktZzi+y+7BPpzsNWrMCypG1BPmjTYvOtedt7yh7QXT3Pq0D9z+eUnSTo1xFiMCTEmWCmN1eF8gtcEayJmJ27gtdfex47ZOzh2/of894kvdF3KFgYsnwWu6lAQD4JfLa+TSYxXJSGIGJL2MlFxDdt3v4/NW++ENGbx4kEW5p6lVj1N0qnifYKIJQpKTBQ2sXZqN5umb2Iy2sCFxad5+uTXmKs9Rz6c6mavvs+PgO+5znh5fav24ckVJPZRElnF6n1K0qmRy8+wbuMb2LDhTUxPbicXTGG8xbhuPW+84JI69cY5Xp5/kjNzj7LUPENoC5nVV8qEYVmdq0jr2luBrTo0mSSb0nClEdMAjWw11KekaRPvU2xQIIomCYMygc11SaYNOkmNTloDhDAoEpioW6D15wEDYK8EfmgzGyIwMtQGdHCTHpVezMqJ/gShNyLCo+q68wH13dmAGATbV9l6pYEOlcGjtc4A+N6QZNWWrFlnMTC+1IGutA9aR2a5fmW+OzDeGeDbBSvCkHWHfHzVqHU18MHbDcaBR69QTq889xdqIOxHiGW6vYqsEg507L0F40COqYgHnHnsFYcG3To4zx0msRLcA0REVw+2VUdIcjU2VwXevwFEr/C1gdUOVl9smEQXj664g8qqQFo16ddf8G4PHTfM92NO6xVuVxjTUq64yIqVtS+r9HQxWW0ReeV3qoy97Uav4HpXaGj+DzDA2yLaJ6DkAAAAAElFTkSuQmCC',
      // SOL - official Solana token
      'SOL': 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
      '1DEV': 'data:image/webp;base64,UklGRlwJAABXRUJQVlA4IFAJAADQJQCdASpAAEAAPhkIg0EhBv4rvwQAYSxAFOjeOHXy38bvyA+TGtv0z8Hb2iSnt8ndbZ3zE/sV+wHu7+h76M/h0/qvrFeqX+zPsAeXH7Iv+E/6/7Ae0bgAm4P7j+JPmD4VvSPtx6gOAPpn1AvlP3L/aeTHeD8AdQL2L/mfyq9rf4TsCs7/wfoBe0P2L/W+AhqBdy/RT/S/9V6Df3zwPvo3999gD+Yf3T/if3j3Vf6f/2/6Hza/S//k9wT9b/+n64frh/bb//+7j+wBh+KnsiC/V+OzkQZ9xnsPcb/R4BS9G6rCJUElCa2zpAn6yH1fLY2lk4C3m0NBCjbpYNw26lH01KHAdmXiig6rtgIpssbm3//428xJbrp4rg8PNVi0n1UBJaCTUtDZArp17P79TGWL1piPuMZ4kAD+/6oBwxZnprfB3Z04cTZir9TxW6M3b9YMLmR2Gu920U7y+zsz1AnnNLpBkuLva/iYMPFt8WA5AHFehPyR0iHg1YbYMjfOBEvkytnybjJV5nnbCpTIIXVR8fX//3p1/AjCKZ8CMP/9Ug4T25pe/WOjAkPcN/9aOJ7PJc1Xq0m+mhQJlb152HrEq3VYVPBda9GPgAm1QyzGtTbAQng5Dxesy/JRgu6uLiOB4ovEhyJrAGD9bHZrpHH93EyupT7x7/fWSHaAx+aHL5OpQfY3s0UCUsLfllULEQ/x3pTg+iUuJW7xCz5JkSlEbmpTlcHPnLFUBQ9dIYpsV8k9x6Bi7xMCzGsUBxFjt7S0hAbt0E7pLBvDPiNkDAsInRzJkyiqtB+fLRKtqJaxbR0Ih6KTaGJeCPCzwpjfVUe1ugK1lmulASfWU55zBIGfNXCf5L1qlKZ6hGFvDE1y10S84mVfaCXKDUJqou04vJ4BY3ycpSZJbI58BXCfFRS4i9CF5i6bmy6M1PutB77GjlbExU/kt3QwIQ5x/GyHnj5S2t4X4xp/xTrQCSJZAahoHuqWrE1NNHrYiYwaXX1LjkxC8WcouXpXbKZ+D2lOBLTBikhMFfMlPlNl3WEg6IHXDvF41P8FVzEBluEel9vpWp52AlazCalz3jI9+vyi8aloEmqMI/8C51CTxvS7fsxzT1tJQKlyEw2RV8hgNb+YTBfcUH1iCd8Y7oXAfXWvntqqDUr5R8e65JDm8A4vLFsSg9PuRd6WeaB6vHgwoxzQIhjApCVwqIg9vwsWmfDA5cn/DDvYO9rnjJ2ejGgsvg/0P1o62vLeslmbER15fwNHmv7s42+PzbEFsVIwvjKinRLW3cJ8SzjZrcaCejiTY/7p9mZNMAVCsDSPYlKTDg/dVdW8ZZ8RXGANXOcMNidank78eDNaaosmgoteewsu03q/Jz283R5jgokZHoQ17JphkRuG0Il1yBeNBBmD4ZrMBizwlmiPOvuOaSdOV6Xp5rhZGUxy6yigVAaLFHmTfLr3Oien3HHtDzH7HtU09ZIrubO9KJLNzAjxp2OBcEQFiP+F70D0UgLsFjUO9EQfjm6qHA0IGfr01Q47Kp5uc2PycLdHwraJmh5d5ChC80QEqudsrebzjcq7LiTy7SchubfLsQWBXULcu92pcGNIGtyTSNvwNPXd8iequ2STZIAbshQ0rmwyKqnAz/h41BbCy1VkBiRAmjMiusXdo5dikjWfrD66eNXxoo/pa9p+8T/NCminxf+YEBw7ab1TUsRsEPdzAWxW/eOdDK0Rh7e41y4L5NNhKN99ktKcs+FBgd4bR+YfwXWj+15tIHdcnfthSzDgOHyc143s5ChWxdbIlwxjEnxKVCex+hJBmdpln/QFn93+CoS3MpMxW8DTbtYjDfDP+bI9K8vZV5U3UQxEKYrZ9mglhwXYgsnI5RH4e2P7Pi3YHgyzt/raot15D4AVrFVKFJTMF1OYll7e0KILO01+MVNS+RP3FdXzV5bKaVBu0hGx+5WVYZwnzkDvRHuYARLh7XsBG6FbUYFqFJuQ11R8z+X6W0y4Ke19og3M8f5y+ODK2l9GvHkofeDcerCoqFuQZlWso8fu3kNndG1hT/SCjzbugqm+xHiclF3wHTXL2ova3Zr1lnAnWVaUNr030Zh6czayHPE7lY5Ue1bhqCH0jgj1KZ5bm6SLv9e/o6k+lh03vnmEvcPgN6xQKnoc/xR5y7V6rHjdVPYgCeKJDyHTnLKB/W1uiPPlh9v7MWyztQ42JrB3ngtLlaN7Qn2rrQ+bq73ldZDkbbUV85grcToYmG8IE/GI5gMyBUyBpApxsqoKdCjF/2lPGHseR/C72iSdsNQ9LsD+4mhOrk39PS7BmyGLAHqyoLQDhXd2gQhzA4byKDMGvsSmIjgXUj7QD/RB32HfzXSXJsGBU6aFeH9N0/+SneviUbr93ui+wKoSDNvgBNWHe5jn+gwLdjoVYMbbbLiHWL/+JsHS3A65XcHmZPfzrVBz8lmwKXwjijkGNoHGq+mR/taFOKbHVTbyWidaT7LxV2Ypj/ebQ9UXc5V/CSImRmlCVhCjct47pn5PosoOk7P5OWyFi92KwW6nWfJVAvWDNoJrRCP59I0q8mIZ/mi1DJsSb0MXCP8OYd5rikw98Efdjxj10DfXp7Hnn6e5F4XZpyyZtOCwtNpj6M1xvcQ3GSj6YjtryPz4Rjl8Kj8aC/fTzWz++RZQdlXTAFyy8/KyEv5oey9lOQjMTSs0RF+UJlb1c1K3Oe00xoYzXTXRM27ZdF2VnWA/nQ12RVYwCOUSwYdUjXZGmyhcsliYsXHrGS8Zg9ndSDP+3Jgmq//rS2bw7OxkRbPf0zc54jvD4vKy6xNyik6F9359RsD83cyxvM3LWWTCFHBtvUx9D+QbdzIQ0C+GZBHZAP3KRMs4eier71LX+OGDp+wWeuM96W3EaZWV+hs4w7VhCMw4Ej2loQwQ3eEXyVlCylxmIc+mje/pPUvcFpnL9v1SsAXnWV0DYM35U+P/G1fYuDY0JquMOpelQUBcI5DhB4iolkbc/LIkQcexaAInlEBqfbuaWiYeh9eUMC3F0Po5WYdcU+slUtVMTL+cUAA1cMiFukh1h4E4ifmGtdvsJXBtXUQfpaPsnmqgaF4rapu3V5/TVsMc2ARuKH3YK8m3LPURCDcec3oT9SvUt0kfS4U1A/roXNtPPY/656lEw2OOP+2f5aoliVljHdbdK/n7dPg6EXAAAA==',
      // USDC
      'USDC': 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png'
    };
    return icons[symbol.toUpperCase()] || null;
  };

  useEffect(() => {
    // Load wallet data in parallel
    checkWalletExists();
    loadSettings();
  }, []);

  // Load real burn progress when activation tab is selected
  useEffect(() => {
    if (activeTab === 'activate' && wallet) {
      // Small delay to let UI render first
      const timer = setTimeout(() => {
        loadBurnProgress();
      }, 50);
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
            const code = syncedCodes[nodeType];
            setActivatedNodeType(nodeType);
            setActivationCode(code.code || code);
            
            // Stop syncing once we found activation
            if (syncInterval) {
              clearInterval(syncInterval);
              syncInterval = null;
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
  // - Full/Super/Genesis: Server is the node, app just monitors via single API call
  useEffect(() => {
    if (activeTab === 'node' && activatedNodeType && activationCode) {
      
      if (activatedNodeType === 'light') {
        // LIGHT NODES: App IS the node
        // - Load rewards (local tracking)
        // - Check ping status from network
        // - Start ping interval for responding to challenges
        loadNodeRewards();
        loadLightNodeStatus();
        
        // Start ping interval if not already running (for responding to challenges)
        if (!global.nodePingInterval) {
          startNodePingInterval();
        }
        
        // NO POLLING - user can pull-to-refresh
        // Light nodes get push notifications for pings anyway
        
      } else {
        // FULL/SUPER/GENESIS NODES: Server IS the node
        // - Single API call gets ALL info (status, heartbeats, rewards)
        // - Server handles heartbeats automatically every 24 min
        // - Rewards calculated at end of 4h window on server
        loadServerNodeStatus();
        
        // NO POLLING - server nodes don't need real-time updates from app
        // User can pull-to-refresh when they want to check
        // This saves battery significantly!
      }
      }
  }, [activeTab, activatedNodeType, activationCode, nodePseudonym]); // Load when tab opens
  
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
    try {
      const progress = await walletManager.getBurnProgress(isTestnet);
      setBurnProgress(progress);
    } catch (error) {
      // console.error('Failed to load burn progress:', error);
      setBurnProgress('0.0');
    }
  };
  
  // Load dynamic activation pricing
  const loadActivationPricing = async () => {
    try {
      const pricing = await walletManager.calculateActivationCost('full');
      setActivationPricing(pricing);
    } catch (error) {
      setActivationPricing(null);
    }
  };
  
  // Load Light node network status (for ping system)
  const loadLightNodeStatus = async () => {
    if (activatedNodeType !== 'light' || !nodePseudonym) return;
    
    try {
      const status = await checkNodeStatus();
      setLightNodeStatus(status);
      
      if (status.needsReactivation) {
        console.log('[Node] Light node needs reactivation');
      }
    } catch (error) {
      console.error('Failed to load Light node status:', error);
    }
  };
  
  // Load Server node (Full/Super/Genesis) network status
  // This single API call returns ALL info: status, heartbeats, rewards
  const loadServerNodeStatus = async () => {
    if (activatedNodeType === 'light' || !activationCode) return;
    
    try {
      const status = await checkServerNodeStatus(activationCode);
      setServerNodeStatus(status);
      
      // Also load pseudonym for display
      await loadNodePseudonym(activationCode);
      
      if (status.needsAttention) {
        console.log('[Node] Server node needs attention:', status.message);
      }
    } catch (error) {
      console.error('Failed to load server node status:', error);
    }
  };
  
  // Handle Light node reactivation ("I'm Back" button)
  const handleReactivateNode = async () => {
    if (reactivatingNode) return;
    
    setReactivatingNode(true);
    try {
      const result = await reactivateNode();
      
      if (result.success) {
        showAlert('Success', result.wasReactivated ? 
          'Your node has been reactivated! Next ping scheduled.' : 
          'Your node is already active.');
        // Reload status
        await loadLightNodeStatus();
      } else {
        showAlert('Error', result.error || 'Failed to reactivate node');
      }
    } catch (error) {
      showAlert('Error', 'Network error. Please try again.');
    } finally {
      setReactivatingNode(false);
    }
  };
  
  // Load node rewards data
  const loadNodeRewards = async () => {
    if (!activatedNodeType || !activationCode || !wallet) return;
    
    try {
      const rewards = await walletManager.getNodeRewards(activatedNodeType, activationCode, wallet.publicKey);
      setNodeRewards(rewards);
      
      // Auto-ping node if needed (4 hour interval)
      if (rewards && !rewards.isActive && password) {
        // Send automatic ping to keep node active
        const pingResult = await walletManager.pingNode(activationCode, wallet.publicKey, activatedNodeType, password);
        if (pingResult.success) {
          // Reload rewards after successful ping
          const updatedRewards = await walletManager.getNodeRewards(activatedNodeType, activationCode, wallet.publicKey);
          setNodeRewards(updatedRewards);
        }
      }
      
      // Load system-generated pseudonym
      await loadNodePseudonym(activationCode);
    } catch (error) {
      // console.error('Failed to load node rewards:', error);
      setNodeRewards(null);
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
      // Validate code format (QNET-XXXXXX-XXXXXX-XXXXXX)
      const codePattern = /^QNET-[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/;
      if (!codePattern.test(activationInputCode.trim())) {
        throw new Error('Invalid activation code format');
      }
      
      // Register node with backend (system generates pseudonym automatically)
      const result = await walletManager.registerNodeWithCode(
        activationInputCode.trim(),
        wallet.publicKey,
        password
      );
      
      if (result.success) {
        // Store activation locally
        const nodeType = result.nodeType || 'light';
        const code = activationInputCode.trim();
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
          timestamp: Date.now()
        }));
        
        // Start automatic ping interval (every 4 hours)
        startNodePingInterval();
        
        showAlert(
          'Node Activated!',
          `Your ${result.nodeType || 'light'} node has been successfully activated and registered in the network.\n\nNode ID: ${activationInputCode.trim()}\nSystem ID: ${result.pseudonym}`,
          [{ text: 'OK', onPress: () => {
            setShowActivationInput(false);
            setActivationInputCode('');
            loadNodeRewards();
          }}]
        );
      } else {
        throw new Error(result.error || 'Failed to activate node');
      }
    } catch (error) {
      showAlert('Activation Failed', error.message || 'Unable to activate node. Please check your code and try again.');
    } finally {
      setNodeActivating(false);
    }
  };
  
  // Start automatic ping interval for active nodes
  const startNodePingInterval = () => {
    // Clear any existing interval
    if (global.nodePingInterval) {
      clearInterval(global.nodePingInterval);
    }
    
    // Ping every 4 hours (14400000 ms)
    global.nodePingInterval = setInterval(async () => {
      if (activationCode && wallet && password) {
        const pingResult = await walletManager.pingNode(
          activationCode,
          wallet.publicKey,
          activatedNodeType || 'light',
          password
        );
        
        if (pingResult.success) {
          // Update rewards after successful ping
          loadNodeRewards();
        }
      }
    }, 4 * 60 * 60 * 1000); // 4 hours
    
    // Also do an immediate ping
    if (activationCode && wallet && password) {
      walletManager.pingNode(
        activationCode,
        wallet.publicKey,
        activatedNodeType || 'light',
        password
      ).then(result => {
        if (result.success) {
          loadNodeRewards();
        }
      });
    }
  };
  
  // Get the correct wallet address for claims based on activation phase
  // Phase 1: Solana address (1DEV burn)
  // Phase 2: QNet address (QNC transfer)
  const getWalletAddressForClaim = async () => {
    try {
      // Check activation metadata for phase
      const metaStr = await AsyncStorage.getItem(`qnet_activation_meta_${activatedNodeType}`);
      if (metaStr) {
        const meta = JSON.parse(metaStr);
        if (meta.phase === 2) {
          // Phase 2: Use QNet address
          return wallet.qnetAddress || wallet.address;
        }
        // If walletAddress was stored during activation, use it
        if (meta.walletAddress) {
          return meta.walletAddress;
        }
      }
      // Default: Phase 1 uses Solana address
      return wallet.solanaAddress || wallet.address;
    } catch (e) {
      // Fallback to Solana address
      return wallet.solanaAddress || wallet.address;
    }
  };
  
  // Claim rewards for Light nodes (local tracking)
  const handleProcessValidation = async () => {
    if (!nodeRewards || nodeRewards.unclaimed <= 0 || processingValidation) return;
    
    setProcessingValidation(true);
    try {
      // Get correct wallet address based on activation phase
      const walletAddress = await getWalletAddressForClaim();
      const result = await walletManager.claimRewards(activatedNodeType, activationCode, walletAddress, password);
      
      if (result.success) {
        showAlert(
          'Rewards Claimed!',
          `Successfully claimed ${result.amount} QNC rewards.\n\nTransaction: ${result.txHash}`,
          [
            { text: 'OK', onPress: () => {
              // Reload rewards
              loadNodeRewards();
              // Reload balance
              if (wallet && wallet.publicKey) {
                loadBalance(wallet.publicKey);
              }
            }}
          ]
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
  
  // Claim rewards for Server nodes (Full/Super/Genesis) - uses server-side pending rewards
  const handleClaimServerNodeRewards = async () => {
    const pendingRewards = serverNodeStatus?.pendingRewards || 0;
    if (pendingRewards <= 0 || processingValidation) return;
    
    setProcessingValidation(true);
    try {
      // Get correct wallet address based on activation phase
      const walletAddress = await getWalletAddressForClaim();
      // Pass serverPendingRewards so claimRewards knows this is a server node claim
      const result = await walletManager.claimRewards(
        activatedNodeType, 
        activationCode, 
        walletAddress, 
        password,
        pendingRewards  // Server pending rewards
      );
      
      if (result.success) {
        const claimedAmount = (pendingRewards / 1e9).toFixed(4);
        showAlert(
          'Rewards Claimed!',
          `Successfully claimed ${claimedAmount} QNC rewards from your ${activatedNodeType} node.\n\nTransaction: ${result.txHash}`,
          [
            { text: 'OK', onPress: () => {
              // Reload server node status (will show updated pending rewards)
              loadServerNodeStatus();
              // Reload balance
              if (wallet && wallet.publicKey) {
                loadBalance(wallet.publicKey);
              }
            }}
          ]
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
      
      // Reset timer on any activity
      const resetTimer = () => {
        lastActivityRef.current = Date.now();
        setLastActivityTime(Date.now());
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

      setAutoLockTimer(checkAutoLock);

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
      };
    }
  }, [wallet, isTestnet, selectedNetwork, activeTab]); // Reload on any network or tab change

  // Check for existing activation codes when wallet is loaded
  useEffect(() => {
    const checkActivationStatus = async () => {
      if (wallet && wallet.address && password) {
        try {
          const storedCodes = await walletManager.getStoredActivationCodes(password);
          if (storedCodes && Object.keys(storedCodes).length > 0) {
            // Verify the code belongs to current wallet
            // Generate the expected code for this wallet to verify
            const nodeType = Object.keys(storedCodes)[0];
            const code = storedCodes[nodeType];
            
            // Verify code is for current wallet by checking if it's the expected format
            // and was generated from current wallet's seed
            // Verify code asynchronously
            if (password) {
              walletManager.getEncryptedMnemonic(password).then(mnemonic => {
                if (mnemonic) {
                  const expectedCode = walletManager.generateActivationCode(nodeType, wallet.address, mnemonic);
                  if (code && code.code && code.code === expectedCode) {
                    setActivatedNodeType(nodeType);
                    setActivationCode(code.code);
                    // Save to AsyncStorage for quick restore
                    AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
                      nodeType: nodeType,
                      code: code.code,
                      timestamp: Date.now()
                    }));
                    // Start ping interval for active node
                    if (!global.nodePingInterval) {
                      setTimeout(() => startNodePingInterval(), 1000);
                    }
                  } else {
                    // Code doesn't match current wallet, clear it
                    setActivatedNodeType(null);
                    setActivationCode(null);
                  }
                }
              });
            } else {
              // If we can't verify, show the code (backward compatibility)
              setActivatedNodeType(nodeType);
              setActivationCode(code.code || code);
              // Start ping interval for active node
              if (!global.nodePingInterval) {
                setTimeout(() => startNodePingInterval(), 1000);
              }
            }
          } else {
            // No codes found, ensure state is cleared
            setActivatedNodeType(null);
            setActivationCode(null);
          }
        } catch (error) {
          // console.error('Error checking activation status:', error);
          // On error, clear activation status
          setActivatedNodeType(null);
          setActivationCode(null);
        }
      } else {
        // No wallet or password, clear activation status
        setActivatedNodeType(null);
        setActivationCode(null);
      }
    };
    
    checkActivationStatus();
  }, [wallet, password]);

  // Sync activation codes when app comes to foreground (battery-friendly)
  useEffect(() => {
    const handleAppStateChange = async (nextAppState) => {
      // Only sync when coming back to active from background
      if (nextAppState === 'active' && wallet && wallet.publicKey && password) {
        try {
          // Get mnemonic securely from encrypted storage
          const mnemonic = await walletManager.getEncryptedMnemonic(password);
          if (!mnemonic) return;
          
          // Silent sync in background - no loading indicators
          const syncedCodes = await walletManager.syncActivationCodes(
            wallet.publicKey,
            mnemonic,
            password
          );
          
          if (syncedCodes && Object.keys(syncedCodes).length > 0) {
            const nodeType = Object.keys(syncedCodes)[0];
            const code = syncedCodes[nodeType];
            setActivatedNodeType(nodeType);
            setActivationCode(code.code || code);
          }
        } catch (error) {
          // Silent fail - don't interrupt user
        }
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    
    return () => {
      subscription.remove();
    };
  }, [wallet, password]);


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
      
      // Clear previous wallet's activation data
      setActivatedNodeType(null);
      setActivationCode(null);
      setNodeRewards(null);
      setNodePseudonym('');
      setNodeStatus(null); // Reset node selection
      
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
      
      // Store wallet in background (non-blocking) - async PBKDF2 won't block UI
      walletManager.storeWallet(imported, password).then(async () => {
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
              const code = syncedCodes[nodeType];
              setActivatedNodeType(nodeType);
              setActivationCode(code.code || code);
              
              // Regenerate pseudonym for imported wallet (deterministic based on wallet address)
              const regeneratedPseudonym = await walletManager.generateLightNodePseudonym(imported.address);
              setNodePseudonym(regeneratedPseudonym);
              
              // Save regenerated pseudonym to AsyncStorage
              await AsyncStorage.setItem(`node_pseudonym_${code.code || code}`, regeneratedPseudonym);
              
              // Save to AsyncStorage for persistence across app restarts
              await AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
                nodeType: nodeType,
                code: code.code || code,
                pseudonym: regeneratedPseudonym,
                timestamp: Date.now()
              }));
            }
          }
        } catch (error) {
          // Silent fail - activation sync is not critical
          console.log('Activation sync failed:', error.message);
        }
      }).catch(error => {
        // If save fails, show error but keep wallet in memory
        showAlert('Warning', 'Wallet imported but not saved: ' + error.message);
      });
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
    
    // All words correct, save wallet
    // Optimized: Set UI state immediately, save in background
    setWallet(tempWallet);
    setHasWallet(true);
    setShowSeedConfirm(false);
    // Keep password in state for subsequent operations (like node activation)
    // setPassword(''); // DON'T clear password
    setConfirmPassword('');
    setSeedConfirmWords({});
    // Clear activation status for new wallet
    setActivatedNodeType(null);
    setActivationCode(null);
    setNodeRewards(null);
    setNodePseudonym('');
    setNodeStatus(null); // Reset node selection
    
    // Clear stored activation data from AsyncStorage
    AsyncStorage.removeItem('qnet_activation_codes');
    AsyncStorage.removeItem('qnet_activation_meta_light');
    AsyncStorage.removeItem('qnet_activation_meta_full');
    AsyncStorage.removeItem('qnet_activation_meta_super');
    AsyncStorage.removeItem('qnet_last_activated_node');
    AsyncStorage.removeItem(`blockchain_check_${tempWallet.publicKey}`);
    
    // Switch to assets tab immediately
    setActiveTab('assets');
    loadBalance(tempWallet.publicKey);
    
    // Save wallet in background (non-blocking) - async PBKDF2 won't block UI
    walletManager.storeWallet(tempWallet, tempWallet.password).then(() => {
      setTempWallet(null);
    }).catch(error => {
      // If save fails, revert UI state
      showAlert('Error', 'Failed to save wallet: ' + (error.message || 'Unknown error'));
      setWallet(null);
      setHasWallet(false);
    });
  };

  const unlockWallet = async () => {
    if (!password) {
      setUnlockError(translations[language].incorrect_password);
      setTimeout(() => setUnlockError(''), 3000);
      return;
    }
    
    // Quick password check first (fast)
    const isValid = await walletManager.verifyPassword(password);
    if (!isValid) {
      setUnlockError(translations[language].incorrect_password);
      setTimeout(() => setUnlockError(''), 3000);
      return;
    }

    // Optimized: Set UI state immediately, decrypt in background
    setShowSplash(false); // Hide splash immediately
    
    // Load wallet asynchronously
    walletManager.loadWallet(password).then(loadedWallet => {
      setWallet(loadedWallet);
      
      // Load balance in parallel
      loadBalance(loadedWallet.publicKey);
      
      // Restore activation state from AsyncStorage immediately
      AsyncStorage.getItem('qnet_last_activated_node').then(async savedState => {
        if (savedState) {
          try {
            const state = JSON.parse(savedState);
            if (state.nodeType && state.code) {
              setActivatedNodeType(state.nodeType);
              setActivationCode(state.code);
              if (state.pseudonym) {
                setNodePseudonym(state.pseudonym);
              } else {
                // Try to load pseudonym from separate storage
                const savedPseudonym = await AsyncStorage.getItem(`node_pseudonym_${state.code}`);
                if (savedPseudonym) {
                  setNodePseudonym(savedPseudonym);
                }
              }
            }
          } catch (e) {
            // Silent fail
          }
        }
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
            const code = syncedCodes[nodeType];
            setActivatedNodeType(nodeType);
            setActivationCode(code.code || code);
            
            // Try to load pseudonym
            const savedPseudonym = await AsyncStorage.getItem(`node_pseudonym_${code.code || code}`);
            if (savedPseudonym) {
              setNodePseudonym(savedPseudonym);
            }
            
            // Save to AsyncStorage for quick restore
            await AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
              nodeType: nodeType,
              code: code.code || code,
              pseudonym: savedPseudonym || undefined,
              timestamp: Date.now()
            }));
          }
        }).catch(() => {
          // Silent fail
        });
      }, 100);
    }).catch(error => {
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
                  setNodeStatus(null); // Reset node selection
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

  const loadBalance = async (publicKey) => {
    try {
      // Get current wallet reference (might be set after initial call)
      const currentWallet = wallet || await walletManager.getCurrentWallet();
      
      // Load balances in parallel for better performance
      const [bal, oneDevBalance] = await Promise.all([
        walletManager.getBalance(publicKey, isTestnet),
        walletManager.getTokenBalance(
          currentWallet?.solanaAddress || currentWallet?.address || publicKey,
          isTestnet 
        ? '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ'  // Testnet/Devnet
            : '4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump', // Mainnet (pump.fun)
          isTestnet
        )
      ]);
      
      setBalance(bal);
      
      // For QNC, we'll need the actual mint address when deployed
      // For now, set to 0 as it's not yet deployed
      const qncBalance = 0;
      
      // Update all balances
      setTokenBalances({
        qnc: qncBalance,
        sol: bal,
        '1dev': oneDevBalance
      });
      
      // Fetch real token prices (always mainnet prices as requested)
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

  const fetchTokenPrices = async () => {
    // Set fallback prices immediately
    setTokenPrices({
      qnc: 0.0125,
      sol: 150.00,
      '1dev': 0.0001
    });
    
    // Then try to fetch real prices in background
    setTimeout(async () => {
    try {
      // Only fetch prices if wallet is loaded
      if (!wallet) return;
        
        // Helper function to fetch with timeout (1 second)
        const fetchWithTimeout = async (url, timeout = 1000) => {
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
      
      // Fetch real prices from CoinGecko API
        const prices = { qnc: 0.0125, sol: 150.00, '1dev': 0.0001 };
      
        // Fetch SOL price with timeout
      try {
          const solResponse = await fetchWithTimeout('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
        if (solResponse.ok) {
          const solData = await solResponse.json();
            prices.sol = solData.solana?.usd || 150.00;
            setTokenPrices(prev => ({ ...prev, sol: prices.sol }));
        }
      } catch (e) {
          // Silently fail, use fallback
        }
        
        // Fetch 1DEV price (if available) with timeout
        try {
          const devResponse = await fetchWithTimeout('https://api.coingecko.com/api/v3/simple/price?ids=1dev&vs_currencies=usd');
        if (devResponse.ok) {
          const devData = await devResponse.json();
          prices['1dev'] = devData['1dev']?.usd || 0.0001;
            setTokenPrices(prev => ({ ...prev, '1dev': prices['1dev'] }));
        }
      } catch (e) {
          // Silently fail, use fallback
      }
    } catch (error) {
        // Silently fail, fallback prices already set
      }
    }, 100); // Small delay to not block UI
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
          
          // Try to load existing or generate new
          let code = await walletManager.loadActivationCode('full', password);
          if (!code) {
            code = walletManager.generateActivationCode('full', walletData.address);
            await walletManager.storeActivationCode(code, 'full', password);
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
        // Show existing codes
        const codesList = Object.entries(storedCodes)
          .map(([type, data]) => `${type.toUpperCase()} Node:\n${data.code || data}\n`)
          .join('\n');
      
      setShowExportActivation(false);
      setExportPassword('');
      
      showAlert(
          'Activation Codes',
          codesList,
          [
            { text: 'Copy All', onPress: () => {
              const plainCodes = Object.entries(storedCodes)
                .map(([type, data]) => data.code || data)
                .join('\n');
              Clipboard.setString(plainCodes);
              showAlert('Copied', 'Activation codes copied to clipboard');
              // Clear sensitive data from clipboard after 10 seconds
              setTimeout(() => {
                Clipboard.setString('');
              }, 10000);
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
      
      showAlert('Success', 'Password changed successfully!');
      setShowChangePassword(false);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
    } catch (error) {
      showAlert('Error', 'Failed to change password: ' + error.message);
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
              await AsyncStorage.removeItem('qnet_wallet');
              await AsyncStorage.removeItem('qnet_wallet_address');
              setWallet(null);
              setHasWallet(false);
              setActivatedNodeType(null);
              setActivationCode(null);
              setNodeStatus(null); // Reset node selection
              
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
  if (showSeedConfirm && tempWallet) {
    const words = tempWallet.mnemonic.split(' ');
    const positions = Object.keys(seedConfirmWords).map(Number).sort((a, b) => a - b);
    
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView 
          contentContainerStyle={styles.centerContent}
          showsVerticalScrollIndicator={true}
          bounces={true}
          scrollEnabled={true}
        >
          <Text style={styles.title}>Confirm Your Recovery Phrase</Text>
          <Text style={styles.subtitle}>
            Please enter the following words from your recovery phrase to confirm you've saved it correctly
          </Text>
          
          {positions.map(pos => (
            <View key={pos} style={styles.formGroup}>
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
            contentContainerStyle={styles.centerContent}
            showsVerticalScrollIndicator={true}
            bounces={true}
            scrollEnabled={true}
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
            contentContainerStyle={[styles.centerContent, {paddingBottom: 100}]}
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
              contentContainerStyle={styles.centerContent}
              showsVerticalScrollIndicator={true}
              bounces={true}
              scrollEnabled={true}
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
              contentContainerStyle={styles.centerContent}
              showsVerticalScrollIndicator={true}
              bounces={true}
              scrollEnabled={true}
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
    return (
      <SafeAreaView 
        style={[styles.container, Platform.OS === 'ios' && {paddingTop: 44}]} 
        edges={Platform.OS === 'ios' ? ['left', 'right'] : ['top', 'left', 'right']}
      >
        <View style={styles.centerContent}>
          <Text style={styles.title}>QNet Wallet</Text>
          <Text style={styles.subtitle}>Unlock your wallet</Text>
          
          <TextInput
            style={styles.input}
            placeholder="Enter password"
            placeholderTextColor="#888"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />
          
          <TouchableOpacity 
            style={styles.button}
            onPress={unlockWallet}
            disabled={loading}
          >
            <Text style={styles.buttonText}>
              {loading ? 'Unlocking...' : 'Unlock Wallet'}
            </Text>
          </TouchableOpacity>
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
        return (
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
                {/* QNC Token */}
                <View style={styles.tokenItem}>
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
                    <Text style={styles.tokenAmount}>{tokenBalances.qnc.toFixed(4)}</Text>
                  </View>
                </View>
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
                    <Text style={styles.tokenAmount}>{balance.toFixed(4)}</Text>
                    <Text style={styles.tokenValue}>${(balance * tokenPrices.sol).toFixed(2)}</Text>
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
                    <Text style={styles.tokenAmount}>{tokenBalances['1dev'].toFixed(4)}</Text>
                    <Text style={styles.tokenValue}>${(tokenBalances['1dev'] * tokenPrices['1dev']).toFixed(2)}</Text>
                  </View>
                </View>
              </View>
            )}

          </ScrollView>
        );

      case 'send':
        return (
          <ScrollView 
            style={styles.content} 
            contentContainerStyle={styles.scrollContentContainer}
            onScroll={handleUserActivity} 
            scrollEventThrottle={500}
            showsVerticalScrollIndicator={true}
            bounces={true}
            scrollEnabled={true}
          >
            <Text style={styles.tabTitle}>Send Tokens</Text>
            
            <View style={styles.formGroup}>
              <Text style={styles.label}>To Address</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter recipient address"
                placeholderTextColor="#888"
                value={sendAddress}
                onChangeText={setSendAddress}
              />
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Amount</Text>
              <View style={styles.amountInputGroup}>
                <TextInput
                  style={[styles.input, styles.amountInput]}
                  placeholder="0.00"
                  placeholderTextColor="#888"
                  keyboardType="numeric"
                  value={sendAmount}
                  onChangeText={setSendAmount}
                />
                <View style={styles.tokenSelector}>
                  <TouchableOpacity 
                    style={[styles.tokenButton, selectedToken === 'qnc' && styles.tokenButtonActive]}
                    onPress={() => setSelectedToken('qnc')}
                  >
                    <Text style={[styles.tokenButtonText, selectedToken === 'qnc' && styles.tokenButtonTextActive]}>QNC</Text>
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={[styles.tokenButton, selectedToken === 'sol' && styles.tokenButtonActive]}
                    onPress={() => setSelectedToken('sol')}
                  >
                    <Text style={[styles.tokenButtonText, selectedToken === 'sol' && styles.tokenButtonTextActive]}>SOL</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Network Fee</Text>
              <Text style={styles.feeText}>
                {selectedToken === 'qnc' ? 'Free' : '~0.00025 SOL'}
              </Text>
            </View>

            <TouchableOpacity 
              style={styles.button}
              onPress={() => {
                if (!sendAddress || !sendAmount) {
                  showAlert('Error', 'Please enter address and amount');
                  return;
                }
                showAlert('Send', 'Transaction functionality coming soon');
              }}
            >
              <Text style={styles.buttonText}>Send Transaction</Text>
            </TouchableOpacity>
          </ScrollView>
        );

      case 'receive':
        const currentReceiveAddress = selectedNetwork === 'qnet' 
          ? (wallet.qnetAddress || wallet.address)
          : (wallet.solanaAddress || wallet.address);
        
        return (
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
        );

      case 'activate':
        return (
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
                
                {nodeStatus === 'full' && (
                  <View style={[styles.warningBox, {backgroundColor: 'rgba(255, 170, 0, 0.1)', borderColor: 'rgba(255, 170, 0, 0.3)'}]}>
                    <Text style={[styles.warningText, {color: '#ffaa00'}]}>
                      ⚠️ Full nodes require server activation after code generation
                    </Text>
                   
                  </View>
                )}
                
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
                      : 'Mobile node for smartphones.'}
                  </Text>
                </View>
                <Text style={styles.nodeTypePrice}>
                  {activatedNodeType === 'light' ? 'CODE RECEIVED' : 
                   activationPricing ? 
                   `${activationPricing.cost} ${activationPricing.currency}` : 
                   '...'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={[
                  styles.nodeTypeCard, 
                  nodeStatus === 'full' && !activatedNodeType && styles.nodeTypeActive,
                  activatedNodeType === 'full' && styles.nodeTypeActivated
                ]}
                onPress={() => !activatedNodeType && setNodeStatus('full')}
                disabled={Boolean(activatedNodeType)}
              >
                <View style={styles.nodeTypeInfo}>
                  <Text style={styles.nodeTypeName}>
                    Full Node
                  </Text>
                  <Text style={styles.nodeTypeDesc}>
                    {activatedNodeType === 'full' 
                      ? 'Code received • Ready to use'
                      : 'Server node with full validation.'}
                  </Text>
                </View>
                <Text style={styles.nodeTypePrice}>
                  {activatedNodeType === 'full' ? 'CODE RECEIVED' :
                   activationPricing ? 
                   `${activationPricing.cost} ${activationPricing.currency}` : 
                   '...'}
                </Text>
              </TouchableOpacity>

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
                
                const nodeMessages = {
                  light: `Get ${nodeTypeName} Code\n\n• No token burn required\n• Instant code generation\n• Basic validation node`,
                  full: `Get ${nodeTypeName} Code\n\n• Server activation required\n• ${activationCost} burn required\n• Professional validator`,
                  super: `Get ${nodeTypeName} Code\n\n• Server activation required\n• ${activationCost} burn required\n• Enterprise grade node`
                };
                
                const warningMessage = nodeMessages[nodeStatus];
                
                // Node detailed specifications (like in browser extension)
                const nodeSpecs = {
                  light: {
                    platform: 'Mobile',
                    storage: '~100MB',
                    rewards: 'Pool 1',
                    uptime: 'Flexible',
                    role: 'Basic validation',
                    activation: '✓ Full activation in Mobile App'
                  },
                  full: {
                    platform: 'Server',
                    storage: '50-100GB',
                    rewards: '30% of fees',
                    uptime: '80% required',
                    role: 'Full validation',
                    activation: '⚠️ Requires server activation'
                  },
                  super: {
                    platform: 'High-end server',
                    storage: '2TB+',
                    rewards: '70% of fees',
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
                          // Check if already activated (prevent duplicates)
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
                          
                          // Also check blockchain to prevent concurrent activation attempts
                          const activatedNodes = await walletManager.checkBlockchainForActivations(wallet.publicKey);
                          if (activatedNodes && activatedNodes.length > 0) {
                            setActivatingNode(false);
                            Alert.alert(
                              'Already Activated',
                              'This wallet has a node activation on blockchain. Please wait for sync to complete.',
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
                          
                          // Fix floating point precision issue (0.01 might be 0.009999999)
                          const minSolRequired = 0.009; // Slightly less than 0.01 to account for precision
                          if (solBalance < minSolRequired) {
                            throw new Error(`Insufficient SOL for transaction fees.\nNeed at least 0.01 SOL, have: ${solBalance.toFixed(4)}`);
                          }
                          
                          const oneDevMint = isTestnet 
                            ? '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ'
                            : '4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump';
                          
                          const oneDevBalance = await walletManager.getTokenBalance(wallet.publicKey, oneDevMint, isTestnet);
                          const requiredAmount = activationPricing?.cost || 1500;
                          
                          if (oneDevBalance < requiredAmount) {
                            throw new Error(`Insufficient 1DEV tokens.\nNeed: ${requiredAmount} 1DEV\nHave: ${oneDevBalance} 1DEV`);
                          }
                          
                          if (nodeStatus === 'light') {
                            // Light Node - direct activation with burn
                            result = await walletManager.activateLightNode(wallet.publicKey, password);
                            code = result.activationCode;
                          } else {
                            // Full/Super nodes - also require burn BEFORE generating code
                            const burnResult = await walletManager.burnTokensForNode(
                              nodeStatus, 
                              requiredAmount, 
                              isTestnet, 
                              password
                            );
                            
                            if (!burnResult || !burnResult.signature) {
                              throw new Error('Failed to burn tokens for activation');
                            }
                            
                            // Only generate code AFTER successful burn
                            // Get mnemonic securely from encrypted storage
                            const mnemonic = await walletManager.getEncryptedMnemonic(password);
                            if (!mnemonic) {
                              throw new Error('Failed to retrieve seed phrase for code generation');
                            }
                            code = walletManager.generateActivationCode(nodeStatus, wallet.publicKey, mnemonic);
                            
                            // Store the code
                          await walletManager.storeActivationCode(code, nodeStatus, password);
                          
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
                            
                            // Create detailed activation message
                            const nodeTypeName = nodeStatus.charAt(0).toUpperCase() + nodeStatus.slice(1) + ' Node';
                            const contract = BURN_CONTRACT_PROGRAM_ID;
                            const transaction = result.signature || '2tY9K8hr...cJLuXFC3';
                            
                            // Different status messages based on node type
                            const burnedAmount = result.burned || requiredAmount;
                            const statusMessages = {
                              light: `Paid (${burnedAmount} 1DEV burned)`,
                              full: `Paid (${burnedAmount} 1DEV burned) • Server activation required`,
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
                                    style={{ backgroundColor: 'rgba(0, 212, 255, 0.1)', borderRadius: 8, padding: 8, marginBottom: 12 }}
                                  >
                                    <Text style={[styles.modalContent, { fontFamily: 'monospace', color: '#00d4ff', fontSize: 12, textAlign: 'center' }]}>
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
          </ScrollView>
        );

      case 'node':
        return (
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
          >
            <Text style={styles.tabTitle}>Node Monitoring</Text>
            
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
                      nodePseudonym 
                        ? ((activatedNodeType === 'light' && lightNodeStatus?.needsReactivation) ||
                           (activatedNodeType !== 'light' && serverNodeStatus?.success && !serverNodeStatus?.isOnline)
                            ? styles.statusBadgeInactive  // Red for inactive node
                            : styles.statusBadgeActivated)  // Green for active
                        : styles.statusBadgeActive  // Yellow for code received
                    ]}>
                      <Text style={[
                        styles.statusBadgeText, 
                        !nodePseudonym && styles.statusBadgeTextActive,
                        ((activatedNodeType === 'light' && lightNodeStatus?.needsReactivation) ||
                         (activatedNodeType !== 'light' && serverNodeStatus?.success && !serverNodeStatus?.isOnline)) && {color: '#ff3b30'}
                      ]}>
                        {!nodePseudonym 
                          ? 'CODE RECEIVED' 
                          : ((activatedNodeType === 'light' && lightNodeStatus?.needsReactivation) ||
                             (activatedNodeType !== 'light' && serverNodeStatus?.success && !serverNodeStatus?.isOnline))
                              ? 'OFFLINE' 
                              : 'ONLINE'}
                      </Text>
                    </View>
                  </View>
                  
                  {/* Action Button based on node type */}
                  {activatedNodeType === 'light' ? (
                    nodePseudonym ? (
                      <>
                        {/* Light Node Network Status */}
                        {lightNodeStatus?.needsReactivation ? (
                          <View style={[styles.serverActivationNotice, {backgroundColor: '#ff3b3020', borderColor: '#ff3b30'}]}>
                            <Text style={[styles.serverActivationText, {color: '#ff3b30'}]}>
                              ⚠️ Node Inactive - Missed {lightNodeStatus.consecutiveFailures || 0} pings
                            </Text>
                            <Text style={styles.serverActivationSubtext}>
                              Your node was offline and needs reactivation
                            </Text>
                          </View>
                        ) : lightNodeStatus?.isActive ? (
                          <View style={[styles.serverActivationNotice, {backgroundColor: '#34c75920', borderColor: '#34c759'}]}>
                            <Text style={[styles.serverActivationText, {color: '#34c759'}]}>
                              ✅ Node Active - Responding to pings
                            </Text>
                            <Text style={styles.serverActivationSubtext}>
                              Next ping: {lightNodeStatus.nextPingTime ? 
                                new Date(lightNodeStatus.nextPingTime * 1000).toLocaleTimeString() : 'Soon'}
                            </Text>
                          </View>
                        ) : null}
                        
                        {/* Reactivation Button - Only shown when needed */}
                        {lightNodeStatus?.needsReactivation ? (
                          <TouchableOpacity 
                            style={[styles.button, styles.primaryButton, reactivatingNode && styles.buttonDisabled]}
                            onPress={handleReactivateNode}
                            disabled={reactivatingNode}
                          >
                            <Text style={styles.buttonText}>
                              {reactivatingNode ? 'Reactivating...' : "🔄 I'm Back - Reactivate Node"}
                            </Text>
                          </TouchableOpacity>
                        ) : (
                          <TouchableOpacity 
                            style={[styles.button, styles.buttonDisabled]}
                            disabled={true}
                          >
                            <Text style={styles.buttonText}>
                              Activated
                            </Text>
                          </TouchableOpacity>
                        )}
                      </>
                    ) : (
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
                    )
                  ) : (
                    <>
                      {/* Server Node Status from Network */}
                      {serverNodeStatus?.success ? (
                        serverNodeStatus.isOnline ? (
                          <View style={[styles.serverActivationNotice, {backgroundColor: '#34c75920', borderColor: '#34c759'}]}>
                            <Text style={[styles.serverActivationText, {color: '#34c759'}]}>
                              ✅ Server Online - {serverNodeStatus.heartbeatCount}/{serverNodeStatus.requiredHeartbeats} heartbeats
                            </Text>
                            <Text style={styles.serverActivationSubtext}>
                              Reputation: {serverNodeStatus.reputation?.toFixed(1) || 'N/A'} • 
                              Block: {serverNodeStatus.currentBlockHeight || 'N/A'}
                            </Text>
                          </View>
                        ) : (
                          <View style={[styles.serverActivationNotice, {backgroundColor: '#ff3b3020', borderColor: '#ff3b30'}]}>
                            <Text style={[styles.serverActivationText, {color: '#ff3b30'}]}>
                              ⚠️ Server Offline - Last seen {Math.floor((serverNodeStatus.lastSeenAgoSeconds || 0) / 60)} min ago
                            </Text>
                            <Text style={styles.serverActivationSubtext}>
                              {serverNodeStatus.message || 'Check your server is running'}
                            </Text>
                          </View>
                        )
                      ) : (
                        <View style={styles.serverActivationNotice}>
                          <Text style={styles.serverActivationText}>
                            {activatedNodeType === 'full' ? 'Full' : 'Super'} nodes require server activation
                          </Text>
                          <Text style={styles.serverActivationSubtext}>
                            Use your activation code on a dedicated server
                          </Text>
                        </View>
                      )}
                    </>
                  )}
                </View>
                
                {/* Validator Status Section */}
                <View style={styles.rewardsCard}>
                  <Text style={styles.rewardsTitle}>Validator Status</Text>
                  
                  <View style={styles.rewardItem}>
                    <Text style={styles.rewardLabel}>Validator Node:</Text>
                    <Text style={[styles.rewardValue, {
                      color: !nodePseudonym 
                        ? '#ff3b30'  // Red - not activated
                        : (activatedNodeType === 'light' && lightNodeStatus?.needsReactivation)
                          ? '#ff9500'  // Orange - Light node needs reactivation
                          : (activatedNodeType !== 'light' && serverNodeStatus?.success && !serverNodeStatus?.isOnline)
                            ? '#ff3b30'  // Red - Server offline
                            : '#34c759'  // Green - active
                    }]}>
                      {!nodePseudonym 
                        ? 'Inactive' 
                        : (activatedNodeType === 'light' && lightNodeStatus?.needsReactivation)
                          ? 'Needs Reactivation'
                          : (activatedNodeType !== 'light' && serverNodeStatus?.success && !serverNodeStatus?.isOnline)
                            ? 'Server Offline'
                            : 'Active'}
                    </Text>
                  </View>
                  
                  {/* LIGHT NODES: Show local ping/reward tracking */}
                  {activatedNodeType === 'light' && (
                    <>
                      <View style={styles.rewardItem}>
                        <Text style={styles.rewardLabel}>Ping Responses:</Text>
                        <Text style={styles.rewardValue}>
                          {nodeRewards?.totalClaimed || 0} successful
                        </Text>
                      </View>
                      
                      <View style={styles.rewardItem}>
                        <Text style={styles.rewardLabel}>Pending Rewards:</Text>
                        <Text style={[styles.rewardValue, {color: (nodeRewards?.unclaimed || 0) > 0 ? '#34c759' : '#00d4ff'}]}>
                          {nodeRewards?.unclaimed || 0} pending
                        </Text>
                      </View>
                    </>
                  )}
                  
                  {/* SERVER NODES (Full/Super/Genesis): Show server-side data */}
                  {activatedNodeType !== 'light' && serverNodeStatus?.success && (
                    <>
                      <View style={styles.rewardItem}>
                        <Text style={styles.rewardLabel}>Heartbeats (4h window):</Text>
                        <Text style={[styles.rewardValue, {
                          color: serverNodeStatus.isRewardEligible ? '#34c759' : '#ff9500'
                        }]}>
                          {serverNodeStatus.heartbeatCount || 0}/{serverNodeStatus.requiredHeartbeats || 8} 
                          {serverNodeStatus.isRewardEligible ? ' ✓' : ' (need more)'}
                        </Text>
                      </View>
                      
                      <View style={styles.rewardItem}>
                        <Text style={styles.rewardLabel}>Reputation:</Text>
                        <Text style={[styles.rewardValue, {
                          color: (serverNodeStatus.reputation || 0) >= 70 ? '#34c759' : '#ff9500'
                        }]}>
                          {serverNodeStatus.reputation?.toFixed(1) || '0.0'}
                        </Text>
                      </View>
                      
                      <View style={styles.rewardItem}>
                        <Text style={styles.rewardLabel}>Pending Rewards:</Text>
                        <Text style={[styles.rewardValue, {
                          color: (serverNodeStatus.pendingRewards || 0) > 0 ? '#34c759' : '#00d4ff'
                        }]}>
                          {((serverNodeStatus.pendingRewards || 0) / 1e9).toFixed(4)} QNC
                        </Text>
                      </View>
                      
                      <View style={styles.rewardItem}>
                        <Text style={styles.rewardLabel}>Block Height:</Text>
                        <Text style={styles.rewardValue}>
                          {serverNodeStatus.currentBlockHeight?.toLocaleString() || 'N/A'}
                        </Text>
                      </View>
                    </>
                  )}
                  
                  {/* ALL NODES use Lazy Rewards - owner must claim */}
                  {/* LIGHT NODES: Use local nodeRewards tracking */}
                  {activatedNodeType === 'light' && (
                    <TouchableOpacity 
                      style={[
                        styles.button,
                        (!nodeRewards?.unclaimed || nodeRewards.unclaimed <= 0 || processingValidation) && styles.buttonDisabled
                      ]}
                      disabled={Boolean(!nodeRewards?.unclaimed || nodeRewards.unclaimed <= 0 || processingValidation)}
                      onPress={handleProcessValidation}
                    >
                      <Text style={styles.buttonText}>
                        {processingValidation ? 'Claiming...' : 
                         !nodeRewards?.unclaimed || nodeRewards.unclaimed <= 0 ? 'Claim Rewards' :
                         `Claim ${nodeRewards.unclaimed} Rewards`}
                      </Text>
                    </TouchableOpacity>
                  )}
                  
                  {/* SERVER NODES: Use serverNodeStatus.pendingRewards */}
                  {activatedNodeType !== 'light' && serverNodeStatus?.success && (
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
                         `Claim ${((serverNodeStatus.pendingRewards || 0) / 1e9).toFixed(4)} QNC`}
                      </Text>
                    </TouchableOpacity>
                  )}
                  
                  <TouchableOpacity 
                    style={[styles.button, styles.secondaryButton, {marginTop: 10}]}
                    onPress={() => {
                      // Open blockchain explorer
                      const explorerUrl = `https://explorer.aiqnet.io/validator/${walletAddress}`;
                      Linking.openURL(explorerUrl).catch(err => 
                        showAlert('Error', 'Unable to open blockchain explorer')
                      );
                    }}
                  >
                    <Text style={styles.buttonText}>
                      View on Explorer
                    </Text>
                  </TouchableOpacity>
                  
                  <Text style={styles.validatorNote}>
                    Validator activities are recorded on-chain. Process pending activities to finalize them on the blockchain. View complete history on explorer.
                  </Text>
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
        );

      case 'settings':
        return (
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
                  <Text style={styles.settingSubtitle}>Solana {isTestnet ? 'Testnet' : 'Mainnet'}</Text>
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
        
        <TouchableOpacity 
          style={[styles.tab, activeTab === 'send' && styles.activeTab]}
          onPress={() => {
            setActiveTab('send');
            setNodeStatus(null); // Reset node selection when leaving activate tab
          }}
        >
          <Text style={[styles.tabText, activeTab === 'send' && styles.activeTabText]}>Send</Text>
        </TouchableOpacity>
        
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
          style={[styles.tab, activeTab === 'node' && styles.activeTab]}
          onPress={() => {
            setActiveTab('node');
            setNodeStatus(null); // Reset node selection when leaving activate tab
          }}
        >
          <Text style={[styles.tabText, activeTab === 'node' && styles.activeTabText]}>Node</Text>
        </TouchableOpacity>

        <TouchableOpacity 
          style={[styles.tab, activeTab === 'settings' && styles.activeTab]}
          onPress={() => {
            setActiveTab('settings');
            setNodeStatus(null); // Reset node selection when leaving activate tab
          }}
        >
          <Text style={[styles.tabText, activeTab === 'settings' && styles.activeTabText]}>⚙️</Text>
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
    minWidth: '45%',
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
});

export default WalletScreen;
