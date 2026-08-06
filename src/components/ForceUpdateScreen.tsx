import React from 'react';
import { Text, TouchableOpacity, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { styles } from '../styles/appStyles';

interface ForceUpdateScreenProps {
  message: string;
  storeUrl: string;
}

// Force update: replaces the WebView entirely. Only action is "Update Now";
// there is no way back into the app from here this session.
export function ForceUpdateScreen({ message, storeUrl }: ForceUpdateScreenProps) {
  return (
    <SafeAreaView style={[styles.gateScreen, { justifyContent: 'center' }]}>
      <Text style={styles.gateTitle}>Update Required</Text>
      <Text style={styles.gateMessage}>{message}</Text>
      <TouchableOpacity
        style={[styles.button, { paddingHorizontal: 24, marginTop: 20 }]}
        onPress={() => Linking.openURL(storeUrl)}
      >
        <Text style={styles.buttonText}>Update Now</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}
