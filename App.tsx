import 'react-native-get-random-values';
import React, { useRef, useState, useEffect, useCallback } from "react";
import messaging from '@react-native-firebase/messaging';
import notifee, { EventType } from '@notifee/react-native';
import { initFCM, getFCMToken } from './src/services/fcmService';
import { rememberSession, syncDeviceToken, configureApiBase } from './src/services/deviceToken';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  useColorScheme,
  Modal,
  Platform,
  Dimensions,
  NativeModules,
  PermissionsAndroid,
  AppState,
  ToastAndroid,
  DeviceEventEmitter,
  BackHandler,
  Alert,
} from "react-native";

const { BatteryOptimization } = NativeModules;
import { WebView, type WebView as WebViewType } from "react-native-webview";
import AsyncStorage from "@react-native-async-storage/async-storage";
import RNBootSplash from "react-native-bootsplash";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useNetInfo } from "@react-native-community/netinfo";
import NetInfo from "@react-native-community/netinfo";
import CryptoJS from 'crypto-js';
import DeviceInfo from 'react-native-device-info';
import axios from 'axios';
import { Linking } from 'react-native';
import Share from 'react-native-share';
import ReactNativeBlobUtil from 'react-native-blob-util';
import Geolocation from 'react-native-geolocation-service';


const API_BASE = 'https://node.heritageimshospital.com';

const WEB_BASE = 'https://ray.heritageimshospital.com';

