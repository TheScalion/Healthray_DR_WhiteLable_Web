import 'react-native-get-random-values';
import React, { useRef, useState, useEffect, useCallback } from "react";
import messaging from '@react-native-firebase/messaging';
import notifee, { EventType } from '@notifee/react-native';
import {
  View,
  StatusBar,
  useColorScheme,
  Platform,
  PermissionsAndroid,
  AppState,
  ToastAndroid,
  BackHandler,
  Linking,
} from "react-native";
import { WebView, type WebView as WebViewType } from "react-native-webview";
import AsyncStorage from "@react-native-async-storage/async-storage";
import RNBootSplash from "react-native-bootsplash";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useNetInfo } from "@react-native-community/netinfo";

import { initFCM } from './src/services/fcmService';
import { syncDeviceToken, configureApiBase } from './src/services/deviceToken';
import { hrmsTracker } from './src/tracking';
import { TRACKING_STORAGE } from './src/tracking/constants';
import { API_BASE, WEB_BASE, WEB_LOAD_RETRY_DELAYS_MS, isOnLoginPage } from './src/config/env';
import { createRequestLocationPermission } from './src/webview/locationPermission';
import { createMessageHandler } from './src/webview/messageHandler';
import {
  combinedScript,
  beforeContentLoadedScript,
  syncWebAuthTokensScript,
  nativeTrackingStatusScript,
  navigateToAmbulanceScript,
} from './src/webview/injectedScripts';
import { useVersionGate } from './src/hooks/useVersionGate';
import { ForceUpdateScreen } from './src/components/ForceUpdateScreen';
import { MaintenanceScreen } from './src/components/MaintenanceScreen';
import { NoInternetModal } from './src/components/NoInternetModal';
import { WebViewErrorOverlay } from './src/components/WebViewErrorOverlay';

