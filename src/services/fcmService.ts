import messaging from '@react-native-firebase/messaging';
import notifee, { AndroidImportance } from '@notifee/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { showCallNotification } from './notificationHandler';

export const FCM_STORAGE_KEY = 'fcm_registration_token';

export type FCMTokenRefreshCallback = (newToken: string) => void;

export async function initFCM(onTokenRefresh?: FCMTokenRefreshCallback): Promise<{
  token: string;
  unsubscribe: () => void;
}> {
  const noop = () => {};

  try {
    const authStatus = await messaging().requestPermission();
    const granted =
      authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
      authStatus === messaging.AuthorizationStatus.PROVISIONAL;

    if (!granted) {
      console.log('[FCM] Permission denied — status:', authStatus);
      return { token: '', unsubscribe: noop };
    }

    if (Platform.OS === 'android') {
      await notifee.createChannel({
        id: 'fcm-notifications',
        name: 'Push Notifications',
        importance: AndroidImportance.HIGH,
      });
    }

    const token = await messaging().getToken();
    if (!token) {
      console.log('[FCM] ❌ getToken() returned empty — check google-services.json and internet');
      return { token: '', unsubscribe: noop };
    }

    console.log('[FCM] ✅ Token:', token);
    await AsyncStorage.setItem(FCM_STORAGE_KEY, token);

    const unsubscribeRefresh = messaging().onTokenRefresh(async (newToken: string) => {
      console.log('[FCM] Token refreshed:', newToken);
      await AsyncStorage.setItem(FCM_STORAGE_KEY, newToken);
      onTokenRefresh?.(newToken);
    });

    const unsubscribeForeground = messaging().onMessage(async (remoteMessage: any) => {
      const { notification, data } = remoteMessage;
      console.log('[FCM][FOREGROUND] title:', notification?.title ?? '(none)', '| data:', JSON.stringify(data ?? {}));

      if (!notification) {
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
            smallIcon: 'ic_launcher',
          },
          data: (data as Record<string, string>) ?? {},
        });
      } catch (e: any) {
        console.log('[FCM][FOREGROUND] ❌ displayNotification error:', e?.message ?? e);
      }
    });

    return {
      token,
      unsubscribe: () => {
        unsubscribeForeground();
        unsubscribeRefresh();
      },
    };
  } catch (e: any) {
    console.log('[FCM] ❌ initFCM error:', e?.message ?? e);
    return { token: '', unsubscribe: noop };
  }
}

export async function getFCMToken(): Promise<string> {
  return (await AsyncStorage.getItem(FCM_STORAGE_KEY)) ?? '';
}
