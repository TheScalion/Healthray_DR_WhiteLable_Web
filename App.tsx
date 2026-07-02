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


const LOGIN_URL = "https://ray.theheritagehospitals.com/login";

const STORAGE_KEYS = {
  ONLY_WEB: "ONLY_WEB",
  SAVE_WEB_URL: "SAVE_WEB_URL",
  IS_LOGGED_IN: "IS_LOGGED_IN",
};

const SECRET_KEY = 'YsF&7B@34$+0A@408$B3x62&62';
const { width } = Dimensions.get('window');
const IS_TABLET = width >= 768;



const BASE_URL = 'https://node.theheritagehospitals.com/api/v2/';
const BASE_URL1 = 'https://node.theheritagehospitals.com/api/v2/';
const BUILD_MANAGMENT_API = 'build_management/check_update_required';

const ITUNES_URL = 'https://apps.apple.com/in/app/healthray-dr-for-doctors/id1513592834';
const PLAYSTORE_URL = 'https://play.google.com/store/apps/details?id=com.heritage.doctor.noida&hl=en_IN';


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
  // Gate the WebView mount until checkLoginState resolves, so it mounts once
  // with the correct source (savedUrl when logged in, LOGIN_URL to pre-warm
  // when logged out) and never double-loads.
  const [bootResolved, setBootResolved] = useState(false);
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
    buildVersionManagement();
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
        // Logged out: mount the WebView with LOGIN_URL so the Angular SPA
        // boots (pre-warms) behind the native login screen.
        setInitialWebUrl(LOGIN_URL);
        setShowWeb(false);
      }
      // Source is now decided — allow the WebView to mount.
      setBootResolved(true);
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
        // application: 'heritage'
      };

      console.log('📡 Calling API with params:', params);

      const response = await axios.post(
        `${BASE_URL1}${BUILD_MANAGMENT_API}`,
        params,
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 25000, // optional but useful
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

  // const handleLogin = async () => {

  //   if (!mobileNo || !password) {
  //     Alert.alert("Error", "Enter mobile number & password");
  //     return;
  //   }

  //   setMobileNoError(null);

  //   // Optional: mobile validation (remove if not needed)
  //   if (mobileNo.length < 10) {
  //     setMobileNoError("Please enter a valid mobile number.");
  //     return;
  //   }

  //   setLoading(true);
  //   Keyboard.dismiss()
  //   try {

  //     // Encrypt password
  //     const passwordPayload = JSON.stringify({
  //       text: password,
  //       time: convertLocalTimeToUtcTime(),
  //     });

  //     const encryptedPassword = encryptText(passwordPayload);

  //     // API payload (UPDATED)
  //     const payload = {
  //       user: {
  //         mobile_no: mobileNo,
  //         password: password,
  //         platform: Platform.OS === "android" ? "Android" : "iOS",
  //         user_type: userType,
  //       },
  //     };

  //     console.log('Login payload ::::', payload);

  //     // API call
  //     const res = await fetch(
  //       "https://node.theheritagehospitals.com/api/v1/users/sign_in",
  //       {
  //         method: "POST",
  //         headers: {
  //           "Content-Type": "application/json",
  //           Accept: "application/json",
  //         },
  //         body: JSON.stringify(payload),
  //       }
  //     );

  //     const data = await res.json();

  //     console.log('Login Data :::', data);

  //     // Error handling
  //     if (!res.ok || data?.statusState !== "success") {
  //       Alert.alert("Login Failed", data?.message || "Unable to sign in");
  //       setLoading(false);
  //       return;
  //     }

  //     // Success
  //     await AsyncStorage.setItem(STORAGE_KEYS.IS_LOGGED_IN, "true");

  //     // CLEAR WEBVIEW SESSION ONCE
  //     // await resetWebViewSession();

  //     isFirstWebLoadRef.current = true;
  //     setInitialWebUrl(LOGIN_URL);
  //     setShowWeb(true);

  //     /* START LOGIN WATCHDOG */
  //     if (loginTimeoutRef.current) {
  //       clearTimeout(loginTimeoutRef.current);
  //     }

  //     loginTimeoutRef.current = setTimeout(async () => {
  //       const currentUrl = lastWebUrlRef.current;

  //       console.log("Login timeout check:", currentUrl);

  //       // Still stuck on login
  //       if (!currentUrl || currentUrl.includes("/login")) {
  //         console.log("Auto-login failed, fallback to native login");

  //         await AsyncStorage.multiRemove([
  //           STORAGE_KEYS.IS_LOGGED_IN,
  //           STORAGE_KEYS.SAVE_WEB_URL,
  //         ]);

  //         wasLoggedInRef.current = false;
  //         setShowWeb(false);
  //         setLoading(false);

  //         Alert.alert(
  //           "Login Failed",
  //           // "Auto login falied. Please try again."
  //           "Something went wrong. Please try again or check your internet connection."
  //         );
  //       }
  //     }, 100000);


  //   } catch (e: any) {
  //     Alert.alert(
  //       "Login Failed",
  //       e.message || "Something went wrong. Please try again."
  //     );
  //     setLoading(false);
  //   }
  //   finally {
  //     setLoading(false);
  //   }
  // };



  const handleLogin = async () => {
    if (!mobileNo || !password) {
      Alert.alert("Error", "Enter mobile number & password");
      return;
    }
    setMobileNoError(null);
    if (mobileNo.length < 10) {
      setMobileNoError("Please enter a valid mobile number.");
      return;
    }

    setLoading(true);
    Keyboard.dismiss();
    console.log('[LOGIN] ▶ handleLogin start — mobileLen:', mobileNo.length, 'userType:', userType);

    // Reveal the already-warm WebView and start the web-side login immediately.
    // We do NOT wait for the native sign_in below: the web login uses these
    // credentials directly, and sign_in is only for HRMS tokens + early
    // validation. The Angular SPA has been pre-warming behind the login screen,
    // so this is the fast path.
    isFirstWebLoadRef.current = true;
    setInitialWebUrl(LOGIN_URL);
    setShowWeb(true);
    // The pre-warmed /login page already fired onLoadEnd, so handleLoadEnd
    // won't re-fire — trigger the auto-fill explicitly. The autoFillScript in
    // this render already carries the typed credentials.
    console.log('[LOGIN] injecting autoFill into pre-warmed WebView — webRef ready?', !!webRef.current, '| lastWebUrl:', lastWebUrlRef.current);
    if (!webRef.current) {
      console.warn('[LOGIN] ⚠ webRef is NULL — pre-warm WebView not mounted yet; auto-fill will only run when onLoadEnd fires.');
    }
    webRef.current?.injectJavaScript(autoFillScript);

    if (loginTimeoutRef.current) clearTimeout(loginTimeoutRef.current);
    loginTimeoutRef.current = setTimeout(async () => {
      const currentUrl = lastWebUrlRef.current;
      console.log('[LOGIN] ⏰ watchdog(55s) fired — currentUrl:', currentUrl);
      if (!currentUrl || currentUrl.includes("/login")) {
        await AsyncStorage.multiRemove([
          STORAGE_KEYS.IS_LOGGED_IN,
          STORAGE_KEYS.SAVE_WEB_URL,
        ]);
        wasLoggedInRef.current = false;
        setShowWeb(false);
        setLoading(false);
        Alert.alert(
          "Login Failed",
          "Something went wrong. Please try again or check your internet connection."
        );
      }
    }, 55000);

    // Native sign_in runs concurrently (not on the critical path): it stores
    // HRMS tokens on success and preserves fast wrong-password feedback.
    (async () => {
      try {
        const payload = {
          user: {
            mobile_no: mobileNo,
            password: password,
            platform: Platform.OS === "android" ? "Android" : "iOS",
            user_type: userType,
          },
        };
        console.log('[LOGIN] native sign_in POST → /api/v1/users/sign_in', { user_type: userType, platform: payload.user.platform });

        const res = await fetch(
          "https://node.theheritagehospitals.com/api/v1/users/sign_in",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(payload),
          }
        );

        const data = await res.json();
        console.log('[LOGIN] native sign_in response — httpOk:', res.ok, '| status:', data?.status, '| state:', data?.statusState, '| msg:', data?.message);

        if (!res.ok || data?.statusState !== "success") {
          console.warn('[LOGIN] native sign_in FAILED — web already loggedIn?', wasLoggedInRef.current);
          // Native validation failed. Only abort if the web side hasn't already
          // logged in (reached the post-login page) — otherwise a hiccup on the
          // native call shouldn't tear down a good web session.
          if (!wasLoggedInRef.current) {
            if (loginTimeoutRef.current) {
              clearTimeout(loginTimeoutRef.current);
              loginTimeoutRef.current = null;
            }
            await AsyncStorage.multiRemove([
              STORAGE_KEYS.IS_LOGGED_IN,
              STORAGE_KEYS.SAVE_WEB_URL,
            ]);
            setShowWeb(false);
            setLoading(false);
            Alert.alert("Login Failed", data?.message || "Unable to sign in");
          }
          return;
        }

        // Native credentials are valid — mark the session as logged in.
        console.log('[LOGIN] native sign_in SUCCESS');
        await AsyncStorage.setItem(STORAGE_KEYS.IS_LOGGED_IN, 'true');
      } catch (e: any) {
        // A native-call network error alone shouldn't kill the web login; the
        // 55s timeout covers a fully-failed login.
        console.warn('[LOGIN] native sign_in network error:', e?.message ?? e);
      }
    })();
  };


  const handleLoadEnd = (e: any) => {
    const url = e.nativeEvent.url.toLowerCase();
    console.log('[LOGIN] ⤓ onLoadEnd url:', url);
    if (url.includes("/login")) {
      // The script polls for form readiness itself, so inject as soon as the
      // page DOM is loaded — no fixed pre-delay needed.
      webRef.current?.injectJavaScript(autoFillScript);
      return;
    }
    // Any non-login page means we're logged in. Hide the loader the moment the
    // page has painted real content (WEB_READY), with a 1500ms fallback so we
    // never reveal a blank page on a slow render. Portal-agnostic — it does not
    // depend on a specific post-login route.
    webRef.current?.injectJavaScript(webReadyProbeScript);
    setTimeout(() => setLoading(false), 1500);
  };

  const handleNavigationStateChange = async (navState: any) => {
    const url = navState.url.toLowerCase();
    lastWebUrlRef.current = url;
    console.log('[LOGIN] ↪ navChange url:', url, '| loading:', navState.loading);

    await AsyncStorage.setItem(STORAGE_KEYS.SAVE_WEB_URL, navState.url);

    if (!url.includes("/login")) {
      console.log('[LOGIN] ✓ non-login route → treating as logged in, hiding loader');
      wasLoggedInRef.current = true;
      await AsyncStorage.setItem(STORAGE_KEYS.IS_LOGGED_IN, "true");

      if (loginTimeoutRef.current) {
        clearTimeout(loginTimeoutRef.current);
        loginTimeoutRef.current = null;
      }
      // SPA route change (pushState) does NOT fire onLoadEnd, so the loader
      // must be hidden from here too — WEB_READY probe + 1500ms fallback.
      // Any non-login route counts as logged in, so this works for every portal.
      webRef.current?.injectJavaScript(webReadyProbeScript);
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

  const safeMobile = JSON.stringify(mobileNo);
  const safePassword = JSON.stringify(password);
  const safeUserType = JSON.stringify(userType);


  const autoFillScript = `
  (function autoLogin() {
    var mobileNo = ${safeMobile};
    var password = ${safePassword};
    var verificationType = ${safeUserType};

    // Route every step out to native (WebView console.log is invisible in
    // Metro/logcat). Watch these as [WEB-LOGIN] lines to see where it stalls.
    function dbg(step, extra) {
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'LOGIN_DBG', step: step, url: location.href, extra: extra || null
        }));
      } catch (e) {}
    }

    dbg('script_injected');

    // Skip entirely when we have no credentials to fill (e.g. cold-restart
    // landing on /login). Prevents spurious clicks on a disabled button.
    if (!mobileNo || !password) { dbg('no_creds_abort'); return; }

    var POLL_INTERVAL = 250;     // re-check form readiness ~4x/sec
    var MAX_WAIT = 30000;        // worst-case SPA ceiling, well under the native 55s timeout
    var maxAttempts = 3;
    var retryDelay = 5000;       // wait after a click before retrying if still on /login

    var startTime = Date.now();
    var attemptCount = 0;
    var submitted = false;
    var typeSelected = false;
    var formReadyLogged = false;
    var notReadyLogged = false;
    var disabledLogged = false;

    function selectUserType() {
      var doctorButton = document.getElementById('mat-button-toggle-1-button');
      var staffButton = document.getElementById('mat-button-toggle-2-button');
      dbg('select_type', { doctorBtn: !!doctorButton, staffBtn: !!staffButton, type: verificationType });
      if (verificationType.toLowerCase() === 'invitee') {
        if (staffButton) staffButton.click();
      } else {
        if (doctorButton) doctorButton.click();
      }
    }

    function tick() {
      if (submitted) return;
      if (Date.now() - startTime > MAX_WAIT) { dbg('form_not_ready_timeout'); return; }
      if (!window.location.href.includes('/login')) { dbg('left_login_page'); return; }
      if (attemptCount >= maxAttempts) { dbg('max_attempts'); return; }

      var mobileInput = document.getElementById('mobile_no');
      var passwordInput =
        document.querySelector('#mat-input-1') ||
        document.querySelector('input[type="password"]');
      var loginButton = document.querySelector('button.submit-button');

      // Form not rendered yet — keep waiting instead of giving up (slow-SPA fix).
      if (!mobileInput || !passwordInput || !loginButton) {
        if (!notReadyLogged) {
          dbg('form_not_ready', { mobile: !!mobileInput, pass: !!passwordInput, btn: !!loginButton });
          notReadyLogged = true;
        }
        setTimeout(tick, POLL_INTERVAL);
        return;
      }

      if (!formReadyLogged) { dbg('form_ready'); formReadyLogged = true; }

      // Select the doctor/staff toggle once, before filling.
      if (!typeSelected) {
        selectUserType();
        typeSelected = true;
      }

      mobileInput.value = mobileNo;
      mobileInput.dispatchEvent(new Event('input', { bubbles: true }));
      passwordInput.value = password;
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }));

      // Button may still be disabled until Angular validates the values we set.
      // Re-filling the same value next tick is harmless.
      if (loginButton.disabled) {
        if (!disabledLogged) { dbg('button_disabled_waiting'); disabledLogged = true; }
        setTimeout(tick, POLL_INTERVAL);
        return;
      }

      loginButton.click();
      submitted = true;
      attemptCount++;
      dbg('login_clicked', { attempt: attemptCount });

      // If we're still on /login after retryDelay, the submit didn't take —
      // reset and try again (up to maxAttempts).
      setTimeout(function () {
        if (window.location.href.includes('/login') && attemptCount < maxAttempts) {
          dbg('still_on_login_retry', { attempt: attemptCount });
          submitted = false;
          tick();
        }
      }, retryDelay);
    }

    tick();
  })();
  true;
  `;


  // Polls the org-selection page until it has rendered real, interactive
  // content (not just a spinner), then signals native via WEB_READY so the
  // loader can be hidden without flashing a blank page. A 1500ms native
  // fallback covers the case where this never fires.
  const webReadyProbeScript = `
  (function webReady() {
    var POLL_INTERVAL = 150;
    var MAX_WAIT = 5000;
    var startTime = Date.now();

    function hasContent() {
      if (document.readyState !== 'complete') return false;
      // The post-login page varies by portal, so detect any real app shell or
      // interactive content (not just a spinner) rather than one fixed route.
      var el =
        document.querySelector('mat-toolbar') ||
        document.querySelector('mat-sidenav') ||
        document.querySelector('mat-card') ||
        document.querySelector('mat-list-item') ||
        document.querySelector('mat-selection-list') ||
        document.querySelector('[class*="dashboard"]') ||
        document.querySelector('[class*="organization"]') ||
        document.querySelector('table') ||
        document.querySelector('button');
      if (el) return true;
      // Fallback: substantial rendered text means the SPA has painted.
      return !!(document.body && document.body.innerText.trim().length > 40);
    }

    function tick() {
      if (hasContent() || Date.now() - startTime > MAX_WAIT) {
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'WEB_READY' }));
        } catch (e) {}
        return;
      }
      setTimeout(tick, POLL_INTERVAL);
    }
    tick();
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

      // ─── LOGIN_DBG ───────────────────────────────────────────────────────
      // Debug breadcrumbs from autoFillScript (running inside the WebView).
      // Watch these [WEB-LOGIN] lines to see exactly where auto-login stalls.
      if (message?.type === 'LOGIN_DBG') {
        console.log('[WEB-LOGIN]', message.step, '| url:', message.url, message.extra ? JSON.stringify(message.extra) : '');
        return;
      }

      // ─── WEB_READY ───────────────────────────────────────────────────────
      // Post-login page has rendered real content — hide the loader now
      // (the 1500ms fallback in handleLoadEnd covers the case this never fires).
      if (message?.type === 'WEB_READY') {
        console.log('[LOGIN] WEB_READY received → hiding loader');
        setLoading(false);
        return;
      }


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
    function sendBlob(blob) {
      const reader = new FileReader();
      reader.onloadend = function() {
        window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: 'pdf', data: reader.result })
        );
      };
      reader.readAsDataURL(blob);
    }

    const originalOpen = window.open;
    window.open = function(url) {
      if (url && url.startsWith('blob:')) {
        fetch(url).then(res => res.blob()).then(blob => sendBlob(blob));
        return null;
      }
      return originalOpen.apply(this, arguments);
    };

    document.addEventListener('click', function(e) {
      const element = e.target.closest('a');
      if (element && element.href && element.href.startsWith('blob:')) {
        fetch(element.href).then(res => res.blob()).then(blob => sendBlob(blob));
        e.preventDefault();
      }
    });

    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function(blob) {
      sendBlob(blob);
      return originalCreateObjectURL.apply(this, arguments);
    };
  })();

  true;
  `;

  // WebView layer — mounted once `bootResolved`, kept mounted across the
  // login → web transition so the Angular SPA boots (pre-warms) behind the
  // native login screen and is never remounted (a remount discards the warm
  // page). Hidden + non-interactive until `showWeb` reveals it.
  const webViewLayer = bootResolved ? (
    <View style={StyleSheet.absoluteFill} pointerEvents={showWeb ? 'auto' : 'none'}>
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
          onLoadStart={(e) => console.log('[LOGIN] ⤒ onLoadStart url:', e.nativeEvent.url)}
          onLoadEnd={handleLoadEnd}
          onNavigationStateChange={handleNavigationStateChange}
          onError={(e) =>
            console.warn('[LOGIN] ✗ WebView onError:', e.nativeEvent.code, e.nativeEvent.description, '| url:', e.nativeEvent.url)
          }
          onHttpError={(e) =>
            console.warn('[LOGIN] ✗ WebView onHttpError:', e.nativeEvent.statusCode, '| url:', e.nativeEvent.url)
          }
        />


        {showWeb && loading && (
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

        {/* <Modal visible={showInternetModel} transparent animationType="fade" supportedOrientations={['landscape']}>
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
        </Modal> */}
      </SafeAreaView>
    </View>
  ) : null;

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
    <View style={{ flex: 1, backgroundColor: '#fff' }}>
      {webViewLayer}

      {!showWeb && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#fff' }]}>
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
                    <View style={styles.tabletRight}>
                      {renderMobileUI()}
                    </View>
                  </View>
                </>
              ) : (
                renderMobileUI()
              )}
            </SafeAreaView>
          </KeyboardAvoidingView>
        </View>
      )}

      {/* No-Internet modal for the web session (the login UI renders its own
          inside renderMobileUI). Single instance avoids a duplicate modal. */}
      {showWeb && (
        <Modal visible={showInternetModel} transparent animationType="fade" supportedOrientations={['landscape']}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalBox}>
              <Text style={styles.modalTitle}>No Internet</Text>
              <Text style={styles.modalText}>
                Please check your internet connection
              </Text>
              <TouchableOpacity style={[styles.button, { paddingHorizontal: 12 }]}>
                <Text style={styles.buttonText}>Try again</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}
    </View>
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

