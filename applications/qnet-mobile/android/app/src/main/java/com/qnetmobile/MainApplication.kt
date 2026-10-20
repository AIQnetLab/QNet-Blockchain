package com.qnetmobile

import android.app.Application
import android.os.Build
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.modules.network.OkHttpClientProvider
import com.facebook.react.views.view.setEdgeToEdgeFeatureFlagOn
import java.io.File

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // CRYSTALS-Dilithium3 (ML-DSA-65) post-quantum signature module
              add(DilithiumPackage())
            }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    // Edge to edge from API 29 (Android 15+ enforces it), where the navigation bar is transparent and MainActivity gives
    // the bars the dark app's look. Below it React Native's switch gives that bar a scrim by the system's light or dark
    // mode, in its modal sheets too, where the app cannot change it; there the app keeps its own dark bars.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) setEdgeToEdgeFeatureFlagOn()
    // The wallet's network reads (balances, history, the nodes' answers) are never kept on disk: React Native's client
    // would cache them under cacheDir; this one has no cache, and the cache an earlier build left is deleted.
    OkHttpClientProvider.setOkHttpClientFactory { OkHttpClientProvider.createClientBuilder().build() }
    Thread { File(cacheDir, HTTP_CACHE_DIR).deleteRecursively() }.start()
    loadReactNative(this)
  }

  private companion object {
    // React Native's HTTP disk cache under cacheDir, which builds before the cache-less client wrote.
    const val HTTP_CACHE_DIR = "http-cache"
  }
}
