// ─── Environment ─────────────────────────────────────────────────────────────
// Set IS_STAGING = true  → staging  (devfront.healthray.com / node-stage)
// Set IS_STAGING = false → production (ray.healthray.com / node)
export const IS_STAGING = false;

export const API_BASE = IS_STAGING
  ? 'https://node-stage.healthray.com'
  : 'https://node.healthray.com';

export const WEB_BASE = IS_STAGING
  ? 'https://devfront.healthray.com'
  : 'https://ray.healthray.com';


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
