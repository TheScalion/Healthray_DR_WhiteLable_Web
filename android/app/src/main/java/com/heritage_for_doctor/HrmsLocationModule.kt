package com.heritage_for_doctor

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

class HrmsLocationModule(private val reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    companion object {
        @Volatile var instance: HrmsLocationModule? = null
    }

    init {
        instance = this
    }

    override fun getName() = "HrmsLocation"

    fun emitLocation(event: WritableMap) {
        if (reactContext.hasActiveReactInstance()) {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("hrmsLocationChange", event)
        }
    }

    @ReactMethod
    fun startTracking(interval: Double, distanceFilter: Double, highAccuracy: Boolean) {
        val intent = Intent(reactContext, HrmsLocationService::class.java).apply {
            action = HrmsLocationService.ACTION_START
            putExtra(HrmsLocationService.EXTRA_INTERVAL, interval.toLong())
            putExtra(HrmsLocationService.EXTRA_DISTANCE_FILTER, distanceFilter.toFloat())
            putExtra(HrmsLocationService.EXTRA_HIGH_ACCURACY, highAccuracy)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            reactContext.startForegroundService(intent)
        } else {
            reactContext.startService(intent)
        }
    }

    @ReactMethod
    fun stopTracking() {
        val intent = Intent(reactContext, HrmsLocationService::class.java).apply {
            action = HrmsLocationService.ACTION_STOP
        }
        reactContext.startService(intent)
    }

    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}
}
