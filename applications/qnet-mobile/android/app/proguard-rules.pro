# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# React Native ProGuard rules for production build
# Obfuscation and minification enabled for security

# Keep React Native classes
-keep class com.facebook.react.** { *; }
-keep class com.facebook.hermes.** { *; }
-keep class com.facebook.jni.** { *; }

# Keep our application classes
-keep class com.qnetmobile.** { *; }

# AsyncStorage
-keep class com.reactnativecommunity.asyncstorage.** { *; }

# Clipboard
-keep class com.reactnativecommunity.clipboard.** { *; }

# Keep native methods
-keepclassmembers class * {
    @com.facebook.react.uimanager.annotations.ReactProp <methods>;
    @com.facebook.react.uimanager.annotations.ReactPropGroup <methods>;
}

# Keep JavaScript interface
-keepclassmembers,includedescriptorclasses class * {
    native <methods>;
}

# Crypto and security related
-keep class javax.crypto.** { *; }
-keep class java.security.** { *; }
-keep class org.bouncycastle.** { *; }

# Keep Solana/Web3 related classes if any
-keep class org.bitcoinj.** { *; }
-keep class com.google.protobuf.** { *; }

# Optimization for React Native
-optimizationpasses 5
-dontusemixedcaseclassnames
-dontskipnonpubliclibraryclasses
-dontpreverify
-verbose

# Remove debugging information
-assumenosideeffects class android.util.Log {
    public static *** d(...);
    public static *** v(...);
    public static *** i(...);
    public static *** w(...);
    public static *** e(...);
}

# Keep source file names for stack traces (can be removed for max obfuscation)
-keepattributes SourceFile,LineNumberTable

# If you want maximum obfuscation, uncomment this:
# -renamesourcefileattribute SourceFile
# -keepattributes !SourceFile,!LineNumberTable

# Warnings to ignore
-dontwarn com.facebook.react.**
-dontwarn com.facebook.hermes.**
-dontwarn org.bitcoinj.**
-dontwarn okio.**
-dontwarn retrofit2.**