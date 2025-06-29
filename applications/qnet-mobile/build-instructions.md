# QNet Mobile - Production Build Instructions

## Prerequisites

### Android Build
```bash
# Install Android Studio and Android SDK
# Install React Native CLI
npm install -g @react-native-community/cli

# Install dependencies
npm install

# Create release keystore
keytool -genkeypair -v -storetype PKCS12 -keystore qnet-release-key.keystore -alias qnet-release -keyalg RSA -keysize 2048 -validity 10000

# Build production APK
cd android
./gradlew assembleRelease

# Generated APK location:
# android/app/build/outputs/apk/release/app-release.apk
```

### iOS Build (macOS required)
```bash
# Install Xcode from App Store
# Install CocoaPods
sudo gem install cocoapods

# Install iOS dependencies
cd ios && pod install

# Build production IPA
npx react-native run-ios --configuration Release

# Archive for App Store
xcodebuild -workspace ios/QNetMobile.xcworkspace -scheme QNetMobile -configuration Release -destination generic/platform=iOS -archivePath build/QNetMobile.xcarchive archive
```

## Build Configuration Summary

### ✅ Production Ready Files Created:
- `android/app/build.gradle` - Android production configuration
- `ios/QNetMobile.xcodeproj/project.pbxproj` - iOS production configuration  
- `scripts/build-production.js` - Automated build script
- `package.json` - Production dependencies

### 🔧 Build Features:
- **Version**: 2.0.0 (Build 200)
- **Bundle ID**: io.qnet.mobile
- **Production endpoints**: bridge.qnet.io, rpc.qnet.io
- **Security**: Code signing, ProGuard optimization
- **Performance**: Hermes JS engine, bundle optimization

### 📱 Build Outputs:
- **Android**: `QNetWallet-v2.0.0-release.apk` + `QNetWallet-v2.0.0-release.aab`
- **iOS**: `QNetWallet-v2.0.0-release.ipa`

## Manual Build Commands

### Android APK
```bash
# From project root
cd applications/qnet-mobile
npm install
npx react-native bundle --platform android --dev false --entry-file index.js --bundle-output android/app/src/main/assets/index.android.bundle
cd android && ./gradlew assembleRelease
```

### Android AAB (Play Store)
```bash
cd android && ./gradlew bundleRelease
```

### iOS IPA (App Store)
```bash
# From project root
cd applications/qnet-mobile
npm install
cd ios && pod install
npx react-native bundle --platform ios --dev false --entry-file index.js --bundle-output ios/main.jsbundle
xcodebuild -workspace QNetMobile.xcworkspace -scheme QNetMobile -configuration Release -destination generic/platform=iOS -archivePath build/QNetMobile.xcarchive archive
```

## Ready for Production Deployment!

All build configurations are production-ready. Once React Native environment is set up:
1. Run build commands above
2. Test APK/IPA on devices  
3. Submit to app stores

**Status: ✅ Build configuration completed - Ready for compilation** 