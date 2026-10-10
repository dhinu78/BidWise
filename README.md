# Tender Estimation (web app, no backend)

This app runs entirely in the browser. It uses Firebase for three things:

- **Login:** Google sign-in through Firebase Authentication.
- **Project data:** project names, parameters, file names and version history are kept in Firestore.
- **Files:** the uploaded files are kept in Cloud Storage. Every **Re-compute** creates a new version folder:

```
users/<uid>/projects/<project-id>/
  working/<kind>/...               latest uploads
  versions/v0001/
    tender/BKP_244_LV_Lueftung_260804.pdf
    catalog/catalog.csv
    productivity/productivity.csv
    project_parameters.json
    manifest.json                  who, when, note, original file names, sha256, what changed
    results.json                   only if js/compute.js returns results
  versions/v0002/ ...
```

## 1. Firebase setup (one time, about 10 minutes)

All of these steps are in the Firebase console (https://console.firebase.google.com), in your project.

1. **Turn on Google sign-in:** go to **Build → Authentication → Get started → Sign-in method** and enable **Google**.
2. **Create the database:** go to **Build → Firestore Database → Create database**. Production mode is fine. Then open the **Rules** tab, paste the contents of `firestore.rules`, and click **Publish**.
3. **Create the file storage:** go to **Build → Storage → Get started**. Then open the **Rules** tab, paste the contents of `storage.rules`, and click **Publish**.
4. **Connect the web page to Firebase:** go to **Project settings (gear icon) → General → Your apps → Add app → Web (`</>`)**. Copy the `firebaseConfig` values it shows into `js/firebase-config.js`.
5. **Allow your site address:** go to **Authentication → Settings → Authorized domains**. `localhost` is already listed. Add `YOUR-GITHUB-NAME.github.io` for when the page is online.

## 2. Storage CORS (one time)

The page sometimes needs to read files back from Storage. This happens when you click Re-compute after reloading the page without picking the files again. For that, the bucket must allow your site:

1. Edit `cors.json` and put your GitHub Pages address in it.
2. Open **Google Cloud Shell**, using the `>_` icon at https://console.cloud.google.com with your Firebase project selected.
3. Upload `cors.json` there, then run:
   ```
   gcloud storage buckets update gs://YOUR_PROJECT_ID.firebasestorage.app --cors-file=cors.json
   ```

Without this step, everything still works if the three files were picked in the current browser session.

## 3. Run it on your computer

The page must be opened through a small local web server, not by double-clicking `index.html`. In VS Code:

1. Install the **Live Server** extension (by Ritwick Dey).
2. Open this folder with **File → Open Folder…**.
3. Right-click `index.html` and choose **Open with Live Server**. It opens at http://127.0.0.1:5500.

## 4. Put it online with GitHub Pages

1. Push this folder to a GitHub repository. `index.html` must be in the root.
2. On GitHub, go to **Settings → Pages → Build and deployment**. Choose **Deploy from a branch**, then **main** and **/ (root)**.
3. After about a minute the site is at `https://YOUR-GITHUB-NAME.github.io/REPO-NAME/`.

The values in `firebase-config.js` are safe to publish. Your data is protected by the rules from step 1, which only let each signed-in user read and write their own files.

## 5. Where to change things

| What | File |
|---|---|
| Firebase connection, allowed email domains | `js/firebase-config.js` |
| Default parameters for new projects | `defaults/project_parameters.json` |
| Required CSV columns, parameter checks | `js/validate.js` |
| **Your calculation** (fills the dashboard) | `js/compute.js` |
| Logo | put a file at `assets/logo.png` |
| Layout and colours | `index.html` |

`computeEstimation()` in `js/compute.js` receives the parameters, the CSV rows and the tender PDF. Return an object shaped like `sample_data/expected_output_example.json`. It is saved as `results.json` in the version folder, and the donuts, cost box and bid cards fill in automatically.

You can also do the calculation elsewhere, for example in Python. Each version folder in Storage has everything you need: the three files, `project_parameters.json` and `manifest.json`.
