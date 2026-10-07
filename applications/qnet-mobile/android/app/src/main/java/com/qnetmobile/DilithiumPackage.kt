package com.qnetmobile

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * React Native package for the app's own native modules: DilithiumModule (ML-DSA-65), SecurityModule,
 * DeviceAttestModule (the light node's device key), AppBuildModule (what kind of build this is), TaskStateModule
 * (whether the user swiped the app away since it was last opened) and BackgroundPriorityModule (how much the system lets
 * the app run in the background)
 */
class DilithiumPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(
            DilithiumModule(reactContext), SecurityModule(reactContext), DeviceAttestModule(reactContext),
            AppBuildModule(reactContext), TaskStateModule(reactContext), BackgroundPriorityModule(reactContext),
        )
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}

