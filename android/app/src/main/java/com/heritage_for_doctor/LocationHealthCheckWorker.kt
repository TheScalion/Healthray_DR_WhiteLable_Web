package com.heritage_for_doctor

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.work.Worker
import androidx.work.WorkerParameters

class LocationHealthCheckWorker(ctx: Context, params: WorkerParameters)
    : Worker(ctx, params) {

  override fun doWork(): Result {
    return try {
      if (!isServiceRunning()) {
        Log.w("LocationHealthCheck", "LocationUpdatesService dead — launching app to resume")
        val intent = Intent(applicationContext, MainActivity::class.java).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        applicationContext.startActivity(intent)
      } else {
        Log.d("LocationHealthCheck", "LocationUpdatesService is healthy")
      }
      Result.success()
    } catch (e: Exception) {
      Log.e("LocationHealthCheck", "Worker error", e)
      Result.retry()
    }
  }

  @Suppress("DEPRECATION")
  private fun isServiceRunning(): Boolean {
    val am = applicationContext.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    return am.getRunningServices(Int.MAX_VALUE).any {
      it.service.className == "com.agontuk.RNFusedLocation.LocationUpdatesService"
    }
  }
}
