import {
  Platform,
  PermissionsAndroid,
  NativeModules,
  DeviceEventEmitter,
  Linking,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DeviceInfo from 'react-native-device-info';
import axios from 'axios';
import Geolocation from 'react-native-geolocation-service';
import NetInfo from '@react-native-community/netinfo';

import { openAppSettings } from '../utils/appSettings';
import { haversineMeters } from '../utils/geo';
import { makeRequestId } from '../utils/requestId';
import { TrackingPoint, TrackingStatus, TrackingActiveSession } from './types';
import {
  TRACKING_API_BASE,
  TRACKING_PATH_START,
  TRACKING_PATH_BATCH,
  TRACKING_PATH_END,
  TRACKING_FLUSH_INTERVAL_MS,
  TRACKING_MIN_FLUSH_GAP_MS,
  TRACKING_KEEPALIVE_INTERVAL_MS,
  TRACKING_MAX_POINTS_PER_BATCH,
  TRACKING_MAX_BUFFER_POINTS,
  TRACKING_ACCURACY_MAX_M,
  KALMAN_PROCESS_NOISE_M2_PER_S,
  KALMAN_PROCESS_NOISE_STATIONARY_M2_PER_S,
  KALMAN_INITIAL_VARIANCE_M2,
  KALMAN_RESET_GAP_S,
  TRACKING_RESUME_WINDOW_MS,
  TRACKING_HEARTBEAT_MS,
  ACTIVE_DISTANCE_FILTER_M,
  STATIONARY_DISTANCE_FILTER_M,
  ACTIVE_POLL_MS,
  STATIONARY_POLL_MS,
  MOTION_THRESHOLD_MPS,
  STILL_THRESHOLD_MPS,
  STILL_CONSECUTIVE_REQUIRED,
  debugToast,
  ACCEL_SAMPLE_HZ,
  ACCEL_WINDOW_SIZE,
  ACCEL_STILL_VARIANCE_THRESHOLD,
  ACCEL_MOVING_VARIANCE_THRESHOLD,
  TRACKING_AUTO_RESUME_MAX_ATTEMPTS,
  TRACKING_AUTO_RESUME_BACKOFFS_MS,
  TRACKING_AUTO_RESUME_TIGHT_LOOP_MS,
  TRACKING_STORAGE,
  trackingSessionKey,
  trackingBufferKey,
  TRACKING_BATTERY_OPT_KEY,
  _rnSensors,
} from './constants';

const { BatteryOptimization } = NativeModules;

// ─── HRMS Location Tracker (module-level singleton) ──────────────────────────
// Lives outside React tree so GPS callbacks that fire after unmount or after
// an app-kill resume never reference a stale instance.
export class HRMSLocationTracker {
  private active: TrackingActiveSession | null = null;
  private buffer: TrackingPoint[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // Force-poller: drives a getCurrentPosition every TRACKING_ACTIVE_POLL_MS so
  // that we get a guaranteed point per 10 s even when the OS suppresses
  // watchPosition (e.g., screen off, doze mode, distanceFilter blocking small
  // movements). This is the difference between "live tracking" and "tracking
  // that misses 4-minute travel segments".
  private activePollTimer: ReturnType<typeof setInterval> | null = null;
  private lastFlushAt = 0;
  private lastKeepaliveAt = 0;
  private flushInFlight = false;
  private lastHandledAt = 0;   // dedup: reject readings within 4 s of the last accepted one
  private watchId: number | null = null;
  private locationSub: { remove: () => void } | null = null;
  private netInfoUnsub: (() => void) | null = null;
  private statusEmitter: ((status: TrackingStatus, detail?: any) => void) | null = null;
  private starting = false;
  // Timestamp of the last successful auto-resume. Used by the tight-loop
  // guard: if a fresh session 410s within TRACKING_AUTO_RESUME_TIGHT_LOOP_MS,
  // we stop instead of looping forever.
  private lastAutoResumeAt = 0;
  // Re-entrancy lock so two concurrent 410s don't fire two parallel resumes.
  private resuming = false;
  // Path-3 Kalman filter state. Initialized lazily on the first reading.
  // Reset whenever a session starts/stops or readings are >30s apart.
  private kfLat: number | null = null;
  private kfLng: number | null = null;
  private kfVariance: number = KALMAN_INITIAL_VARIANCE_M2;
  private kfLastTimestamp: number = 0;

  // Adaptive sampling state. Default 'active' on session start so the very
  // first journey is captured at full fidelity; we drop to 'stationary' only
  // after observing N consecutive low-velocity readings.
  private motionState: 'active' | 'stationary' = 'active';
  private prevForVelocity: { lat: number; lng: number; ts: number } | null = null;
  private stillStreak: number = 0;

  // Path 1: accelerometer-driven motion detection.
  // When `accelerometerSubscription` is active, it overrides the GPS-velocity
  // heuristic and provides instant motion classification.
  private accelMagSquaredHistory: number[] = [];
  private accelerometerSubscription: { unsubscribe: () => void } | null = null;
  private externalMotionStateActive = false; // true while OS / accelerometer is driving state

  setStatusEmitter(fn: (status: TrackingStatus, detail?: any) => void) {
    this.statusEmitter = fn;
  }

  private emit(status: TrackingStatus, detail?: any) {
    try {
      this.statusEmitter?.(status, detail);
    } catch (e) {
      console.log('[HRMS] status emit error', e);
    }
  }

  getActiveSession(): TrackingActiveSession | null {
    return this.active;
  }

  // ── Permissions ───────────────────────────────────────────────────────────
  private async hasLocationPermission(): Promise<boolean> {
    try {
      if (Platform.OS === 'ios') {
        const auth = await Geolocation.requestAuthorization('always');
        return auth === 'granted';
      }

      // Android 13+ (API 33+) requires POST_NOTIFICATIONS for the
      // foreground-service notification to render at all.
      if ((Platform.Version as number) >= 33) {
        const notifResult = await PermissionsAndroid.request(
          'android.permission.POST_NOTIFICATIONS' as any,
          {
            title: 'Notifications',
            message: 'HealthRay needs to show a notification while location tracking is active.',
            buttonPositive: 'Allow',
          },
        ).catch(() => PermissionsAndroid.RESULTS.DENIED);
        if (notifResult !== PermissionsAndroid.RESULTS.GRANTED) {
          // Tracking still works — only the status-bar indicator will be absent.
          // Emit so the WebView can prompt the user to re-enable via Settings.
          this.emit('notification_permission_denied');
        }
      }

      const fine = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        {
          title: 'Location Permission',
          message: 'HealthRay needs your location for HRMS work tracking.',
          buttonPositive: 'Allow',
        },
      );
      if (fine !== PermissionsAndroid.RESULTS.GRANTED) return false;

      // Android 10+ (API 29+): background location must be requested
      // SEPARATELY and only AFTER fine-location is granted.
      if ((Platform.Version as number) >= 29) {
        const bg = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
          {
            title: 'Background Location',
            message:
              'Allow HealthRay to record your location while the app is in the background for HRMS attendance.',
            buttonPositive: 'Allow Always',
          },
        );
        return bg === PermissionsAndroid.RESULTS.GRANTED;
      }
      return true;
    } catch (e) {
      console.log('[HRMS] requestPermission error', e);
      return false;
    }
  }

  // ── Auth headers ──────────────────────────────────────────────────────────
  private async authHeaders(): Promise<Record<string, string>> {
    const [authToken, deviceToken] = await Promise.all([
      AsyncStorage.getItem(TRACKING_STORAGE.AUTH_TOKEN),
      AsyncStorage.getItem(TRACKING_STORAGE.DEVICE_TOKEN),
    ]);
    return {
      'X-Auth-Token': authToken ?? '',
      'X-Device-Token': deviceToken ?? '',
      'X-Request-Id': makeRequestId(),
      'Content-Type': 'application/json',
    };
  }

  // HRMS rolls X-Auth-Token (and sometimes X-Device-Token) on each response.
  // Persist the new value so the next request stays authenticated.
  private async persistRolledTokens(res: any): Promise<void> {
    try {
      const headers = res?.headers ?? {};
      const newAuth =
        headers['x-auth-token'] ?? headers['X-Auth-Token'] ?? res?.data?.auth_token;
      const newDevice =
        headers['x-device-token'] ?? headers['X-Device-Token'] ?? res?.data?.device_token;

      const updates: [string, string][] = [];
      if (typeof newAuth === 'string' && newAuth) {
        updates.push([TRACKING_STORAGE.AUTH_TOKEN, newAuth]);
      }
      if (typeof newDevice === 'string' && newDevice) {
        updates.push([TRACKING_STORAGE.DEVICE_TOKEN, newDevice]);
      }
      if (updates.length) await AsyncStorage.multiSet(updates);
    } catch (e) {
      console.log('[HRMS] persistRolledTokens error', e);
    }
  }

  // 401 → wipe auth + tracking session and tell WebView to log out.
  private async handleAuthExpired(): Promise<void> {
    this.stopGPS();
    if (this.active) {
      await AsyncStorage.removeItem(trackingSessionKey(this.active.employeeId));
      await AsyncStorage.removeItem(trackingBufferKey(this.active.sessionId));
    }
    await AsyncStorage.multiRemove([
      TRACKING_STORAGE.AUTH_TOKEN,
      TRACKING_STORAGE.DEVICE_TOKEN,
      TRACKING_STORAGE.EMPLOYEE_ID,
      TRACKING_STORAGE.ORG_ID,
      TRACKING_STORAGE.LAST_ACTIVITY_TS,
    ]);
    this.active = null;
    this.buffer = [];
    this.kalmanReset();
    this.emit('auth_expired');
  }

  // 410 → backend killed the session (24h cap or out-of-band stop).
  // Attempt a silent auto-resume so the employee never has to click Start
  // again during a long shift. Falls back to a hard stop only if:
  //   • all 3 retry attempts on /tracking/start fail, OR
  //   • the freshly-resumed session 410s again within 60s (tight-loop guard).
  private async handleSessionExpired(): Promise<void> {
    if (this.resuming) return;
    this.resuming = true;
    try {
      // Tight-loop guard: if we just resumed and the new session is already
      // dying, something is fundamentally broken. Stop hard.
      const sinceLastResume = Date.now() - this.lastAutoResumeAt;
      if (this.lastAutoResumeAt > 0 && sinceLastResume < TRACKING_AUTO_RESUME_TIGHT_LOOP_MS) {
        console.log('[HRMS] tight-loop on auto-resume — aborting');
        return this.fullSessionTeardown('session_expired');
      }

      // No active session to resume from? Hard stop.
      if (!this.active) {
        return this.fullSessionTeardown('session_expired');
      }

      const { employeeId, organizationId, sessionId: oldSessionId } = this.active;

      // Drop the old session_id locally — /start will return a fresh one.
      await AsyncStorage.removeItem(trackingSessionKey(employeeId));
      await AsyncStorage.removeItem(trackingBufferKey(oldSessionId));
      this.buffer = [];

      // Try to mint a new session. 3 attempts × exponential backoff.
      let newSessionId: string | null = null;
      for (let i = 0; i < TRACKING_AUTO_RESUME_MAX_ATTEMPTS; i++) {
        const wait = TRACKING_AUTO_RESUME_BACKOFFS_MS[i] ?? 0;
        if (wait > 0) await new Promise<void>(r => setTimeout(r, wait));
        newSessionId = await this.startSession(employeeId, organizationId);
        if (newSessionId) break;
        console.log(`[HRMS] auto-resume attempt ${i + 1} failed`);
      }

      if (!newSessionId) {
        console.log('[HRMS] auto-resume exhausted retries — stopping');
        return this.fullSessionTeardown('session_expired');
      }

      // Success: swap session_id in place, persist, and tell the WebView.
      this.active = { employeeId, organizationId, sessionId: newSessionId };
      this.lastAutoResumeAt = Date.now();
      await AsyncStorage.setItem(trackingSessionKey(employeeId), newSessionId);
      await AsyncStorage.setItem(TRACKING_STORAGE.LAST_ACTIVITY_TS, new Date().toISOString());

      this.emit('tracking_resumed', {
        employee_id: employeeId,
        organization_id: organizationId,
        session_id: newSessionId,
      });
    } finally {
      this.resuming = false;
    }
  }

  private async fullSessionTeardown(emitStatus: TrackingStatus): Promise<void> {
    this.stopGPS();
    if (this.active) {
      await AsyncStorage.removeItem(trackingSessionKey(this.active.employeeId));
      await AsyncStorage.removeItem(trackingBufferKey(this.active.sessionId));
    }
    await AsyncStorage.multiRemove([
      TRACKING_STORAGE.EMPLOYEE_ID,
      TRACKING_STORAGE.ORG_ID,
      TRACKING_STORAGE.LAST_ACTIVITY_TS,
    ]);
    this.active = null;
    this.buffer = [];
    this.lastAutoResumeAt = 0;
    this.kalmanReset();
    this.emit(emitStatus);
  }

  // ── Buffer management ─────────────────────────────────────────────────────
  private async loadBufferFromDisk(sessionId: string): Promise<void> {
    try {
      const raw = await AsyncStorage.getItem(trackingBufferKey(sessionId));
      this.buffer = raw ? (JSON.parse(raw) as TrackingPoint[]) : [];
    } catch {
      this.buffer = [];
    }
  }

  private async persistBuffer(): Promise<void> {
    if (!this.active) return;
    try {
      await AsyncStorage.setItem(
        trackingBufferKey(this.active.sessionId),
        JSON.stringify(this.buffer),
      );
    } catch (e) {
      console.log('[HRMS] persistBuffer error', e);
    }
  }

  private appendPoint(p: TrackingPoint): void {
    if (this.buffer.length >= TRACKING_MAX_BUFFER_POINTS) {
      const evicted = this.buffer.splice(0, this.buffer.length - TRACKING_MAX_BUFFER_POINTS + 1);
      console.log(`[HRMS] buffer overflow — evicted ${evicted.length} oldest point(s); check server connectivity`);
    }
    this.buffer.push(p);
  }

  private handleLocation(position: {
    timestamp: number;
    coords: {
      latitude: number;
      longitude: number;
      accuracy: number | null;
      altitude: number | null;
      speed: number | null;
    };
  }): void {
    if (!this.active) return;
    const rawAccuracy = position.coords.accuracy;
    // Only drop readings whose accuracy is *known* to be worse than the threshold.
    // null/undefined means the provider didn't report accuracy — let it through.
    if (rawAccuracy !== null && rawAccuracy !== undefined && rawAccuracy > TRACKING_ACCURACY_MAX_M) {
      debugToast(`⛔ GPS dropped acc=${rawAccuracy?.toFixed(0)}m`);
      return;
    }
    const accuracy = rawAccuracy ?? TRACKING_ACCURACY_MAX_M; // conservative fallback for Kalman

    const ts = Date.now();
    // Deduplicate: watchPosition (5 s Android cadence) and activePollTimer (10 s)
    // both call handleLocation independently and overlap every 10 s. Drop any
    // reading that arrives within 4 s of the last accepted one — the poller's
    // fallback role is preserved because lastHandledAt goes stale whenever
    // watchPosition is silenced by Doze mode.
    if (ts - this.lastHandledAt < 4_000) return;
    this.lastHandledAt = ts;

    // Adaptive sampling — classify motion (active vs stationary) using the
    // velocity from the previous reading. Switches GPS subscriptions if the
    // state changes. Uses RAW lat/lng (not Kalman output) to avoid a circular
    // dependency: motion state sets Q → Q determines filter output → filter
    // output would determine velocity → velocity determines motion state.
    this.updateMotionState(position.coords.latitude, position.coords.longitude, ts);

    // Path-3 Kalman smoothing — uses the GPS chip's own accuracy as
    // observation noise. No new sensors required.
    const filtered = this.kalmanUpdate(
      position.coords.latitude,
      position.coords.longitude,
      Math.max(1, accuracy),
      ts
    );

    const point: TrackingPoint = {
      latitude: filtered.lat,
      longitude: filtered.lng,
      accuracy: filtered.accuracy,
      captured_at: new Date(position.timestamp).toISOString(),
    };
    this.appendPoint(point);
    debugToast(`📍 buf=${this.buffer.length} acc=${rawAccuracy?.toFixed(0) ?? '?'}m`);
    this.persistBuffer().catch(() => { });
    if (this.buffer.length >= TRACKING_MAX_POINTS_PER_BATCH) {
      this.flush().catch(() => { });
    }
  }

  /**
   * 1D Kalman filter applied per axis (lat, lng) using the GPS chip's
   * reported accuracy as observation standard deviation.
   *
   *   predicted_variance = previous_variance + Q * dt
   *   K (gain)           = predicted_variance / (predicted_variance + observation_variance)
   *   new_estimate       = previous_estimate + K * (observed - previous_estimate)
   *   new_variance       = (1 - K) * predicted_variance
   *
   * Where observation_variance = accuracy² (chip's reported accuracy is
   * roughly 1-σ in metres). Latitude and longitude are smoothed separately
   * — they aren't correlated for our purposes.
   *
   * Resets on:
   *   • First call (no prior state)
   *   • Time gap >KALMAN_RESET_GAP_S — too long to predict through
   *
   * Resets are triggered by callers via `kalmanReset()` when starting a
   * new session.
   */
  private kalmanUpdate(lat: number, lng: number, accuracyM: number, ts: number): {
    lat: number; lng: number; accuracy: number;
  } {
    // Reject corrupt GPS readings — NaN/Infinity would poison the filter permanently
    if (!isFinite(lat) || !isFinite(lng) || !isFinite(accuracyM)) {
      return {
        lat: this.kfLat ?? lat,
        lng: this.kfLng ?? lng,
        accuracy: accuracyM,
      };
    }

    // First call OR large time gap → seed the filter with this reading
    if (this.kfLat == null || this.kfLng == null || (ts - this.kfLastTimestamp) > KALMAN_RESET_GAP_S * 1000) {
      this.kfLat = lat;
      this.kfLng = lng;
      this.kfVariance = accuracyM * accuracyM;
      this.kfLastTimestamp = ts;
      return { lat, lng, accuracy: accuracyM };
    }

    const dtSec = Math.max(0.001, (ts - this.kfLastTimestamp) / 1000);
    const Q = this.motionState === 'active'
      ? KALMAN_PROCESS_NOISE_M2_PER_S
      : KALMAN_PROCESS_NOISE_STATIONARY_M2_PER_S;
    const predictedVar = this.kfVariance + Q * dtSec;
    const observationVar = accuracyM * accuracyM;
    const K = predictedVar / (predictedVar + observationVar);

    this.kfLat = this.kfLat + K * (lat - this.kfLat);
    this.kfLng = this.kfLng + K * (lng - this.kfLng);
    this.kfVariance = (1 - K) * predictedVar;
    this.kfLastTimestamp = ts;

    return {
      lat: this.kfLat,
      lng: this.kfLng,
      accuracy: Math.sqrt(this.kfVariance)
    };
  }

  /**
   * Reset the Kalman state. Called when a session starts, stops, or a fresh
   * /tracking/start happens — we don't want the filter carrying state across
   * unrelated sessions. Also resets the motion-state tracking.
   */
  private kalmanReset(): void {
    this.kfLat = null;
    this.kfLng = null;
    this.kfVariance = KALMAN_INITIAL_VARIANCE_M2;
    this.kfLastTimestamp = 0;
    this.prevForVelocity = null;
    this.stillStreak = 0;
    this.motionState = 'active';
    this.lastHandledAt = 0;
    this.lastKeepaliveAt = 0;
  }

  /**
   * Adaptive-sampling decision: classify the current reading as active or
   * stationary motion based on velocity from the previous reading. Triggers
   * `applyMotionState` if the state should change.
   *
   * Hysteresis:
   *   • Any reading >= MOTION_THRESHOLD_MPS → switch to ACTIVE immediately
   *     (don't make the user wait 3 readings to start capturing a journey).
   *   • Need STILL_CONSECUTIVE_REQUIRED readings < STILL_THRESHOLD_MPS to
   *     switch to STATIONARY (avoid flapping on slow walks).
   */
  private updateMotionState(lat: number, lng: number, ts: number): void {
    // If an external source (accelerometer / OS Activity Recognition) is
    // driving motion state, defer to it entirely. The GPS-velocity heuristic
    // is much slower and noisier than IMU-based detection.
    if (this.externalMotionStateActive) {
      this.prevForVelocity = { lat, lng, ts };
      return;
    }

    const prev = this.prevForVelocity;
    this.prevForVelocity = { lat, lng, ts };
    if (!prev) return; // need a baseline

    const dtSec = Math.max(0.1, (ts - prev.ts) / 1000);
    const distM = haversineMeters(prev, { lat, lng });
    const speedMps = distM / dtSec;

    if (speedMps >= MOTION_THRESHOLD_MPS) {
      this.stillStreak = 0;
      if (this.motionState !== 'active') this.applyMotionState('active');
      return;
    }

    if (speedMps < STILL_THRESHOLD_MPS) {
      this.stillStreak += 1;
      if (this.stillStreak >= STILL_CONSECUTIVE_REQUIRED && this.motionState !== 'stationary') {
        this.applyMotionState('stationary');
      }
    } else {
      // In the dead-band — neither clearly active nor still. Hold current
      // state, reset the still-streak (we're not consistently still).
      this.stillStreak = 0;
    }
  }

  /**
   * Public API: external motion source (accelerometer, OS Activity
   * Recognition) reports the current motion state. Bypasses the GPS-velocity
   * heuristic. The tracker still supplements with GPS readings — this is
   * just a faster source-of-truth for "is the phone moving."
   *
   * `state`:    'active' | 'stationary'
   * `source`:   informational tag (e.g. 'accelerometer', 'activity-recognition')
   *             — used only for debug logs; behaviour is identical
   */
  setExternalMotionState(state: 'active' | 'stationary', _source: string = 'external'): void {
    this.externalMotionStateActive = true;
    if (state !== this.motionState) this.applyMotionState(state);
  }

  /**
   * Subscribe to the accelerometer (if `react-native-sensors` is installed)
   * and emit motion-state changes based on the variance of acceleration
   * magnitude over a sliding 3-second window.
   *
   *   variance < 0.05 m²/s⁴  → phone is on a desk / in a still pocket → STATIONARY
   *   variance > 0.50 m²/s⁴  → walking / driving / pocket-jiggle      → ACTIVE
   *   between                → hold current state (dead-band)
   *
   * No-op if the lib isn't installed. Caller doesn't need to check.
   */
  private attachAccelerometerMotionDetection(): void {
    if (!_rnSensors || this.accelerometerSubscription) return;
    try {
      const { accelerometer, setUpdateIntervalForType, SensorTypes } = _rnSensors;
      if (!accelerometer || typeof accelerometer.subscribe !== 'function') return;

      const intervalMs = Math.round(1000 / ACCEL_SAMPLE_HZ);
      if (typeof setUpdateIntervalForType === 'function' && SensorTypes && SensorTypes.accelerometer) {
        setUpdateIntervalForType(SensorTypes.accelerometer, intervalMs);
      }

      this.accelMagSquaredHistory = [];
      this.accelerometerSubscription = accelerometer.subscribe(({ x, y, z }: any) => {
        const magSq = (x * x) + (y * y) + (z * z);
        this.accelMagSquaredHistory.push(magSq);
        if (this.accelMagSquaredHistory.length > ACCEL_WINDOW_SIZE) {
          this.accelMagSquaredHistory.shift();
        }
        if (this.accelMagSquaredHistory.length < ACCEL_WINDOW_SIZE) return;

        // Compute variance of magnitude (sqrt would normalize, but variance
        // of magSq is a perfectly good motion proxy and skips a sqrt per sample).
        const mean = this.accelMagSquaredHistory.reduce((a, b) => a + b, 0) / this.accelMagSquaredHistory.length;
        let varSum = 0;
        for (const v of this.accelMagSquaredHistory) varSum += (v - mean) * (v - mean);
        const variance = varSum / this.accelMagSquaredHistory.length;

        // Map magSq variance back to "m²/s⁴" by sqrt — close enough for
        // our threshold-based decision. We compare against thresholds tuned
        // empirically (see constants).
        const proxy = Math.sqrt(variance);

        if (proxy > ACCEL_MOVING_VARIANCE_THRESHOLD) {
          this.setExternalMotionState('active', 'accelerometer');
        } else if (proxy < ACCEL_STILL_VARIANCE_THRESHOLD) {
          this.setExternalMotionState('stationary', 'accelerometer');
        }
        // Dead-band → keep current state
      });
    } catch (e) {
      console.log('[HRMS] accelerometer subscription failed', e);
    }
  }

  private detachAccelerometerMotionDetection(): void {
    if (this.accelerometerSubscription) {
      try { this.accelerometerSubscription.unsubscribe(); } catch { /* ignore */ }
      this.accelerometerSubscription = null;
    }
    this.accelMagSquaredHistory = [];
    this.externalMotionStateActive = false;
  }

  /**
   * Switch motion state and reconfigure GPS subscriptions accordingly.
   * Idempotent — re-applying the same state is a no-op.
   */
  private applyMotionState(newState: 'active' | 'stationary'): void {
    if (this.motionState === newState) return;
    this.motionState = newState;

    // Restart watchPosition with the new options.
    // Start the new watch BEFORE clearing the old one so the foreground-service
    // notification is never absent between the two calls — a momentary gap here
    // is enough for aggressive OEM battery managers to kill the service.
    const oldWatchId = this.watchId;
    this.watchId = null;             // allow attachWatchPosition to write its new id
    this.attachWatchPosition();
    // On Android, attachWatchPosition re-issues startTracking() with new params and the
    // service updates its LocationRequest in-place — no separate clear needed.
    // On iOS, clear the old watchPosition subscription.
    if (Platform.OS !== 'android' && oldWatchId !== null) {
      Geolocation.clearWatch(oldWatchId);
    }

    // Restart active poller at new cadence
    if (this.activePollTimer) {
      clearInterval(this.activePollTimer);
      this.activePollTimer = null;
    }
    this.attachActivePoller();
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────
  private getCurrentPositionOnce(): Promise<{ latitude: number; longitude: number; accuracy: number | null; timestamp: number } | null> {
    return new Promise((resolve) => {
      Geolocation.getCurrentPosition(
        (pos) => resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? null,
          timestamp: pos.timestamp,
        }),
        (err) => {
          console.log('[HRMS] initial GPS fix failed', err.code, err.message);
          resolve(null);
        },
        {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 60000,
          forceRequestLocation: true,
        } as any,
      );
    });
  }

  private async startSession(
    employeeId: number,
    organizationId: number,
  ): Promise<string | null> {
    try {
      const initial = await this.getCurrentPositionOnce();
      if (!initial) {
        console.log('[HRMS] /start aborted — could not get initial GPS fix');
        return null;
      }

      const headers = await this.authHeaders();
      const res = await axios.post(
        `${TRACKING_API_BASE}${TRACKING_PATH_START}`,
        {
          employee_id: employeeId,
          organization_id: organizationId,
          latitude: initial.latitude,
          longitude: initial.longitude,
          accuracy: initial.accuracy,
          captured_at: new Date(initial.timestamp).toISOString(),
          source: 'mobile_native',
        },
        { headers, timeout: 15000 },
      );
      await this.persistRolledTokens(res);

      // HealthRay's sendJson wraps responses: HTTP is always 200, the real
      // status lives in res.data.status / res.data.statusState. So an axios
      // success here may still be a backend error.
      const body = res?.data ?? {};
      if (body.statusState === 'error' || (typeof body.status === 'number' && body.status >= 400)) {
        console.log('[HRMS] /start backend error',
          'status=', body.status, 'message=', body.message);
        if (body.status === 401) await this.handleAuthExpired();
        return null;
      }

      const sessionId = body?.data?.session_id;
      if (typeof sessionId !== 'string' || !sessionId) {
        console.log('[HRMS] /start returned no session_id — full body:', JSON.stringify(body));
        return null;
      }
      return sessionId;
    } catch (e) {
      if (axios.isAxiosError(e)) {
        if (e.response?.status === 401) await this.handleAuthExpired();
        console.log('[HRMS] /start failed', e.response?.status, e.message,
          'body:', JSON.stringify(e.response?.data));
      } else {
        console.log('[HRMS] /start error', e);
      }
      return null;
    }
  }

  private async endSession(): Promise<void> {
    if (!this.active) return;

    // Capture a final position so the TRACKING_END row has real coords.
    // Previous behaviour stored NULL lat/lng on every END, which made the
    // admin map show "session ended at (null, null)". 5-second timeout
    // because we don't want to delay the end response on a poor-signal
    // moment — fall back to the last buffered point if no fix.
    let finalLat: number | null = null;
    let finalLng: number | null = null;
    let finalAcc: number | null = null;
    try {
      const last = this.buffer[this.buffer.length - 1];
      if (last) {
        finalLat = last.latitude;
        finalLng = last.longitude;
        finalAcc = last.accuracy;
      }
      const fix = await new Promise<{ latitude: number; longitude: number; accuracy: number | null } | null>((resolve) => {
        Geolocation.getCurrentPosition(
          (pos) => resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy ?? null,
          }),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 5000, maximumAge: 5000, forceRequestLocation: true } as any,
        );
      });
      if (fix) {
        finalLat = fix.latitude;
        finalLng = fix.longitude;
        finalAcc = fix.accuracy;
      }
    } catch { /* ignore — proceed with whatever we have */ }

    try {
      const headers = await this.authHeaders();
      const res = await axios.post(
        `${TRACKING_API_BASE}${TRACKING_PATH_END}`,
        {
          employee_id: this.active.employeeId,
          organization_id: this.active.organizationId,
          session_id: this.active.sessionId,
          latitude: finalLat,
          longitude: finalLng,
          accuracy: finalAcc,
          captured_at: new Date().toISOString(),
          source: 'mobile_native',
        },
        { headers, timeout: 15000 },
      );
      await this.persistRolledTokens(res);
    } catch (e) {
      if (axios.isAxiosError(e)) {
        console.log('[HRMS] /end failed', e.response?.status, e.message);
      } else {
        console.log('[HRMS] /end error', e);
      }
    }
  }

  /**
   * Public flush (called from foreground resume + heartbeat + buffer-full).
   */
  async flush(): Promise<void> {
    if (!this.active || this.flushInFlight) return;
    const now = Date.now();
    if (this.buffer.length === 0) {
      if (now - this.lastKeepaliveAt < TRACKING_KEEPALIVE_INTERVAL_MS) return;
    } else {
      if (now - this.lastFlushAt < TRACKING_MIN_FLUSH_GAP_MS) return;
    }

    this.flushInFlight = true;
    this.lastFlushAt = now;
    const sending = this.buffer.slice(0, TRACKING_MAX_POINTS_PER_BATCH);
    const session = this.active;

    try {
      const headers = await this.authHeaders();
      const res = await axios.post(
        `${TRACKING_API_BASE}${TRACKING_PATH_BATCH}`,
        {
          employee_id: session.employeeId,
          organization_id: session.organizationId,
          session_id: session.sessionId,
          source: 'mobile_native',
          points: sending,
        },
        { headers, timeout: 20000, validateStatus: () => true },
      );

      await this.persistRolledTokens(res);

      const body = res?.data ?? {};
      const realStatus = (typeof body.status === 'number' ? body.status : null) ?? res.status;

      if (realStatus === 200 || realStatus === 202) {
        if (sending.length > 0) {
          this.buffer = this.buffer.slice(sending.length);
          await this.persistBuffer();
          debugToast(`✅ /batch OK — sent ${sending.length} pts | buf=${this.buffer.length}`, true);
        } else {
          debugToast('💓 Keepalive OK', true);
        }
        this.lastKeepaliveAt = Date.now();
        await AsyncStorage.setItem(TRACKING_STORAGE.LAST_ACTIVITY_TS, new Date().toISOString());
      } else if (realStatus === 410) {
        await this.handleSessionExpired();
      } else if (realStatus === 401) {
        await this.handleAuthExpired();
      } else if (realStatus >= 500) {
        console.log('[HRMS] /batch 5xx, retaining buffer', realStatus, body.message);
        debugToast(`❌ /batch ${realStatus} server err — retrying`, true);
      } else if (realStatus === 429) {
        console.log('[HRMS] /batch 429 rate-limited, retaining buffer for next cycle');
        debugToast('❌ /batch 429 rate-limited', true);
      } else {
        console.log('[HRMS] /batch 4xx, dropping batch', realStatus, body.message);
        debugToast(`❌ /batch ${realStatus} — dropped`, true);
        this.buffer = this.buffer.slice(sending.length);
        await this.persistBuffer();
      }
    } catch (e) {
      if (axios.isAxiosError(e)) {
        console.log('[HRMS] /batch network error', e.message);
      } else {
        console.log('[HRMS] /batch error', e);
      }
    } finally {
      this.flushInFlight = false;
    }
  }

  async flushNow(): Promise<void> {
    this.lastFlushAt = 0;
    return this.flush();
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => { });
    }, TRACKING_FLUSH_INTERVAL_MS);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ── GPS (react-native-geolocation-service — already installed) ────────────
  private startGPS(): void {
    if (this.watchId !== null) return;
    this.attachWatchPosition();
    this.attachActivePoller();
    this.attachAccelerometerMotionDetection();

    // Legacy 5-min heartbeat — redundant safety net in case the active
    // poller is throttled by an aggressive OEM battery saver. Cheap to keep.
    this.heartbeatTimer = setInterval(() => {
      Geolocation.getCurrentPosition(
        (pos) => this.handleLocation(pos),
        () => { /* swallow — active poller handles error reporting */ },
        {
          enableHighAccuracy: true,
          timeout: 20000,
          maximumAge: 60000,
          forceRequestLocation: true,
        } as any,
      );
      this.flush().catch(() => { });
    }, TRACKING_HEARTBEAT_MS);

    this.netInfoUnsub = NetInfo.addEventListener((state) => {
      if (state.isConnected) this.flush().catch(() => { });
    });
  }

  /**
   * Build watchPosition options based on the current motion state and
   * subscribe. ACTIVE = high-accuracy + tight distanceFilter (5 m); STATIONARY
   * = balanced-accuracy + loose distanceFilter (25 m). The chip uses Wi-Fi /
   * cell positioning in stationary mode, dramatically cutting battery.
   */
  private attachWatchPosition(): void {
    // Drop any existing event subscription before re-subscribing (motion-state change path).
    this.locationSub?.remove();
    this.locationSub = null;

    const isActive = this.motionState === 'active';
    const distanceFilter = isActive ? ACTIVE_DISTANCE_FILTER_M : STATIONARY_DISTANCE_FILTER_M;

    if (Platform.OS === 'android') {
      // react-native-geolocation-service v5.3 silently ignores the foregroundService
      // option — LocationUpdatesService does not exist in that library's source.
      // We drive location from our own HrmsLocationService which calls startForeground()
      // and posts the persistent notification correctly.
      const intervalMs = isActive ? 5000 : 30000;
      (NativeModules as any).HrmsLocation.startTracking(intervalMs, distanceFilter, isActive);
      this.locationSub = DeviceEventEmitter.addListener(
        'hrmsLocationChange',
        (pos) => this.handleLocation(pos),
      );
      this.watchId = -1; // sentinel: foreground service is running
      return;
    }

    // iOS — unchanged watchPosition path
    const watchOptions: any = {
      accuracy: { ios: isActive ? 'bestForNavigation' : 'hundredMeters' },
      distanceFilter,
      enableHighAccuracy: isActive,
      allowsBackgroundLocationUpdates: true,
      showsBackgroundLocationIndicator: true,
      pausesLocationUpdatesAutomatically: false,
      activityType: 'other',
    };

    this.watchId = Geolocation.watchPosition(
      (pos) => this.handleLocation(pos),
      (err) => {
        console.log('[HRMS] GPS error', err.code, err.message);
        if (err.code === 1) this.emit('permission_denied', { reason: 'denied_at_runtime' });
        else if (err.code === 2) this.emit('permission_denied', { reason: 'provider_disabled' });
      },
      watchOptions,
    );
  }

  /**
   * Active poller — guarantees one reading every ACTIVE_POLL_MS (10 s) or
   * STATIONARY_POLL_MS (60 s) regardless of movement. Closes the "GPS chip
   * silent because employee isn't moving" gap.
   */
  private attachActivePoller(): void {
    const pollMs = this.motionState === 'active' ? ACTIVE_POLL_MS : STATIONARY_POLL_MS;
    this.activePollTimer = setInterval(() => {
      Geolocation.getCurrentPosition(
        (pos) => this.handleLocation(pos),
        (err) => {
          if (err.code !== 3) {
            console.log('[HRMS] active-poll GPS error', err.code, err.message);
          }
          if (err.code === 1) this.emit('permission_denied', { reason: 'denied_at_runtime' });
          if (err.code === 2) this.emit('permission_denied', { reason: 'provider_disabled' });
        },
        {
          enableHighAccuracy: this.motionState === 'active',
          timeout: 8000,

          maximumAge: this.motionState === 'active' ? ACTIVE_POLL_MS : STATIONARY_POLL_MS,
          forceRequestLocation: this.motionState === 'active',
        } as any,
      );
    }, pollMs);
  }

  private stopGPS(): void {
    if (this.watchId !== null) {
      if (Platform.OS === 'android') {
        (NativeModules as any).HrmsLocation?.stopTracking?.();
      } else {
        Geolocation.clearWatch(this.watchId);
      }
      this.watchId = null;
    }
    this.locationSub?.remove();
    this.locationSub = null;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.activePollTimer) {
      clearInterval(this.activePollTimer);
      this.activePollTimer = null;
    }
    this.detachAccelerometerMotionDetection();
    this.netInfoUnsub?.();
    this.netInfoUnsub = null;
    this.stopFlushTimer();
  }

  restartGPSIfDead(): void {
    if (!this.active) return;
    const staleMs = Date.now() - this.lastHandledAt;
    const thresholdMs = (this.motionState === 'active' ? ACTIVE_POLL_MS : STATIONARY_POLL_MS) * 3;
    // lastHandledAt === 0 means no fix has ever arrived — let the normal
    // startup path handle it; don't restart before the first fix has had time.
    if (this.lastHandledAt === 0 || staleMs <= thresholdMs) return;
    console.log(`[HRMS] GPS stale for ${Math.round(staleMs / 1000)} s — restarting`);
    this.stopGPS();   // clears watchId, freeing the startGPS guard
    this.startGPS();
    if (!this.flushTimer) this.startFlushTimer();
  }

  // ── Public API ────────────────────────────────────────────────────────────
  async requestPermission(): Promise<boolean> {
    return this.hasLocationPermission();
  }

  async start(employeeId: number, organizationId: number): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      if (this.active && this.active.employeeId === employeeId) {
        this.emit('tracking_started', {
          employee_id: employeeId,
          organization_id: organizationId,
          session_id: this.active.sessionId,
          resumed: true,
        });
        return;
      }

      // Reset the Kalman filter — fresh session = fresh state.
      this.kalmanReset();

      if (this.active && this.active.employeeId !== employeeId) {
        await this.stop();
      }

      const granted = await this.hasLocationPermission();
      if (!granted) {
        this.emit('permission_denied');
        openAppSettings();
        return;
      }

      const previousSessionId = await AsyncStorage.getItem(trackingSessionKey(employeeId));
      if (previousSessionId) {
        await AsyncStorage.removeItem(trackingSessionKey(employeeId));
        await AsyncStorage.removeItem(trackingBufferKey(previousSessionId));
        console.log('[HRMS] cleared stale session before fresh start:', previousSessionId);
      }

      const sessionId = await this.startSession(employeeId, organizationId);
      if (!sessionId) {
        this.emit('start_failed');
        return;
      }
      await AsyncStorage.setItem(trackingSessionKey(employeeId), sessionId);
      const resumed = false;

      this.active = { employeeId, organizationId, sessionId };
      await AsyncStorage.multiSet([
        [TRACKING_STORAGE.EMPLOYEE_ID, String(employeeId)],
        [TRACKING_STORAGE.ORG_ID, String(organizationId)],
        [TRACKING_STORAGE.LAST_ACTIVITY_TS, new Date().toISOString()],
      ]);

      await this.loadBufferFromDisk(sessionId);

      try {
        this.startGPS();
      } catch (e) {
        console.log('[HRMS] startGPS failed', e);
        this.emit('start_failed');
        return;
      }
      this.startFlushTimer();

      // Android: one-time battery-optimisation exemption prompt.
      if (Platform.OS === 'android') {
        const asked = await AsyncStorage.getItem(TRACKING_BATTERY_OPT_KEY);
        if (!asked) {
          await AsyncStorage.setItem(TRACKING_BATTERY_OPT_KEY, 'true');
          try {
            const pkg = DeviceInfo.getBundleId();
            await Linking.openURL(
              `intent:#Intent;action=android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS;data=package:${pkg};end`,
            );
          } catch (e) {
            console.log('[HRMS] battery-opt request failed', e);
            openAppSettings();
          }
        }

        // OEM-specific autostart / protected-apps whitelist (Samsung, Xiaomi,
        // OPPO, Huawei, OnePlus). Shown once, separately from the standard dialog
        // above, so both prompts are seen even if the user dismisses one.
        const oemAsked = await AsyncStorage.getItem('tracking_oem_battery_asked');
        if (!oemAsked && BatteryOptimization) {
          await AsyncStorage.setItem('tracking_oem_battery_asked', 'true');
          BatteryOptimization.launchOemSettings().catch(() => { });
        }
      }

      this.emit('tracking_started', {
        employee_id: employeeId,
        organization_id: organizationId,
        session_id: sessionId,
        resumed,
      });
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    if (!this.active) {
      console.log('[HRMS] STOP_TRACKING received with no active session');
      return;
    }
    const session = this.active;

    try { await this.flushNow(); } catch { }

    await this.endSession();
    this.stopGPS();

    await AsyncStorage.multiRemove([
      trackingSessionKey(session.employeeId),
      trackingBufferKey(session.sessionId),
      TRACKING_STORAGE.EMPLOYEE_ID,
      TRACKING_STORAGE.ORG_ID,
      TRACKING_STORAGE.LAST_ACTIVITY_TS,
    ]);
    this.active = null;
    this.buffer = [];
    this.kalmanReset();
    this.emit('tracking_stopped');
  }

  async resumeIfPossible(): Promise<void> {
    try {
      const [empIdRaw, orgIdRaw, lastTsRaw] = await Promise.all([
        AsyncStorage.getItem(TRACKING_STORAGE.EMPLOYEE_ID),
        AsyncStorage.getItem(TRACKING_STORAGE.ORG_ID),
        AsyncStorage.getItem(TRACKING_STORAGE.LAST_ACTIVITY_TS),
      ]);
      if (!empIdRaw || !orgIdRaw) return;
      const employeeId = Number(empIdRaw);
      const organizationId = Number(orgIdRaw);
      if (!Number.isFinite(employeeId) || !Number.isFinite(organizationId)) return;

      const sessionId = await AsyncStorage.getItem(trackingSessionKey(employeeId));
      if (!sessionId) return;

      const lastTs = lastTsRaw ? Date.parse(lastTsRaw) : 0;
      if (!lastTs || Date.now() - lastTs > TRACKING_RESUME_WINDOW_MS) {
        await AsyncStorage.multiRemove([
          trackingSessionKey(employeeId),
          trackingBufferKey(sessionId),
          TRACKING_STORAGE.EMPLOYEE_ID,
          TRACKING_STORAGE.ORG_ID,
          TRACKING_STORAGE.LAST_ACTIVITY_TS,
        ]);
        return;
      }

      const granted = await this.hasLocationPermission();
      if (!granted) return;

      this.active = { employeeId, organizationId, sessionId };
      await this.loadBufferFromDisk(sessionId);
      try {
        this.startGPS();
      } catch (e) {
        console.log('[HRMS] resumeIfPossible: startGPS failed — clearing active session', e);
        this.active = null;
        return;
      }
      this.startFlushTimer();
      this.emit('tracking_started', {
        employee_id: employeeId,
        organization_id: organizationId,
        session_id: sessionId,
        resumed: true,
      });
    } catch (e) {
      console.log('[HRMS] resumeIfPossible error', e);
    }
  }

  destroy(): void {
    this.stopGPS();
  }
}
