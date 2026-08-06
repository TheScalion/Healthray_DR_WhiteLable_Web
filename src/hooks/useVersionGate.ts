import { useEffect, useState } from 'react';
import { Platform, Alert, Linking } from 'react-native';
import axios from 'axios';
import DeviceInfo from 'react-native-device-info';
import { BUILD_MANAGEMENT_API, ITUNES_URL, PLAYSTORE_URL } from '../config/env';

interface VersionGateState {
  forceUpdateMessage: string | null;
  forceUpdateStoreUrl: string;
  maintenanceMessage: string | null;
}

const getStoreUrl = (data: any): string => {
  if (Platform.OS === 'ios') return data?.ios_app_url || ITUNES_URL;
  return data?.android_app_url || PLAYSTORE_URL;
};

/**
 * Checked once on every app launch. The backend returns a status that decides
 * whether the app is fine, should nudge (soft) or must block (force) an
 * update, or is in maintenance. Fails open on any network/API error so a
 * transient outage never locks users out of an otherwise-working app.
 */
export function useVersionGate(): VersionGateState {
  const [forceUpdateMessage, setForceUpdateMessage] = useState<string | null>(null);
  const [forceUpdateStoreUrl, setForceUpdateStoreUrl] = useState('');
  const [maintenanceMessage, setMaintenanceMessage] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await axios.post(
          BUILD_MANAGEMENT_API,
          {
            platform: Platform.OS === 'ios' ? 'iOS' : 'Android',
            current_version: DeviceInfo.getVersion(),
            user_type: 'D',
          },
          {
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            timeout: 15000,
          },
        );

        const { status, message, data } = res.data ?? {};

        if (status === 701) {
          // Force update: block the app. No dismiss path — the screen stays up
          // for the rest of this session; the gate re-checks on the next launch.
          setForceUpdateStoreUrl(getStoreUrl(data));
          setForceUpdateMessage(message || 'A new version is available. Please update to continue.');
        } else if (status === 702) {
          const storeUrl = getStoreUrl(data);
          Alert.alert(
            'Update Available',
            message || 'A new version is available.',
            [
              { text: 'Later', style: 'cancel' },
              { text: 'Update', onPress: () => Linking.openURL(storeUrl) },
            ],
          );
        } else if (status === 703) {
          setMaintenanceMessage(message || 'The app is currently under maintenance. Please try again later.');
        }
      } catch (e) {
        if (axios.isAxiosError(e)) {
          console.log('[VersionGate] check_update_required failed:', e.message);
        } else {
          console.log('[VersionGate] check_update_required failed:', e);
        }
      }
    })();
  }, []);

  return { forceUpdateMessage, forceUpdateStoreUrl, maintenanceMessage };
}
