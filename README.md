# Ford-DR (Ford Hospital, React Native)

White-label build of the Healthray DR app for **Ford Hospital**.
This branch (`ford-hospital`) builds **production only**. There are no stage or UAT builds.

| App name | Package / Bundle ID | Web (WebView) | API |
|---|---|---|---|
| Ford-DR | `com.fordhospital.doctor` | https://ford.healthray.com/login | https://ford-node.healthray.com |

URLs are in [src/config/env.ts](src/config/env.ts). The app name is in [android/app/src/main/res/values/strings.xml](android/app/src/main/res/values/strings.xml) (Android) and in the Xcode build settings (iOS).

---

## 1. One-time setup

```bash
npm install
cd ios && pod install && cd ..
```

Firebase config files are **required**. Create an Android app and an iOS app with the ID `com.fordhospital.doctor` in the Firebase project, then put the files here:

```
android/app/google-services.json                 ← Android
ios/Heritage_for_Doctor/GoogleService-Info.plist ← iOS
```

> ⚠️ The files currently in the repo still belong to Healthray (`com.healthray.doctor`). The Android build fails with `No matching client found for package name 'com.fordhospital.doctor'` until they are replaced.

## 2. Run on a phone or emulator

| Command | What it does |
|---|---|
| `npm start` | Start Metro (needed for debug builds) |
| `npm run android` | Build, install and open the **debug** app |
| `npm run android:release` | Build, install and open the **release** app (JS bundled, no Metro) |
| `npm run ios` | Run on the iOS simulator |

## 3. Build a release APK / AAB

| Build | Command | Output |
|---|---|---|
| APK | `npm run apk` | `android/app/build/outputs/apk/release/app-release.apk` |
| AAB (Play Store) | `npm run aab` | `android/app/build/outputs/bundle/release/app-release.aab` |

Install a built APK with `npm run install:apk`.
Before each Play Store upload, bump `versionCode` / `versionName` in [android/app/build.gradle](android/app/build.gradle).

## 4. Branding assets

The icons and splash are made from the Ford Hospital logo:

- Android: `android/app/src/main/res/mipmap-*/ic_launcher*.png`, `drawable-*/bootsplash_logo.png`, `drawable/ic_notification.png`, `playstore-icon.png`
- iOS: `ios/Heritage_for_Doctor/Images.xcassets/AppIcon.appiconset`, `lunchScreenLogo.imageset`

The app icon uses only the "HH" mark, because the full logo text can't be read at icon size. The splash screens use the full logo.

## 5. Troubleshooting

| Problem | Fix |
|---|---|
| `No matching client found for package name 'com.fordhospital.doctor'` | `android/app/google-services.json` is missing or belongs to another app. See step 1. |
| No push notifications | The Ford backend must send pushes using the credentials of the Firebase project that `google-services.json` / `GoogleService-Info.plist` come from. |
