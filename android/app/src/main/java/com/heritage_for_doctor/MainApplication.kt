package com.heritage_for_doctor

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import java.util.concurrent.TimeUnit

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(BatteryOptimizationPackage())
          add(HrmsLocationPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    createNotificationChannels()
    scheduleLocationHealthCheck()
    loadReactNative(this)
  }

  private fun createNotificationChannels() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val nm = getSystemService(NotificationManager::class.java) ?: return
      // Delete the old channel first so that a raised importance takes effect
      // on reinstalls — Android ignores createNotificationChannel() importance
      // updates if the channel already exists with a lower setting.
      nm.deleteNotificationChannel("hrms-tracking")
      // IMPORTANCE_DEFAULT = shows in status bar + drawer; sound disabled below.
      // IMPORTANCE_LOW was being silently suppressed by OnePlus/OEM notification
      // managers before the user could whitelist the app.
      val trackingChannel = NotificationChannel(
        "hrms-tracking",
        "Location Tracking",
        NotificationManager.IMPORTANCE_HIGH
      ).apply {
        description = "Active while HealthRay is recording your work location"
        setShowBadge(false)
        setSound(null, null)      // no sound — persistent tracking indicator only
        enableVibration(false)
      }
      nm.createNotificationChannel(trackingChannel)

      val fcmChannel = NotificationChannel(
        "fcm-notifications",
        "Push Notifications",
        NotificationManager.IMPORTANCE_HIGH
      ).apply {
        description = "HealthRay push notifications"
        setShowBadge(true)
        enableVibration(true)
      }
      nm.createNotificationChannel(fcmChannel)
    }
  }

  private fun scheduleLocationHealthCheck() {
    val request = PeriodicWorkRequestBuilder<LocationHealthCheckWorker>(
      15, TimeUnit.MINUTES
    ).build()
    WorkManager.getInstance(this).enqueueUniquePeriodicWork(
      "hrms-location-health",
      ExistingPeriodicWorkPolicy.KEEP,
      request
    )
  }
}
