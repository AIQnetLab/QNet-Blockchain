#!/bin/bash

# QNet Mobile - Build Tools Installation Script
# Installs React Native CLI, Android SDK, and iOS build tools

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

# Detect OS
detect_os() {
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        OS="linux"
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        OS="macos"
    elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
        OS="windows"
    else
        log_error "Unsupported operating system: $OSTYPE"
        exit 1
    fi
    
    log_info "Detected OS: $OS"
}

# Install Node.js and npm
install_nodejs() {
    log_step "Installing Node.js and npm..."
    
    if command -v node >/dev/null 2>&1; then
        node_version=$(node --version)
        log_info "Node.js already installed: $node_version"
        
        if [[ "$node_version" < "v18" ]]; then
            log_warn "Node.js version is older than recommended (18+)"
        fi
    else
        case $OS in
            "linux")
                curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
                sudo apt-get install -y nodejs
                ;;
            "macos")
                if command -v brew >/dev/null 2>&1; then
                    brew install node
                else
                    log_error "Homebrew not installed. Please install Node.js manually from nodejs.org"
                    exit 1
                fi
                ;;
            "windows")
                log_warn "Please install Node.js manually from https://nodejs.org"
                log_warn "Then run this script again"
                exit 1
                ;;
        esac
        
        log_info "✅ Node.js installed successfully"
    fi
}

# Install React Native CLI
install_react_native_cli() {
    log_step "Installing React Native CLI..."
    
    if command -v react-native >/dev/null 2>&1; then
        rn_version=$(npx react-native --version)
        log_info "React Native CLI already installed: $rn_version"
    else
        npm install -g @react-native-community/cli
        log_info "✅ React Native CLI installed successfully"
    fi
}

# Install Android development tools
install_android_tools() {
    log_step "Installing Android development tools..."
    
    case $OS in
        "linux")
            # Install Java JDK
            sudo apt-get update
            sudo apt-get install -y openjdk-11-jdk
            
            # Install Android Studio dependencies
            sudo apt-get install -y libc6:i386 libncurses5:i386 libstdc++6:i386 lib32z1 libbz2-1.0:i386
            
            log_info "📱 Download Android Studio from: https://developer.android.com/studio"
            log_info "📱 Or use Android SDK command line tools"
            ;;
        "macos")
            # Install Java JDK
            if command -v brew >/dev/null 2>&1; then
                brew install --cask adoptopenjdk11
                log_info "✅ Java JDK 11 installed"
            fi
            
            log_info "📱 Download Android Studio from: https://developer.android.com/studio"
            ;;
        "windows")
            log_info "📱 Install Android Studio from: https://developer.android.com/studio"
            log_info "📱 Make sure to install Android SDK and configure ANDROID_HOME"
            ;;
    esac
    
    echo
    echo "🔧 Android Studio Setup Instructions:"
    echo "1. Download and install Android Studio"
    echo "2. Open Android Studio and go to SDK Manager"
    echo "3. Install Android SDK Platform 33 (API 33)"
    echo "4. Install Android SDK Build-Tools 33.0.0"
    echo "5. Install Android Emulator (optional)"
    echo "6. Add ANDROID_HOME to your environment variables"
    echo
}

# Install iOS development tools (macOS only)
install_ios_tools() {
    if [[ "$OS" != "macos" ]]; then
        log_warn "iOS development requires macOS. Skipping iOS tools installation."
        return
    fi
    
    log_step "Installing iOS development tools..."
    
    # Check if Xcode is installed
    if xcode-select -p >/dev/null 2>&1; then
        log_info "✅ Xcode command line tools already installed"
    else
        log_info "Installing Xcode command line tools..."
        xcode-select --install
    fi
    
    # Install CocoaPods
    if command -v pod >/dev/null 2>&1; then
        pod_version=$(pod --version)
        log_info "CocoaPods already installed: $pod_version"
    else
        log_info "Installing CocoaPods..."
        sudo gem install cocoapods
        log_info "✅ CocoaPods installed successfully"
    fi
    
    echo
    echo "🍎 iOS Development Setup:"
    echo "1. Install Xcode from App Store (required for iOS builds)"
    echo "2. Open Xcode and accept license agreements"
    echo "3. Install iOS Simulator if needed"
    echo
}

# Set up environment variables
setup_environment() {
    log_step "Setting up environment variables..."
    
    case $OS in
        "linux"|"macos")
            shell_profile=""
            if [[ "$SHELL" == *"zsh"* ]]; then
                shell_profile="$HOME/.zshrc"
            elif [[ "$SHELL" == *"bash"* ]]; then
                shell_profile="$HOME/.bashrc"
            else
                shell_profile="$HOME/.profile"
            fi
            
            if [[ ! -f "$shell_profile" ]]; then
                touch "$shell_profile"
            fi
            
            # Android environment variables
            if ! grep -q "ANDROID_HOME" "$shell_profile"; then
                echo "" >> "$shell_profile"
                echo "# Android development environment" >> "$shell_profile"
                echo "export ANDROID_HOME=\$HOME/Android/Sdk" >> "$shell_profile"
                echo "export PATH=\$PATH:\$ANDROID_HOME/emulator" >> "$shell_profile"
                echo "export PATH=\$PATH:\$ANDROID_HOME/tools" >> "$shell_profile"
                echo "export PATH=\$PATH:\$ANDROID_HOME/tools/bin" >> "$shell_profile"
                echo "export PATH=\$PATH:\$ANDROID_HOME/platform-tools" >> "$shell_profile"
                
                log_info "✅ Android environment variables added to $shell_profile"
                log_warn "Please restart your terminal or run: source $shell_profile"
            else
                log_info "Android environment variables already configured"
            fi
            ;;
        "windows")
            echo "🪟 Windows Environment Setup:"
            echo "1. Add ANDROID_HOME to system environment variables"
            echo "2. Add %ANDROID_HOME%\\platform-tools to PATH"
            echo "3. Add %ANDROID_HOME%\\tools to PATH"
            echo "4. Restart command prompt after setting variables"
            ;;
    esac
}

