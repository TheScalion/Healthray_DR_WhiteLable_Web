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

// Fires for DATA-ONLY messages when app is background/killed.
// Notification messages (title+body) are shown by OS automatically — this won't fire for those.
messaging().setBackgroundMessageHandler(async remoteMessage => {
  console.log('[FCM][BACKGROUND] data:', JSON.stringify(remoteMessage?.data ?? {}));
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
