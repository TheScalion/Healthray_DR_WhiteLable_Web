// Injected JS run inside the WebView. Kept as plain strings (no React
// coupling) so they can be unit-reviewed independently of the native bridge
// wiring in App.tsx / messageHandler.ts.

export const disableZoomScript = `
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

// Runs at the EARLIEST point of every page load (before content). Sets the
// isNativeApp flag the web app keys off to enable the native bridges (native
// geolocation, PDF postMessage, HRMS tracking controls).
export const beforeContentLoadedScript = `
  window.isNativeApp = true;
  true;
`;

// Runs after every page load. Handles:
//  1) Capturing blob: PDF downloads/opens and posting them back to native
//     (blocked otherwise by the WebView sandbox).
//  2) Overriding navigator.geolocation so Angular/web uses native GPS via the
//     React Native bridge instead of the unreliable WKWebView/Android WebView
//     geolocation.
export const combinedScript = `
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

    const isPdf = function(blob) {
      return blob && blob.type === 'application/pdf';
    };

    const originalOpen = window.open;
    window.open = function(url) {
      if (url && url.startsWith('blob:')) {
        fetch(url).then(function(res) { return res.blob(); }).then(function(blob) {
          if (isPdf(blob)) { sendBlob(blob); }
          else { originalOpen.call(window, url); }
        });
        return null;
      }
      return originalOpen.apply(this, arguments);
    };

    document.addEventListener('click', function(e) {
      const element = e.target.closest('a');
      if (element && element.href && element.href.startsWith('blob:')) {
        e.preventDefault();
        fetch(element.href).then(function(res) { return res.blob(); }).then(function(blob) {
          if (isPdf(blob)) { sendBlob(blob); }
        });
      }
    });

    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function(blob) {
      if (isPdf(blob)) { sendBlob(blob); }
      return originalCreateObjectURL.apply(this, arguments);
    };
  })();

  // Override navigator.geolocation so Angular/web uses native GPS via the
  // React Native bridge instead of the unreliable WKWebView/Android WebView
  // geolocation.
  (function() {
    if (!window.__nativeGeoCallbacks) window.__nativeGeoCallbacks = {};
    if (!window.__nativeGeoWatches) window.__nativeGeoWatches = {};
    var callbackCounter = 0;

    var geoInFlight = false;   // Fix 4: prevent concurrent GPS requests

    var nativeGeo = {
      getCurrentPosition: function(success, error, options) {
        // Fix 4: drop the call if a previous request is still pending.
        // Without this guard, a setInterval caller piles up concurrent requests
        // that all resolve in a burst when GPS finally responds.
        if (geoInFlight) return;
        geoInFlight = true;

        var id = 'geo_' + (++callbackCounter) + '_' + Date.now();
        window.__nativeGeoCallbacks[id] = {
          success: function(pos) { geoInFlight = false; (success || function(){})(pos); },
          error:   function(err) { geoInFlight = false; (error   || function(){})(err); }
        };

        // Fix 5: self-cleanup after GPS timeout (15 s) + 5 s buffer.
        // If native never calls back (GPS crash, silent timeout), the entry and
        // its closures are removed so they don't accumulate across the session.
        setTimeout(function() {
          if (window.__nativeGeoCallbacks[id]) {
            delete window.__nativeGeoCallbacks[id];
            geoInFlight = false;
          }
        }, 20000);

        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'GET_LOCATION',
          data: { callbackId: id }
        }));
      },
      watchPosition: function(success, error, options) {
        var watchId = ++callbackCounter;
        var ms = 10000;   // fixed 10 s — maximumAge is cache-staleness, not an update rate
        window.__nativeGeoWatches[watchId] = setInterval(function() {
          nativeGeo.getCurrentPosition(success, error, options);
        }, ms);
        return watchId;
      },
      clearWatch: function(watchId) {
        if (window.__nativeGeoWatches[watchId]) {
          clearInterval(window.__nativeGeoWatches[watchId]);
          delete window.__nativeGeoWatches[watchId];
        }
      }
    };

    try {
      Object.defineProperty(navigator, 'geolocation', {
        value: nativeGeo,
        configurable: false,
        writable: false
      });
    } catch(e) {
      navigator.geolocation = nativeGeo;
    }
  })();

  true;
