import DeviceInfo from 'react-native-device-info';

// ─── Environment ─────────────────────────────────────────────────────────────
// Selected at build time by the Android product flavor (prod / stage / uat in
// android/app/build.gradle). Each flavor installs under its own applicationId,
// which is what we key off here — no manual flag to flip before a build.
export type AppEnv = 'prod' | 'stage' | 'uat';

// WEB_START_URL is the page the WebView opens on launch.
const ENVIRONMENTS: Record<AppEnv, { API_BASE: string; WEB_BASE: string; WEB_START_URL: string }> = {
  prod: {
    API_BASE: 'https://node.healthray.com',
    WEB_BASE: 'https://ray.healthray.com',
    WEB_START_URL: 'https://ray.healthray.com/',
  },
  stage: {
    API_BASE: 'https://stage-node.healthray.com',
    WEB_BASE: 'https://stage-ray.healthray.com',
    WEB_START_URL: 'https://stage-ray.healthray.com/login',
  },
  uat: {
    API_BASE: 'https://uat-node.healthray.com',
    WEB_BASE: 'https://uat-ray.healthray.com',
    WEB_START_URL: 'https://uat-ray.healthray.com/login',
  },
};

const resolveAppEnv = (bundleId: string): AppEnv => {
  if (bundleId.endsWith('.stage')) return 'stage';
  if (bundleId.endsWith('.uat')) return 'uat';
  return 'prod';
};

export const APP_ENV: AppEnv = resolveAppEnv(DeviceInfo.getBundleId());
export const IS_STAGING = APP_ENV !== 'prod';

// Dev-only, opt-in: set to 'http://localhost:4200' to point debug builds at a
// local Angular dev server, tunneled through `adb reverse tcp:4200 tcp:4200` +
// a local relay to 192.168.0.150:4200 (the phone has no direct network path to
// that PC). Leave undefined so debug builds load their flavor's real web URL.
// Ignored in release builds.
const LOCAL_DEV_WEB_BASE: string | undefined = undefined;

export const API_BASE = ENVIRONMENTS[APP_ENV].API_BASE;

// Origin only — callers append paths (e.g. `${WEB_BASE}/ambulance`).
export const WEB_BASE = (__DEV__ && LOCAL_DEV_WEB_BASE) || ENVIRONMENTS[APP_ENV].WEB_BASE;

export const WEB_START_URL = (__DEV__ && LOCAL_DEV_WEB_BASE)
  ? `${LOCAL_DEV_WEB_BASE}/`
  : ENVIRONMENTS[APP_ENV].WEB_START_URL;


export const WEB_BASE_HOST = WEB_BASE.replace(/^https?:\/\//, '');


export const WEB_LOGIN_PATH = '/login';
export const isOnLoginPage = (url: string): boolean =>
  !!url && url.toLowerCase().includes(WEB_LOGIN_PATH);
// ─────────────────────────────────────────────────────────────────────────────

// ─── Build/version gate ──────────────────────────────────────────────────────
// Checked once on every app launch. The backend returns a status that decides
export const BUILD_MANAGEMENT_API = `${API_BASE}/api/v1/build_management/check_update_required`;
export const ITUNES_URL = 'https://apps.apple.com/in/app/healthray-dr-for-doctors/id1513592834';
export const PLAYSTORE_URL = 'https://play.google.com/store/apps/details?id=com.healthray.doctor&hl=en_IN';
// ─────────────────────────────────────────────────────────────────────────────

// A WebView load error (e.g. DNS failure) doesn't necessarily flip NetInfo's
export const WEB_LOAD_RETRY_DELAYS_MS = [3000, 6000, 12000, 20000];

export const CURRENT_USER_KEY = 'CURRENT_USER';
