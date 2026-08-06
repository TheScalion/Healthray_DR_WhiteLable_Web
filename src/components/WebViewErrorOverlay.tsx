import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { styles } from '../styles/appStyles';

interface WebViewErrorOverlayProps {
  description: string;
  onRetry: () => void;
}

// Replaces the library's raw "Domain / Error Code / Description" default
// (see node_modules/react-native-webview/src/WebViewShared.tsx) with a
// screen that matches the rest of the app and actually gives the user a
// way out instead of a dead end. Ignores the passed-in domain — it's
// undefined on Android by construction (see WEB_BASE_HOST in config/env.ts)
// — the caller shows WEB_BASE_HOST instead, which is always accurate.
export function WebViewErrorOverlay({ description, onRetry }: WebViewErrorOverlayProps) {
  return (
    <View style={styles.webErrorOverlay}>
      <Text style={styles.gateTitle}>Can't Connect</Text>
      <Text style={styles.gateMessage}>
        Please check your internet connection and try again.
      </Text>
      <Text style={[styles.gateMessage, { fontSize: 12, color: '#999', marginTop: 8 }]}>
        {description}
      </Text>
      <TouchableOpacity
        style={[styles.button, { paddingHorizontal: 24, marginTop: 20 }]}
        onPress={onRetry}
      >
        <Text style={styles.buttonText}>Try Again</Text>
      </TouchableOpacity>
    </View>
  );
}
