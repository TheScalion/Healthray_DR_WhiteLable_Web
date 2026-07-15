/**
 * @format
 */

import { AppRegistry } from 'react-native';
import messaging from '@react-native-firebase/messaging';
import notifee, { EventType } from '@notifee/react-native';
import { showCallNotification } from './src/services/notificationHandler';
import { syncDeviceToken } from './src/services/deviceToken';
import App from './App';
import { name as appName } from './app.json';

messaging().setBackgroundMessageHandler(async remoteMessage => {
  // When backend sends a message with BOTH notification + data fields,
  // the OS already shows the notification automatically (one banner).
  // If we also call showCallNotification here, the user sees TWO banners.
  // Fix: only handle data-only messages — skip if notification key is present.
  if (remoteMessage.notification) {
    console.log('[FCM][BACKGROUND] notification+data message — OS already displayed it, skipping to avoid duplicate');
    return;
  }
  console.log('[FCM][BACKGROUND] data-only message — data:', JSON.stringify(remoteMessage?.data ?? {}));
  await showCallNotification(remoteMessage);
});

messaging().onTokenRefresh(async (newToken) => {
  console.log('[FCM] Token refreshed (background):', newToken);
  await syncDeviceToken(newToken);
});

notifee.onBackgroundEvent(async ({ type }) => {
  if (type === EventType.PRESS) {
    // Navigation handled in App.tsx via notifee.getInitialNotification()
  }
});

AppRegistry.registerComponent(appName, () => App);
