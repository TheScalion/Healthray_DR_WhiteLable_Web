/**
 * fcmService.ts
 *
 * Single responsibility: Firebase Cloud Messaging token lifecycle.
 *
 * What this file does:
 *  1. Requests notification permission (iOS + Android 13+)
 *  2. Creates the Android "Push Notifications" channel via notifee
 *  3. Fetches the FCM registration token and persists it in AsyncStorage
 *  4. Listens for token rotation and keeps AsyncStorage in sync
 *  5. Shows foreground notifications via notifee (Firebase does NOT auto-show them)
 *
 * What this file does NOT do:
 *  - Background / quit-state notification tap handling (stays in App.tsx — needs webRef)
 *  - API calls to register the token with your backend (done in App.tsx at sign-in time)
 */

import messaging from '@react-native-firebase/messaging';
import notifee, { AndroidImportance } from '@notifee/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { showCallNotification } from './notificationHandler';

// AsyncStorage key — must match TRACKING_STORAGE.FCM_TOKEN in App.tsx
export const FCM_STORAGE_KEY = 'fcm_registration_token';

export type FCMTokenRefreshCallback = (newToken: string) => void;

/**
 * initFCM
 *
 * Call once on app mount (inside a useEffect in AppContent).
 *
 * @param onTokenRefresh  Optional — called whenever Firebase rotates the token.
 *                        Use this to keep a ref in App.tsx in sync so the
 *                        next sign-in always sends the freshest token.
 *
 * @returns  { token, unsubscribe }
 *           token       — the FCM registration token to send to your backend as "device_token"
 *           unsubscribe — call in the useEffect cleanup to remove listeners
 */
export async function initFCM(onTokenRefresh?: FCMTokenRefreshCallback): Promise<{
  token: string;
  unsubscribe: () => void;
}> {
  const noop = () => {};

  try {
    // ── 1. Permission ────────────────────────────────────────────────────────
    // iOS always requires a runtime prompt.
    // Android 13+ (API 33) requires POST_NOTIFICATIONS — handled by
    // PermissionsAndroid in App.tsx; messaging().requestPermission() is a no-op there.
    const authStatus = await messaging().requestPermission();
    const granted =
      authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
      authStatus === messaging.AuthorizationStatus.PROVISIONAL;

    if (!granted) {
      console.log('[FCM] Permission denied — notifications will not work');
      return { token: '', unsubscribe: noop };
    }

    // ── 2. Android notification channel ─────────────────────────────────────
    // Must exist before calling notifee.displayNotification().
    // Channel is idempotent — safe to call on every app start.
    if (Platform.OS === 'android') {
      await notifee.createChannel({
        id: 'fcm-notifications',
        name: 'Push Notifications',
        importance: AndroidImportance.HIGH,
      });
      console.log('[FCM] Android notification channel ready');
    }

    // ── 3. Get FCM registration token ────────────────────────────────────────
    // This is the token your backend needs to send push notifications to THIS device.
    // Pass it as "device_token" in your sign-in API payload.
    const token = await messaging().getToken();
    if (!token) {
      console.log('[FCM] getToken() returned empty — google-services.json may be missing');
      return { token: '', unsubscribe: noop };
    }

    await AsyncStorage.setItem(FCM_STORAGE_KEY, token);
    console.log('[FCM] Token ready:', token.slice(0, 25) + '...');

    // ── 4. Token-refresh subscription ────────────────────────────────────────
    // Firebase rotates tokens after re-installs or long inactivity.
    // Keep AsyncStorage and the ref in App.tsx in sync.
    const unsubscribeRefresh = messaging().onTokenRefresh(async (newToken: string) => {
      await AsyncStorage.setItem(FCM_STORAGE_KEY, newToken);
      onTokenRefresh?.(newToken);
      console.log('[FCM] Token refreshed:', newToken.slice(0, 25) + '...');
    });

    // ── 5. Foreground notification display ───────────────────────────────────
    // When the app is in the FOREGROUND, Firebase does NOT show notifications
    // automatically — we must display them manually via notifee.
    // Background / killed state: OS handles display automatically.
    const unsubscribeForeground = messaging().onMessage(async (remoteMessage: any) => {
      const { notification, data } = remoteMessage;
      console.log('[FCM][FOREGROUND] ── notification received ──');
      console.log('[FCM][FOREGROUND] title  :', notification?.title ?? '(none)');
      console.log('[FCM][FOREGROUND] body   :', notification?.body  ?? '(none)');
      console.log('[FCM][FOREGROUND] data   :', JSON.stringify(data ?? {}));
      console.log('[FCM][FOREGROUND] full   :', JSON.stringify(remoteMessage));

      if (!notification) {
        // Data-only ambulance message — let the driver call handler decide
        await showCallNotification(remoteMessage);
        return;
      }

      try {
        await notifee.displayNotification({
          title: notification.title ?? 'HealthRay',
          body: notification.body ?? '',
          android: {
            channelId: 'fcm-notifications',
            importance: AndroidImportance.HIGH,
            pressAction: { id: 'default' },
            // ic_launcher is always present in mipmap folders and supports alpha.
            // ic_notification.png is RGB-only (no alpha) which causes silent failures.
            smallIcon: 'ic_launcher',
          },
          data: (data as Record<string, string>) ?? {},
        });
        console.log('[FCM][FOREGROUND] ✅ notifee.displayNotification called successfully');
      } catch (e) {
        console.log('[FCM][FOREGROUND] ❌ notifee.displayNotification error:', e);
      }
    });

    return {
      token,
      unsubscribe: () => {
        unsubscribeForeground();
        unsubscribeRefresh();
      },
    };
  } catch (e) {
    console.log('[FCM] initFCM error:', e);
    return { token: '', unsubscribe: noop };
  }
}

/**
 * getFCMToken
 *
 * Returns the last known FCM token from AsyncStorage.
 * Use this as a fallback when fcmTokenRef.current is empty
 * (e.g. when resuming a session without going through initFCM again).
 */
export async function getFCMToken(): Promise<string> {
  return (await AsyncStorage.getItem(FCM_STORAGE_KEY)) ?? '';
}
