// Data layer: Firebase Auth + Firestore (project data) + Cloud Storage (files).
//
// Firestore                                          Cloud Storage
//   users/{uid}                    profile             users/{uid}/projects/{pid}/
//   users/{uid}/projects/{pid}     name, parameters,     working/{kind}/{file}        latest uploads
//                                  workingFiles,         versions/v0001/
//                                  currentVersion          tender/{file}.pdf
//   .../projects/{pid}/versions/v0001  manifest            catalog/{file}.csv
//                                                          productivity/{file}.csv
//                                                          project_parameters.json
//                                                          manifest.json
//                                                          results.json   (if compute returns one)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, doc, getDoc, setDoc, updateDoc, collection, getDocs, query, orderBy, runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getBlob, getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { firebaseConfig, ALLOWED_EMAIL_DOMAINS } from "./firebase-config.js";
import { KINDS, safeFilename } from "./validate.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, { ignoreUndefinedProperties: true });
const storage = getStorage(app);

const now = () => new Date().toISOString();
const vName = (n) => `v${String(n).padStart(4, "0")}`;
const base = (uid, pid) => `users/${uid}/projects/${pid}`;
const who = (u) => ({ uid: u.uid, email: u.email, name: u.displayName });
const jsonBlob = (obj) => new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });

// ---- auth -------------------------------------------------------------------------

export async function signIn() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const { user } = await signInWithPopup(auth, provider);
  const domain = (user.email || "").split("@").pop().toLowerCase();
  if (ALLOWED_EMAIL_DOMAINS.length && !ALLOWED_EMAIL_DOMAINS.includes(domain)) {
    await signOut(auth);
    throw new Error(`Please sign in with an account from: ${ALLOWED_EMAIL_DOMAINS.join(", ")}`);
  }
  return user;
}
export const logOut = () => signOut(auth);
export const onUser = (cb) => onAuthStateChanged(auth, cb);

export async function saveProfile(user) {
  const r = doc(db, "users", user.uid);
  const snap = await getDoc(r);
  const data = { uid: user.uid, email: user.email, name: user.displayName, picture: user.photoURL, lastLoginAt: now() };
  if (!snap.exists()) data.createdAt = now();
  await setDoc(r, data, { merge: true });
}

// ---- projects ----------------------------------------------------------------------

const projRef = (uid, pid) => doc(db, "users", uid, "projects", pid);

export async function listProjects(uid) {
  const snap = await getDocs(query(collection(db, "users", uid, "projects"), orderBy("updatedAt", "desc")));
  return snap.docs.map((d) => d.data());
}

export async function createProject(user, name, defaultParameters) {
  const pid = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const parameters = structuredClone(defaultParameters);
  parameters.project = { ...parameters.project, name, source_tender_file: null };
  const project = {
    id: pid, name, owner: who(user), createdAt: now(), updatedAt: now(),
    currentVersion: 0, workingFiles: {}, parameters,
    parametersUpdatedAt: now(), parametersUpdatedBy: who(user),
  };
  await setDoc(projRef(user.uid, pid), project);
  return project;
}

export async function getProject(uid, pid) {
  const snap = await getDoc(projRef(uid, pid));
  if (!snap.exists()) throw new Error("Project not found");
  return snap.data();
}

export async function renameProject(user, pid, name) {
  const p = await getProject(user.uid, pid);
  const parameters = { ...p.parameters, project: { ...p.parameters.project, name } };
  await updateDoc(projRef(user.uid, pid), { name, parameters, updatedAt: now() });
}

// ---- uploads -----------------------------------------------------------------------

export async function uploadWorkingFile(user, pid, kind, file, checked, hash) {
  const storedName = safeFilename(file.name);
  const path = `${base(user.uid, pid)}/working/${kind}/${Date.now()}_${storedName}`;
  await uploadBytes(ref(storage, path), file, {
    contentType: file.type || (kind === "tender" ? "application/pdf" : "text/csv"),
    customMetadata: { originalName: file.name, kind },
  });
  const record = {
    filename: file.name, storedName, storagePath: path, size: file.size, sha256: hash,
    uploadedAt: now(), uploadedBy: who(user), ...checked.info,
  };
  const p = await getProject(user.uid, pid);
  const update = { [`workingFiles.${kind}`]: record, updatedAt: now() };
  if (kind === "tender") {
    update.parameters = { ...p.parameters, project: { ...p.parameters.project, source_tender_file: file.name } };
  }
  await updateDoc(projRef(user.uid, pid), update);
  return record;
}

export const fileUrl = (storagePath) => getDownloadURL(ref(storage, storagePath));

// ---- parameters ---------------------------------------------------------------------

export async function saveParameters(user, pid, parameters) {
  await updateDoc(projRef(user.uid, pid), {
    parameters, name: parameters.project.name,
    parametersUpdatedAt: now(), parametersUpdatedBy: who(user), updatedAt: now(),
  });
}

/**
 * User correction for one tender position (product, quantity, status, note), kept in
 * parameters.position_overrides so it is frozen into project_parameters.json on Re-compute.
 * `override` = null removes it.
 */
