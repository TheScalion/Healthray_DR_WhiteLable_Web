// ─── Environment ─────────────────────────────────────────────────────────────
// Ford Hospital branch: production only. There are no stage/uat builds here.
export type AppEnv = 'prod';
export const APP_ENV: AppEnv = 'prod';
export const IS_STAGING = false;

const PROD = {
  API_BASE: 'https://ford-node.healthray.com',
  WEB_BASE: 'https://ford.healthray.com',
  // Page the WebView opens on launch.
  WEB_START_URL: 'https://ford.healthray.com/login',
};

// Dev-only, opt-in: set to 'http://localhost:4200' to point debug builds at a
// local Angular dev server, tunneled through `adb reverse tcp:4200 tcp:4200` +
// a local relay to 192.168.0.150:4200 (the phone has no direct network path to
// that PC). Leave undefined so debug builds load the real web URL.
// Ignored in release builds.
const LOCAL_DEV_WEB_BASE: string | undefined = undefined;

export const API_BASE = PROD.API_BASE;

// Origin only — callers append paths (e.g. `${WEB_BASE}/ambulance`).
export const WEB_BASE = (__DEV__ && LOCAL_DEV_WEB_BASE) || PROD.WEB_BASE;

export const WEB_START_URL = (__DEV__ && LOCAL_DEV_WEB_BASE)
  ? `${LOCAL_DEV_WEB_BASE}/`
  : PROD.WEB_START_URL;


export const WEB_BASE_HOST = WEB_BASE.replace(/^https?:\/\//, '');


export const WEB_LOGIN_PATH = '/login';
export const isOnLoginPage = (url: string): boolean =>
  !!url && url.toLowerCase().includes(WEB_LOGIN_PATH);
// ─────────────────────────────────────────────────────────────────────────────

// ─── Build/version gate ──────────────────────────────────────────────────────
// Checked once on every app launch. The backend returns a status that decides
export const BUILD_MANAGEMENT_API = `${API_BASE}/api/v1/build_management/check_update_required`;
// Fallback store links, used only when the build-management API doesn't send
// ios_app_url / android_app_url.
// TODO: set the real App Store link once the Ford-DR iOS app is published.
export const ITUNES_URL = 'https://apps.apple.com/in/app/healthray-dr-for-doctors/id1513592834';
export const PLAYSTORE_URL = 'https://play.google.com/store/apps/details?id=com.fordhospital.doctor&hl=en_IN';
// ─────────────────────────────────────────────────────────────────────────────

// A WebView load error (e.g. DNS failure) doesn't necessarily flip NetInfo's
export const WEB_LOAD_RETRY_DELAYS_MS = [3000, 6000, 12000, 20000];

export const CURRENT_USER_KEY = 'CURRENT_USER';
