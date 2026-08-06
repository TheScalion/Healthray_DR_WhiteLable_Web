import React from 'react';
import { Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { styles } from '../styles/appStyles';

interface MaintenanceScreenProps {
  message: string;
}

// Maintenance: same idea as ForceUpdateScreen, no action available — just wait it out.
export function MaintenanceScreen({ message }: MaintenanceScreenProps) {
  return (
    <SafeAreaView style={[styles.gateScreen, { justifyContent: 'center' }]}>
      <Text style={styles.gateTitle}>Under Maintenance</Text>
      <Text style={styles.gateMessage}>{message}</Text>
    </SafeAreaView>
  );
}
