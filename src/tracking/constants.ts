import { Platform, ToastAndroid } from 'react-native';
import { API_BASE } from '../config/env';

// ─── HRMS tracking constants ─────────────────────────────────────────────────
// Native owns auth + base URL, so the WebView never sends them in the
// START_TRACKING / STOP_TRACKING bridge payload.
export const TRACKING_API_BASE = API_BASE;
export const TRACKING_PATH_START = '/api/v1/hrms/attendance/tracking/start';
export const TRACKING_PATH_BATCH = '/api/v1/hrms/attendance/tracking/batch';
export const TRACKING_PATH_END = '/api/v1/hrms/attendance/tracking/end';

// Buffer / batch parameters
export const TRACKING_FLUSH_INTERVAL_MS = 30_000;     // flush every 30 s
export const TRACKING_MIN_FLUSH_GAP_MS = 10_000;     // 10 s minimum between /batch calls (was 20 s)
export const TRACKING_KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000; // keepalive every 5 min when buffer is empty
export const TRACKING_MAX_POINTS_PER_BATCH = 50;      // hard server batch cap
export const TRACKING_MAX_BUFFER_POINTS = 500;        // hard local buffer cap (drop oldest)
export const TRACKING_ACCURACY_MAX_M = 100;        // 100 m passes network-assisted fixes on OnePlus/urban GPS (was 50)

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
export const KALMAN_PROCESS_NOISE_M2_PER_S = 8;            // active (moving) — reacts quickly to real displacement
export const KALMAN_PROCESS_NOISE_STATIONARY_M2_PER_S = 0.5; // stationary — trusts accumulated history, suppresses jitter
// Initial variance assumed for the very first reading (m²). Picked large
// enough that the first observation almost fully overrides the prior.
export const KALMAN_INITIAL_VARIANCE_M2 = 1e6;
// If two consecutive readings are >this many seconds apart, reset the
// filter — the gap is too large to predict through reliably.
export const KALMAN_RESET_GAP_S = 90;   // must be > STATIONARY_POLL_MS/1000 (60 s) for filter to work when still
export const TRACKING_RESUME_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 h session resume window
export const TRACKING_HEARTBEAT_MS = 5 * 60 * 1000; // legacy stationary heartbeat (kept as fallback)

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
export const ACTIVE_DISTANCE_FILTER_M = 5;
export const STATIONARY_DISTANCE_FILTER_M = 25;
export const ACTIVE_POLL_MS = 10_000;   // 10 s while moving
export const STATIONARY_POLL_MS = 60_000;   // 60 s while still
export const MOTION_THRESHOLD_MPS = 1.0;      // ~3.6 km/h — switch to ACTIVE on any reading at/above this
export const STILL_THRESHOLD_MPS = 0.5;      // ~1.8 km/h — N consecutive readings below → STATIONARY
export const STILL_CONSECUTIVE_REQUIRED = 3;
// Backwards-compat alias for the legacy "active poll" constant referenced
// in older comments. Kept so nothing reads a stale value.
export const TRACKING_ACTIVE_POLL_MS = ACTIVE_POLL_MS;

// ── Debug toasts — set HRMS_DEBUG_TOASTS = false or delete this block to remove ──
export const HRMS_DEBUG_TOASTS = true;
export const debugToast = (msg: string, long = false): void => {
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
export const ACCEL_SAMPLE_HZ = 5;
export const ACCEL_WINDOW_SIZE = 15;     // 3 seconds @ 5 Hz
export const ACCEL_STILL_VARIANCE_THRESHOLD = 0.05;   // m²/s⁴ — phone-on-desk noise floor
export const ACCEL_MOVING_VARIANCE_THRESHOLD = 0.50;   // m²/s⁴ — clear motion (walking ≈ 0.3-2.0)

// ── Auto-resume tuning (matches WebSocket-reconnect playbook) ───────────────
// Backend caps a session at 24h. When that fires (or a stray 410 arrives),
// we silently call /tracking/start again so the employee never sees it.
//
//   • 3 attempts with exponential backoff: 0 s → 1 s → 4 s
//   • Tight-loop guard: if a freshly-resumed session ALSO 410s within 60 s,
//     stop. That signals a fundamental problem (employee disabled, org gone)
//     that no amount of retrying will fix.
export const TRACKING_AUTO_RESUME_MAX_ATTEMPTS = 3;
export const TRACKING_AUTO_RESUME_BACKOFFS_MS = [0, 1000, 4000];
export const TRACKING_AUTO_RESUME_TIGHT_LOOP_MS = 60_000;

// AsyncStorage keys per spec
export const TRACKING_STORAGE = {
  EMPLOYEE_ID: 'tracking_employee_id',
  ORG_ID: 'tracking_organization_id',
  LAST_ACTIVITY_TS: 'tracking_last_activity_ts',
  AUTH_TOKEN: 'auth_token',
  DEVICE_TOKEN: 'device_token',
  FCM_TOKEN: 'fcm_registration_token',
};
export const trackingSessionKey = (empId: number | string) => `tracking_session_id_${empId}`;
export const trackingBufferKey = (sessionId: string) => `tracking_buffer_${sessionId}`;

export const TRACKING_BATTERY_OPT_KEY = 'tracking_battery_opt_asked';

// Optional dependency — guarded require so the app still builds without it.
export let _rnSensors: any = null;
try { _rnSensors = require('react-native-sensors'); } catch (e) { /* not installed */ }