`;

// Pull the web session's auth token out of the WebView's localStorage and hand
// it to native (WEB_AUTH_TOKENS) so HRMS tracking + ambulance push stay
// authenticated without a native login. The web app stores everything under
// localStorage['currentUser'] as { auth_token, deviceToken, ... }. The reader
// retries because on a fresh login the nav event can beat Angular's write.
export const syncWebAuthTokensScript = `
  (function(){
    var tries = 0;
    function grab(){
      try {
        var cu = JSON.parse(localStorage.getItem('currentUser') || '{}') || {};
        var auth = cu.auth_token || cu.authToken || localStorage.getItem('auth_token') || '';
        var dev = cu.deviceToken || cu.device_token || localStorage.getItem('device_token') || '';
        if (auth) {
          var isDriver = !!(cu.isDriver ||
            String(cu.user_type || cu.userType || cu.role || '').toLowerCase() === 'driver');
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'WEB_AUTH_TOKENS', auth_token: auth, device_token: dev, is_driver: isDriver
          }));
          return;
        }
      } catch(e) {}
      if (++tries < 5) setTimeout(grab, 300);
    }
    grab();
  })(); true;
`;

// Dispatches the HRMS tracker's native status (tracking_started, auth_expired,
// etc.) into the WebView as a CustomEvent the web app listens for.
export const nativeTrackingStatusScript = (payloadJson: string): string => `
  (function(){
    try {
      window.dispatchEvent(new CustomEvent('NATIVE_TRACKING_STATUS', { detail: ${payloadJson} }));
    } catch(e) {}
  })(); true;
`;

// Tells the web app the outcome of a native location-permission request.
export const nativeLocationPermissionScript = (granted: boolean): string => `
  (function() {
    window.dispatchEvent(new CustomEvent('nativeLocationPermission', {
      detail: { granted: ${granted} }
    }));
  })(); true;
`;

// Reads localStorage.currentUser and posts it back as CURRENT_USER_DATA —
// used right before a START_TRACKING call so native has the full user object.
export const requestCurrentUserDataScript = `
  (function() {
    var raw = localStorage.getItem('currentUser');
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'CURRENT_USER_DATA',
      data: raw ? JSON.parse(raw) : null
    }));
  })();
  true;
`;

// Resolves a pending navigator.geolocation.getCurrentPosition() call that the
// nativeGeo shim (see combinedScript above) forwarded to native as a
// GET_LOCATION bridge message.
export const resolveGeoSuccessScript = (
  callbackId: string,
  latitude: number,
  longitude: number,
  accuracy: number | null,
  altitude: number | null,
  timestamp: number,
): string => `
  (function(){
    var cb = window.__nativeGeoCallbacks && window.__nativeGeoCallbacks['${callbackId}'];
    if(cb){
      cb.success({ coords: { latitude: ${latitude}, longitude: ${longitude}, accuracy: ${accuracy}, altitude: ${altitude ?? null}, altitudeAccuracy: null, heading: null, speed: null }, timestamp: ${timestamp} });
      delete window.__nativeGeoCallbacks['${callbackId}'];
    }
  })(); true;
`;

export const resolveGeoErrorScript = (
  callbackId: string,
  code: number,
  message: string,
): string => `
  (function(){
    var cb = window.__nativeGeoCallbacks && window.__nativeGeoCallbacks['${callbackId}'];
    if(cb){
      cb.error({ code: ${code}, message: ${JSON.stringify(message ?? 'Location error')} });
      delete window.__nativeGeoCallbacks['${callbackId}'];
    }
  })(); true;
`;

// Ambulance push deep-link — jumps the WebView straight to /ambulance when a
// dispatch/reassign notification is tapped (background tap or foreground press).
export const navigateToAmbulanceScript = `window.location.href = '/ambulance'; true;`;
