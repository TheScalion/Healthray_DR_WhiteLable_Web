import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Share from 'react-native-share';
import ReactNativeBlobUtil from 'react-native-blob-util';
import Geolocation from 'react-native-geolocation-service';
import type { WebView as WebViewType } from 'react-native-webview';

import { getFCMToken } from '../services/fcmService';
import { rememberSession, syncDeviceToken } from '../services/deviceToken';
import { hrmsTracker } from '../tracking';
import { TRACKING_STORAGE } from '../tracking/constants';
import { CURRENT_USER_KEY } from '../config/env';
import {
  requestCurrentUserDataScript,
  resolveGeoSuccessScript,
  resolveGeoErrorScript,
} from './injectedScripts';

interface MessageHandlerDeps {
  webRef: React.RefObject<WebViewType | null>;
  fcmTokenRef: React.RefObject<string>;
  authSyncedRef: React.RefObject<boolean>;
  requestLocationPermission: () => Promise<void>;
}

/**
 * Builds the WebView `onMessage` handler — the single entry point for every
 * native bridge call the web app makes (PDF export, HRMS tracking controls,
 * auth-token sync, native geolocation shim). Bundled as a factory so the
 * refs/callbacks it closes over stay owned by App.tsx while the dispatch
 * logic itself lives here.
 */
