package com.heritage_for_doctor

import android.app.Activity
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise

class BatteryOptimizationModule(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "BatteryOptimization"

  @ReactMethod
  fun launchOemSettings(promise: Promise) {
    val activity = reactApplicationContext.currentActivity as? Activity
    if (activity == null) {
      promise.reject("NO_ACTIVITY", "No foreground activity available")
      return
    }
    try {
      OemBatteryOptimizationHelper.launch(activity)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("ERROR", e.message, e)
    }
  }
}
