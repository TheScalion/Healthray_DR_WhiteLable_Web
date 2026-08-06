import { Platform, PermissionsAndroid } from 'react-native';
import Geolocation from 'react-native-geolocation-service';
import type { WebView as WebViewType } from 'react-native-webview';
import { openAppSettings } from '../utils/appSettings';
import { nativeLocationPermissionScript } from './injectedScripts';

/**
 * Shows the system location permission popup and reports the outcome back
 * into the WebView as a `nativeLocationPermission` CustomEvent. Falls back
 * to App Settings only when permanently denied (OS blocks the dialog).
 *
 * Used by the OPEN_LOCATION_SETTINGS bridge message and the `app-settings:`
 * deep-link intercepted in onShouldStartLoadWithRequest.
 */
export function createRequestLocationPermission(
  webRef: React.RefObject<WebViewType | null>,
) {
  return async function requestLocationPermission(): Promise<void> {
    if (Platform.OS === 'android') {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        {
          title: 'Location Permission',
          message: 'HealthRay needs your location to track your position.',
          buttonPositive: 'Allow',
          buttonNegative: 'Deny',
        },
      );
      if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
        await openAppSettings();
      } else {
        const granted = result === PermissionsAndroid.RESULTS.GRANTED;
        webRef.current?.injectJavaScript(nativeLocationPermissionScript(granted));
      }
    } else {
      const auth = await Geolocation.requestAuthorization('whenInUse');
      const granted = auth === 'granted';
      if (!granted) { await openAppSettings(); }
      webRef.current?.injectJavaScript(nativeLocationPermissionScript(granted));
    }
  };
}
