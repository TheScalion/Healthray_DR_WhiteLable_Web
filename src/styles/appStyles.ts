import { Dimensions, StyleSheet } from 'react-native';

const { width } = Dimensions.get('window');
export const IS_TABLET = width >= 768;

export const styles = StyleSheet.create({
  button: {
    backgroundColor: "#0b3d6e",
    height: 45,
    borderRadius: 6,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 10,
  },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBox: {
    width: IS_TABLET ? '30%' : '80%',
    backgroundColor: 'white',
    padding: 20,
    borderRadius: 10,
    alignItems: 'center',
  },
  modalTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 10 },
  modalText: { textAlign: 'center' },
  gateScreen: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingHorizontal: 24,
  },
  gateTitle: { fontSize: 22, fontWeight: '700', marginBottom: 12, textAlign: 'center' },
  gateMessage: { fontSize: 15, textAlign: 'center', color: '#333' },
  // Unlike gateScreen (a full top-level return with no sibling), this renders
  // inside the WebView's own container next to the (still-mounted) WebView —
  // it needs absolute positioning to actually cover it, matching the sizing
  // the library's own default error/loading views use internally.
  webErrorOverlay: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingHorizontal: 24,
  },
});
