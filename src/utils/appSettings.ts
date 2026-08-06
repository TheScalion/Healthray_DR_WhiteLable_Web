import { Linking } from 'react-native';

export async function openAppSettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch (e) {
    console.log('[Bridge] openAppSettings error', e);
  }
}