export async function saveOverride(user, pid, lvId, override) {
  const p = await getProject(user.uid, pid);
  const overrides = { ...(p.parameters.position_overrides || {}) };
  if (override) overrides[lvId] = { ...override, updatedAt: now(), updatedBy: user.email || user.uid };
  else delete overrides[lvId];
  const parameters = { ...p.parameters, position_overrides: overrides };
  await updateDoc(projRef(user.uid, pid), {
    parameters, parametersUpdatedAt: now(), parametersUpdatedBy: who(user), updatedAt: now(),
  });
}

// ---- versions -----------------------------------------------------------------------

const versionRef = (uid, pid, n) => doc(db, "users", uid, "projects", pid, "versions", vName(n));

export async function listVersions(uid, pid) {
  const snap = await getDocs(query(collection(db, "users", uid, "projects", pid, "versions"), orderBy("version", "desc")));
  return snap.docs.map((d) => d.data());
}

export async function getVersion(uid, pid, n) {
  const snap = await getDoc(versionRef(uid, pid, n));
  return snap.exists() ? snap.data() : null;
}

/**
 * Freeze the current files + parameters into versions/vNNNN.
 * `localBlobs[kind]` = {sha256, blob} for files picked in this browser session; otherwise the
 * file is downloaded from Storage first (this needs CORS on the bucket, see README).
 * `afterSave(blobs, version, manifest)` may return results to store (see compute.js).
 */
export async function recompute(user, pid, note, localBlobs, prepare, afterSave) {
  const project = await getProject(user.uid, pid);
  const missing = KINDS.filter((k) => !project.workingFiles?.[k]);
  if (missing.length) throw new Error(`Upload these files first: ${missing.join(", ")}`);

  // Collect the file contents before reserving a version number.
  const blobs = {};
  for (const kind of KINDS) {
    const rec = project.workingFiles[kind];
    const local = localBlobs[kind];
    if (local && local.sha256 === rec.sha256) blobs[kind] = local.blob;
    else {
      try { blobs[kind] = await getBlob(ref(storage, rec.storagePath)); }
      catch (e) {
        throw new Error(`Could not read the saved ${kind} file (${e.code || e.message}). ` +
          "Pick the file again, or set up CORS on the Storage bucket (see README).");
      }
    }
  }
  const warnings = await prepare(blobs, project.parameters);

  // Reserve the next version number atomically.
  const n = await runTransaction(db, async (tx) => {
    const snap = await tx.get(projRef(user.uid, pid));
    const next = (snap.data().currentVersion || 0) + 1;
    tx.update(projRef(user.uid, pid), { currentVersion: next, updatedAt: now() });
    return next;
  });
  const vdir = `${base(user.uid, pid)}/versions/${vName(n)}`;

  try {
    const files = {};
    for (const kind of KINDS) {
      const rec = project.workingFiles[kind];
      const path = `${vdir}/${kind}/${rec.storedName}`;
      await uploadBytes(ref(storage, path), blobs[kind], {
        contentType: kind === "tender" ? "application/pdf" : "text/csv",
        customMetadata: { originalName: rec.filename, kind },
      });
      files[kind] = { ...rec, storagePath: path };
    }
    const paramsBlob = jsonBlob(project.parameters);
    await uploadBytes(ref(storage, `${vdir}/project_parameters.json`), paramsBlob);
    const paramsSha = await sha(paramsBlob);

    const prev = n > 1 ? await getVersion(user.uid, pid, n - 1) : null;
    const changed = Object.fromEntries(KINDS.map((k) => [k, !prev?.files?.[k] || prev.files[k].sha256 !== files[k].sha256]));
    changed.parameters = !prev || prev.parametersSha256 !== paramsSha;

    const manifest = {
      version: n, projectId: pid, projectName: project.name, createdAt: now(), createdBy: who(user),
      note: note || null, folder: vdir, files, parametersPath: `${vdir}/project_parameters.json`,
      parametersSha256: paramsSha, parameters: project.parameters, changedSincePrevious: changed,
      warnings, status: "saved",
    };
    await uploadBytes(ref(storage, `${vdir}/manifest.json`), jsonBlob(manifest));
    await setDoc(versionRef(user.uid, pid, n), manifest);

    // Optional calculation (js/compute.js)
    try {
      const results = await afterSave(blobs, n, manifest);
      if (results) {
        await uploadBytes(ref(storage, `${vdir}/results.json`), jsonBlob(results));
        manifest.results = results;
        manifest.status = "computed";
        await updateDoc(versionRef(user.uid, pid, n), { results, status: "computed" });
      }
    } catch (e) {
      manifest.status = "compute_failed";
      manifest.computeError = String(e.message || e);
      await updateDoc(versionRef(user.uid, pid, n), { status: manifest.status, computeError: manifest.computeError });
    }
    return manifest;
  } catch (e) {
    await setDoc(versionRef(user.uid, pid, n), {
      version: n, createdAt: now(), createdBy: who(user), status: "failed", error: String(e.message || e),
    });
    throw e;
  }
}

/** Make an old version the current working state (no file copy needed). */
export async function restoreVersion(user, pid, n) {
  const v = await getVersion(user.uid, pid, n);
  if (!v || !v.files) throw new Error(`Version ${n} cannot be restored`);
  await updateDoc(projRef(user.uid, pid), {
    workingFiles: v.files, parameters: v.parameters, name: v.parameters.project.name,
    parametersUpdatedAt: now(), parametersUpdatedBy: who(user), restoredFromVersion: n, updatedAt: now(),
  });
}

async function sha(blob) {
  const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