export default function App() {
  const mode = useColorScheme();
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={mode === "dark" ? "light-content" : "dark-content"} />
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const webRef = useRef<WebViewType>(null);

  const prevInternetRef = useRef<boolean | null>(null);
  const isOnlineRef = useRef<boolean>(false);
  const canGoBackRef = useRef(false);        // WebView has history (Android hardware back)
  const webErroredRef = useRef(false);       // last WebView load errored → reload on reconnect/foreground
  const errorRetryCountRef = useRef(0);      // capped auto-retry attempts for the current error streak
  const errorRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fcmTokenRef = useRef<string>('');    // cached FCM token (for WEB_AUTH_TOKENS sync)
  const authSyncedRef = useRef(false);       // web auth token pulled into AsyncStorage this session
  const lastBackPressRef = useRef(0);        // double-tap-to-exit timestamp
  const splashHiddenRef = useRef(false);     // BootSplash.hide() called exactly once

  const { isConnected, isInternetReachable } = useNetInfo();

  const [initialWebUrl, setInitialWebUrl] = useState(`${WEB_BASE}/`);
  const [netInfoReady, setNetInfoReady] = useState(false);
  const showInternetModel = netInfoReady && isConnected === false;

  // Non-null blocks the WebView entirely in favor of a dedicated screen (see render below).
  const { forceUpdateMessage, forceUpdateStoreUrl, maintenanceMessage } = useVersionGate();

  // an offline cold start where no load event fires at all.
  const hideSplashOnce = useCallback(() => {
    if (splashHiddenRef.current) return;
    splashHiddenRef.current = true;
    RNBootSplash.hide({ fade: true });
  }, []);

  useEffect(() => {
    const t = setTimeout(hideSplashOnce, 6000);
    return () => clearTimeout(t);
  }, [hideSplashOnce]);

  useEffect(() => {
    if (forceUpdateMessage || maintenanceMessage) hideSplashOnce();
  }, [forceUpdateMessage, maintenanceMessage, hideSplashOnce]);

  const clearWebLoadRetry = useCallback(() => {
    if (errorRetryTimerRef.current) {
      clearTimeout(errorRetryTimerRef.current);
      errorRetryTimerRef.current = null;
    }
  }, []);

  // Shared by the reconnect and foreground effects below: recover a WebView
  // that errored while offline/backgrounded without waiting out its backoff.
  const reloadIfErrored = useCallback(() => {
    if (!webErroredRef.current || !webRef.current) return;
    webErroredRef.current = false;
    clearWebLoadRetry();
    errorRetryCountRef.current = 0;
    webRef.current.reload();
  }, [clearWebLoadRetry]);

  // HRMS tracking + ambulance push stay authenticated without a native login.
  const syncWebAuthTokens = useCallback(() => {
    webRef.current?.injectJavaScript(syncWebAuthTokensScript);
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    (async () => {
      const perms: string[] = [
        PermissionsAndroid.PERMISSIONS.CAMERA,
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ];
      // Android 13+ (API 33) requires a runtime POST_NOTIFICATIONS grant
      if ((PermissionsAndroid.PERMISSIONS as any).POST_NOTIFICATIONS) {
        perms.push((PermissionsAndroid.PERMISSIONS as any).POST_NOTIFICATIONS);
      }
      const results = await PermissionsAndroid.requestMultiple(perms as any);
      const notifPerm = (results as any)['android.permission.POST_NOTIFICATIONS'];
      if (notifPerm && notifPerm !== 'granted') {
        console.log('[PERMISSIONS] ⚠ POST_NOTIFICATIONS not granted:', notifPerm);
      }
    })();
  }, []);

  // Firebase Cloud Messaging: token lifecycle + ambulance-call deep link.
  useEffect(() => {
    configureApiBase(API_BASE);

    let unsubscribeFcm: () => void = () => { };

    // concurrent refresh_token calls for the same rotation.
    initFCM((newToken) => { fcmTokenRef.current = newToken; })
      .then(({ token, unsubscribe: unsub }) => {
        unsubscribeFcm = unsub;
        fcmTokenRef.current = token;
        console.log(token ? `[FCM] ✅ Token ready: ${token}` : '[FCM] ⚠ Token empty — check [FCM] logs in fcmService');
      })
      .catch((e) => console.log('[FCM] ❌ initFCM error:', e?.message ?? e));

    syncDeviceToken();

    const unsubscribeBgTap = messaging().onNotificationOpenedApp((remoteMessage: any) => {
      const type = remoteMessage?.data?.notification_type;
      if (type === 'AMBULANCE_CALL_DISPATCHED' || type === 'AMBULANCE_CALL_REASSIGNED') {
        setTimeout(() => webRef.current?.injectJavaScript(navigateToAmbulanceScript), 500);
      }
    });

    notifee.getInitialNotification().then(initial => {
      if (initial?.notification?.data?.call_id) setInitialWebUrl(`${WEB_BASE}/ambulance`);
    });

    const unsubscribeNotifee = notifee.onForegroundEvent(({ type, detail }) => {
      if (type === EventType.PRESS && detail.notification?.data?.call_id) {
        webRef.current?.injectJavaScript(navigateToAmbulanceScript);
      }
    });

    return () => {
      unsubscribeFcm();
      unsubscribeBgTap();
      unsubscribeNotifee();
    };
  }, []);

  // Reconnect: reload a WebView that errored out while offline.
  useEffect(() => {
    if (!netInfoReady) return;
    const isOnline = isConnected !== false;
    isOnlineRef.current = isOnline;
    if (prevInternetRef.current === false && isOnline) reloadIfErrored();
    prevInternetRef.current = isOnline;
  }, [isConnected, isInternetReachable, netInfoReady, reloadIfErrored]);

  useEffect(() => {
    const timer = setTimeout(() => setNetInfoReady(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  // Foreground: drain the HRMS buffer, re-sync the web auth token (in case it
  // rotated while backgrounded), and recover an errored WebView.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (nextAppState) => {
      if (nextAppState !== 'active') return;
      if (hrmsTracker.getActiveSession()) {
        hrmsTracker.restartGPSIfDead();
        if (isOnlineRef.current) hrmsTracker.flushNow().catch(() => { });
      }
      if (authSyncedRef.current) syncWebAuthTokens();
      reloadIfErrored();
    });
    return () => sub.remove();
  }, [syncWebAuthTokens, reloadIfErrored]);

  // HRMS tracker: relay native status into the WebView + resume any session on launch.
  useEffect(() => {
    hrmsTracker.setStatusEmitter((status, detail) => {
      const payload = JSON.stringify({ status, ...(detail ?? {}) });
      try {
        webRef.current?.injectJavaScript(nativeTrackingStatusScript(payload));
      } catch (e) {
        console.log('[HRMS] failed to dispatch status', status, e);
      }

      // refreshed one from the still-live web session.
      if (status === 'auth_expired') {
        AsyncStorage.multiRemove([TRACKING_STORAGE.AUTH_TOKEN, TRACKING_STORAGE.DEVICE_TOKEN]).catch(() => { });
        authSyncedRef.current = false;
        syncWebAuthTokens();
      }
    });

    hrmsTracker.resumeIfPossible().catch((e) => console.log('[HRMS] resume failed', e));

    return () => hrmsTracker.destroy();
  }, [syncWebAuthTokens]);

  // Android hardware back → step back through WebView history; at the root,
  // double-tap to exit.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBackRef.current && webRef.current) {
        webRef.current.goBack();
        return true;
      }
      const now = Date.now();
      if (now - lastBackPressRef.current < 2000) {
        BackHandler.exitApp();
        return true;
      }
      lastBackPressRef.current = now;
      if (Platform.OS === 'android') ToastAndroid.show('Press back again to exit', ToastAndroid.SHORT);
      return true;
    });
    return () => sub.remove();
  }, []);

  // onLoadEnd fires on both success AND failure — it only ever drops the
  // splash. Clearing the error flag here would defeat every recovery path below.
  const handleLoadEnd = () => hideSplashOnce();

  // onLoad fires only on the success path — the correct place to clear the error state.
  const handleWebLoadSuccess = useCallback(() => {
    webErroredRef.current = false;
    errorRetryCountRef.current = 0;
    clearWebLoadRetry();
  }, [clearWebLoadRetry]);

  // Capped-backoff self-heal: a DNS/transient failure doesn't necessarily flip
  // NetInfo's isConnected, so this is the only automatic retry for that case.
  // The manual "Try Again" button is the fallback once it's exhausted.
  const scheduleWebLoadRetry = useCallback(() => {
    if (errorRetryTimerRef.current) return;
    const attempt = errorRetryCountRef.current;
    if (attempt >= WEB_LOAD_RETRY_DELAYS_MS.length) return;
    errorRetryTimerRef.current = setTimeout(() => {
      errorRetryTimerRef.current = null;
      errorRetryCountRef.current += 1;
      webRef.current?.reload();
    }, WEB_LOAD_RETRY_DELAYS_MS[attempt]);
  }, []);

  const retryWebViewNow = useCallback(() => {
    clearWebLoadRetry();
    errorRetryCountRef.current = 0; // manual retry gets a fresh backoff budget
    webRef.current?.reload();
  }, [clearWebLoadRetry]);

  const renderWebViewError = useCallback(
    (_domain: string | undefined, _code: number, description: string) => (
      <WebViewErrorOverlay description={description} onRetry={retryWebViewNow} />
    ),
    [retryWebViewNow],
  );

  useEffect(() => clearWebLoadRetry, [clearWebLoadRetry]);

  const handleNavigationStateChange = (navState: any) => {
    const url = (navState.url || '').toLowerCase();
    canGoBackRef.current = !!navState.canGoBack;

    if (isOnLoginPage(url)) {
      // On the login page after being authenticated this session = logout /
      // session-expiry. Stop tracking (its /tracking/end must run before the
      // token is cleared) and drop stored auth.
      if (authSyncedRef.current) {
        authSyncedRef.current = false;
        (async () => {
          try { await hrmsTracker.stop(); } catch { }
          await AsyncStorage.multiRemove([TRACKING_STORAGE.AUTH_TOKEN, TRACKING_STORAGE.DEVICE_TOKEN, 'user_role']).catch(() => { });
        })();
      }
      return;
    }

    // Authenticated page, not yet synced this session — covers both a fresh
    // login and a stay-signed-in relaunch. Rotation is handled on foreground.
    if (!authSyncedRef.current) syncWebAuthTokens();
  };

  const requestLocationPermission = createRequestLocationPermission(webRef);
  const handleMessage = createMessageHandler({ webRef, fcmTokenRef, authSyncedRef, requestLocationPermission });

  // Version-gate screens replace the WebView entirely for this session.
  if (forceUpdateMessage) {
    return <ForceUpdateScreen message={forceUpdateMessage} storeUrl={forceUpdateStoreUrl} />;
  }
  if (maintenanceMessage) {
    return <MaintenanceScreen message={maintenanceMessage} />;
  }

  // WebView-only: the web app owns auth and persists its session in the
  // WebView's localStorage/cookies, so the user stays signed in across restarts.
  return (
    <View style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
        <WebView
          ref={webRef}
          source={{ uri: initialWebUrl }}
          style={{ flex: 1 }}
          javaScriptEnabled
          domStorageEnabled
          cacheEnabled
          sharedCookiesEnabled          // iOS: persist cookies → stay signed in
          thirdPartyCookiesEnabled      // Android: allow the web session cookie
          mixedContentMode="always"
          injectedJavaScriptBeforeContentLoaded={beforeContentLoadedScript}
          injectedJavaScript={combinedScript}
          scalesPageToFit={false}
          setBuiltInZoomControls={false}
          setDisplayZoomControls={false}
          bounces={false}
          scrollEnabled={true}
          originWhitelist={['https://*', 'http://*', 'app-settings:*']}
          onMessage={handleMessage}
          onLoad={handleWebLoadSuccess}
          onLoadEnd={handleLoadEnd}
          onNavigationStateChange={handleNavigationStateChange}
          renderError={renderWebViewError}
          onError={(e: any) => {
            webErroredRef.current = true;
            console.log('⚠ WebView onError', e?.nativeEvent?.description ?? e?.nativeEvent);
            hideSplashOnce();
            scheduleWebLoadRetry();
          }}
          onHttpError={(e: any) => {
            webErroredRef.current = true;
            console.log('⚠ WebView onHttpError', { code: e?.nativeEvent?.statusCode, url: e?.nativeEvent?.url });
          }}
          // OS can kill the WebView renderer under memory pressure — reload
          // rather than sit on a dead white screen (the web session persists).
          onRenderProcessGone={(e: any) => {
            console.log('⚠ WebView renderer process gone — reloading', e?.nativeEvent);
            webRef.current?.reload();
          }}
          onContentProcessDidTerminate={() => {
            console.log('⚠ WebView content process terminated — reloading');
            webRef.current?.reload();
          }}
          onShouldStartLoadWithRequest={(request: any) => {
            const url = request.url || '';
            if (url.startsWith('app-settings:')) {
              requestLocationPermission();
              return false;
            }
            // Non-http(s) schemes can't render in a WebView — hand to the OS
            // (dialer, mail, SMS, WhatsApp, UPI, maps, Android intents).
            if (/^(tel:|mailto:|sms:|whatsapp:|upi:|geo:|intent:)/i.test(url)) {
              Linking.openURL(url).catch(() => { });
              return false;
            }
            return true;
          }}
        />
      </SafeAreaView>

      <NoInternetModal visible={showInternetModel} />
    </View>
  );
}
