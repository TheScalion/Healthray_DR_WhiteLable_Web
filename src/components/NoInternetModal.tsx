import React from 'react';
import { Modal, View, Text, TouchableOpacity } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { styles } from '../styles/appStyles';

interface NoInternetModalProps {
  visible: boolean;
}

// No Internet modal — single instance, works in any app state.
export function NoInternetModal({ visible }: NoInternetModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" supportedOrientations={['landscape']}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalBox}>
          <Text style={styles.modalTitle}>No Internet</Text>
          <Text style={styles.modalText}>
            Please check your internet connection
          </Text>
          <TouchableOpacity
            style={[styles.button, { paddingHorizontal: 12 }]}
            onPress={() => {
              // Re-evaluate connectivity; useNetInfo picks up the refreshed
              // state and hides this modal, and the reconnect effect reloads
              // the WebView if it had errored.
              NetInfo.refresh().catch(() => { });
            }}
          >
            <Text style={styles.buttonText}>Try again</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
