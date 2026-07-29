package com.heritage_for_doctor

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Log

object OemBatteryOptimizationHelper {
  private const val TAG = "OemBatteryOpt"

  fun launch(activity: Activity) {
    val mfr = Build.MANUFACTURER.lowercase()
    val tried = when {
      mfr.contains("samsung") -> tryIntent(
        activity,
        "com.samsung.android.lool",
        "com.samsung.android.sm.battery.ui.BatteryActivity"
      )
      mfr.contains("xiaomi") -> tryIntent(
        activity,
        "com.miui.securitycenter",
        "com.miui.powercenter.PowerCenterMainActivity"
      )
      mfr.contains("oppo") -> tryIntent(
        activity,
        "com.coloros.safecenter",
        "com.coloros.safecenter.permission.startup.StartupAppListActivity"
      )
      mfr.contains("huawei") -> tryIntent(
        activity,
        "com.huawei.systemmanager",
        "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"
      )
      mfr.contains("oneplus") -> tryIntent(
        activity,
        "com.oneplus.security",
        "com.oneplus.security.battery.BatteryOptimizeActivity"
      )
      else -> false
    }
    if (!tried) {
      try {
        activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
      } catch (e: Exception) {
        Log.e(TAG, "All battery opt intents failed", e)
      }
    }
  }

  private fun tryIntent(activity: Activity, pkg: String, cls: String): Boolean {
    return try {
      val intent = Intent().setClassName(pkg, cls)
      if (activity.packageManager.resolveActivity(intent, 0) != null) {
        activity.startActivity(intent)
        true
      } else false
    } catch (e: Exception) { false }
  }
}
