/**
 * deviceToken.ts
 *
 * Manages the native FCM token lifecycle for the ambulance module.
 *
 * - rememberSession  : called right after sign_in succeeds; persists auth_token,
 *                      the native FCM token as device_token, and user_role.
 * - syncDeviceToken  : called on cold start + onTokenRefresh; if the token has
 *                      changed, calls POST /api/v1/users/refresh_token so the
 *                      backend row always holds the current native token.
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
}

export async function syncDeviceToken(newToken?: string): Promise<void> {
  try {
    const [oldToken, authToken] = await Promise.all([
      AsyncStorage.getItem('device_token'),
      AsyncStorage.getItem('auth_token'),
    ]);

    if (!authToken) return; // not logged in → nothing to update

    if (!newToken) {
      try {
        newToken = await messaging().getToken();
      } catch {
        return;
      }
    }

    if (!newToken || newToken === oldToken) return; // unchanged → no-op

    await fetch(`${_apiBase}/api/v1/users/refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': authToken,
        'X-Device-Token': oldToken || '', // the token currently in the row
      },
      body: JSON.stringify({ user: { device_token: newToken } }),
    });

    await AsyncStorage.setItem('device_token', newToken);
    console.log('[deviceToken] syncDeviceToken: token updated in DB');
  } catch (e) {
    console.log('[deviceToken] syncDeviceToken error:', e);
  }
}