export function createMessageHandler(deps: MessageHandlerDeps) {
  const { webRef, fcmTokenRef, authSyncedRef, requestLocationPermission } = deps;

  return async function handleMessage(event: any): Promise<void> {
    try {
      const message = JSON.parse(event.nativeEvent.data);

      // ─── PDF (existing) ──────────────────────────────────────────────────
      if (message?.type === 'pdf') {
        if (!message?.data) return;
        const base64Data = message.data.replace(/^data:[^;]+;base64,/, '').trim();

        if (Platform.OS === 'android') {
          const folderPath =
            ReactNativeBlobUtil.fs.dirs.DownloadDir + '/HealthrayDR/HealthrayDocument';
          const filePath = folderPath + '/Prescription.pdf';
          await ReactNativeBlobUtil.fs.mkdir(folderPath).catch(() => { });
          await ReactNativeBlobUtil.fs.writeFile(filePath, base64Data, 'base64');
          await ReactNativeBlobUtil.android.actionViewIntent(filePath, 'application/pdf');
        } else {
          const folderPath =
            ReactNativeBlobUtil.fs.dirs.DocumentDir + '/HealthrayDR/HealthrayDocument';
          const filePath = folderPath + '/Prescription.pdf';
          await ReactNativeBlobUtil.fs.mkdir(folderPath).catch(() => { });
          await ReactNativeBlobUtil.fs.writeFile(filePath, base64Data, 'base64');
          await Share.open({ url: 'file://' + filePath, type: 'application/pdf', failOnCancel: false });
        }
        return;
      }

      // ─── START_TRACKING (HRMS spec) ──────────────────────────────────────
      // Bridge contract:
      //   { type: 'START_TRACKING', payload: { employee_id: number, organization_id: number } }
      // Native owns: API base URL, auth token, device token, session_id.
      if (message?.type === 'START_TRACKING') {
        const payload = message?.payload ?? message?.data ?? {};
        const employeeId = Number(payload.employee_id ?? payload.employeeId);
        const organizationId = Number(
          payload.organization_id ?? payload.orgId ?? payload.organizationId,
        );

        if (!Number.isFinite(employeeId) || !Number.isFinite(organizationId)) {
          console.log('[HRMS] START_TRACKING missing employee_id or organization_id');
          return;
        }

        webRef.current?.injectJavaScript(requestCurrentUserDataScript);

        await hrmsTracker.start(employeeId, organizationId);
        return;
      }

      if (message?.type === 'WEB_AUTH_TOKENS') {
        const authToken: string = message?.auth_token ?? '';
        const webDeviceToken: string = message?.device_token ?? '';
        const isDriver: boolean = !!message?.is_driver;

        if (!authToken) {
          // Web session not ready yet (localStorage.currentUser has no token).
          // Leave authSyncedRef false so a later nav / foreground retries.
          console.log('[WEB_AUTH_TOKENS] ⚠ auth_token empty — web session not ready, will retry');
          return;
        }

        // We have a token → the session is synced for this app run, so the
        // nav-based injector stops re-firing. Rotation is caught by the
        // foreground re-sync in the AppState effect.
        authSyncedRef.current = true;

        // Idempotent: if the token is unchanged from what we already stored, do
        // nothing. Without this guard, re-syncing on every nav/foreground would
        // thrash device_token (rememberSession → web token, syncDeviceToken →
        // FCM) and fire a redundant refresh_token call each time.
        const storedAuth = await AsyncStorage.getItem(TRACKING_STORAGE.AUTH_TOKEN);
        if (storedAuth === authToken) return;

        const nativeFcmToken = fcmTokenRef.current || await getFCMToken();
        console.log('[WEB_AUTH_TOKENS] new/changed token → storing session', {
          authToken: `${authToken.slice(0, 10)}...`,
          isDriver,
          fcm: nativeFcmToken ? 'present' : 'EMPTY',
        });

        // Store the web session (auth_token + web device_token + user_role). This
        // runs even when the FCM token isn't ready yet, because HRMS tracking +
        // the ambulance-push gate need auth_token regardless of FCM.
        await rememberSession(authToken, isDriver, webDeviceToken);
        // Swap the stored device_token to the native FCM token so backend push
        // targets this device. syncDeviceToken no-ops if the token is unchanged.
        if (nativeFcmToken) {
          await syncDeviceToken(nativeFcmToken);
          console.log('[WEB_AUTH_TOKENS] ✅ native FCM token synced to backend via refresh_token');
        } else {
          console.log('[WEB_AUTH_TOKENS] ⚠ native FCM token not ready — will sync on next foreground');
        }
        return;
      }

      // ─── CURRENT_USER_DATA ───────────────────────────────────────────────
      if (message?.type === 'CURRENT_USER_DATA') {
        const user = message?.data ?? null;
        await AsyncStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user));
        return;
      }

      // ─── STOP_TRACKING (HRMS spec) ───────────────────────────────────────
      if (message?.type === 'STOP_TRACKING') {
        await hrmsTracker.stop();
        return;
      }

      // ─── OPEN_LOCATION_SETTINGS (web retryGpsLostSession bridge) ───────────
      if (message?.type === 'OPEN_LOCATION_SETTINGS') {
        await requestLocationPermission();
        return;
      }

      // ─── REQUEST_LOCATION_PERMISSION (generic one-shot permission request) ─
      if (message?.type === 'REQUEST_LOCATION_PERMISSION') {
        const granted = await hrmsTracker.requestPermission();
        webRef.current?.injectJavaScript(`
          (function() {
            window.dispatchEvent(new CustomEvent('nativeLocationPermission', {
              detail: { granted: ${granted} }
            }));
          })(); true;
        `);
        return;
      }

      // ─── GET_LOCATION (one-shot bridge for navigator.geolocation) ────────
      if (message?.type === 'GET_LOCATION') {
        const callbackId: string = message?.data?.callbackId ?? '';
        if (!/^geo_\d+_\d+$/.test(callbackId)) {
          console.log('[HRMS] GET_LOCATION rejected — invalid callbackId shape');
          return;
        }
        Geolocation.getCurrentPosition(
          (pos) => {
            const { latitude, longitude, accuracy, altitude } = pos.coords;
            webRef.current?.injectJavaScript(
              resolveGeoSuccessScript(callbackId, latitude, longitude, accuracy, altitude, pos.timestamp),
            );
          },
          (err) => {
            // JSON.stringify handles quotes/backslashes/newlines — a bare
            // quote-escape broke the injected script on multiline messages.
            webRef.current?.injectJavaScript(resolveGeoErrorScript(callbackId, err.code, err.message));
          },
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000, forceRequestLocation: true } as any
        );
        return;
      }
    } catch (error) {
      console.log('[handleMessage] Error:', error);
    }
  };
}
