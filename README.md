# Healthray DR (React Native)

A React Native app that wraps the Healthray web app in a WebView. On top of the web app it adds push notifications, HRMS location tracking, PDF saving, and a force-update / maintenance check.

There are three builds of the app, one per backend environment. Each has its own name, package ID and Firebase project, so **all three can be installed on the same phone at the same time**.

| Environment | App name on phone | Package ID | Web app | API | Firebase project |
|---|---|---|---|---|---|
| **Prod** | Healthray-DR | `com.healthray.doctor` | https://ray.healthray.com | https://node.healthray.com | `healthray-dr` |
| **Stage** | Stage-DR-Healthray | `com.healthray.doctor.stage` | https://stage-ray.healthray.com/login | https://stage-node.healthray.com | `healthray-dr-stage` |
| **UAT** | UAT-DR-Healthray | `com.healthray.doctor.uat` | https://uat-ray.healthray.com/login | https://uat-node.healthray.com | `healthray-dr-uat` |

> Android only for now. iOS still builds as Prod only.

---

## 1. One-time setup

1. Finish the React Native [environment setup](https://reactnative.dev/docs/set-up-your-environment) for Android (JDK 17, Android Studio, Android SDK).
2. Install dependencies from the project root:
   ```sh
   npm install
   ```
3. Check that the Firebase config files are in place. Each environment has its own:
   ```
   android/app/google-services.json              ← Prod
   android/app/src/stage/google-services.json    ← Stage
   android/app/src/uat/google-services.json      ← UAT
   ```

---

## 2. Run an app on a phone or emulator (debug)

Connect a phone with USB debugging on (or start an emulator), then:

**Step 1:** start Metro in one terminal. One Metro serves all three apps.
```sh
npm start
```

**Step 2:** in a second terminal, run the environment you want:

| To run | Command |
|---|---|
| Prod | `npm run android:prod` (or `npm run android`) |
| Stage | `npm run android:stage` |
| UAT | `npm run android:uat` |

The command builds the app, installs it and opens it. You can run all three one after another; each installs as a separate app.

> 💡 **Testing against a local web server (optional).** By default every build loads its environment's real web URL. To point **debug** builds at a local Angular server instead, set this in [src/config/env.ts](src/config/env.ts):
> ```ts
> const LOCAL_DEV_WEB_BASE: string | undefined = 'http://localhost:4200';
> ```
> and run `adb reverse tcp:4200 tcp:4200`. Set it back to `undefined` when you're done. Release builds ignore this setting.

---

## 3. Build a release APK / AAB

Bump the version first if this build is going to testers or the store. Edit `versionCode` and `versionName` in [android/app/build.gradle](android/app/build.gradle); all three environments share them.

| To build | Command | Output |
|---|---|---|
| Prod APK | `npm run apk:prod` | `android/app/build/outputs/apk/prod/release/app-prod-release.apk` |
| Stage APK | `npm run apk:stage` | `android/app/build/outputs/apk/stage/release/app-stage-release.apk` |
| UAT APK | `npm run apk:uat` | `android/app/build/outputs/apk/uat/release/app-uat-release.apk` |
| All three APKs | `npm run apk:all` | all of the above |
| Prod AAB (Play Store) | `npm run aab:prod` | `android/app/build/outputs/bundle/prodRelease/app-prod-release.aab` |
| Stage / UAT AAB | `npm run aab:stage` / `npm run aab:uat` | `android/app/build/outputs/bundle/<env>Release/` |

To install a built release APK on the connected phone:
```sh
npm run install:prod     # or install:stage / install:uat
```

Upload the **Prod AAB** to the Play Store. Share Stage/UAT APKs directly with testers.

---

## All scripts

| Script | What it does |
|---|---|
| `npm start` | Start Metro (needed for debug runs) |
| `npm run start:reset` | Start Metro with a cleared cache |
| `npm run android` | Same as `android:prod` |
| `npm run android:prod` / `android:stage` / `android:uat` | Build, install and open the **debug** app (needs Metro) |
| `npm run android:prod:release` / `android:stage:release` / `android:uat:release` | Build, install and open the **release** app on the connected phone (JS bundled, no Metro) |
| `npm run apk:prod` / `apk:stage` / `apk:uat` | Build a release APK |
| `npm run apk:all` | Build release APKs for all three environments |
| `npm run aab:prod` / `aab:stage` / `aab:uat` | Build a release AAB |
| `npm run install:prod` / `install:stage` / `install:uat` | Install an already-built release APK with `adb` |
| `npm run android:clean` | Clear Android build output (`gradlew clean`) |
| `npm run ios` / `lint` / `test` | Unchanged |

---

## 4. How the environment is picked

You never edit a URL or flip a flag before a build. The command you run decides everything:

1. `npm run android:stage` builds the **stage** flavor, which is defined in `productFlavors` in [android/app/build.gradle](android/app/build.gradle).
2. That flavor sets:
   - the package ID suffix (`.stage`) → `com.healthray.doctor.stage`;
   - the app name (`Stage-DR-Healthray`);
   - the Firebase config, which Gradle takes from `android/app/src/stage/google-services.json`.
3. When the app starts, [src/config/env.ts](src/config/env.ts) reads the installed package ID and chooses the matching `API_BASE`, `WEB_BASE` and `WEB_START_URL` (the page opened on launch):
   - ending `.stage` → Stage URLs
   - ending `.uat` → UAT URLs
   - anything else → Prod URLs

All URLs live in the `ENVIRONMENTS` table in `env.ts`. To change an environment's URL, edit it there.

---

## 5. Troubleshooting

| Problem | Fix |
|---|---|
| `No matching client found for package name 'com.healthray.doctor.xxx'` | That environment's `google-services.json` is missing, or it belongs to a different package. Download it from the right Firebase project and put it in the folder listed in step 1. |
| App shows `http://localhost:4200 ... ERR_CONNECTION_REFUSED` | `LOCAL_DEV_WEB_BASE` in `src/config/env.ts` is set. Change it back to `undefined` and reload the app (press `r` in Metro). |
| App doesn't launch after `npm run android:stage` | Open **Stage-DR-Healthray** from the launcher manually. For future runs, check that `package.json` still passes `--appIdSuffix stage`. |
| Strange build errors after switching branches | `npm run android:clean`, then run the command again. |
| No push notifications on Stage/UAT | Each environment uses its own Firebase project. The Stage/UAT backend must send pushes with the credentials of `healthray-dr-stage` / `healthray-dr-uat`. |

---

## 6. Adding another environment later

1. Add a flavor in [android/app/build.gradle](android/app/build.gradle) with its own `applicationIdSuffix` and `app_name`, and add `<name>Debug` to `debuggableVariants`.
2. Add its URLs to `ENVIRONMENTS` in [src/config/env.ts](src/config/env.ts), and match its suffix in `resolveAppEnv`.
3. Register the new package ID in Firebase and save its file to `android/app/src/<name>/google-services.json`.
4. Add `android:<name>`, `android:<name>:release`, `apk:<name>`, `aab:<name>` and `install:<name>` scripts to [package.json](package.json).
