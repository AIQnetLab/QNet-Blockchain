# Release build: R8 in full mode (the default since AGP 8) over proguard-android-optimize.txt, with resource
# shrinking. React Native's consumer rules keep every class or member marked DoNotStrip, every NativeModule and
# JavaScriptModule, every native method, every ReactProp setter, the bridge, the TurboModule core and fbjni;
# proguard-android-optimize.txt keeps native methods, JavascriptInterface methods, enums and Parcelable creators; AAPT
# keeps what the manifest and the layouts name; libraries from Maven bring rules where they need them (OkHttp's, for
# one). Of the React Native libraries only react-native-background-fetch and react-native-svg ship rules; the others
# hold through those rules and direct references. Only what nothing covers is kept here, so R8 can shrink and optimise
# the rest.

# No blanket keep of com.qnetmobile: the native modules are kept by React Native's consumer rules
# (every NativeModule and every native method), the activity, application, service and receiver by the manifest.

# Hermes' Java side ships no keep rules, and the engine's native code finds its classes by name.
-keep class com.facebook.hermes.** { *; }

-dontusemixedcaseclassnames

# Remove debugging information
-assumenosideeffects class android.util.Log {
    public static *** d(...);
    public static *** v(...);
    public static *** i(...);
    public static *** w(...);
    public static *** e(...);
}

# No source file names or line numbers of our own in the release build; a library that keeps the
# attribute gets the placeholder name instead of the real one.
-renamesourcefileattribute SourceFile
