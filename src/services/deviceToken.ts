/**
 * deviceToken.ts
 *
 * Manages the native FCM token lifecycle for the ambulance module.
 *
 * - rememberSession  : called right after sign_in succeeds; persists auth_token,
 *                      the native FCM token as device_token, and user_role.
 * - syncDeviceToken  : called on cold start + onTokenRefresh (index.js only);
 *                      if the token has changed, calls POST /api/v1/users/refresh_token
 *                      so the backend row always holds the current native token.
 *
 * IMPORTANT — token refresh is handled in ONE place only: index.js onTokenRefresh.
 * Do NOT also call syncDeviceToken from fcmService.ts or App.tsx initFCM callback,
 * or you get two concurrent API calls for the same rotation which breaks the
 * X-Device-Token lookup on the backend.
 */

import messaging from '@react-native-firebase/messaging';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Configured by App.tsx at startup so it matches the IS_STAGING flag there.
let _apiBase = 'https://node.healthray.com';

export function configureApiBase(url: string): void {
  _apiBase = url;
}

export async function rememberSession(
  authToken: string,
  isDriver: boolean,
  deviceToken: string,
): Promise<void> {
  await AsyncStorage.multiSet([
    ['auth_token', authToken],
    ['device_token', deviceToken],
    ['user_role', isDriver ? 'driver' : 'staff'],
  ]);
  console.log('[deviceToken] rememberSession — auth_token:', authToken ? `${authToken.slice(0, 15)}...` : 'EMPTY');
  console.log('[deviceToken] rememberSession — device_token (FCM):', deviceToken || 'EMPTY');
}

export async function syncDeviceToken(newToken?: string): Promise<void> {
  try {
    const [oldToken, authToken] = await Promise.all([
      AsyncStorage.getItem('device_token'),
      AsyncStorage.getItem('auth_token'),
    ]);

    // Not logged in — nothing to sync
    if (!authToken) {
      console.log('[deviceToken] syncDeviceToken — skipped (not logged in)');
      return;
    }

    // If no token passed, fetch the current one from Firebase
    if (!newToken) {
      try {
        newToken = await messaging().getToken();
      } catch (e) {
        console.log('[deviceToken] syncDeviceToken — getToken() failed:', e);
        return;
      }
    }

    if (!newToken) {
      console.log('[deviceToken] syncDeviceToken — skipped (newToken is empty)');
      return;
    }

    // Token unchanged — backend already has the correct token
    if (newToken === oldToken) {
      console.log('[deviceToken] syncDeviceToken — token unchanged, no update needed');
      return;
    }

    console.log('[deviceToken] syncDeviceToken — token changed!');
    console.log('[deviceToken]   old:', oldToken || '(none)');
    console.log('[deviceToken]   new:', newToken);
    console.log('[deviceToken]   Calling POST /api/v1/users/refresh_token ...');

    const res = await fetch(`${_apiBase}/api/v1/users/refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': authToken,
        'X-Device-Token': oldToken || '', // identifies the session row in the backend
      },
      body: JSON.stringify({ user: { device_token: newToken } }),
    });

    const responseText = await res.text();
    console.log('[deviceToken] syncDeviceToken — response status:', res.status);
    console.log('[deviceToken] syncDeviceToken — response body:', responseText);

    if (!res.ok) {
      // DO NOT update AsyncStorage on failure.
      // If we update it here, the next rotation sends the wrong X-Device-Token
      // (one the backend doesn't know about), making every future update fail too.
      console.log('[deviceToken] syncDeviceToken — ❌ API failed (status', res.status, ') — AsyncStorage NOT updated');
      console.log('[deviceToken]   Backend still has token:', oldToken || '(none)');
      console.log('[deviceToken]   Will retry on next app launch or next token rotation');
      return;
    }

    // Only persist locally after confirmed backend update
    await AsyncStorage.setItem('device_token', newToken);
    console.log('[deviceToken] syncDeviceToken — ✅ token updated in backend and AsyncStorage');

  } catch (e: any) {
    console.log('[deviceToken] syncDeviceToken — error:', e?.message ?? e);
  }
}