# Install project dependencies
install_project_dependencies() {
    log_step "Installing QNet Mobile project dependencies..."
    
    if [[ -f "package.json" ]]; then
        npm install
        log_info "✅ Project dependencies installed"
    else
        log_warn "package.json not found. Run this script from QNet mobile project directory."
    fi
    
    # iOS dependencies (macOS only)
    if [[ "$OS" == "macos" ]] && [[ -d "ios" ]]; then
        log_info "Installing iOS dependencies..."
        cd ios && pod install && cd ..
        log_info "✅ iOS dependencies installed"
    fi
}

# Verify installation
verify_installation() {
    log_step "Verifying installation..."
    
    echo "📋 Build Tools Status:"
    echo "======================"
    
    # Node.js
    if command -v node >/dev/null 2>&1; then
        echo "✅ Node.js: $(node --version)"
    else
        echo "❌ Node.js: Not installed"
    fi
    
    # npm
    if command -v npm >/dev/null 2>&1; then
        echo "✅ npm: $(npm --version)"
    else
        echo "❌ npm: Not installed"
    fi
    
    # React Native CLI
    if command -v react-native >/dev/null 2>&1; then
        echo "✅ React Native CLI: Available"
    else
        echo "❌ React Native CLI: Not installed"
    fi
    
    # Java
    if command -v java >/dev/null 2>&1; then
        echo "✅ Java: $(java -version 2>&1 | head -n1)"
    else
        echo "❌ Java: Not installed"
    fi
    
    # Android
    if [[ -n "$ANDROID_HOME" ]] && [[ -d "$ANDROID_HOME" ]]; then
        echo "✅ Android SDK: $ANDROID_HOME"
    else
        echo "❌ Android SDK: Not configured"
    fi
    
    # iOS tools (macOS only)
    if [[ "$OS" == "macos" ]]; then
        if xcode-select -p >/dev/null 2>&1; then
            echo "✅ Xcode: $(xcode-select -p)"
        else
            echo "❌ Xcode: Not installed"
        fi
        
        if command -v pod >/dev/null 2>&1; then
            echo "✅ CocoaPods: $(pod --version)"
        else
            echo "❌ CocoaPods: Not installed"
        fi
    fi
    
    echo
}

# Generate build commands
generate_build_commands() {
    log_step "Generating build commands..."
    
    cat > build-commands.sh << 'EOF'
#!/bin/bash

# QNet Mobile Build Commands
# Run these commands to build APK/IPA

echo "🚀 QNet Mobile Build Commands"
echo "============================="

# Android APK
echo "📱 To build Android APK:"
echo "  cd android"
echo "  ./gradlew assembleRelease"
echo "  # APK location: android/app/build/outputs/apk/release/app-release.apk"
echo

# Android AAB (Play Store)
echo "📦 To build Android AAB (Play Store):"
echo "  cd android"
echo "  ./gradlew bundleRelease"
echo "  # AAB location: android/app/build/outputs/bundle/release/app-release.aab"
echo

# iOS IPA (macOS only)
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "🍎 To build iOS IPA:"
    echo "  cd ios"
    echo "  pod install"
    echo "  xcodebuild -workspace QNetMobile.xcworkspace -scheme QNetMobile -configuration Release -destination generic/platform=iOS -archivePath build/QNetMobile.xcarchive archive"
    echo "  # Then export IPA using Xcode or xcodebuild -exportArchive"
    echo
fi

# Automated build script
echo "🤖 Or use the automated build script:"
echo "  node scripts/build-production.js --android-only"
echo "  node scripts/build-production.js --ios-only"
echo "  node scripts/build-production.js  # Both platforms"
EOF
    
    chmod +x build-commands.sh
    log_info "✅ Build commands saved to build-commands.sh"
}

# Main function
main() {
    echo "🛠️  QNet Mobile - Build Tools Installation"
    echo "=========================================="
    echo
    
    detect_os
    install_nodejs
    install_react_native_cli
    install_android_tools
    install_ios_tools
    setup_environment
    install_project_dependencies
    verify_installation
    generate_build_commands
    
    echo
    echo "🎉 Build Tools Installation Complete!"
    echo "====================================="
    echo
    echo "Next steps:"
    echo "1. Restart your terminal (to load environment variables)"
    echo "2. Install Android Studio and configure Android SDK"
    if [[ "$OS" == "macos" ]]; then
        echo "3. Install Xcode from App Store (for iOS builds)"
    fi
    echo "4. Run ./build-commands.sh to see available build commands"
    echo "5. Run: node scripts/build-production.js to build APK/IPA"
    echo
    log_info "Build tools installation completed successfully!"
}

# Run main function
main "$@" 