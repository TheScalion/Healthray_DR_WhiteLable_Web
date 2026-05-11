package com.heritage_for_doctor

import android.annotation.SuppressLint
import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import com.facebook.react.bridge.Arguments
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices

class HrmsLocationService : Service() {

    companion object {
        const val ACTION_START = "hrms.action.START"
        const val ACTION_STOP = "hrms.action.STOP"
        const val NOTIFICATION_ID = 1001
        const val EXTRA_INTERVAL = "interval"
        const val EXTRA_DISTANCE_FILTER = "distanceFilter"
        const val EXTRA_HIGH_ACCURACY = "highAccuracy"
    }

    private lateinit var fusedClient: FusedLocationProviderClient

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val loc = result.lastLocation ?: return
            val module = HrmsLocationModule.instance ?: return

            val coords = Arguments.createMap().apply {
                putDouble("latitude", loc.latitude)
                putDouble("longitude", loc.longitude)
                if (loc.hasAltitude()) putDouble("altitude", loc.altitude) else putNull("altitude")
                putDouble("accuracy", loc.accuracy.toDouble())
                putNull("altitudeAccuracy")
                if (loc.hasBearing()) putDouble("heading", loc.bearing.toDouble()) else putNull("heading")
                if (loc.hasSpeed()) putDouble("speed", loc.speed.toDouble()) else putNull("speed")
            }
            val event = Arguments.createMap().apply {
                putMap("coords", coords)
                putDouble("timestamp", loc.time.toDouble())
            }
            module.emitLocation(event)
        }
    }

    override fun onCreate() {
        super.onCreate()
        fusedClient = LocationServices.getFusedLocationProviderClient(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = NotificationCompat.Builder(this, "hrms-tracking")
            .setContentTitle("Location tracking active")
            .setContentText("HealthRay is recording your work location.")
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .setSilent(true)
            .build()
        startForeground(NOTIFICATION_ID, notification)

        when (intent?.action) {
            ACTION_START -> startLocationUpdates(intent)
            ACTION_STOP -> {
                stopLocationUpdates()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_STICKY
    }

    @SuppressLint("MissingPermission")
    private fun startLocationUpdates(intent: Intent) {
        val intervalMs = intent.getLongExtra(EXTRA_INTERVAL, 10_000L)
        val distanceFilter = intent.getFloatExtra(EXTRA_DISTANCE_FILTER, 0f)
        val highAccuracy = intent.getBooleanExtra(EXTRA_HIGH_ACCURACY, true)

        @Suppress("DEPRECATION")
        val request = LocationRequest()
            .setInterval(intervalMs)
            .setFastestInterval(intervalMs)
            .setPriority(
                if (highAccuracy) LocationRequest.PRIORITY_HIGH_ACCURACY
                else LocationRequest.PRIORITY_BALANCED_POWER_ACCURACY
            )
            .setSmallestDisplacement(distanceFilter)

        fusedClient.removeLocationUpdates(locationCallback)
        fusedClient.requestLocationUpdates(request, locationCallback, Looper.getMainLooper())
    }

    private fun stopLocationUpdates() {
        fusedClient.removeLocationUpdates(locationCallback)
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
