import 'react-native-get-random-values';
import React, { useRef, useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Image,
  StyleSheet,
  Alert,
  StatusBar,
  useColorScheme,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Dimensions,
  ScrollView,
  Keyboard
} from "react-native";
import { WebView, type WebView as WebViewType } from "react-native-webview";
import AsyncStorage from "@react-native-async-storage/async-storage";
import RNBootSplash from "react-native-bootsplash";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useNetInfo } from "@react-native-community/netinfo";
import CryptoJS from 'crypto-js';
import Icon from 'react-native-vector-icons/MaterialIcons';
// import CookieManager from '@react-native-cookies/cookies';
import DeviceInfo from 'react-native-device-info';
import axios from 'axios';
import { Linking } from 'react-native';
import Share from 'react-native-share';
import ReactNativeBlobUtil from 'react-native-blob-util';
import LottieView from 'lottie-react-native';




const LOGIN_URL = "https://heritage.healthray.com/login";

const STORAGE_KEYS = {
  ONLY_WEB: "ONLY_WEB",
  SAVE_WEB_URL: "SAVE_WEB_URL",
  IS_LOGGED_IN: "IS_LOGGED_IN",
};

const SECRET_KEY = 'YsF&7B@34$+0A@408$B3x62&62';
const { width } = Dimensions.get('window');
const IS_TABLET = width >= 768;



const BASE_URL = 'https://heritagenode.healthray.com/api/v2/';
const BUILD_MANAGMENT_API = 'build_management/check_update_required';

const ITUNES_URL = 'https://apps.apple.com/in/app/healthray-dr-for-doctors/id1513592834';
const PLAYSTORE_URL = 'https://play.google.com/store/apps/details?id=com.heritage.doctor&hl=en_IN';


