package com.heritage_for_doctor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

class BootCompletedReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED &&
        intent.action != "android.intent.action.QUICKBOOT_POWERON") return

    Log.d("BootReceiver", "Boot completed — rescheduling health check and resuming tracking")

    // Reschedule WorkManager (Android clears periodic work on reboot)
    val request = PeriodicWorkRequestBuilder<LocationHealthCheckWorker>(
      15, TimeUnit.MINUTES
    ).build()
    WorkManager.getInstance(context).enqueueUniquePeriodicWork(
      "hrms-location-health",
      ExistingPeriodicWorkPolicy.REPLACE,
      request
    )

    // Launch app so resumeIfPossible() restores the session from AsyncStorage
    val launchIntent = Intent(context, MainActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(launchIntent)
  }
}
