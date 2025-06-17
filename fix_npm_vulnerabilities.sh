#!/bin/bash

echo "=== QNet NPM Security Fix ==="
echo "Исправление уязвимостей в зависимостях..."

# Переходим в директорию приложения
cd /var/www/qnet/applications/qnet-explorer/frontend

# Создаем резервную копию package-lock.json
echo "1. Создание резервной копии..."
cp package-lock.json package-lock.json.backup
cp package.json package.json.backup

# Проверяем текущие уязвимости
echo "2. Проверка текущих уязвимостей..."
npm audit --audit-level=high

# Пытаемся автоматически исправить уязвимости
echo "3. Автоматическое исправление..."
npm audit fix

# Если автоматическое исправление не помогло, принудительно обновляем
echo "4. Принудительное обновление критических пакетов..."
npm audit fix --force

# Проверяем результат
echo "5. Проверка результата..."
npm audit --audit-level=high

# Перестраиваем приложение
echo "6. Пересборка приложения..."
npm run build

# Перезапускаем сервис
echo "7. Перезапуск сервиса..."
systemctl restart qnet-explorer

echo "=== NPM Security Fix Complete ==="
echo "Проверьте статус приложения:"
echo "systemctl status qnet-explorer"
echo "curl -I https://aiqnet.io" 