export default function App() {
  const mode = useColorScheme();
  return (
    <SafeAreaProvider>
      <StatusBar
        barStyle={mode === "dark" ? "light-content" : "dark-content"}
      />
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const webRef = useRef<WebViewType>(null);

  const wasLoggedInRef = useRef(false);
  const isFirstWebLoadRef = useRef(true);
  const lastWebUrlRef = useRef<string>('');
  const loginTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevInternetRef = useRef<boolean | null>(null);
  const { isConnected, isInternetReachable } = useNetInfo()

  const [showWeb, setShowWeb] = useState(false);
  const [webKey, setWebKey] = useState(0);
  const [initialWebUrl, setInitialWebUrl] = useState(LOGIN_URL);
  const [mobileNo, setMobileNo] = useState("");
  const [password, setPassword] = useState("");
  const [userType, setUserType] = useState('Doctor');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mobileNoError, setMobileNoError] = useState<string | null>(null);
  const [netInfoReady, setNetInfoReady] = useState(false);
  const showInternetModel =
    netInfoReady && !isConnected && !isInternetReachable;

  const [userBasicData, setUserBasicData] = useState<any>(null);
  const [showMaintenance, setShowMaintenance] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState('');

  const getStoreUrl = () => {
    if (Platform.OS === 'ios') {
      return userBasicData?.ios_app_url && userBasicData.ios_app_url !== ''
        ? userBasicData.ios_app_url
        : ITUNES_URL;
    }

    return userBasicData?.android_app_url && userBasicData.android_app_url !== ''
      ? userBasicData.android_app_url
      : PLAYSTORE_URL;
  };

  useEffect(() => {
    RNBootSplash.hide({ fade: true });
    // buildVersionManagement();
  }, []);


  useEffect(() => {
    // wait until netInfo is ready
    if (!netInfoReady) return;

    const isOnline = isConnected && isInternetReachable;

    // Detect OFF -> ON
    if (prevInternetRef.current === false && isOnline) {
      console.log('Internet restored');

      (async () => {
        const lastUrl = await AsyncStorage.getItem(
          STORAGE_KEYS.SAVE_WEB_URL
        );

        if (lastUrl && webRef.current) {
          console.log('Reloading last URL:', lastUrl);

          // Option 1 (BEST): reload current page
          webRef.current.reload();

          // Option 2 (fallback if reload fails)
          // setInitialWebUrl(lastUrl);
          // setWebKey(prev => prev + 1);
        }
      })();
    }

    prevInternetRef.current = isOnline;
  }, [isConnected, isInternetReachable, netInfoReady]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setNetInfoReady(true);
    }, 1500); // 1.5 seconds delay (you can tune)

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const checkLoginState = async () => {
      const savedUrl = await AsyncStorage.getItem(STORAGE_KEYS.SAVE_WEB_URL);
      const isLoggedIn = await AsyncStorage.getItem(STORAGE_KEYS.IS_LOGGED_IN);

      if (isLoggedIn === "true") {
        wasLoggedInRef.current = true;
        setInitialWebUrl(savedUrl ?? LOGIN_URL);
        setShowWeb(true);
      } else {
        setShowWeb(false);
      }
    };

    checkLoginState();
  }, []);

  const convertLocalTimeToUtcTime = () => {
    // Get current local time
    const localTime = new Date();
    // Get the time zone offset in minutes
    const timezoneOffsetInMinutes = localTime.getTimezoneOffset();
    // Convert local time to UTC by subtracting the offset
    const utcTime = new Date(
      localTime.getTime() - timezoneOffsetInMinutes * 60000
    );

    return utcTime;
  };

  const encryptText = (plainTextString: string): string | null => {
    console.log("JS encryptText: Input plaintext string:", plainTextString);
    try {
      const salt = CryptoJS.lib.WordArray.random(128 / 8); // 16 bytes

      const key = CryptoJS.PBKDF2(SECRET_KEY, salt, {
        keySize: 256 / 32,
        iterations: 1000,
        hasher: CryptoJS.algo.SHA1, // Ensure this is needed and matches iOS
      });

      // Ensure plainText is a WordArray if it's a string
      let plainTextWordArray: CryptoJS.lib.WordArray;
      if (typeof plainTextString === "string") {
        plainTextWordArray = CryptoJS.enc.Utf8.parse(plainTextString);
      } else {
        // This case should not happen if you call it with a string
        plainTextWordArray = plainTextString as CryptoJS.lib.WordArray;
      }

      const encryptedCipherParams = CryptoJS.AES.encrypt(
        plainTextWordArray,
        key,
        {
          iv: salt,
          mode: CryptoJS.mode.CBC,
          padding: CryptoJS.pad.Pkcs7,
        }
      );

      const saltHex = salt.toString(CryptoJS.enc.Hex);
      // Use .ciphertext to get the raw encrypted data, then Base64 encode it
      const ciphertextBase64 = encryptedCipherParams.ciphertext.toString(
        CryptoJS.enc.Base64
      );

      return saltHex + ciphertextBase64;
    } catch (error) {
      console.error("JS Encryption Error:", error);
      return null;
    }
  };

  const buildVersionManagement = async () => {
    try {
      const params = {
        platform: Platform.OS === 'ios' ? 'iOS' : 'Android',
        current_version: DeviceInfo.getVersion(),
        user_type: 'D',
      };

      console.log('📡 Calling API with params:', params);

      const response = await axios.post(
        `${BASE_URL}${BUILD_MANAGMENT_API}`,
        params,
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 15000, // optional but useful
        }
      );

      console.log('✅ Axios response:', response.data);

      handleBuildVersionResponse(response.data);

    } catch (error) {
      // Axios gives better error info
      if (axios.isAxiosError(error)) {
        console.log('❌ Axios error message:', error.message);
        console.log('❌ Status:', error.response?.status);
        console.log('❌ Response data:', error.response?.data);
      } else {
        console.log('❌ Unknown error:', error);
      }
    }
  };

  const handleBuildVersionResponse = (response: any) => {
    const statusCode = response?.status;
    const message = response?.message ?? '';
    const data = response?.data ?? {};

    // same as objUserBasicData
    setUserBasicData(data);

    // ===== 701 FORCE UPDATE =====
    if (statusCode === 701) {
      Alert.alert(
        'HIMS',
        message,
        [
          {
            text: 'Update',
            onPress: () => Linking.openURL(getStoreUrl()),
          },
        ],
        { cancelable: false }
      );
      return;
    }

    // ===== 702 OPTIONAL UPDATE =====
    if (statusCode === 702) {
      Alert.alert(
        'HIMS',
        message,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Update',
            onPress: () => Linking.openURL(getStoreUrl()),
          },
        ]
      );
      return;
    }

    // ===== 703 MAINTENANCE =====
    if (statusCode === 703) {
      setMaintenanceMessage(message);
      setShowMaintenance(true);
      return;
    }

    console.log('✅ App is up to date');
  };


  // const resetWebViewSession = async () => {
  //   try {
  //     // Clear all cookies (Android + iOS)
  //     await CookieManager.clearAll(true).then((res) => {
  //       console.log('clear cookie :::', res)
  //     });

  //     // Android needs flush
  //     if (Platform.OS === 'android') {
  //       try {
  //         await CookieManager.flush();
  //         console.log('Cookies flushed successfully');
  //       } catch (e) {
  //         console.log('flush error ::', e);
  //       }
  //     }

  //     // Destroy old WebView & create new one
  //     setWebKey(prev => prev + 1);
  //     console.log('Refresh Cookie!!')

  //   } catch (e) {
  //     console.log('WebView reset error:', e);
  //   }
  // };

  const handleLogin = async () => {

    if (!mobileNo || !password) {
      Alert.alert("Error", "Enter mobile number & password");
      return;
    }

    setMobileNoError(null);

    // Optional: mobile validation (remove if not needed)
    if (mobileNo.length < 10) {
      setMobileNoError("Please enter a valid mobile number.");
      return;
    }

    setLoading(true);
    Keyboard.dismiss()
    try {

      // Encrypt password
      const passwordPayload = JSON.stringify({
        text: password,
        time: convertLocalTimeToUtcTime(),
      });

      const encryptedPassword = encryptText(passwordPayload);

      // API payload (UPDATED)
      const payload = {
        user: {
          mobile_no: mobileNo,
          password: encryptedPassword,
          platform: Platform.OS === "android" ? "Android" : "iOS",
          user_type: userType,
        },
      };

      console.log('Login payload ::::', payload);

      // API call
      const res = await fetch(
        "https://heritagenode.healthray.com/api/v2/users/sign_in",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
        }
      );

      const data = await res.json();

      console.log('Login Data :::', data);

      // Error handling
      if (!res.ok || data?.statusState !== "success") {
        Alert.alert("Login Failed", data?.message || "Unable to sign in");
        setLoading(false);
        return;
      }

      // Success
      await AsyncStorage.setItem(STORAGE_KEYS.IS_LOGGED_IN, "true");

      // CLEAR WEBVIEW SESSION ONCE
      // await resetWebViewSession();

      isFirstWebLoadRef.current = true;
      setInitialWebUrl(LOGIN_URL);
      setShowWeb(true);

      /* START LOGIN WATCHDOG */
      if (loginTimeoutRef.current) {
        clearTimeout(loginTimeoutRef.current);
      }

      loginTimeoutRef.current = setTimeout(async () => {
        const currentUrl = lastWebUrlRef.current;

        console.log("Login timeout check:", currentUrl);

        // Still stuck on login
        if (!currentUrl || currentUrl.includes("/login")) {
          console.log("Auto-login failed, fallback to native login");

          await AsyncStorage.multiRemove([
            STORAGE_KEYS.IS_LOGGED_IN,
            STORAGE_KEYS.SAVE_WEB_URL,
          ]);

          wasLoggedInRef.current = false;
          setShowWeb(false);
          setLoading(false);

          Alert.alert(
            "Login Failed",
            // "Auto login falied. Please try again."
            "Something went wrong. Please try again or check your internet connection."
          );
        }
      }, 55000);


    } catch (e: any) {
      Alert.alert(
        "Login Failed",
        e.message || "Something went wrong. Please try again."
      );
      setLoading(false);
    }
    // finally {
    //   setLoading(false);
    // }
  };



  const handleLoadEnd = (e: any) => {
    const url = e.nativeEvent.url.toLowerCase();

    if (url.includes("/login")) {
      setTimeout(() => {
        webRef.current?.injectJavaScript(autoFillScript);
      }, 800);
    }

    if (!url.includes("/login")) {
      setTimeout(() => setLoading(false), 1500);
    }
  };

  const handleNavigationStateChange = async (navState: any) => {
    const url = navState.url.toLowerCase();
    lastWebUrlRef.current = url;

    console.log('Updated URL.....', url)

    await AsyncStorage.setItem(STORAGE_KEYS.SAVE_WEB_URL, navState.url);

    if (!url.includes("/login")) {
      wasLoggedInRef.current = true;
      await AsyncStorage.setItem(STORAGE_KEYS.IS_LOGGED_IN, "true");

      // SUCCESS → clear timeout
      if (loginTimeoutRef.current) {
        clearTimeout(loginTimeoutRef.current);
        loginTimeoutRef.current = null;
      }

      setTimeout(() => setLoading(false), 1500);
      return;
    }

    if (
      wasLoggedInRef.current &&
      url.includes("/login") &&
      isFirstWebLoadRef.current
    ) {
      await AsyncStorage.multiRemove([
        STORAGE_KEYS.IS_LOGGED_IN,
        STORAGE_KEYS.SAVE_WEB_URL,
      ]);

      wasLoggedInRef.current = false;
      setShowWeb(false);
      setLoading(false);
      setMobileNo('');
      setPassword('');
    }
  };


  const disableZoomScript = `
    (function () {
      var meta = document.createElement('meta');
      meta.setAttribute('name', 'viewport');
      meta.setAttribute(
        'content',
        'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no'
      );
      document.getElementsByTagName('head')[0].appendChild(meta);
    })();
    true;
  `;


  const autoFillScript = `
  (function autoLogin() {

    let attemptCount = 0;
    const maxAttempts = 3;
    const retryDelay = 5000; // EXACT 3 seconds between clicks
    const clickDelay = 2000;

    function performClick() {

      if (attemptCount >= maxAttempts) {
        console.log('🛑 Max login attempts reached');
        return;
      }

      const url = window.location.href;
      if (!url.includes('/login')) return;

      const mobileInput = document.getElementById('mobile_no');
      const passwordInput =
        document.querySelector('#mat-input-1') ||
        document.querySelector('input[type="password"]');

      const loginButton = document.querySelector('button.submit-button');

      const doctorButton = document.getElementById('mat-button-toggle-1-button');
      const staffButton = document.getElementById('mat-button-toggle-2-button');

      const verificationType = '${userType}';

      if (verificationType.toLowerCase() === 'invitee') {
        if (staffButton) staffButton.click();
      } else {
        if (doctorButton) doctorButton.click();
      }

      if (mobileInput && passwordInput && loginButton && !loginButton.disabled) {

      // Fill inputs
      mobileInput.value = '${mobileNo}';
      mobileInput.dispatchEvent(new Event('input', { bubbles: true }));

      passwordInput.value = '${password}';
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }));

      console.log('⏳ Waiting 2 seconds before click...');

      // 👇 WAIT 2 SECONDS BEFORE CLICK
      setTimeout(() => {

        loginButton.click();
        attemptCount++;

        console.log('✅ Login attempt:', attemptCount);

        if (attemptCount < maxAttempts) {
          setTimeout(performClick, retryDelay);
        }

      }, clickDelay);

    }
  }

  // Start after page loads (2 sec initial delay)
  setTimeout(performClick, 2000);

})();
true;
`;



  /* ================= WEB VIEW ================= */

  if (showMaintenance) {
    return (
      <SafeAreaView
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: '#fff',
          padding: 20,
        }}
      >
        <Text style={{ fontSize: 22, fontWeight: '700', marginBottom: 10 }}>
          Under Maintenance
        </Text>
        <Text style={{ textAlign: 'center', fontSize: 14 }}>
          {maintenanceMessage || 'Please try again later.'}
        </Text>
      </SafeAreaView>
    );
  }



  const handleMessage = async (event: any) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);

      if (message?.type !== 'pdf') return;
      if (!message?.data) return;

      const base64Data = message.data.replace(
        'data:application/pdf;base64,',
        ''
      );

      if (Platform.OS === 'android') {

        // 📂 Folder path
        const folderPath =
          ReactNativeBlobUtil.fs.dirs.DownloadDir +
          '/HealthrayDR/HealthrayDocument';

        const filePath = folderPath + '/Prescription.pdf';

        // 📁 Create folder (ignore if exists)
        await ReactNativeBlobUtil.fs.mkdir(folderPath).catch(() => { });

        // 📄 Overwrite file (no delete needed)
        await ReactNativeBlobUtil.fs.writeFile(
          filePath,
          base64Data,
          'base64'
        );

        console.log('PDF saved at:', filePath);

        // 📖 Open PDF
        await ReactNativeBlobUtil.android.actionViewIntent(
          filePath,
          'application/pdf'
        );

      } else {

        const folderPath =
          ReactNativeBlobUtil.fs.dirs.DocumentDir +
          '/HealthrayDR/HealthrayDocument';

        const filePath = folderPath + '/Prescription.pdf';

        await ReactNativeBlobUtil.fs.mkdir(folderPath).catch(() => { });

        await ReactNativeBlobUtil.fs.writeFile(
          filePath,
          base64Data,
          'base64'
        );

        await Share.open({
          url: 'file://' + filePath,
          type: 'application/pdf',
          failOnCancel: false,
        });
      }

    } catch (error) {
      console.log('PDF Error:', error);
    }
  };

  const combinedScript = `
${disableZoomScript}

(function() {
  document.addEventListener('click', function(e) {
    const element = e.target.closest('a');

    if (element && element.href && element.href.startsWith('blob:')) {

      fetch(element.href)
        .then(res => res.blob())
        .then(blob => {
          const reader = new FileReader();
          reader.onloadend = function() {
            window.ReactNativeWebView.postMessage(
              JSON.stringify({
                type: 'pdf',
                data: reader.result
              })
            );
          };
          reader.readAsDataURL(blob);
        });

      e.preventDefault();
    }
  });
})();
true;
`;



  if (showWeb) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
        <WebView
          // key={webKey}  //forces fresh WebView
          ref={webRef}
          source={{ uri: initialWebUrl }}
          style={{ flex: 1, opacity: loading ? 0 : 1 }}
          javaScriptEnabled
          domStorageEnabled
          mixedContentMode="always"

          // injectedJavaScript={disableZoomScript}
          injectedJavaScript={combinedScript}
          scalesPageToFit={false}        // Android
          setBuiltInZoomControls={false} // Android
          setDisplayZoomControls={false}
          bounces={false}
          scrollEnabled={true}

          // incognito                   // extra safety
          // cacheEnabled={false}         // Android safety
          onMessage={handleMessage}
          onLoadEnd={handleLoadEnd}
          onNavigationStateChange={handleNavigationStateChange}
        />


        {loading && (
          // <View style={styles.overlay}>
          //   <ActivityIndicator size="large" color="#576bff" />
          // </View>
          <View style={styles.overlay}>
            <LottieView
              source={require('./src/common/Loader.json')}
              autoPlay
              loop
              style={styles.lottie}
            />
          </View>

        )}

        <Modal visible={showInternetModel} transparent animationType="fade" supportedOrientations={['landscape']}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalBox}>
              <Text style={styles.modalTitle}>No Internet</Text>
              <Text style={styles.modalText}>
                Please check your internet connection
              </Text>
              <TouchableOpacity
                style={[styles.button, { paddingHorizontal: 12 }]}
              // onPress={async () => {
              //   const lastUrl = await AsyncStorage.getItem(
              //     STORAGE_KEYS.SAVE_WEB_URL
              //   );

              //   if (lastUrl && webRef.current) {
              //     webRef.current.reload();
              //   }
              // }}
              >
                <Text style={styles.buttonText}>Try again</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    );
  }

  const renderMobileUI = () => (
    <>
      {!IS_TABLET && (
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Login Here</Text>
        </View>)}

      <ScrollView
        contentContainerStyle={{ flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.container}>
          {/* Logo */}
          <Image
            source={require('./src/common/HIMSLogo.png')}
            style={styles.logo}
            resizeMode="contain"
          />

          {/* Subtitle */}
          <Text style={styles.subtitle}>
            Glad to see you back. Please login to start chatting with your
            patient.
          </Text>

          {/* Doctor / Staff Switch */}
          <View style={styles.segment}>
            {['Doctor', 'Invitee'].map((item, index) => (
              <TouchableOpacity
                key={item}
                style={[
                  styles.segmentBtn,
                  userType === item && styles.segmentActive,
                ]}
                onPress={() => setUserType(index === 1 ? "Invitee" : "Doctor")}
              >
                <Text
                  style={[
                    styles.segmentText,
                    userType === item && styles.segmentTextActive,
                  ]}
                >
                  {item === "Invitee" ? "Staff" : "Doctor"}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Mobile Input */}
          <View style={styles.inputWrapper}>
            <View style={{ flexDirection: "row", alignItems: 'center', gap: 10 }}>
              <Icon
                name="call"
                size={25}
                color="#666"
              />
              <TextInput
                placeholder="Mobile number"
                placeholderTextColor="#999"
                keyboardType="phone-pad"
                maxLength={10}
                style={styles.input}
                value={mobileNo}
                onChangeText={(text) => {
                  setMobileNo(text);
                  if (mobileNoError) setMobileNoError(null); // clear error while typing
                }}
              />
            </View>
            {mobileNoError && (
              <Text style={styles.errorText}>
                {mobileNoError}
              </Text>
            )}
          </View>

          {/* Password Input */}
          <View style={[styles.inputWrapper, { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }]}>
            <Icon
              name="lock"
              size={25}
              color="#666"
            />
            <TextInput
              placeholder="Password"
              placeholderTextColor="#999"
              secureTextEntry={!passwordVisible}
              style={styles.input}
              value={password}
              onChangeText={setPassword}
            />
            <TouchableOpacity
              onPress={() => setPasswordVisible(!passwordVisible)}
              style={styles.eyeButton}
            >
              <Icon
                name={passwordVisible ? "visibility" : "visibility-off"}
                size={20}
                color="#666"
              />
            </TouchableOpacity>
          </View>

          {/* Login Button */}
          <TouchableOpacity style={styles.loginBtn} onPress={handleLogin}>
            <Text style={styles.loginText}>Login</Text>
          </TouchableOpacity>

          {/* Forgot */}
          {/* <TouchableOpacity>
              <Text style={styles.forgotText}>Forgot Your Password ?</Text>
            </TouchableOpacity> */}
        </View>
      </ScrollView>

      {/* {loading && (
        <View style={styles.overlay}>
          <ActivityIndicator size="large" color="#576bff" />
        </View>
      )} */}

      <Modal visible={showInternetModel} transparent animationType="fade" supportedOrientations={['landscape']}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>No Internet</Text>
            <Text style={styles.modalText}>
              Please check your internet connection
            </Text>
            <TouchableOpacity style={[styles.button, { paddingHorizontal: 12 }]} >
              <Text style={styles.buttonText}>Try again</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );

  /* ================= LOGIN UI ================= */
  return (
    <>
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: '#fff' }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 56 : 0}
      >
        <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
          {IS_TABLET ? (
            <>
              <View style={styles.header}>
                <Text style={styles.headerTitle}>Login Here</Text>
              </View>


              <View style={{ flex: 1, flexDirection: 'row' }}>

                <View style={styles.tabletLeft}>
                  <Image
                    source={require('./src/common/BannerLogo.png')}
                    style={styles.tabletImage}
                    resizeMode="contain"
                  />
                </View>

                {/* RIGHT LOGIN */}
                <View style={styles.tabletRight}>
                  {renderMobileUI()}
                </View>

              </View>
            </>
            // renderMobileUI()

          ) : (
            /* MOBILE LAYOUT */
            renderMobileUI()
          )}


        </SafeAreaView>
      </KeyboardAvoidingView>

      {/* FULL SCREEN LOADER */}
      {loading && (
        // <View style={styles.overlay}>
        //   <ActivityIndicator size="large" color="#576bff" />
        // </View>
        <View style={styles.overlay}>
          <LottieView
            source={require('./src/common/Loader.json')}
            autoPlay
            loop
            style={styles.lottie}
          />
        </View>
      )}
    </>
  );
}

