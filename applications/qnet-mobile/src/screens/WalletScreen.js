import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ScrollView,
  SafeAreaView
} from 'react-native';
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
  const [loading, setLoading] = useState(true);
  const [showCreateOptions, setShowCreateOptions] = useState(false);
  const [seedPhrase, setSeedPhrase] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [activeTab, setActiveTab] = useState('assets');
  const [sendAddress, setSendAddress] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [selectedToken, setSelectedToken] = useState('sol');
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

  useEffect(() => {
    checkWalletExists();
    loadSettings();
  }, []);

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
      Alert.alert(t('error'), 'Failed to save setting');
    }
  };

  const saveLanguage = async (lang) => {
    try {
      await AsyncStorage.setItem('qnet_language', lang);
      setLanguage(lang);
    } catch (error) {
      Alert.alert(t('error'), 'Failed to save language');
    }
  };

  // Auto-lock timer
  useEffect(() => {
    if (wallet && hasWallet) {
      // Reset timer on any activity
      const resetTimer = () => {
        setLastActivityTime(Date.now());
      };

      // Start auto-lock check
      const checkAutoLock = setInterval(() => {
        const now = Date.now();
        const inactiveTime = now - lastActivityTime;
        const lockTimeMs = parseInt(autoLockTime) * 60 * 1000; // Convert minutes to ms

        if (inactiveTime >= lockTimeMs && autoLockTime !== 'never') {
          // Lock wallet
          setWallet(null);
          Alert.alert('Session Expired', 'Wallet locked due to inactivity');
        }
      }, 10000); // Check every 10 seconds

      setAutoLockTimer(checkAutoLock);

      return () => {
        clearInterval(checkAutoLock);
      };
    }
  }, [wallet, hasWallet, lastActivityTime, autoLockTime]);

  const checkWalletExists = async () => {
    try {
      const exists = await walletManager.walletExists();
      setHasWallet(exists);
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
      await walletManager.storeWallet(newWallet, password);
      
      setWallet(newWallet);
      setHasWallet(true);
      setShowCreateOptions(false);
      setPassword('');
      setConfirmPassword('');
      
      // Show seed phrase in a better format
      const words = newWallet.mnemonic.split(' ');
      const formattedSeed = words.map((word, i) => `${i + 1}. ${word}`).join('\n');
      
      Alert.alert(
        'Wallet Created Successfully!', 
        `Your wallet address:\n${newWallet.address.substring(0, 20)}...\n\n⚠️ IMPORTANT: Write down your seed phrase!\n\n${formattedSeed}\n\n⚠️ Keep it safe and never share it with anyone!`,
        [{ text: 'I Saved It' }]
      );
      
      loadBalance(newWallet.publicKey);
    } catch (error) {
      Alert.alert('Error', 'Failed to create wallet: ' + error.message);
    }
    setLoading(false);
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
      
      Alert.alert('Success', 'Wallet imported successfully!');
      loadBalance(imported.publicKey);
    } catch (error) {
      Alert.alert('Error', 'Failed to import wallet: ' + error.message);
    }
    setLoading(false);
  };

  const unlockWallet = async () => {
    if (!password) {
      Alert.alert('Error', 'Please enter password');
      return;
    }

    setLoading(true);
    try {
      const loadedWallet = await walletManager.loadWallet(password);
      setWallet(loadedWallet);
      loadBalance(loadedWallet.publicKey);
    } catch (error) {
      Alert.alert('Error', 'Wrong password or corrupted wallet');
    }
    setLoading(false);
  };

  const loadBalance = async (publicKey) => {
    try {
      const bal = await walletManager.getBalance(publicKey);
      setBalance(bal);
    } catch (error) {
      console.error('Error loading balance:', error);
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
            Alert.alert('Error', 'Incorrect password');
            return;
          }
          
          // Try to load existing or generate new
          let code = await walletManager.loadActivationCode('full', password);
          if (!code) {
            code = walletManager.generateActivationCode('full', walletData.address);
            await walletManager.storeActivationCode(code, 'full', password);
          }
          
          Alert.alert(
            'Node Activation Code',
            code,
            [
              { text: 'OK' }
            ]
          );
        } catch (error) {
          Alert.alert('Error', 'Failed to generate activation code');
        }
      },
      'secure-text'
    );
  };

  const exportSeedPhrase = async () => {
    if (!exportPassword) {
      Alert.alert('Error', 'Please enter your password');
      return;
    }

    try {
      setLoading(true);
      const walletData = await walletManager.loadWallet(exportPassword);
      
      if (!walletData || !walletData.mnemonic) {
        Alert.alert('Error', 'Incorrect password or wallet data corrupted');
        setLoading(false);
        return;
      }

      // Format seed phrase
      const words = walletData.mnemonic.split(' ');
      const formattedSeed = words.map((word, i) => `${i + 1}. ${word}`).join('\n');

      setShowExportSeed(false);
      setExportPassword('');
      
      Alert.alert(
        '⚠️ Recovery Phrase',
        `${formattedSeed}\n\n⚠️ Keep it safe and never share!`,
        [
          { text: 'I Saved It', style: 'default' }
        ]
      );
    } catch (error) {
      Alert.alert('Error', 'Incorrect password');
    } finally {
      setLoading(false);
    }
  };

  const exportActivationCode = async () => {
    if (!exportPassword) {
      Alert.alert('Error', 'Please enter your password');
      return;
    }

    try {
      setLoading(true);
      
      // Verify password by trying to decrypt wallet
      const walletData = await walletManager.loadWallet(exportPassword);
      
      if (!walletData || !walletData.publicKey) {
        Alert.alert('Error', 'Incorrect password');
        setLoading(false);
        setExportPassword('');
        return;
      }

      // Try to load existing activation code first
      let code = await walletManager.loadActivationCode('full', exportPassword);
      
      if (!code) {
        // Generate new secure activation code if none exists
        code = walletManager.generateActivationCode('full', walletData.address);
        // Store it encrypted
        await walletManager.storeActivationCode(code, 'full', exportPassword);
      }
      
      setShowExportActivation(false);
      setExportPassword('');
      
      Alert.alert(
        '🔑 Activation Code',
        `${code}\n\n🔑 Keep this code secure!`,
        [
          { text: 'I Saved It', style: 'default' }
        ]
      );
    } catch (error) {
      console.error('Error verifying password:', error);
      Alert.alert('Error', 'Incorrect password');
      setExportPassword('');
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = async () => {
    if (!newPassword || newPassword.length < 8) {
      Alert.alert('Error', 'New password must be at least 8 characters');
      return;
    }

    if (newPassword !== confirmNewPassword) {
      Alert.alert('Error', 'New passwords do not match');
      return;
    }

    try {
      setLoading(true);
      
      // Verify current password by trying to unlock wallet
      const walletData = await walletManager.loadWallet(currentPassword);
      if (!walletData) {
        Alert.alert('Error', 'Current password is incorrect');
        setLoading(false);
        return;
      }

      // Re-encrypt wallet with new password
      await walletManager.storeWallet(walletData, newPassword);
      
      Alert.alert('Success', 'Password changed successfully!');
      setShowChangePassword(false);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
    } catch (error) {
      Alert.alert('Error', 'Failed to change password: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const deleteWallet = async () => {
    Alert.alert(
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
              Alert.alert('Success', 'Wallet deleted successfully');
            } catch (error) {
              Alert.alert('Error', 'Failed to delete wallet: ' + error.message);
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
          <ScrollView style={styles.content}>
            <View style={styles.balanceCard}>
              <Text style={styles.balanceLabel}>Balance</Text>
              <Text style={styles.balanceAmount}>{balance.toFixed(4)} SOL</Text>
            </View>

            <View style={styles.addressCard}>
              <Text style={styles.addressLabel}>Address</Text>
              <Text style={styles.addressText}>
                {wallet.address.substring(0, 20)}...{wallet.address.substring(wallet.address.length - 10)}
              </Text>
            </View>

            <TouchableOpacity 
              style={[styles.actionButton, styles.refreshButton]}
              onPress={() => loadBalance(wallet.publicKey)}
            >
              <Text style={styles.actionButtonText}>Refresh Balance</Text>
            </TouchableOpacity>
          </ScrollView>
        );

      case 'send':
        return (
          <ScrollView style={styles.content}>
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
                  Alert.alert('Error', 'Please enter address and amount');
                  return;
                }
                Alert.alert('Send', 'Transaction functionality coming soon');
              }}
            >
              <Text style={styles.buttonText}>Send Transaction</Text>
            </TouchableOpacity>
          </ScrollView>
        );

      case 'receive':
        return (
          <ScrollView style={styles.content}>
            <Text style={styles.tabTitle}>Receive Tokens</Text>
            
            <View style={styles.receiveContent}>
              <View style={styles.qrPlaceholder}>
                <Text style={styles.qrText}>QR Code</Text>
                <Text style={styles.qrSubtext}>(Coming Soon)</Text>
              </View>

              <View style={styles.addressDisplay}>
                <Text style={styles.label}>Your Address</Text>
                <Text style={styles.addressDisplayText}>{wallet.address}</Text>
                <TouchableOpacity 
                  style={[styles.button, styles.secondaryButton]}
                  onPress={() => Alert.alert('Copied', 'Address copied to clipboard')}
                >
                  <Text style={[styles.buttonText, styles.secondaryButtonText]}>Copy Address</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        );

      case 'activate':
        return (
          <ScrollView style={styles.content}>
            <Text style={styles.tabTitle}>Node Activation</Text>
            
            <View style={styles.activateCard}>
              <Text style={styles.phaseText}>Phase 1: 1DEV Burn Activation</Text>
              <Text style={styles.statusText}>Status: Not Active</Text>
            </View>

            <TouchableOpacity 
              style={styles.actionButton}
              onPress={generateActivationCode}
            >
              <Text style={styles.actionButtonText}>Generate Activation Code</Text>
            </TouchableOpacity>
          </ScrollView>
        );

      case 'history':
        return (
          <ScrollView style={styles.content}>
            <Text style={styles.tabTitle}>Transaction History</Text>
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No transactions yet</Text>
            </View>
          </ScrollView>
        );

      case 'settings':
        return (
          <ScrollView style={styles.content}>
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
                  <Text style={styles.settingSubtitle}>Solana Mainnet</Text>
                </View>
              </View>
            </View>

            {/* Danger Zone */}
            <View style={styles.settingGroup}>
              <Text style={[styles.settingGroupTitle, {color: '#ff4444'}]}>{t('danger_zone')}</Text>
              
              <TouchableOpacity 
                style={[styles.actionButton, {backgroundColor: '#16213e', borderColor: '#ff4444'}]}
                onPress={() => {
                  Alert.alert(
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

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>QNet Wallet</Text>
      </View>

      {/* Tab Navigation */}
      <View style={styles.tabNav}>
        <TouchableOpacity 
          style={[styles.tab, activeTab === 'assets' && styles.activeTab]}
          onPress={() => setActiveTab('assets')}
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
          <Text style={[styles.tabText, activeTab === 'history' && styles.activeTabText]}>History</Text>
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
                style={[styles.button, styles.secondaryButton]}
                onPress={() => {
                  setShowChangePassword(false);
                  setCurrentPassword('');
                  setNewPassword('');
                  setConfirmNewPassword('');
                }}
              >
                <Text style={[styles.buttonText, styles.secondaryButtonText]}>{t('cancel')}</Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={styles.button}
                onPress={handleChangePassword}
                disabled={loading}
              >
                <Text style={styles.buttonText}>{loading ? t('changing') : t('change')}</Text>
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
                style={[styles.button, styles.secondaryButton]}
                onPress={() => {
                  setShowExportSeed(false);
                  setExportPassword('');
                }}
              >
                <Text style={[styles.buttonText, styles.secondaryButtonText]}>{t('cancel')}</Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={styles.button}
                onPress={exportSeedPhrase}
                disabled={loading}
              >
                <Text style={styles.buttonText}>{loading ? t('verifying') : t('show')}</Text>
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
                style={[styles.button, styles.secondaryButton]}
                onPress={() => {
                  setShowExportActivation(false);
                  setExportPassword('');
                }}
              >
                <Text style={[styles.buttonText, styles.secondaryButtonText]}>{t('cancel')}</Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={styles.button}
                onPress={exportActivationCode}
                disabled={loading}
              >
                <Text style={styles.buttonText}>{loading ? t('verifying') : t('show')}</Text>
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
            
            <ScrollView style={{maxHeight: 400}}>
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
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  centerContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
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
    backgroundColor: '#16213e',
    borderRadius: 10,
    paddingHorizontal: 15,
    color: '#ffffff',
    fontSize: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#00d4ff',
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
    backgroundColor: '#16213e',
    borderWidth: 1,
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
  refreshButton: {
    backgroundColor: '#0f3460',
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
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalBox: {
    backgroundColor: '#16213e',
    borderRadius: 15,
    padding: 20,
    width: '100%',
    maxWidth: 400,
    borderWidth: 1,
    borderColor: '#00d4ff',
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#00d4ff',
    marginBottom: 20,
    textAlign: 'center',
  },
  modalActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
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
});

export default WalletScreen;