// react-native-webview's error event only populates `domain` on iOS/macOS
// (see WebViewTypes.ts: "`domain` is only used on iOS and macOS") — on
// Android it's always undefined by construction, not something fixable from
// this file. Show the host we actually know we're loading instead.
const WEB_BASE_HOST = WEB_BASE.replace(/^https?:\/\//, '');

// WebView-only: the app loads WEB_BASE (root) and the web app handles auth
// itself. We only need to recognise the web login route so we can (a) trigger
// the auth-token sync when the user is on an authenticated page and (b) tear
// down tracking when the web logs out / the session expires.
const WEB_LOGIN_PATH = '/login';
const isOnLoginPage = (url: string): boolean =>
  !!url && url.toLowerCase().includes(WEB_LOGIN_PATH);
// ─────────────────────────────────────────────────────────────────────────────

// ─── Build/version gate ──────────────────────────────────────────────────────
// Checked once on every app launch. The backend returns a status that decides
// whether the app is fine, should nudge (soft) or must block (force) an
// update, or is in maintenance. Fails open on any network/API error so a
// transient outage never locks users out of an otherwise-working app.
const BUILD_MANAGEMENT_API = `${API_BASE}/api/v1/build_management/check_update_required`;
const ITUNES_URL = 'https://apps.apple.com/in/app/healthray-dr-for-doctors/id1513592834';
const PLAYSTORE_URL = 'https://play.google.com/store/apps/details?id=com.healthray.doctor&hl=en_IN';
// ─────────────────────────────────────────────────────────────────────────────

// A WebView load error (e.g. DNS failure) doesn't necessarily flip NetInfo's
// isConnected — the device can be online at the link layer while the domain
// fails to resolve. So on top of the reconnect-triggered reload, self-heal
// with a capped backoff; after these are exhausted the user still has the
// "Try Again" button in the error screen (see renderWebViewError below).
const WEB_LOAD_RETRY_DELAYS_MS = [3000, 6000, 12000, 20000];

// ─── HRMS tracking constants ─────────────────────────────────────────────────
// Native owns auth + base URL, so the WebView never sends them in the
// START_TRACKING / STOP_TRACKING bridge payload.
const TRACKING_API_BASE = API_BASE;
const TRACKING_PATH_START = '/api/v1/hrms/attendance/tracking/start';
const TRACKING_PATH_BATCH = '/api/v1/hrms/attendance/tracking/batch';
const TRACKING_PATH_END = '/api/v1/hrms/attendance/tracking/end';

const makeRequestId = (): string => {
  const timestamp = Date.now().toString();
  const salt = Math.random().toString(36).substring(2, 15);
  const hash = CryptoJS.SHA256(timestamp + salt);
  return hash.toString(CryptoJS.enc.Hex);
};

// Buffer / batch parameters
const TRACKING_FLUSH_INTERVAL_MS = 30_000;     // flush every 30 s
const TRACKING_MIN_FLUSH_GAP_MS = 10_000;     // 10 s minimum between /batch calls (was 20 s)
const TRACKING_KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000; // keepalive every 5 min when buffer is empty
const TRACKING_MAX_POINTS_PER_BATCH = 50;      // hard server batch cap
const TRACKING_MAX_BUFFER_POINTS = 500;        // hard local buffer cap (drop oldest)
const TRACKING_ACCURACY_MAX_M = 100;        // 100 m passes network-assisted fixes on OnePlus/urban GPS (was 50)

// ── Path-3 client-side Kalman filter (Part B Path 3) ──────────────────────
// Smooths the GPS readings using only the GPS chip's own output (no IMU
// access from JS-land). The filter weights each new reading against the
// previous smoothed estimate using the chip's reported `accuracy` field
// as observation variance. This eliminates the worst per-frame jitter
// and reduces zigzag in stationary-cluster cases without any native code.
//
// Process noise Q (in m²/s) controls how much we trust new readings vs
// the model. Higher Q = trust readings more (faster reaction to real
// movement). Lower Q = trust history more (smoother but laggy).
//   Q = 4 m²/s ≈ "user is moving at walking pace"
//   Q = 25      ≈ "user is in a vehicle"
// We pick 8 — a compromise that handles both reasonably well for HRMS.
const KALMAN_PROCESS_NOISE_M2_PER_S = 8;            // active (moving) — reacts quickly to real displacement
const KALMAN_PROCESS_NOISE_STATIONARY_M2_PER_S = 0.5; // stationary — trusts accumulated history, suppresses jitter
// Initial variance assumed for the very first reading (m²). Picked large
// enough that the first observation almost fully overrides the prior.
const KALMAN_INITIAL_VARIANCE_M2 = 1e6;
// If two consecutive readings are >this many seconds apart, reset the
// filter — the gap is too large to predict through reliably.
const KALMAN_RESET_GAP_S = 90;   // must be > STATIONARY_POLL_MS/1000 (60 s) for filter to work when still
const TRACKING_RESUME_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 h session resume window
const TRACKING_HEARTBEAT_MS = 5 * 60 * 1000; // legacy stationary heartbeat (kept as fallback)

// ── Adaptive sampling (battery-aware) ─────────────────────────────────────
// We toggle between two modes based on observed GPS velocity:
//   • ACTIVE     — employee moving. Highest sampling cadence; high-accuracy
//                  GPS chip mode. Captures every 5 m of movement.
//   • STATIONARY — employee at a desk / standing still. 6× less frequent
//                  polling, "balanced" accuracy mode (Wi-Fi + cell first,
//                  GPS occasionally). ~50% battery savings overall on a
//                  desk-heavy workday.
//
// State machine:
//   • Any reading with avg-of-window speed > MOTION_THRESHOLD_MPS → ACTIVE
//     (immediate — we don't want to miss the start of a journey)
//   • Three consecutive readings with avg speed < STILL_THRESHOLD_MPS
//     → STATIONARY (hysteresis prevents flapping on slow walking)
const ACTIVE_DISTANCE_FILTER_M = 5;
const STATIONARY_DISTANCE_FILTER_M = 25;
const ACTIVE_POLL_MS = 10_000;   // 10 s while moving
const STATIONARY_POLL_MS = 60_000;   // 60 s while still
const MOTION_THRESHOLD_MPS = 1.0;      // ~3.6 km/h — switch to ACTIVE on any reading at/above this
const STILL_THRESHOLD_MPS = 0.5;      // ~1.8 km/h — N consecutive readings below → STATIONARY
const STILL_CONSECUTIVE_REQUIRED = 3;
// Backwards-compat alias for the legacy "active poll" constant referenced
// in older comments. Kept so nothing reads a stale value.
const TRACKING_ACTIVE_POLL_MS = ACTIVE_POLL_MS;

// ── Debug toasts — set HRMS_DEBUG_TOASTS = false or delete this block to remove ──
const HRMS_DEBUG_TOASTS = true;
const debugToast = (msg: string, long = false): void => {
  if (!HRMS_DEBUG_TOASTS || Platform.OS !== 'android') return;
  ToastAndroid.show(msg, long ? ToastAndroid.LONG : ToastAndroid.SHORT);
};

// ── Accelerometer-driven motion detection (Path 1 — battery + accuracy) ──
// Optional. If `react-native-sensors` is installed, we subscribe to the
// accelerometer at 5 Hz and detect motion via the variance of acceleration
// magnitude over a sliding window. Detects motion ~10× faster than the
// GPS-velocity heuristic (1-3 s vs 30 s) and lets us drop GPS to balanced
// accuracy the moment the phone goes still.
//
// If the lib isn't installed, this code is a silent no-op; the tracker
// falls back to the GPS-velocity heuristic in `updateMotionState`.
//
// Mobile team upgrade path: replace the accelerometer source with native
// OS Activity Recognition (Android `ActivityRecognitionClient` / iOS
// `CMMotionActivityManager`) for even better detection. The tracker's
// public API `setExternalMotionState(state)` is the single integration point.
const ACCEL_SAMPLE_HZ = 5;
const ACCEL_WINDOW_SIZE = 15;     // 3 seconds @ 5 Hz
const ACCEL_STILL_VARIANCE_THRESHOLD = 0.05;   // m²/s⁴ — phone-on-desk noise floor
const ACCEL_MOVING_VARIANCE_THRESHOLD = 0.50;   // m²/s⁴ — clear motion (walking ≈ 0.3-2.0)

// Optional dependency — guarded require so the app still builds without it.
let _rnSensors: any = null;
try { _rnSensors = require('react-native-sensors'); } catch (e) { /* not installed */ }

/**
 * Great-circle distance in metres between two {lat, lng} points. Used by
 * the adaptive-sampling motion detector to compute speed from consecutive
 * GPS readings.
 */
function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Guarantees a point per 10 s instead of relying on watchPosition's
// distanceFilter+interval (which dropped 3-7 min gaps in the data).

// ── Auto-resume tuning (matches WebSocket-reconnect playbook) ───────────────
// Backend caps a session at 24h. When that fires (or a stray 410 arrives),
// we silently call /tracking/start again so the employee never sees it.
//
//   • 3 attempts with exponential backoff: 0 s → 1 s → 4 s
//   • Tight-loop guard: if a freshly-resumed session ALSO 410s within 60 s,
//     stop. That signals a fundamental problem (employee disabled, org gone)
//     that no amount of retrying will fix.
const TRACKING_AUTO_RESUME_MAX_ATTEMPTS = 3;
const TRACKING_AUTO_RESUME_BACKOFFS_MS = [0, 1000, 4000];
const TRACKING_AUTO_RESUME_TIGHT_LOOP_MS = 60_000;

// AsyncStorage keys per spec
const TRACKING_STORAGE = {
  EMPLOYEE_ID: 'tracking_employee_id',
  ORG_ID: 'tracking_organization_id',
  LAST_ACTIVITY_TS: 'tracking_last_activity_ts',
  AUTH_TOKEN: 'auth_token',
  DEVICE_TOKEN: 'device_token',
  FCM_TOKEN: 'fcm_registration_token',
};
const trackingSessionKey = (empId: number | string) => `tracking_session_id_${empId}`;
const trackingBufferKey = (sessionId: string) => `tracking_buffer_${sessionId}`;

const CURRENT_USER_KEY = 'CURRENT_USER';
const TRACKING_BATTERY_OPT_KEY = 'tracking_battery_opt_asked';

// ─── HRMS tracking types ─────────────────────────────────────────────────────
interface TrackingPoint {
  latitude: number;
  longitude: number;
  accuracy: number;
  captured_at: string; // ISO UTC — GPS measurement time (position.timestamp)
}

type TrackingStatus =
  | 'tracking_started'
  | 'tracking_stopped'
  | 'tracking_resumed'        // auto-resume after backend 24h cap (silent renew)
  | 'permission_denied'
  | 'notification_permission_denied' // POST_NOTIFICATIONS denied — tracking works but no status-bar indicator
  | 'session_expired'         // emitted only when auto-resume gives up
  | 'auth_expired'
  | 'start_failed';

interface TrackingActiveSession {
  employeeId: number;
  organizationId: number;
  sessionId: string;
}

// ─── HRMS Location Tracker (module-level singleton) ──────────────────────────
// Lives outside React tree so GPS callbacks that fire after unmount or after
// an app-kill resume never reference a stale instance.
class HRMSLocationTracker {
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

const hrmsTracker = new HRMSLocationTracker();

async function openAppSettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch (e) {
    console.log('[Bridge] openAppSettings error', e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

const { width } = Dimensions.get('window');
const IS_TABLET = width >= 768;

export default function App() {
  const mode = useColorScheme();
  return (
    <SafeAreaProvider>
      <StatusBar
        barStyle={mode === "dark" ? "light-content" : "dark-content"}
      />
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  console.log("App Rendered ==========================");
  const webRef = useRef<WebViewType>(null);

  const prevInternetRef = useRef<boolean | null>(null);
  const isOnlineRef = useRef<boolean>(false);
  const canGoBackRef = useRef(false);        // WebView has history (for Android hardware back)
  const webErroredRef = useRef(false);       // WebView had a load error → reload on reconnect
  const errorRetryCountRef = useRef(0);      // auto-retry attempts for the current error streak (capped)
  const errorRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fcmTokenRef = useRef<string>('');    // cached FCM device token (for WEB_AUTH_TOKENS sync)
  const authSyncedRef = useRef(false);       // web auth token pulled into AsyncStorage this session
  const lastBackPressRef = useRef(0);        // ms timestamp of last root back-press (double-tap-to-exit)
  const splashHiddenRef = useRef(false);     // BootSplash.hide() called exactly once

  const { isConnected, isInternetReachable } = useNetInfo();

  const [initialWebUrl, setInitialWebUrl] = useState(`${WEB_BASE}/`);
  const [netInfoReady, setNetInfoReady] = useState(false);
  const showInternetModel = netInfoReady && isConnected === false;

  // Version gate (see BUILD_MANAGEMENT_API above). Non-null blocks the WebView
  // entirely in favor of a dedicated screen — see the early return below.
  const [forceUpdateMessage, setForceUpdateMessage] = useState<string | null>(null);
  const [forceUpdateStoreUrl, setForceUpdateStoreUrl] = useState('');
  const [maintenanceMessage, setMaintenanceMessage] = useState<string | null>(null);

  // Splash: dismiss it once the WebView paints its first page (see handleLoadEnd
  // and the WebView onError handler). The safety timer guarantees the splash is
  // never stuck if no load event fires (e.g. an offline cold start).
  const hideSplashOnce = useCallback(() => {
    if (splashHiddenRef.current) return;
    splashHiddenRef.current = true;
    RNBootSplash.hide({ fade: true });
  }, []);

  useEffect(() => {
    const t = setTimeout(hideSplashOnce, 6000);
    return () => clearTimeout(t);
  }, [hideSplashOnce]);

  // The version-gate screens below replace the WebView, so nothing will ever
  // fire the WebView's onLoadEnd to dismiss the splash — do it here instead.
  useEffect(() => {
    if (forceUpdateMessage || maintenanceMessage) hideSplashOnce();
  }, [forceUpdateMessage, maintenanceMessage, hideSplashOnce]);

  // Runs once per app launch, before the WebView loads anything. A network/API
  // failure is swallowed (fail open) — see comment at BUILD_MANAGEMENT_API.
  useEffect(() => {
    const getStoreUrl = (data: any): string => {
      if (Platform.OS === 'ios') return data?.ios_app_url || ITUNES_URL;
      return data?.android_app_url || PLAYSTORE_URL;
    };

    (async () => {
      try {
        const res = await axios.post(
          BUILD_MANAGEMENT_API,
          {
            platform: Platform.OS === 'ios' ? 'iOS' : 'Android',
            current_version: DeviceInfo.getVersion(),
            user_type: 'D',
          },
          {
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            timeout: 15000,
          },
        );

        const { status, message, data } = res.data ?? {};

        if (status === 701) {
          // Force update: block the app. No dismiss path — the screen stays up
          // for the rest of this session; the gate re-checks on the next launch.
          setForceUpdateStoreUrl(getStoreUrl(data));
          setForceUpdateMessage(message || 'A new version is available. Please update to continue.');
        } else if (status === 702) {
          const storeUrl = getStoreUrl(data);
          Alert.alert(
            'Update Available',
            message || 'A new version is available.',
            [
              { text: 'Later', style: 'cancel' },
              { text: 'Update', onPress: () => Linking.openURL(storeUrl) },
            ],
          );
        } else if (status === 703) {
          setMaintenanceMessage(message || 'The app is currently under maintenance. Please try again later.');
        }
      } catch (e) {
        if (axios.isAxiosError(e)) {
          console.log('[VersionGate] check_update_required failed:', e.message);
        } else {
          console.log('[VersionGate] check_update_required failed:', e);
        }
      }
    })();
  }, []);

  // Pull the web session's auth token out of the WebView's localStorage and hand
  // it to native (WEB_AUTH_TOKENS) so HRMS tracking + ambulance push stay
  // authenticated without a native login. The web app stores everything under
  // localStorage['currentUser'] as { auth_token, deviceToken, ... }. The reader
  // retries because on a fresh login the nav event can beat Angular's write.
  const syncWebAuthTokens = useCallback(() => {
    webRef.current?.injectJavaScript(`
      (function(){
        var tries = 0;
        function grab(){
          try {
            var cu = JSON.parse(localStorage.getItem('currentUser') || '{}') || {};
            var auth = cu.auth_token || cu.authToken || localStorage.getItem('auth_token') || '';
            var dev = cu.deviceToken || cu.device_token || localStorage.getItem('device_token') || '';
            if (auth) {
              var isDriver = !!(cu.isDriver ||
                String(cu.user_type || cu.userType || cu.role || '').toLowerCase() === 'driver');
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'WEB_AUTH_TOKENS', auth_token: auth, device_token: dev, is_driver: isDriver
              }));
              return;
            }
          } catch(e) {}
          if (++tries < 5) setTimeout(grab, 300);
        }
        grab();
      })(); true;
    `);
  }, []);

  useEffect(() => {
    const requestPermissions = async () => {
      if (Platform.OS === 'android') {
        const perms: string[] = [
          PermissionsAndroid.PERMISSIONS.CAMERA,
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        ];
        // Android 13+ (API 33) requires runtime POST_NOTIFICATIONS grant
        if ((PermissionsAndroid.PERMISSIONS as any).POST_NOTIFICATIONS) {
          perms.push((PermissionsAndroid.PERMISSIONS as any).POST_NOTIFICATIONS);
        }
        const results = await PermissionsAndroid.requestMultiple(perms as any);
        const notifPerm = (results as any)['android.permission.POST_NOTIFICATIONS'];
        if (notifPerm && notifPerm !== 'granted') {
          console.log('[PERMISSIONS] ⚠ POST_NOTIFICATIONS not granted:', notifPerm);
        }
      }
    };
    requestPermissions();
  }, []);

  // ─── Firebase Cloud Messaging ─────────────────────────────────────────────
  useEffect(() => {
    configureApiBase(API_BASE);

    let unsubscribeFcm: () => void = () => { };

    initFCM((newToken) => {
      // Only update the in-memory ref here.
      // syncDeviceToken is handled exclusively by index.js onTokenRefresh
      // so we never fire two concurrent refresh_token API calls for the same rotation.
      fcmTokenRef.current = newToken;
    }).then(({ token, unsubscribe: unsub }) => {
      unsubscribeFcm = unsub;
      if (token) {
        fcmTokenRef.current = token;
        console.log('[FCM] ✅ Token ready:', token);
      } else {
        console.log('[FCM] ⚠ Token empty — check [FCM] logs in fcmService');
      }
    }).catch((e) => {
      console.log('[FCM] ❌ initFCM error:', e?.message ?? e);
    });

    syncDeviceToken();

    const unsubscribeBgTap = messaging().onNotificationOpenedApp((remoteMessage: any) => {
      const type = remoteMessage?.data?.notification_type;
      if (type === 'AMBULANCE_CALL_DISPATCHED' || type === 'AMBULANCE_CALL_REASSIGNED') {
        setTimeout(() => {
          webRef.current?.injectJavaScript(`window.location.href = '/ambulance'; true;`);
        }, 500);
      }
    });

    notifee.getInitialNotification().then(initial => {
      if (initial?.notification?.data?.call_id) {
        setInitialWebUrl(`${WEB_BASE}/ambulance`);
      }
    });

    const unsubscribeNotifee = notifee.onForegroundEvent(({ type, detail }) => {
      if (type === EventType.PRESS && detail.notification?.data?.call_id) {
        webRef.current?.injectJavaScript(`window.location.href = '/ambulance'; true;`);
      }
    });

    return () => {
      unsubscribeFcm();
      unsubscribeBgTap();
      unsubscribeNotifee();
    };
  }, []);
  // ─────────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!netInfoReady) return;
    const isOnline = isConnected !== false;
    isOnlineRef.current = isOnline;

    if (prevInternetRef.current === false && isOnline) {
      // Back online: reload the WebView if its last load errored, so a page that
      // failed while offline recovers automatically.
      if (webErroredRef.current && webRef.current) {
        webErroredRef.current = false;
        if (errorRetryTimerRef.current) {
          clearTimeout(errorRetryTimerRef.current); // don't double-reload against the pending backoff retry
          errorRetryTimerRef.current = null;
        }
        errorRetryCountRef.current = 0;
        webRef.current.reload();
      }
    }
    prevInternetRef.current = isOnline;
  }, [isConnected, isInternetReachable, netInfoReady]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setNetInfoReady(true);
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

  // App foreground → drain HRMS buffer immediately
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (nextAppState) => {
      if (nextAppState !== 'active') return;
      if (hrmsTracker.getActiveSession()) {

        hrmsTracker.restartGPSIfDead();
        if (isOnlineRef.current) hrmsTracker.flushNow().catch(() => { });
      }
      // Re-pull the web auth token on every foreground so a token the web/HRMS
      // backend rotated while we were backgrounded is refreshed in native
      // storage. The WEB_AUTH_TOKENS handler no-ops when the token is unchanged.
      if (authSyncedRef.current) syncWebAuthTokens();
      // A user who backgrounds the app to fix their network/DNS shouldn't have
      // to sit through the remaining backoff delay when they come back.
      if (webErroredRef.current && webRef.current) {
        webErroredRef.current = false;
        if (errorRetryTimerRef.current) {
          clearTimeout(errorRetryTimerRef.current);
          errorRetryTimerRef.current = null;
        }
        errorRetryCountRef.current = 0;
        webRef.current.reload();
      }
    });
    return () => sub.remove();
  }, [syncWebAuthTokens]);

  // ─── HRMS tracker: status emitter + resume on launch ───────────────────────
  useEffect(() => {
    hrmsTracker.setStatusEmitter((status, detail) => {
      const payload = JSON.stringify({ status, ...(detail ?? {}) });
      const script = `
        (function(){
          try {
            window.dispatchEvent(new CustomEvent('NATIVE_TRACKING_STATUS', { detail: ${payload} }));
          } catch(e) {}
        })(); true;
      `;
      try {
        webRef.current?.injectJavaScript(script);
      } catch (e) {
        console.log('[HRMS] failed to dispatch status', status, e);
      }

      if (status === 'auth_expired') {
        // Native token expired (tracking hit a 401). In a webview-only app there
        // is no native login to fall back to, so DON'T reload or redirect the
        // WebView. Clear the stale native token and try to re-read a possibly
        // refreshed one from the still-live web session; if the web is also
        // logged out it will navigate to /login and the logout path takes over.
        AsyncStorage.multiRemove([
          TRACKING_STORAGE.AUTH_TOKEN,
          TRACKING_STORAGE.DEVICE_TOKEN,
        ]).catch(() => { });
        authSyncedRef.current = false;
        syncWebAuthTokens();
      }
    });

    hrmsTracker.resumeIfPossible().catch((e) =>
      console.log('[HRMS] resume failed', e),
    );

    return () => {
      hrmsTracker.destroy();
    };
  }, []);


  // Android hardware back → step back through WebView history; at the root
  // (no web history) double-tap to exit so a stray back press doesn't drop the
  // user out of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBackRef.current && webRef.current) {
        webRef.current.goBack();
        return true;
      }
      const now = Date.now();
      if (now - lastBackPressRef.current < 2000) {
        BackHandler.exitApp();
        return true;
      }
      lastBackPressRef.current = now;
      if (Platform.OS === 'android') {
        ToastAndroid.show('Press back again to exit', ToastAndroid.SHORT);
      }
      return true;
    });
    return () => sub.remove();
  }, []);

  // onLoadEnd fires on BOTH success and failure (the library calls it right
  // after onError too), so it must never be the thing that clears the error
  // flag — that used to happen here and silently defeated every recovery path
  // below it. It only owns dropping the splash.
  const handleLoadEnd = (_e: any) => {
    hideSplashOnce(); // first paint (or first failure) → drop the native splash
  };

  const clearWebLoadRetry = useCallback(() => {
    if (errorRetryTimerRef.current) {
      clearTimeout(errorRetryTimerRef.current);
      errorRetryTimerRef.current = null;
    }
  }, []);

  // Success-only: onLoad fires only via the library's success path, never the
  // error path, so it's the correct place to clear the error state.
  const handleWebLoadSuccess = useCallback(() => {
    webErroredRef.current = false;
    errorRetryCountRef.current = 0;
    clearWebLoadRetry();
  }, [clearWebLoadRetry]);

  // Self-heal with a capped backoff — a DNS/transient failure doesn't
  // necessarily flip NetInfo's isConnected, so this is the only automatic
  // retry path for that case. Exhausting it just leaves the manual "Try
  // Again" button in the error screen as the fallback.
  const scheduleWebLoadRetry = useCallback(() => {
    if (errorRetryTimerRef.current) return; // already scheduled
    const attempt = errorRetryCountRef.current;
    if (attempt >= WEB_LOAD_RETRY_DELAYS_MS.length) return;
    errorRetryTimerRef.current = setTimeout(() => {
      errorRetryTimerRef.current = null;
      errorRetryCountRef.current += 1;
      webRef.current?.reload();
    }, WEB_LOAD_RETRY_DELAYS_MS[attempt]);
  }, []);

  const retryWebViewNow = useCallback(() => {
    clearWebLoadRetry();
    errorRetryCountRef.current = 0; // manual retry gets a fresh backoff budget next time
    webRef.current?.reload();
  }, [clearWebLoadRetry]);

  // Replaces the library's raw "Domain / Error Code / Description" default
  // (see node_modules/react-native-webview/src/WebViewShared.tsx) with a
  // screen that matches the rest of the app and actually gives the user a
  // way out instead of a dead end. Ignores the passed-in domain — it's
  // undefined on Android by construction (see WEB_BASE_HOST above) — and
  // shows WEB_BASE_HOST instead, which is always accurate.
  const renderWebViewError = useCallback(
    (_domain: string | undefined, _code: number, description: string) => (
      <View style={styles.webErrorOverlay}>
        <Text style={styles.gateTitle}>Can't Connect</Text>
        <Text style={styles.gateMessage}>
          Please check your internet connection and try again.
        </Text>
        <Text style={[styles.gateMessage, { fontSize: 12, color: '#999', marginTop: 8 }]}>
          {description}
        </Text>
        <TouchableOpacity
          style={[styles.button, { paddingHorizontal: 24, marginTop: 20 }]}
          onPress={retryWebViewNow}
        >
          <Text style={styles.buttonText}>Try Again</Text>
        </TouchableOpacity>
      </View>
    ),
    [retryWebViewNow],
  );

  useEffect(() => clearWebLoadRetry, [clearWebLoadRetry]);

  const handleNavigationStateChange = (navState: any) => {
    const url = (navState.url || '').toLowerCase();
    canGoBackRef.current = !!navState.canGoBack;

    if (isOnLoginPage(url)) {
      // On the web login page. If we were previously authenticated this session,
      // it's a logout / session-expiry: stop tracking (its /tracking/end must run
      // BEFORE we clear the token) and drop the stored auth so a logged-out
      // device neither tracks nor receives ambulance push.
      if (authSyncedRef.current) {
        authSyncedRef.current = false;
        (async () => {
          try { await hrmsTracker.stop(); } catch { }
          await AsyncStorage.multiRemove([
            TRACKING_STORAGE.AUTH_TOKEN,
            TRACKING_STORAGE.DEVICE_TOKEN,
            'user_role',
          ]).catch(() => { });
        })();
      }
      return;
    }

    // Authenticated page. Pull the web session's auth token into native storage
    // once per session — covers both a fresh web login and a stay-signed-in
    // relaunch that lands straight on an app page. Rotation is handled by the
    // foreground re-sync in the AppState effect.
    if (!authSyncedRef.current) {
      syncWebAuthTokens();
    }
  };

  const disableZoomScript = `
    (function () {
      var meta = document.createElement('meta');
      meta.setAttribute('name', 'viewport');
      meta.setAttribute(
        'content',
        'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no'
      );
      document.getElementsByTagName('head')[0].appendChild(meta);
    })();
    true;
  `;

  /* ================= WEB VIEW ================= */

  // Show the system location permission popup.
  // Falls back to App Settings only when permanently denied (OS blocks the dialog).
  const requestLocationPermission = async () => {
    if (Platform.OS === 'android') {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        {
          title: 'Location Permission',
          message: 'HealthRay needs your location to track your position.',
          buttonPositive: 'Allow',
          buttonNegative: 'Deny',
        },
      );
      if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
        await openAppSettings();
      } else {
        const granted = result === PermissionsAndroid.RESULTS.GRANTED;
        webRef.current?.injectJavaScript(`
          (function() {
            window.dispatchEvent(new CustomEvent('nativeLocationPermission', {
              detail: { granted: ${granted} }
            }));
          })(); true;
        `);
      }
    } else {
      const auth = await Geolocation.requestAuthorization('whenInUse');
      const granted = auth === 'granted';
      if (!granted) { await openAppSettings(); }
      webRef.current?.injectJavaScript(`
        (function() {
          window.dispatchEvent(new CustomEvent('nativeLocationPermission', {
            detail: { granted: ${granted} }
          }));
        })(); true;
      `);
    }
  };

  const handleMessage = async (event: any) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);

      // ─── PDF (existing) ──────────────────────────────────────────────────
      if (message?.type === 'pdf') {
        if (!message?.data) return;
        const base64Data = message.data.replace(/^data:[^;]+;base64,/, '').trim();

        if (Platform.OS === 'android') {
          const folderPath =
            ReactNativeBlobUtil.fs.dirs.DownloadDir + '/HealthrayDR/HealthrayDocument';
          const filePath = folderPath + '/Prescription.pdf';
          await ReactNativeBlobUtil.fs.mkdir(folderPath).catch(() => { });
          await ReactNativeBlobUtil.fs.writeFile(filePath, base64Data, 'base64');
          await ReactNativeBlobUtil.android.actionViewIntent(filePath, 'application/pdf');
        } else {
          const folderPath =
            ReactNativeBlobUtil.fs.dirs.DocumentDir + '/HealthrayDR/HealthrayDocument';
          const filePath = folderPath + '/Prescription.pdf';
          await ReactNativeBlobUtil.fs.mkdir(folderPath).catch(() => { });
          await ReactNativeBlobUtil.fs.writeFile(filePath, base64Data, 'base64');
          await Share.open({ url: 'file://' + filePath, type: 'application/pdf', failOnCancel: false });
        }
        return;
      }

      // ─── START_TRACKING (HRMS spec) ──────────────────────────────────────
      // Bridge contract:
      //   { type: 'START_TRACKING', payload: { employee_id: number, organization_id: number } }
      // Native owns: API base URL, auth token, device token, session_id.
      if (message?.type === 'START_TRACKING') {
        const payload = message?.payload ?? message?.data ?? {};
        const employeeId = Number(payload.employee_id ?? payload.employeeId);
        const organizationId = Number(
          payload.organization_id ?? payload.orgId ?? payload.organizationId,
        );

        if (!Number.isFinite(employeeId) || !Number.isFinite(organizationId)) {
          console.log('[HRMS] START_TRACKING missing employee_id or organization_id');
          return;
        }

        webRef.current?.injectJavaScript(`
          (function() {
            var raw = localStorage.getItem('currentUser');
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'CURRENT_USER_DATA',
              data: raw ? JSON.parse(raw) : null
            }));
          })();
          true;
        `);

        await hrmsTracker.start(employeeId, organizationId);
        return;
      }

      if (message?.type === 'WEB_AUTH_TOKENS') {
        const authToken: string = message?.auth_token ?? '';
        const webDeviceToken: string = message?.device_token ?? '';
        const isDriver: boolean = !!message?.is_driver;

        if (!authToken) {
          // Web session not ready yet (localStorage.currentUser has no token).
          // Leave authSyncedRef false so a later nav / foreground retries.
          console.log('[WEB_AUTH_TOKENS] ⚠ auth_token empty — web session not ready, will retry');
          return;
        }

        // We have a token → the session is synced for this app run, so the
        // nav-based injector stops re-firing. Rotation is caught by the
        // foreground re-sync in the AppState effect (re-reads localStorage).
        authSyncedRef.current = true;

        // Idempotent: if the token is unchanged from what we already stored, do
        // nothing. Without this guard, re-syncing on every nav/foreground would
        // thrash device_token (rememberSession → web token, syncDeviceToken →
        // FCM) and fire a redundant refresh_token call each time.
        const storedAuth = await AsyncStorage.getItem(TRACKING_STORAGE.AUTH_TOKEN);
        if (storedAuth === authToken) return;

        const nativeFcmToken = fcmTokenRef.current || await getFCMToken();
        console.log('[WEB_AUTH_TOKENS] new/changed token → storing session', {
          authToken: `${authToken.slice(0, 10)}...`,
          isDriver,
          fcm: nativeFcmToken ? 'present' : 'EMPTY',
        });

        // Store the web session (auth_token + web device_token + user_role). This
        // runs even when the FCM token isn't ready yet, because HRMS tracking +
        // the ambulance-push gate need auth_token regardless of FCM.
        await rememberSession(authToken, isDriver, webDeviceToken);
        // Swap the stored device_token to the native FCM token so backend push
        // targets this device. syncDeviceToken no-ops if the token is unchanged.
        if (nativeFcmToken) {
          await syncDeviceToken(nativeFcmToken);
          console.log('[WEB_AUTH_TOKENS] ✅ native FCM token synced to backend via refresh_token');
        } else {
          console.log('[WEB_AUTH_TOKENS] ⚠ native FCM token not ready — will sync on next foreground');
        }
        return;
      }

      // ─── CURRENT_USER_DATA ───────────────────────────────────────────────
      if (message?.type === 'CURRENT_USER_DATA') {
        const user = message?.data ?? null;
        await AsyncStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user));
        return;
      }

      // ─── STOP_TRACKING (HRMS spec) ───────────────────────────────────────
      if (message?.type === 'STOP_TRACKING') {
        await hrmsTracker.stop();
        return;
      }

      // ─── OPEN_LOCATION_SETTINGS (web retryGpsLostSession bridge) ───────────
      if (message?.type === 'OPEN_LOCATION_SETTINGS') {
        await requestLocationPermission();
        return;
      }

      // ─── REQUEST_LOCATION_PERMISSION (generic one-shot permission request) ─
      if (message?.type === 'REQUEST_LOCATION_PERMISSION') {
        const granted = await hrmsTracker.requestPermission();
        webRef.current?.injectJavaScript(`
          (function() {
            window.dispatchEvent(new CustomEvent('nativeLocationPermission', {
              detail: { granted: ${granted} }
            }));
          })(); true;
        `);
        return;
      }

      // ─── GET_LOCATION (one-shot bridge for navigator.geolocation) ────────
      if (message?.type === 'GET_LOCATION') {
        const callbackId: string = message?.data?.callbackId ?? '';
        if (!/^geo_\d+_\d+$/.test(callbackId)) {
          console.log('[HRMS] GET_LOCATION rejected — invalid callbackId shape');
          return;
        }
        Geolocation.getCurrentPosition(
          (pos) => {
            const { latitude, longitude, accuracy, altitude } = pos.coords;
            webRef.current?.injectJavaScript(`
              (function(){
                var cb = window.__nativeGeoCallbacks && window.__nativeGeoCallbacks['${callbackId}'];
                if(cb){
                  cb.success({ coords: { latitude: ${latitude}, longitude: ${longitude}, accuracy: ${accuracy}, altitude: ${altitude ?? null}, altitudeAccuracy: null, heading: null, speed: null }, timestamp: ${pos.timestamp} });
                  delete window.__nativeGeoCallbacks['${callbackId}'];
                }
              })(); true;
            `);
          },
          (err) => {
            // JSON.stringify handles quotes/backslashes/newlines — a bare
            // quote-escape broke the injected script on multiline messages.
            webRef.current?.injectJavaScript(`
              (function(){
                var cb = window.__nativeGeoCallbacks && window.__nativeGeoCallbacks['${callbackId}'];
                if(cb){
                  cb.error({ code: ${err.code}, message: ${JSON.stringify(err.message ?? 'Location error')} });
                  delete window.__nativeGeoCallbacks['${callbackId}'];
                }
              })(); true;
            `);
          },
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000, forceRequestLocation: true } as any
        );
        return;
      }
    } catch (error) {
      console.log('[handleMessage] Error:', error);
    }
  };

  const combinedScript = `
  ${disableZoomScript}

  (function() {
    function sendBlob(blob) {
      const reader = new FileReader();
      reader.onloadend = function() {
        window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: 'pdf', data: reader.result })
        );
      };
      reader.readAsDataURL(blob);
    }

    const isPdf = function(blob) {
      return blob && blob.type === 'application/pdf';
    };

    const originalOpen = window.open;
    window.open = function(url) {
      if (url && url.startsWith('blob:')) {
        fetch(url).then(function(res) { return res.blob(); }).then(function(blob) {
          if (isPdf(blob)) { sendBlob(blob); }
          else { originalOpen.call(window, url); }
        });
        return null;
      }
      return originalOpen.apply(this, arguments);
    };

    document.addEventListener('click', function(e) {
      const element = e.target.closest('a');
      if (element && element.href && element.href.startsWith('blob:')) {
        e.preventDefault();
        fetch(element.href).then(function(res) { return res.blob(); }).then(function(blob) {
          if (isPdf(blob)) { sendBlob(blob); }
        });
      }
    });

    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function(blob) {
      if (isPdf(blob)) { sendBlob(blob); }
      return originalCreateObjectURL.apply(this, arguments);
    };
  })();

  // Override navigator.geolocation so Angular/web uses native GPS via the
  // React Native bridge instead of the unreliable WKWebView/Android WebView
  // geolocation.
  (function() {
    if (!window.__nativeGeoCallbacks) window.__nativeGeoCallbacks = {};
    if (!window.__nativeGeoWatches) window.__nativeGeoWatches = {};
    var callbackCounter = 0;

    var geoInFlight = false;   // Fix 4: prevent concurrent GPS requests

    var nativeGeo = {
      getCurrentPosition: function(success, error, options) {
        // Fix 4: drop the call if a previous request is still pending.
        // Without this guard, a setInterval caller piles up concurrent requests
        // that all resolve in a burst when GPS finally responds.
        if (geoInFlight) return;
        geoInFlight = true;

        var id = 'geo_' + (++callbackCounter) + '_' + Date.now();
        window.__nativeGeoCallbacks[id] = {
          success: function(pos) { geoInFlight = false; (success || function(){})(pos); },
          error:   function(err) { geoInFlight = false; (error   || function(){})(err); }
        };

        // Fix 5: self-cleanup after GPS timeout (15 s) + 5 s buffer.
        // If native never calls back (GPS crash, silent timeout), the entry and
        // its closures are removed so they don't accumulate across the session.
        setTimeout(function() {
          if (window.__nativeGeoCallbacks[id]) {
            delete window.__nativeGeoCallbacks[id];
            geoInFlight = false;
          }
        }, 20000);

        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'GET_LOCATION',
          data: { callbackId: id }
        }));
      },
      watchPosition: function(success, error, options) {
        var watchId = ++callbackCounter;
        var ms = 10000;   // fixed 10 s — maximumAge is cache-staleness, not an update rate
        window.__nativeGeoWatches[watchId] = setInterval(function() {
          nativeGeo.getCurrentPosition(success, error, options);
        }, ms);
        return watchId;
      },
      clearWatch: function(watchId) {
        if (window.__nativeGeoWatches[watchId]) {
          clearInterval(window.__nativeGeoWatches[watchId]);
          delete window.__nativeGeoWatches[watchId];
        }
      }
    };

    try {
      Object.defineProperty(navigator, 'geolocation', {
        value: nativeGeo,
        configurable: false,
        writable: false
      });
    } catch(e) {
      navigator.geolocation = nativeGeo;
    }
  })();

  true;
  `;

  // Runs at the EARLIEST point of every page load (before content). Sets the
  // isNativeApp flag the web app keys off to enable the native bridges (native
  // geolocation, PDF postMessage, HRMS tracking controls).
  const beforeContentLoadedScript = `
    window.isNativeApp = true;
    true;
  `;

  /* ================= UNIFIED RENDER ================= */

  // Force update: replaces the WebView entirely. Only action is "Update Now";
  // there is no way back into the app from here this session.
  if (forceUpdateMessage) {
    return (
      <SafeAreaView style={[styles.gateScreen, { justifyContent: 'center' }]}>
        <Text style={styles.gateTitle}>Update Required</Text>
        <Text style={styles.gateMessage}>{forceUpdateMessage}</Text>
        <TouchableOpacity
          style={[styles.button, { paddingHorizontal: 24, marginTop: 20 }]}
          onPress={() => Linking.openURL(forceUpdateStoreUrl)}
        >
          <Text style={styles.buttonText}>Update Now</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // Maintenance: same idea, no action available — just wait it out.
  if (maintenanceMessage) {
    return (
      <SafeAreaView style={[styles.gateScreen, { justifyContent: 'center' }]}>
        <Text style={styles.gateTitle}>Under Maintenance</Text>
        <Text style={styles.gateMessage}>{maintenanceMessage}</Text>
      </SafeAreaView>
    );
  }

  // WebView-only: one always-visible WebView pointed at the web app root. The
  // web app owns auth and persists its session in the WebView's localStorage /
  // cookies, so the user stays signed in across restarts.
  return (
    <View style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
        <WebView
          ref={webRef}
          source={{ uri: initialWebUrl }}
          style={{ flex: 1 }}
          javaScriptEnabled
          domStorageEnabled
          cacheEnabled
          sharedCookiesEnabled          // iOS (WKWebView): persist cookies → stay signed in
          thirdPartyCookiesEnabled      // Android: allow the web session cookie
          mixedContentMode="always"
          injectedJavaScriptBeforeContentLoaded={beforeContentLoadedScript}
          injectedJavaScript={combinedScript}
          scalesPageToFit={false}
          setBuiltInZoomControls={false}
          setDisplayZoomControls={false}
          bounces={false}
          scrollEnabled={true}
          originWhitelist={['https://*', 'http://*', 'app-settings:*']}
          onMessage={handleMessage}
          onLoad={handleWebLoadSuccess}
          onLoadEnd={handleLoadEnd}
          onNavigationStateChange={handleNavigationStateChange}
          renderError={renderWebViewError}
          onError={(e: any) => {
            webErroredRef.current = true;
            console.log('⚠ WebView onError', e?.nativeEvent?.description ?? e?.nativeEvent);
            hideSplashOnce(); // never leave the splash stuck if the first load errors (offline)
            scheduleWebLoadRetry();
          }}
          onHttpError={(e: any) => {
            webErroredRef.current = true;
            console.log('⚠ WebView onHttpError', { code: e?.nativeEvent?.statusCode, url: e?.nativeEvent?.url });
          }}
          // The OS can kill the WebView renderer under memory pressure; reload so
          // the app doesn't sit on a dead white screen (the web session persists).
          onRenderProcessGone={(e: any) => {
            console.log('⚠ WebView renderer process gone — reloading', e?.nativeEvent);
            webRef.current?.reload();
          }}
          onContentProcessDidTerminate={() => {
            console.log('⚠ WebView content process terminated — reloading');
            webRef.current?.reload();
          }}
          onShouldStartLoadWithRequest={(request: any) => {
            const url = request.url || '';
            // App-settings deep link → native location-permission flow.
            if (url.startsWith('app-settings:')) {
              requestLocationPermission();
              return false;
            }
            // Non-http(s) schemes can't render in a WebView — hand them to the OS
            // (dialer, mail, SMS, WhatsApp, UPI, maps, Android intents).
            if (/^(tel:|mailto:|sms:|whatsapp:|upi:|geo:|intent:)/i.test(url)) {
              Linking.openURL(url).catch(() => { });
              return false;
            }
            return true;
          }}
        />
      </SafeAreaView>

      {/* No Internet modal — single instance, works in any app state */}
      <Modal visible={showInternetModel} transparent animationType="fade" supportedOrientations={['landscape']}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>No Internet</Text>
            <Text style={styles.modalText}>
              Please check your internet connection
            </Text>
            <TouchableOpacity
              style={[styles.button, { paddingHorizontal: 12 }]}
              onPress={() => {
                // Re-evaluate connectivity; useNetInfo picks up the refreshed
                // state and hides this modal, and the reconnect effect reloads
                // the WebView if it had errored.
                NetInfo.refresh().catch(() => { });
              }}
            >
              <Text style={styles.buttonText}>Try again</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

/* ================= STYLES ================= */
const styles = StyleSheet.create({
  button: {
    backgroundColor: "#0b3d6e",
    height: 45,
    borderRadius: 6,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 10,
  },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBox: {
    width: IS_TABLET ? '30%' : '80%',
    backgroundColor: 'white',
    padding: 20,
    borderRadius: 10,
    alignItems: 'center',
  },
  modalTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 10 },
  modalText: { textAlign: 'center' },
  gateScreen: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingHorizontal: 24,
  },
  gateTitle: { fontSize: 22, fontWeight: '700', marginBottom: 12, textAlign: 'center' },
  gateMessage: { fontSize: 15, textAlign: 'center', color: '#333' },
  // Unlike gateScreen (a full top-level return with no sibling), this renders
  // inside the WebView's own container next to the (still-mounted) WebView —
  // it needs absolute positioning to actually cover it, matching the sizing
  // the library's own default error/loading views use internally.
  webErrorOverlay: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingHorizontal: 24,
  },
});
