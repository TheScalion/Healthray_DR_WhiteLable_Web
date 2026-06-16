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

// Push received while app is in background / killed → display the driver call notification.
messaging().setBackgroundMessageHandler(async remoteMessage => {
  console.log('[FCM][BACKGROUND] ── notification received ──');
  console.log('[FCM][BACKGROUND] data   :', JSON.stringify(remoteMessage?.data ?? {}));
  await showCallNotification(remoteMessage);
});

// Token rotated while app was backgrounded / killed → keep auth_tokens row current.
messaging().onTokenRefresh(syncDeviceToken);

// Notifee background event: user taps the notification while app is backgrounded/killed.
// call_id is available in detail.notification.data.call_id;
// App.tsx reads it via notifee.getInitialNotification() on cold start.
notifee.onBackgroundEvent(async ({ type }) => {
  if (type === EventType.PRESS) {
    // Navigation is handled in App.tsx via notifee.getInitialNotification()
  }
});

AppRegistry.registerComponent(appName, () => App);
