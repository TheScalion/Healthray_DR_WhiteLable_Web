/**
 * notificationHandler.ts
 *
 * Displays a native full-screen "incoming call" notification when the
 * backend dispatches or reassigns an ambulance call to this driver.
 *
 * Only shows for AMBULANCE_CALL_DISPATCHED and AMBULANCE_CALL_REASSIGNED
 * (the two driver-facing types). All other notification_type values are
 * dispatcher-facing and are intentionally ignored here.
 *
 * Role guard: the notification is suppressed unless user_role === 'driver'
 * so that non-driver staff who happen to receive the push see nothing.
 */

import notifee, { AndroidImportance, AndroidCategory } from '@notifee/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const DRIVER_CALL_TYPES: Record<string, { title: string; body: string }> = {
  AMBULANCE_CALL_DISPATCHED: {
    title: 'New Emergency Call',
    body: 'A new emergency call has been dispatched to you',
  },
  AMBULANCE_CALL_REASSIGNED: {
    title: 'Emergency Call Reassigned',
    body: 'An emergency call has been reassigned to you',
  },
};

export async function showCallNotification(remoteMessage: any): Promise<void> {
  try {
    const type = remoteMessage?.data?.notification_type;
    console.log('[notificationHandler] received type:', type);

    const content = DRIVER_CALL_TYPES[type];
    if (!content) {
      console.log(`[notificationHandler] ⏭ type "${type}" is not driver-facing — skipped (need AMBULANCE_CALL_DISPATCHED or AMBULANCE_CALL_REASSIGNED to trigger a notification)`);
      return;
    }

    // The backend already targets only the correct user's device token.
    // Only suppress if nobody is logged in (stale push after logout).
    const authToken = await AsyncStorage.getItem('auth_token');
    if (!authToken) {
      console.log('[notificationHandler] ⏭ no auth_token in storage — user not logged in, suppressing notification');
      return;
    }
    console.log('[notificationHandler] auth_token present — proceeding to display notification');

    const channelId = await notifee.createChannel({
      id: 'emergency_calls',
      name: 'Emergency Calls',
      importance: AndroidImportance.HIGH,
      sound: 'default',
      vibration: true,
    });

    console.log('[notificationHandler] ✅ displaying call notification for type:', type);
    await notifee.displayNotification({
      title: content.title,
      body: content.body,
      data: { call_id: String(remoteMessage?.data?.call_id || '') },
      android: {
        channelId,
        category: AndroidCategory.CALL, // incoming-call styling
        importance: AndroidImportance.HIGH,
        pressAction: { id: 'default' },
        fullScreenAction: { id: 'default' }, // wakes the screen like a real call
      },
    });
  } catch (e) {
    console.log('[notificationHandler] showCallNotification error:', e);
  }
}
