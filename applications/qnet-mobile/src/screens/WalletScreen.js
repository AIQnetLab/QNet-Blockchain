import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ScrollView,
  Animated,
  Clipboard,
  Image,
  Platform,
  RefreshControl,
  TouchableWithoutFeedback,
  DeviceEventEmitter,
  Linking
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import WalletManager from '../components/WalletManager';

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
    history: 'History',
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
    history: '历史',
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
    history: 'История',
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
    history: 'Historial',
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
    history: '기록',
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
    history: '履歴',
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
    history: 'Histórico',
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
    history: 'Historique',
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
    history: 'Verlauf',
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
    history: 'السجل',
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
    history: 'Cronologia',
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
  const [selectedNetwork, setSelectedNetwork] = useState('qnet'); // 'qnet' or 'solana'
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
  const [tempWallet, setTempWallet] = useState(null);
  const [wordChoices, setWordChoices] = useState({});
  const [showSplash, setShowSplash] = useState(true);
  const spinValue = useRef(new Animated.Value(0)).current;
  const [customAlert, setCustomAlert] = useState(null); // {title, message, buttons}
  const [nodeStatus, setNodeStatus] = useState(null); // 'light', 'full', or 'super'
  const [copiedAddress, setCopiedAddress] = useState(''); // Track which address was copied
  const [burnProgress, setBurnProgress] = useState('0.0'); // Real burn progress from blockchain
  const [activatingNode, setActivatingNode] = useState(false); // For node activation loading state
  const [verificationError, setVerificationError] = useState(''); // Error message for seed verification
  const [activatedNodeType, setActivatedNodeType] = useState(null); // Track which node type is activated
  const [activationCode, setActivationCode] = useState(null); // Store the activation code

  // Helper function to show custom styled alerts
  const showAlert = (title, message, buttons = [{ text: 'OK', onPress: () => {} }]) => {
    setCustomAlert({ title, message, buttons });
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
      console.error('Failed to copy:', error);
    }
  };

  // Get token icon URL like in extension
  const getTokenIconUrl = (symbol) => {
    const icons = {
      // QNC - using QNet branding colors
      'QNC': 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIxNiIgY3k9IjE2IiByPSIxNiIgZmlsbD0iIzRhOTBlMiIvPjx0ZXh0IHg9IjE2IiB5PSIyMSIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXNpemU9IjE4IiBmb250LXdlaWdodD0iYm9sZCIgZmlsbD0id2hpdGUiIHRleHQtYW5jaG9yPSJtaWRkbGUiPlE8L3RleHQ+PC9zdmc+',
      // SOL - official Solana token
      'SOL': 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
      // 1DEV - from pump.fun/dexscreener
      '1DEV': 'https://dd.dexscreener.com/ds-data/tokens/solana/4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump.png',
      // USDC
      'USDC': 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png'
    };
    return icons[symbol.toUpperCase()] || null;
  };

  useEffect(() => {
    // Start rotation animation for splash spinner
    Animated.loop(
      Animated.timing(spinValue, {
        toValue: 1,
        duration: 1000,
        useNativeDriver: true,
      })
    ).start();
    
    // Show splash screen for 2 seconds (like browser extension)
    const splashTimer = setTimeout(() => {
      setShowSplash(false);
    }, 2000);
    
    checkWalletExists();
    loadSettings();
    
    return () => clearTimeout(splashTimer);
  }, []);

  // Load real burn progress when activation tab is selected
  useEffect(() => {
    if (activeTab === 'activate' && wallet) {
      loadBurnProgress();
    }
  }, [activeTab, isTestnet, wallet]);

  const loadBurnProgress = async () => {
    try {
      const progress = await walletManager.getBurnProgress(isTestnet);
      setBurnProgress(progress);
    } catch (error) {
      console.error('Failed to load burn progress:', error);
      setBurnProgress('0.0');
    }
  };

  // Translation function
  const t = (key) => {
    return translations[language]?.[key] || translations['en'][key] || key;
  };

  const loadSettings = async () => {
    try {
      const savedAutoLockTime = await AsyncStorage.getItem('qnet_autolock_time');
      if (savedAutoLockTime) {
        setAutoLockTime(savedAutoLockTime);
      }
      
      const savedLanguage = await AsyncStorage.getItem('qnet_language');
      if (savedLanguage) {
        setLanguage(savedLanguage);
      }
    } catch (error) {
      console.error('Error loading settings:', error);
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
          // Lock wallet
          setWallet(null);
          showAlert('Session Expired', 'Wallet locked due to inactivity');
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
      console.log('Loading balance for assets tab - network:', selectedNetwork, isTestnet ? 'testnet' : 'mainnet');
      loadBalance(wallet.publicKey);

      // Set up auto-refresh only for assets tab
      const balanceInterval = setInterval(() => {
        if (wallet && wallet.publicKey && activeTab === 'assets') {
          console.log('Auto-refresh balance (5s) - network:', selectedNetwork, isTestnet ? 'testnet' : 'mainnet');
          loadBalance(wallet.publicKey);
        }
      }, 5000); // Refresh every 5 seconds

      return () => {
        clearInterval(balanceInterval);
      };
    }
  }, [wallet, isTestnet, selectedNetwork, activeTab]); // Reload on any network or tab change

  // Check for existing activation codes when wallet is loaded
  useEffect(() => {
    const checkActivationStatus = async () => {
      if (wallet && wallet.address) {
        try {
          const storedCodes = await walletManager.getStoredActivationCodes();
          if (storedCodes && Object.keys(storedCodes).length > 0) {
            // Get the first (and should be only) activation code
            const nodeType = Object.keys(storedCodes)[0];
            const code = storedCodes[nodeType];
            setActivatedNodeType(nodeType);
            setActivationCode(code);
            console.log('Found existing activation:', nodeType, code);
          }
        } catch (error) {
          console.error('Error checking activation status:', error);
        }
      }
    };
    
    checkActivationStatus();
  }, [wallet]);

  const checkWalletExists = async () => {
    try {
      const exists = await walletManager.walletExists();
      setHasWallet(exists);
      
      // If wallet exists, try to validate it's not corrupted
      if (exists) {
        try {
          const vaultDataStr = await AsyncStorage.getItem('qnet_wallet');
          if (vaultDataStr) {
            JSON.parse(vaultDataStr); // Just check if it's valid JSON
          }
        } catch (parseError) {
          console.error('Wallet data appears corrupted:', parseError);
          // Don't auto-clear, let user decide when they try to unlock
        }
      }
      
      setLoading(false);
    } catch (error) {
      console.error('Error checking wallet:', error);
      setLoading(false);
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
    if (!validatePassword()) {
      return;
    }

    setLoading(true);
    try {
      const newWallet = await walletManager.generateWallet();
      
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
      showAlert('Error', 'Failed to create wallet: ' + error.message);
      setLoading(false);
    }
  };

  const importWallet = async () => {
    setPasswordError('');

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

    setLoading(true);
    try {
      const imported = await walletManager.importWallet(seedPhrase.trim());
      await walletManager.storeWallet(imported, password);
      
      setWallet(imported);
      setHasWallet(true);
      setShowCreateOptions(false);
      setPassword('');
      setConfirmPassword('');
      setSeedPhrase('');
      setImportStep(1); // Reset to step 1 for next time
      
      showAlert('Success', 'Wallet imported successfully!');
      // Force immediate balance load
      setTimeout(() => {
      loadBalance(imported.publicKey);
      }, 500);
    } catch (error) {
      showAlert('Error', 'Failed to import wallet: ' + error.message);
    }
    setLoading(false);
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
    setLoading(true);
    try {
      await walletManager.storeWallet(tempWallet, tempWallet.password);
      
      setWallet(tempWallet);
      setHasWallet(true);
      setShowSeedConfirm(false);
      setPassword('');
      setConfirmPassword('');
      setTempWallet(null);
      setSeedConfirmWords({});
      
      // Show both addresses like in extension
      const qnetAddr = tempWallet.qnetAddress || 'Generating...';
      const solanaAddr = tempWallet.solanaAddress || tempWallet.address;
      showAlert(
        'Wallet Created Successfully', 
        `Your QNet Wallet is ready to use.\n\nQNet Address:\n${qnetAddr}\n\nSolana Address:\n${solanaAddr}\n\nYou can now manage QNet and Solana assets securely.`
      );
      loadBalance(tempWallet.publicKey);
    } catch (error) {
      console.error('Error saving wallet:', error);
      showAlert('Error', 'Failed to save wallet: ' + (error.message || 'Unknown error'));
    } finally {
      setLoading(false);
    }
  };

  const unlockWallet = async () => {
    if (!password) {
      showAlert('Error', 'Please enter password');
      return;
    }

    setLoading(true);
    try {
      const loadedWallet = await walletManager.loadWallet(password);
      setWallet(loadedWallet);
      // Add a small delay to ensure wallet state is set
      setTimeout(() => {
      loadBalance(loadedWallet.publicKey);
      }, 100);
    } catch (error) {
      console.error('Wallet unlock error:', error);
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
                  showAlert('Success', 'Wallet data cleared. You can now create a new wallet or import an existing one.');
                } catch (clearError) {
                  console.error('Error clearing wallet:', clearError);
                  showAlert('Error', 'Failed to clear wallet data');
                }
              }
            }
          ]
        );
      } else {
        showAlert('Error', 'Wrong password');
      }
    }
    setLoading(false);
  };

  const loadBalance = async (publicKey) => {
    try {
      // Get current wallet reference (might be set after initial call)
      const currentWallet = wallet || await walletManager.getCurrentWallet();
      
      console.log('Loading balances for:', publicKey, 
                  'Selected Network:', selectedNetwork,
                  'Mode:', isTestnet ? 'Testnet' : 'Mainnet');
      
      // Always load SOL balance (used in both networks)
      const bal = await walletManager.getBalance(publicKey, isTestnet);
      console.log('SOL balance:', bal);
      setBalance(bal);
      
      // Get 1DEV token balance - use correct address based on network
      const oneDevMint = isTestnet 
        ? '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ'  // Testnet/Devnet
        : '4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump'; // Mainnet (pump.fun)
      
      // Use Solana address for token balance (not QNet address)
      const solanaAddr = currentWallet?.solanaAddress || currentWallet?.address || publicKey;
      const oneDevBalance = await walletManager.getTokenBalance(solanaAddr, oneDevMint, isTestnet);
      console.log('1DEV balance:', oneDevBalance);
      
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
      console.error('Error loading balance:', error);
      // Retry once after a delay if network error
      if (error.message && (error.message.includes('fetch') || error.message.includes('network'))) {
        console.log('Network error, retrying balance fetch in 2 seconds...');
        setTimeout(() => {
          if (wallet && wallet.publicKey) {
            loadBalance(wallet.publicKey);
          }
        }, 2000);
      }
    }
  };

  const fetchTokenPrices = async () => {
    try {
      // Only fetch prices if wallet is loaded
      if (!wallet) return;
      
      // Fetch real prices from CoinGecko API
      const prices = { qnc: 0, sol: 0, '1dev': 0 };
      
      // Fetch SOL price
      try {
        const solResponse = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
        if (solResponse.ok) {
          const solData = await solResponse.json();
          prices.sol = solData.solana?.usd || 0;
        }
      } catch (e) {
        console.log('Failed to fetch SOL price, trying backup...');
        // Try Binance as backup
        try {
          const binanceResponse = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
          if (binanceResponse.ok) {
            const binanceData = await binanceResponse.json();
            prices.sol = parseFloat(binanceData.price) || 0;
          }
        } catch (e2) {
          prices.sol = 150; // Fallback price
        }
      }
      
      // Fetch 1DEV price (if available)
      try {
        const devResponse = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=1dev&vs_currencies=usd');
        if (devResponse.ok) {
          const devData = await devResponse.json();
          prices['1dev'] = devData['1dev']?.usd || 0.0001;
        } else {
          prices['1dev'] = 0.0001; // Fallback for 1DEV
        }
      } catch (e) {
        prices['1dev'] = 0.0001; // Fallback price
      }
      
      // QNC price (not listed yet, using fixed price)
      prices.qnc = 0.0125;
      
      setTokenPrices(prices);
    } catch (error) {
      console.error('Error fetching prices:', error);
      // Set fallback prices
      setTokenPrices({
        qnc: 0.0125,
        sol: 150.00,
        '1dev': 0.0001
      });
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
      setLoading(true);
      
      let walletData;
      try {
        walletData = await walletManager.loadWallet(exportPassword);
      } catch (error) {
        setLoading(false);
        setExportPassword('');
        showAlert('Error', 'Incorrect password');
        return;
      }
      
      if (!walletData || !walletData.mnemonic) {
        setLoading(false);
        setExportPassword('');
        showAlert('Error', 'Incorrect password');
        return;
      }

      // Format seed phrase
      const words = walletData.mnemonic.split(' ');
      const formattedSeed = words.map((word, i) => `${i + 1}. ${word}`).join('\n');

      setShowExportSeed(false);
      setExportPassword('');
      
      showAlert(
        '⚠️ Recovery Phrase',
        `${formattedSeed}\n\n Keep it safe and never share!`,
        [
          { text: 'Copy', onPress: () => {
            Clipboard.setString(walletData.mnemonic);
            showAlert('📋 Copied', 'Recovery phrase copied to clipboard');
          }},
          { text: 'OK', style: 'default' }
        ]
      );
    } catch (error) {
      console.error('Export seed error:', error);
      showAlert('Error', 'Failed to export seed phrase');
    } finally {
      setLoading(false);
      setExportPassword('');
    }
  };

  const exportActivationCode = async () => {
    if (!exportPassword) {
      showAlert('Error', 'Please enter your password');
      return;
    }

    try {
      setLoading(true);
      
      // Verify password by trying to decrypt wallet
      let walletData;
      try {
        walletData = await walletManager.loadWallet(exportPassword);
      } catch (error) {
        setLoading(false);
        setExportPassword('');
        showAlert('Error', 'Incorrect password');
        return;
      }
      
      if (!walletData || !walletData.publicKey) {
        setLoading(false);
        setExportPassword('');
        showAlert('Error', 'Incorrect password');
        return;
      }

      // Get stored activation codes
      const storedCodes = await walletManager.getStoredActivationCodes(exportPassword);
      
      if (storedCodes && Object.keys(storedCodes).length > 0) {
        // Show existing codes
        const codesList = Object.entries(storedCodes)
          .map(([type, data]) => `${type.toUpperCase()} Node:\n${data.code}\n\nGenerated: ${new Date(data.timestamp).toLocaleString()}`)
          .join('\n\n');
      
      setShowExportActivation(false);
      setExportPassword('');
      
      showAlert(
          '🔑 Activation Codes',
          codesList,
          [
            { text: 'Copy All', onPress: () => {
              const plainCodes = Object.entries(storedCodes)
                .map(([type, data]) => data.code)
                .join('\n');
              Clipboard.setString(plainCodes);
              showAlert('📋 Copied', 'Activation codes copied to clipboard');
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
      console.error('Export activation error:', error);
      setLoading(false);
      setExportPassword('');
      showAlert('Error', 'Failed to get activation codes');
    } finally {
      setLoading(false);
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
    } finally {
      setLoading(false);
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
              showAlert('Success', 'Wallet deleted successfully');
            } catch (error) {
              showAlert('Error', 'Failed to delete wallet: ' + error.message);
            }
          }
        }
      ]
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centerContent}>
          <Text style={styles.title}>QNet Wallet</Text>
          <Text style={styles.subtitle}>Loading...</Text>
        </View>
      </SafeAreaView>
    );
  }

  // Splash screen with animated spinner (like browser extension)
  if (showSplash) {
    const spin = spinValue.interpolate({
      inputRange: [0, 1],
      outputRange: ['0deg', '360deg'],
    });
    
    return (
      <View style={styles.splashContainer}>
        <View style={styles.splashContent}>
          <View style={[styles.logoContainer, {overflow: 'hidden', borderRadius: 60}]}>
            {/* Outer rotating ring */}
            <Animated.View style={[styles.outerRing, { transform: [{ rotate: spin }] }]}>
              <View style={styles.outerRingGradient} />
            </Animated.View>
            {/* Inner static ring */}
            <View style={styles.innerRing}>
              <View style={styles.innerRingGradient} />
            </View>
            {/* Center Q letter */}
            <View style={styles.qLetterContainer}>
              <Text style={styles.qLetter}>Q</Text>
            </View>
          </View>
          <Text style={styles.splashTitle}>QNet Wallet</Text>
          <Text style={styles.splashSubtitle}>Loading...</Text>
        </View>
      </View>
    );
  }

  // Seed phrase confirmation screen
  if (showSeedConfirm && tempWallet) {
    const words = tempWallet.mnemonic.split(' ');
    const positions = Object.keys(seedConfirmWords).map(Number).sort((a, b) => a - b);
    
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.centerContent}>
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
            disabled={loading || !Object.values(seedConfirmWords).every(w => w.length > 0)}
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
        <SafeAreaView style={styles.container}>
          <View style={styles.centerContent}>
            <Text style={styles.title}>QNet Wallet</Text>
            <Text style={styles.subtitle}>Get started with QNet</Text>
            
            <TouchableOpacity 
              style={styles.button}
              onPress={() => setShowCreateOptions('create')}
            >
              <Text style={styles.buttonText}>Create New Wallet</Text>
            </TouchableOpacity>

            <TouchableOpacity 
              style={[styles.button, styles.secondaryButton]}
              onPress={() => setShowCreateOptions('import')}
            >
              <Text style={[styles.buttonText, styles.secondaryButtonText]}>Import Existing Wallet</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      );
    }

    if (showCreateOptions === 'create') {
      return (
        <SafeAreaView style={styles.container}>
          <ScrollView contentContainerStyle={styles.centerContent}>
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
            
            <TouchableOpacity 
              style={styles.button}
              onPress={createWallet}
              disabled={loading}
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
              }}
            >
              <Text style={[styles.buttonText, styles.secondaryButtonText]}>Back</Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      );
    }

    // Show seed phrase screen (beautiful grid like extension)
    if (showCreateOptions === 'show-seed' && tempWallet) {
      const words = tempWallet.mnemonic.split(' ');
      
      return (
        <SafeAreaView style={styles.container}>
          <ScrollView contentContainerStyle={styles.centerContent}>
            <Text style={styles.title}>IMPORTANT: Save Your Recovery Phrase</Text>
            <Text style={styles.subtitle}>
              Write down these 12 words in order. You'll need them to recover your wallet.
            </Text>
            
            <View style={styles.seedGrid}>
              {words.map((word, index) => (
                <View key={index} style={styles.seedWordContainer}>
                  <Text style={styles.seedWordNumber}>{index + 1}</Text>
                  <Text style={styles.seedWordText}>{word}</Text>
                </View>
              ))}
            </View>
            
            <TouchableOpacity 
              style={[styles.button, styles.secondaryButton]}
              onPress={() => {
                try {
                  // Copy seed phrase to clipboard
                  const seedText = words.join(' ');
                  Clipboard.setString(seedText);
                  showAlert('Copied', 'Recovery phrase copied to clipboard');
                } catch (error) {
                  showAlert('Error', 'Failed to copy to clipboard');
                }
              }}
            >
              <Text style={[styles.buttonText, styles.secondaryButtonText]}>Copy Recovery Phrase</Text>
            </TouchableOpacity>
            
            <Text style={styles.warningText}>
              ⚠️ Never share this with anyone!
            </Text>
            
            <TouchableOpacity 
              style={styles.button}
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
          <SafeAreaView style={styles.container}>
            <ScrollView contentContainerStyle={styles.centerContent}>
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
                  setImportStep(1);
                }}
              >
                <Text style={[styles.buttonText, styles.secondaryButtonText]}>Back</Text>
              </TouchableOpacity>
            </ScrollView>
          </SafeAreaView>
        );
      }

      // Step 2: Enter seed phrase
      if (importStep === 2) {
        return (
          <SafeAreaView style={styles.container}>
            <ScrollView contentContainerStyle={styles.centerContent}>
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
              
              <TouchableOpacity 
                style={styles.button}
                onPress={importWallet}
                disabled={loading}
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
                }}
              >
                <Text style={[styles.buttonText, styles.secondaryButtonText]}>Back</Text>
              </TouchableOpacity>
            </ScrollView>
          </SafeAreaView>
        );
      }
    }
  }

  if (!wallet) {
    return (
      <SafeAreaView style={styles.container}>
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
      </SafeAreaView>
    );
  }

  const renderTabContent = () => {
    switch(activeTab) {
      case 'assets':
        return (
          <ScrollView 
            style={styles.content}
            onScroll={handleUserActivity}
            scrollEventThrottle={1000}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={async () => {
                  setRefreshing(true);
                  try {
                    await loadBalance(wallet.publicKey);
                    await fetchTokenPrices();
                  } catch (error) {
                    console.error('Error refreshing:', error);
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
                    console.log('Switched to QNet, refreshing balance');
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
                    console.log('Switched to Solana, refreshing balance');
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
                      {getTokenIconUrl('QNC') ? (
                        <Image 
                          source={{uri: getTokenIconUrl('QNC')}} 
                          style={styles.tokenIconImage}
                          resizeMode="contain"
                        />
                      ) : (
                        <Text style={styles.tokenIconText}>Q</Text>
                      )}
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
          <ScrollView style={styles.content} onScroll={handleUserActivity} scrollEventThrottle={1000}>
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
        return (
          <ScrollView style={styles.content} onScroll={handleUserActivity} scrollEventThrottle={1000}>
            <Text style={styles.tabTitle}>Receive Tokens</Text>
            
            <View style={styles.receiveContent}>
              <View style={styles.qrPlaceholder}>
                <Text style={styles.qrText}>QR Code</Text>
                <Text style={styles.qrSubtext}>(Coming Soon)</Text>
              </View>

              <View style={styles.addressDisplay}>
                <Text style={styles.label}>
                  {selectedNetwork === 'qnet' ? 'Your QNet Address' : 'Your Solana Address'}
                </Text>
                <Text style={styles.addressDisplayText}>
                  {selectedNetwork === 'qnet' 
                    ? (wallet.qnetAddress || wallet.address)
                    : (wallet.solanaAddress || wallet.address)}
                </Text>
                <TouchableOpacity 
                  style={[styles.button, styles.secondaryButton]}
                  onPress={() => {
                    const currentAddress = selectedNetwork === 'qnet' 
                      ? (wallet.qnetAddress || wallet.address)
                      : (wallet.solanaAddress || wallet.address);
                    const addressType = selectedNetwork === 'qnet' ? 'qnet-receive' : 'solana-receive';
                    copyToClipboard(currentAddress, addressType);
                  }}
                >
                  <Text style={[styles.buttonText, styles.secondaryButtonText]}>
                    {copiedAddress.includes('receive') ? '✓ Copied!' : 'Copy Address'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        );

      case 'activate':
        return (
          <ScrollView style={styles.content} onScroll={handleUserActivity} scrollEventThrottle={1000}>
            <Text style={styles.tabTitle}>Node Activation</Text>
            
            {/* Phase Indicator */}
            <View style={styles.phaseCard}>
              <Text style={styles.phaseTitle}>Phase 1: 1DEV Burn Activation</Text>
              <Text style={styles.phaseSubtitle}>
                Burn 1500 1DEV to activate your node
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
                    <Text style={styles.warningText}>
                      ⚡ Mobile activation is available for Light Nodes only
                    </Text>
                    <Text style={styles.warningSubtext}>
                      Full and Super nodes must be activated on servers
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
                      ⚠️ Full nodes require server activation
                    </Text>
                    <Text style={styles.warningSubtext}>
                      Mobile can only generate activation code
                    </Text>
                  </View>
                )}
                
                {nodeStatus === 'super' && (
                  <View style={[styles.warningBox, {backgroundColor: 'rgba(255, 170, 0, 0.1)', borderColor: 'rgba(255, 170, 0, 0.3)'}]}>
                    <Text style={[styles.warningText, {color: '#ffaa00'}]}>
                      ⚠️ Super nodes require server activation
                    </Text>
                    <Text style={styles.warningSubtext}>
                      Mobile can only generate activation code
                    </Text>
                  </View>
                )}
              
              <TouchableOpacity 
                style={[
                  styles.nodeTypeCard, 
                  nodeStatus === 'light' && styles.nodeTypeActive,
                  activatedNodeType === 'light' && styles.nodeTypeActivated
                ]}
                onPress={() => !activatedNodeType && setNodeStatus('light')}
                disabled={!!activatedNodeType}
              >
                <View style={styles.nodeTypeInfo}>
                  <Text style={styles.nodeTypeName}>
                    Light Node (Mobile) {activatedNodeType === 'light' && '✅'}
                  </Text>
                  <Text style={styles.nodeTypeDesc}>
                    {activatedNodeType === 'light' 
                      ? `Activated • Code: ${activationCode?.substring(0, 8)}...`
                      : 'Basic validation, optimized for mobile devices'}
                  </Text>
                </View>
                <Text style={styles.nodeTypePrice}>
                  {activatedNodeType === 'light' ? 'ACTIVATED' : '1500 1DEV'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={[
                  styles.nodeTypeCard, 
                  nodeStatus === 'full' && styles.nodeTypeActive,
                  activatedNodeType === 'full' && styles.nodeTypeActivated
                ]}
                onPress={() => !activatedNodeType && setNodeStatus('full')}
                disabled={!!activatedNodeType}
              >
                <View style={styles.nodeTypeInfo}>
                  <Text style={styles.nodeTypeName}>
                    Full Node {activatedNodeType === 'full' && '✅'}
                  </Text>
                  <Text style={styles.nodeTypeDesc}>
                    {activatedNodeType === 'full' 
                      ? `Activated • Code: ${activationCode?.substring(0, 8)}...`
                      : 'Full validation, medium resources'}
                  </Text>
                </View>
                <Text style={styles.nodeTypePrice}>
                  {activatedNodeType === 'full' ? 'ACTIVATED' : '1500 1DEV'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={[
                  styles.nodeTypeCard, 
                  nodeStatus === 'super' && styles.nodeTypeActive,
                  activatedNodeType === 'super' && styles.nodeTypeActivated
                ]}
                onPress={() => !activatedNodeType && setNodeStatus('super')}
                disabled={!!activatedNodeType}
              >
                <View style={styles.nodeTypeInfo}>
                  <Text style={styles.nodeTypeName}>
                    Super Node {activatedNodeType === 'super' && '✅'}
                  </Text>
                  <Text style={styles.nodeTypeDesc}>
                    {activatedNodeType === 'super' 
                      ? `Activated • Code: ${activationCode?.substring(0, 8)}...`
                      : 'Maximum validation, high resources'}
                  </Text>
                </View>
                <Text style={styles.nodeTypePrice}>
                  {activatedNodeType === 'super' ? 'ACTIVATED' : '1500 1DEV'}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Activation Button */}
            {activatedNodeType && (
              <View style={styles.activationStatus}>
                <Text style={styles.activationStatusTitle}>
                  ✅ {activatedNodeType.charAt(0).toUpperCase() + activatedNodeType.slice(1)} Node Activated
                </Text>
                <Text style={styles.activationStatusCode}>
                  Code: {activationCode}
                </Text>
                <Text style={styles.activationStatusInfo}>
                  One wallet can only activate one node
                </Text>
              </View>
            )}
            
            
            <TouchableOpacity 
              style={[styles.button, (!nodeStatus || activatedNodeType || activatingNode) && styles.buttonDisabled]}
              disabled={!nodeStatus || activatedNodeType || activatingNode}
              onPress={async () => {
                if (!nodeStatus) {
                  showAlert('Select Node Type', 'Please select a node type to activate');
                  return;
                }
                
                if (activatedNodeType) {
                  showAlert('Already Activated', `This wallet has already activated a ${activatedNodeType} node. One wallet can only activate one node.`);
                  return;
                }
                
                // Show confirmation with appropriate warnings
                const nodeTypeName = nodeStatus.charAt(0).toUpperCase() + nodeStatus.slice(1) + ' Node';
                
                let warningMessage = `Burn 1500 1DEV to activate\n${nodeTypeName}`;
                if (nodeStatus === 'light') {
                  warningMessage += '\n\n✅ Light nodes can be fully activated on mobile';
                } else if (nodeStatus === 'full' || nodeStatus === 'super') {
                  warningMessage += `\n\n⚠️ IMPORTANT: ${nodeTypeName}s require server activation!\nMobile can only generate activation codes.`;
                }
                
                showAlert(
                  'Activate Node',
                  warningMessage,
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { 
                      text: 'Confirm', 
                      style: 'destructive',
                      onPress: async () => {
                        setActivatingNode(true);
                        try {
                          // Check 1DEV balance
                          if (tokenBalances['1dev'] < 1500) {
                            showAlert('Insufficient Balance', `You need 1500 1DEV to activate a node. Your balance: ${tokenBalances['1dev'].toFixed(2)} 1DEV`);
                            setActivatingNode(false);
                            return;
                          }
                          
                          // Burn tokens on blockchain
                          const burnResult = await walletManager.burnTokensForNode(nodeStatus, 1500, isTestnet, password);
                          
                          // Generate activation code (use Solana address for node activation)
                          const solanaAddr = wallet.solanaAddress || wallet.address;
                          const code = await walletManager.generateActivationCode(nodeStatus, solanaAddr);
                          await walletManager.storeActivationCode(code, nodeStatus, password);
                          
                          // Update balance after burning tokens
                          if (wallet && wallet.publicKey) {
                          await loadBalance(wallet.publicKey);
                          }
                          
                          // Update activation status
                          setActivatedNodeType(nodeStatus);
                          setActivationCode(code);
                          setNodeStatus(null); // Clear selection to show activated status
                          
                          // Show success with activation code (matching browser extension)
                          showAlert(
                            `✅ ${nodeTypeName} Activation Complete`,
                            `Activation Code:\n${code}\n\n` +
                            `Node Type: ${nodeTypeName}\n` +
                            `Status: ✅ Paid (1500 1DEV burned)\n` +
                            `Contract: ${isTestnet ? '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ' : '4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump'}\n\n` +
                            `Transaction: ${burnResult.txHash.substring(0, 8)}...${burnResult.txHash.slice(-8)}`,
                            [
                              { text: 'Copy Code', onPress: () => {
                                Clipboard.setString(code);
                                showAlert('Copied', 'Activation code copied to clipboard');
                              }},
                              { text: 'View Transaction', onPress: () => {
                                Linking.openURL(burnResult.explorer);
                              }},
                              { text: 'OK' }
                            ]
                          );
                        } catch (error) {
                          showAlert('Error', 'Failed to activate node: ' + error.message);
                        } finally {
                          setActivatingNode(false);
                        }
                      }
                    }
                  ]
                );
              }}
            >
              <Text style={styles.buttonText}>
                {activatingNode 
                  ? 'Processing Transaction...' 
                  : activatedNodeType 
                  ? 'Already Activated' 
                  : 'Get Activation Code'}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        );

      case 'history':
        return (
          <ScrollView style={styles.content} onScroll={handleUserActivity} scrollEventThrottle={1000}>
            <Text style={styles.tabTitle}>Node Monitoring</Text>
            
            {activatedNodeType ? (
              <View>
                {/* Node Status Card */}
                <View style={styles.nodeMonitoringCard}>
                  <View style={styles.nodeMonitoringHeader}>
                    <Text style={styles.nodeMonitoringTitle}>
                      {activatedNodeType.charAt(0).toUpperCase() + activatedNodeType.slice(1)} Node
                    </Text>
                    <View style={[styles.statusBadge, styles.statusBadgeActive]}>
                      <Text style={styles.statusBadgeText}>ACTIVE</Text>
                    </View>
                  </View>
                  
                  <View style={styles.nodeMonitoringInfo}>
                    <Text style={styles.nodeMonitoringLabel}>Activation Code:</Text>
                    <Text style={styles.nodeMonitoringCode}>{activationCode}</Text>
                  </View>
                  
                  <View style={styles.nodeMonitoringInfo}>
                    <Text style={styles.nodeMonitoringLabel}>Activation Type:</Text>
                    <Text style={styles.nodeMonitoringValue}>Phase 1: 1DEV Burn</Text>
                  </View>
                  
                  <View style={styles.nodeMonitoringInfo}>
                    <Text style={styles.nodeMonitoringLabel}>Burned Amount:</Text>
                    <Text style={styles.nodeMonitoringValue}>1500 1DEV</Text>
                  </View>
                  
                  {/* Action Button based on node type */}
                  {activatedNodeType === 'light' ? (
                    <TouchableOpacity 
                      style={[styles.button, styles.secondaryButton]}
                      onPress={() => {
                        showAlert(
                          'Mobile Activation',
                          'Light node activation is coming soon!\n\nYour activation code is ready and will be automatically used when this feature is enabled.',
                          [{ text: 'OK' }]
                        );
                      }}
                    >
                      <Text style={[styles.buttonText, styles.secondaryButtonText]}>
                        Activate Node (Coming Soon)
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <View style={styles.serverActivationNotice}>
                      <Text style={styles.serverActivationIcon}>⚠️</Text>
                      <Text style={styles.serverActivationText}>
                        {activatedNodeType === 'full' ? 'Full' : 'Super'} nodes require server activation
                      </Text>
                      <Text style={styles.serverActivationSubtext}>
                        Use your activation code on a dedicated server
                      </Text>
                    </View>
                  )}
                </View>
                
                {/* Rewards Section */}
                <View style={styles.rewardsCard}>
                  <Text style={styles.rewardsTitle}>Node Rewards</Text>
                  
                  <View style={styles.rewardItem}>
                    <Text style={styles.rewardLabel}>Daily Rewards:</Text>
                    <Text style={styles.rewardValue}>0.00 QNC</Text>
                  </View>
                  
                  <View style={styles.rewardItem}>
                    <Text style={styles.rewardLabel}>Total Earned:</Text>
                    <Text style={styles.rewardValue}>0.00 QNC</Text>
                  </View>
                  
                  <View style={styles.rewardItem}>
                    <Text style={styles.rewardLabel}>Pending Claim:</Text>
                    <Text style={styles.rewardValue}>0.00 QNC</Text>
                  </View>
                  
                  <TouchableOpacity 
                    style={[styles.button, styles.buttonDisabled]}
                    disabled={true}
                  >
                    <Text style={styles.buttonText}>
                      Claim Rewards (No Rewards Yet)
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
            <View style={styles.emptyState}>
                <Text style={styles.emptyText}>No active nodes</Text>
                <Text style={styles.emptySubtext}>
                  You need to activate a node to start earning rewards
                </Text>
                
                <TouchableOpacity
                  style={[styles.button, styles.primaryButton, { marginTop: 20 }]}
                  onPress={() => {
                    setActiveTab('activate');
                  }}
                >
                  <Text style={styles.buttonText}>
                    Activate Node
                  </Text>
                </TouchableOpacity>
            </View>
            )}
          </ScrollView>
        );

      case 'settings':
        return (
          <ScrollView style={styles.content} onScroll={handleUserActivity} scrollEventThrottle={1000}>
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

            {/* Security Settings */}
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
                <Text style={styles.actionButtonText}>{t('export_activation_code')}</Text>
              </TouchableOpacity>
            </View>

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
                        setWallet(null);
                        setHasWallet(false);
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

  // Function to emit user activity
  const handleUserActivity = () => {
    DeviceEventEmitter.emit('userActivity');
  };

  return (
    <TouchableWithoutFeedback onPress={handleUserActivity}>
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>QNet Wallet</Text>
      </View>

      {/* Tab Navigation */}
      <View style={styles.tabNav}>
        <TouchableOpacity 
          style={[styles.tab, activeTab === 'assets' && styles.activeTab]}
          onPress={() => {
            setActiveTab('assets');
            // Immediate balance refresh when switching to assets
            if (wallet && wallet.publicKey) {
              console.log('User switched to assets tab, refreshing balance');
              loadBalance(wallet.publicKey);
            }
          }}
        >
          <Text style={[styles.tabText, activeTab === 'assets' && styles.activeTabText]}>Assets</Text>
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={[styles.tab, activeTab === 'send' && styles.activeTab]}
          onPress={() => setActiveTab('send')}
        >
          <Text style={[styles.tabText, activeTab === 'send' && styles.activeTabText]}>Send</Text>
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={[styles.tab, activeTab === 'receive' && styles.activeTab]}
          onPress={() => setActiveTab('receive')}
        >
          <Text style={[styles.tabText, activeTab === 'receive' && styles.activeTabText]}>Receive</Text>
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={[styles.tab, activeTab === 'activate' && styles.activeTab]}
          onPress={() => setActiveTab('activate')}
        >
          <Text style={[styles.tabText, activeTab === 'activate' && styles.activeTabText]}>Activate</Text>
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={[styles.tab, activeTab === 'history' && styles.activeTab]}
          onPress={() => setActiveTab('history')}
        >
          <Text style={[styles.tabText, activeTab === 'history' && styles.activeTabText]}>Node</Text>
        </TouchableOpacity>

        <TouchableOpacity 
          style={[styles.tab, activeTab === 'settings' && styles.activeTab]}
          onPress={() => setActiveTab('settings')}
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
            <Text style={styles.modalTitle}>⚠️ {t('export_recovery_phrase')}</Text>
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
            <Text style={styles.modalTitle}>🔑 {t('export_activation_code')}</Text>
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
            
            <ScrollView style={{maxHeight: 400}} onScroll={handleUserActivity} scrollEventThrottle={1000}>
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
                {customAlert.title.includes('Success') && '✅ '}
                {customAlert.title.includes('Error') && '❌ '}
                {customAlert.title.includes('Warning') || customAlert.title.includes('⚠️') ? '⚠️ ' : ''}
                {customAlert.title.includes('Activation') || customAlert.title.includes('🔑') ? '🔑 ' : ''}
                {customAlert.title.includes('Recovery') || customAlert.title.includes('⚠️ Recovery') ? '🔐 ' : ''}
                {customAlert.title.includes('Copied') || customAlert.title.includes('📋') ? '📋 ' : ''}
                {customAlert.title}
              </Text>
            </View>
            
            {/* Modal Content */}
            <Text style={styles.modalContent}>
              {customAlert.message}
            </Text>
            
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
    </TouchableWithoutFeedback>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f1a', // Same as splash screen for smooth transition
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
    paddingVertical: 12,
    alignItems: 'center',
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
  },
  activeTabText: {
    color: '#00d4ff',
  },
  tabContentContainer: {
    flex: 1,
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
    width: '100%',
    maxWidth: 400,
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
    fontSize: 15,
    lineHeight: 22,
    paddingHorizontal: 24,
    paddingVertical: 20,
    textAlign: 'center',
  },
  modalActions: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 24,
    paddingBottom: 24,
    paddingTop: 8,
  },
  modalButton: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  modalButtonPrimary: {
    backgroundColor: '#00d4ff',
    shadowColor: '#00d4ff',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  modalButtonSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.5)',
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
  splashContainer: {
    flex: 1,
    backgroundColor: '#0f0f1a', // --bg-primary from extension
    justifyContent: 'center',
    alignItems: 'center',
  },
  splashContent: {
    alignItems: 'center',
  },
  logoContainer: {
    width: 120,
    height: 120,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  outerRing: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 3,
    borderColor: 'transparent',
    borderTopColor: '#00d4ff',
    borderRightColor: '#00d4ff',
    elevation: 0,
  },
  outerRingGradient: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    borderRadius: 60,
    borderWidth: 3,
    borderColor: 'rgba(0, 212, 255, 0.2)',
  },
  innerRing: {
    position: 'absolute',
    width: 90,
    height: 90,
    borderRadius: 45,
    borderWidth: 2,
    borderColor: '#6B46C1',
    backgroundColor: 'rgba(107, 70, 193, 0.1)',
    elevation: 0,
  },
  innerRingGradient: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    borderRadius: 45,
    borderWidth: 2,
    borderColor: 'rgba(107, 70, 193, 0.3)',
  },
  qLetterContainer: {
    width: 70,
    height: 70,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0f0f1a',
    borderRadius: 35,
    elevation: 0,
  },
  qLetter: {
    fontSize: 48,
    fontWeight: '900',
    color: '#00d4ff',
    textAlign: 'center',
    letterSpacing: 2,
  },
  splashTitle: {
    fontSize: 24,
    fontWeight: '600',
    color: '#00d4ff', // --qnet-primary
    marginTop: 8,
    marginBottom: 8,
  },
  splashSubtitle: {
    fontSize: 14,
    color: '#888', // --text-secondary
  },
  seedGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    width: '100%',
    marginVertical: 20,
  },
  seedWordContainer: {
    width: '48%',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(22, 33, 62, 0.8)',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
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
    padding: 15,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.2)',
  },
  nodeTypeActive: {
    borderColor: '#00d4ff',
    backgroundColor: 'rgba(0, 212, 255, 0.1)',
  },
  nodeTypeActivated: {
    borderColor: '#00ff7f',
    backgroundColor: 'rgba(0, 255, 127, 0.05)',
    opacity: 0.9,
  },
  nodeTypeInfo: {
    flex: 1,
  },
  nodeTypeName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
    marginBottom: 4,
  },
  nodeTypeDesc: {
    fontSize: 12,
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
    alignItems: 'center',
    marginBottom: 20,
  },
  nodeMonitoringTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#ffffff',
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusBadgeActive: {
    backgroundColor: 'rgba(0, 255, 127, 0.2)',
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#00ff7f',
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
    color: '#ffffff',
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
});

export default WalletScreen;