/* ================= STYLES ================= */
const styles = StyleSheet.create({
  errorText: {
    color: "red",
    fontSize: 12,
  },
  eyeButton: {
    padding: 5
  },
  button: {
    backgroundColor: "#0b3d6e",
    height: 45,
    borderRadius: 6,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 10,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  overlay: {
    position: "absolute",
    inset: 0,
    backgroundColor: "rgb(38,42,50)",
    justifyContent: "center",
    alignItems: "center",
  },
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
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  modalText: {
    textAlign: 'center',
  },
  header: {
    height: 56,
    backgroundColor: '#114DAA',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  container: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: IS_TABLET ? width * 0.05 : width * 0.08,
  },
  logo: {
    width: IS_TABLET ? width * 0.2 : width * 0.5,
    height: 120,
    marginTop: 30,
  },
  subtitle: {
    textAlign: 'center',
    color: '#444',
    marginVertical: 20,
    fontSize: 14,
  },
  segment: {
    flexDirection: 'row',
    borderWidth: 2,
    borderColor: '#114DAA',
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 30,
    width: '75%',
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  segmentActive: {
    backgroundColor: '#114DAA',
  },
  segmentText: {
    color: '#114DAA',
    fontWeight: '600',
  },
  segmentTextActive: {
    color: '#fff',
  },
  inputWrapper: {
    width: '100%',
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
    marginBottom: 20,
  },
  input: {
    height: 45,
    fontSize: 15,
    width: "75%",
    color: '#000',
  },
  loginBtn: {
    width: '100%',
    backgroundColor: '#114DAA',
    paddingVertical: 14,
    borderRadius: 30,
    alignItems: 'center',
    marginTop: 20,
  },
  loginText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  forgotText: {
    marginTop: 25,
    color: '#114DAA',
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  tabletLeft: {
    width: '65%',
    backgroundColor: '#EAF4FB',
    justifyContent: 'center',
    alignItems: 'center'
  },

  tabletImage: {
    width: '80%',
    height: '80%',
  },

  tabletRight: {
    width: '35%',
    justifyContent: 'center',
  },
  lottie: {
    width: 150,
    height: 150,
  },
});

