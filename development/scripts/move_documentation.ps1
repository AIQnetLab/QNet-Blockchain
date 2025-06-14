# Скрипт для перемещения документации

# Основные документы в documentation/technical
$technicalDocs = @(
    "1DEV_COMPLETE_TRANSFORMATION_PLAN.md",
    "1DEV_TOKEN_CREATION_GUIDE.md",
    "ARCHITECTURE_ANALYSIS.md",
    "BLOCKCHAIN_COMPARISON.md",
    "COMPATIBILITY_RESTORATION_REPORT.md",
    "COMPLETE_ECONOMIC_MODEL_BACKUP.md",
    "COMPLETE_ECONOMIC_MODEL_V2.md",
    "COMPLETE_ECONOMIC_MODEL.md",
    "CONCEPTS_EXPLANATION.md",
    "DETAILED_MECHANICS_ANALYSIS.md",
    "DOCUMENTATION_UPDATE_REPORT.md",
    "DOCUMENTATION_UPDATE_SUMMARY.md",
    "DYNAMIC_NODE_BALANCING.md",
    "EDUCATIONAL_ECONOMIC_MODEL.md",
    "GITHUB_DEPLOYMENT_STRATEGY.md",
    "GITHUB_TRANSPARENCY_STRATEGY.md",
    "HYBRID_SMART_CONTRACTS_INTEGRATION_PLAN.md",
    "IMPLEMENTED_MECHANICS_SUMMARY.md",
    "MICROBLOCK_ARCHITECTURE_PLAN.md",
    "MICROBLOCK_IMPLEMENTATION_REPORT.md",
    "MOBILE_NODE_OPTIMIZATION.md",
    "NETWORK_LOAD_ANALYSIS.md",
    "NODE_ACTIVATION_ARCHITECTURE.md",
    "OPTIMIZATION_COMPLETE_SUMMARY.md",
    "P2P_ISSUE_RESOLVED.md",
    "P2P_NETWORK_MODES_GUIDE.md",
    "P2P_UNIFIED_ARCHITECTURE.md",
    "PING_RANDOMIZATION_STRATEGY.md",
    "POST_QUANTUM_PLAN.md",
    "PRODUCTION_OPTIMIZATION_COMPLETE.md",
    "PRODUCTION_READY_REPORT.md",
    "PYTHON_BINDINGS_REPORT.md",
    "QNET_BLOCKCHAIN_SYSTEM_AUDIT_2025.md",
    "QNET_COMPLETE_GUIDE.md",
    "QNET_PROJECT_OVERVIEW.md",
    "QNET_WALLET_SECURITY_AUDIT_2025.md",
    "QUICK_REFERENCE.md",
    "REPOSITORY_STRUCTURE.md",
    "SCALABILITY_ANALYSIS.md",
    "SCALABILITY_TO_10M_NODES.md",
    "SECURITY_AUDIT_REPORT.md",
    "SHARDING_IMPLEMENTATION_PLAN.md",
    "SMART_CONTRACTS_AND_DAPPS.md",
    "SMART_CONTRACTS_INTEGRATION_TASKS.md",
    "SOLANA_INTEGRATION.md",
    "SYSTEM_INTEGRATION_PERFECT.md",
    "TRANSACTION_FEE_DISTRIBUTION.md",
    "WALLET_DEVELOPMENT_PLAN.md",
    "WALLET_IMPLEMENTATION_STATUS.md",
    "WALLET_SECURITY_AUDIT.md"
)

# Требования для магазинов приложений в documentation/user-guides
$userGuideDocs = @(
    "app_store_requirements.md",
    "chrome_webstore_requirements.md",
    "play_market_requirements.md",
    "production_monitoring_setup.md"
)

# Перемещение технических документов
foreach ($doc in $technicalDocs) {
    if (Test-Path $doc) {
        Write-Host "Перемещаю $doc в documentation/technical..."
        Move-Item $doc "documentation\technical\" -Force
    }
}

# Перемещение пользовательских руководств
foreach ($doc in $userGuideDocs) {
    if (Test-Path $doc) {
        Write-Host "Перемещаю $doc в documentation/user-guides..."
        Move-Item $doc "documentation\user-guides\" -Force
    }
}

# Перемещение основных файлов
if (Test-Path "README.md") {
    Write-Host "Перемещаю README.md в documentation..."
    Move-Item "README.md" "documentation\" -Force
}

if (Test-Path "CHANGELOG.md") {
    Write-Host "Перемещаю CHANGELOG.md в documentation..."
    Move-Item "CHANGELOG.md" "documentation\" -Force
}

if (Test-Path "CONTRIBUTING.md") {
    Write-Host "Перемещаю CONTRIBUTING.md в documentation..."
    Move-Item "CONTRIBUTING.md" "documentation\" -Force
}

if (Test-Path "CONTRIBUTORS.md") {
    Write-Host "Перемещаю CONTRIBUTORS.md в documentation..."
    Move-Item "CONTRIBUTORS.md" "documentation\" -Force
}

if (Test-Path "LICENSE") {
    Write-Host "Перемещаю LICENSE в documentation..."
    Move-Item "LICENSE" "documentation\" -Force
}

Write-Host "Перемещение документации завершено!" 