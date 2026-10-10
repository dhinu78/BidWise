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
//                                                          results.json   (what the app shows)
//                                                          output.json    (backend output as received)
//                                                          project_parameters_out.json (backend-updated parameters)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, query, orderBy, runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getBlob, getDownloadURL, listAll, deleteObject,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { firebaseConfig, ALLOWED_EMAIL_DOMAINS, FIRESTORE_DATABASE_ID } from "./firebase-config.js";
import { KINDS, safeFilename } from "./validate.js";
import { BACKEND_URL } from "./backend.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, { ignoreUndefinedProperties: true }, FIRESTORE_DATABASE_ID || "(default)");
const storage = getStorage(app);
// Fail within seconds instead of retrying silently for minutes (e.g. reads blocked by missing CORS).
storage.maxOperationRetryTime = 15_000;
storage.maxUploadRetryTime = 60_000;

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
/** Firebase ID token of the signed-in user: proves sign-in to the AI relay (js/ai.js). Not sent to the estimation backend. */
export const idToken = () => auth.currentUser?.getIdToken() ?? Promise.reject(new Error("Not signed in"));

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

/**
 * Delete a project for good: every file under users/{uid}/projects/{pid} in Storage (uploads,
 * versions, results, supplier quotes, generated PDFs), then its versions, chats and quotes in
 * Firestore, and last the project itself. If something fails half way, the project is still
 * listed and the delete can simply be repeated.
 */
export async function deleteProject(user, pid, onProgress) {
  const files = [];
  const walk = async (folder) => {
    const res = await listAll(folder);
    files.push(...res.items);
    for (const sub of res.prefixes) await walk(sub);
  };
  onProgress?.("Finding the project's files…");
  await walk(ref(storage, base(user.uid, pid)));
  for (let i = 0; i < files.length; i += 8) {
    onProgress?.(`Deleting files… ${Math.min(i + 8, files.length)} / ${files.length}`);
    await Promise.all(files.slice(i, i + 8).map((f) => deleteObject(f).catch((e) => {
      if (e.code !== "storage/object-not-found") throw e;
    })));
  }
  for (const sub of ["versions", "chats", "quotes"]) {
    onProgress?.(`Deleting ${sub}…`);
    const snap = await getDocs(collection(db, "users", user.uid, "projects", pid, sub));
    for (let i = 0; i < snap.docs.length; i += 20) await Promise.all(snap.docs.slice(i, i + 20).map((d) => deleteDoc(d.ref)));
  }
  onProgress?.("Deleting the project…");
  await deleteDoc(projRef(user.uid, pid));
  return { files: files.length };
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

// ---- supplier quotes (uploaded in the assistant) ------------------------------------------
// users/{uid}/projects/{pid}/quotes/{id} = {id, filename, storagePath, pages, text, details?}
// file in Storage: users/{uid}/projects/{pid}/quotes/{id}/{filename}

const quoteRef = (uid, pid, id) => doc(db, "users", uid, "projects", pid, "quotes", id);

export async function addQuote(user, pid, file, text, pages) {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const storagePath = `${base(user.uid, pid)}/quotes/${id}/${safeFilename(file.name)}`;
  await uploadBytes(ref(storage, storagePath), file, { contentType: file.type || "application/pdf", customMetadata: { originalName: file.name } });
  const quote = { id, filename: file.name, storagePath, size: file.size, pages, text: text.slice(0, 60_000),
    uploadedAt: now(), uploadedBy: who(user), details: null };
  await setDoc(quoteRef(user.uid, pid, id), quote);
  return quote;
}

export async function listQuotes(uid, pid) {
  const snap = await getDocs(query(collection(db, "users", uid, "projects", pid, "quotes"), orderBy("uploadedAt", "desc")));
  return snap.docs.map((d) => { const { text, ...q } = d.data(); return q; });
}

export async function getQuote(uid, pid, id) {
  const snap = await getDoc(quoteRef(uid, pid, id));
  return snap.exists() ? snap.data() : null;
}

export const updateQuote = (uid, pid, id, fields) => updateDoc(quoteRef(uid, pid, id), { ...fields, updatedAt: now() });

// ---- AI assistant conversations ----------------------------------------------------------
// users/{uid}/projects/{pid}/chats/{chatId} = {id, title, createdAt, updatedAt, messages: [...]}

const chatRef = (uid, pid, id) => doc(db, "users", uid, "projects", pid, "chats", id);

export async function listChats(uid, pid) {
  const snap = await getDocs(query(collection(db, "users", uid, "projects", pid, "chats"), orderBy("updatedAt", "desc")));
  return snap.docs.map((d) => {
    const c = d.data();
    return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, version: c.version || 0, count: c.messages?.length || 0 };
  });
}

export async function getChat(uid, pid, id) {
  const snap = await getDoc(chatRef(uid, pid, id));
  return snap.exists() ? snap.data() : null;
}

export async function saveChat(user, pid, chat) {
  await setDoc(chatRef(user.uid, pid, chat.id), { ...chat, updatedAt: now(), createdAt: chat.createdAt || now() });
}

export const deleteChat = (uid, pid, id) => deleteDoc(chatRef(uid, pid, id));

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
      try { blobs[kind] = await readFile(rec.storagePath); }
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

    // Calculation: returns results, or {results, parameters, output} from the backend, where
    // `parameters` are the updated project parameters and `output` the backend's file as received.
    try {
      const out = await afterSave(blobs, n, manifest);
      const results = out && "results" in out ? out.results : out;
      if (out?.output) await uploadBytes(ref(storage, `${vdir}/output.json`), jsonBlob(out.output));
      // other files from the backend run, e.g. the pricer's lv_positions.csv: {name: text}
      for (const [name, text] of Object.entries(out?.files || {})) {
        if (text) await uploadBytes(ref(storage, `${vdir}/${name}`), new Blob([text], { type: name.endsWith(".csv") ? "text/csv" : "text/plain" }));
      }
      if (out?.parameters) {
        // the version keeps both: what was sent (input_parameters) and what came back (parameters);
        // the project continues with the updated ones, so Edit parameters shows them
        await uploadBytes(ref(storage, `${vdir}/project_parameters_out.json`), jsonBlob(out.parameters));
        manifest.input_parameters = manifest.parameters;
        manifest.parameters = out.parameters;
        await updateDoc(versionRef(user.uid, pid, n), {
          input_parameters: manifest.input_parameters, parameters: out.parameters,
          parametersOutPath: `${vdir}/project_parameters_out.json`,
        });
        await updateDoc(projRef(user.uid, pid), {
          parameters: out.parameters, name: out.parameters.project?.name || project.name,
          parametersUpdatedAt: now(), parametersUpdatedBy: { name: "estimation backend", version: n }, updatedAt: now(),
        });
      }
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

/** Offer settings for the priced tender PDF (company details, scenario, Rabatt/Skonto). */
/** Bid status of a project (in process / awaiting response / won / lost) with its history. */
export async function saveBid(user, pid, bid) {
  await updateDoc(projRef(user.uid, pid), { bid, updatedAt: now() });
}

export async function saveOfferSettings(user, pid, offer) {
  await updateDoc(projRef(user.uid, pid), { offer, updatedAt: now() });
}

/** Store a generated file (e.g. the priced tender PDF) with a version. */
export async function saveVersionFile(path, blob, contentType) {
  await uploadBytes(ref(storage, path), blob, { contentType });
}

/**
 * A saved file as a Blob, downloaded through its download URL with a plain fetch. Not getBlob: it
 * caps the whole transfer at maxOperationRetryTime, which a multi-MB tender on a slow connection
 * exceeds (storage/retry-limit-exceeded).
 */
export async function downloadFile(storagePath, timeoutMs = 120_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let url;
  try {
    url = await getDownloadURL(ref(storage, storagePath));
  } catch (e) {
    clearTimeout(timer);
    if (e.code === "storage/object-not-found") throw new Error("the file is no longer in the cloud storage");
    throw e.code ? new Error(e.code) : e;
  }
  const get = async (u) => {
    const res = await fetch(u, { signal: ctl.signal });
    if (!res.ok) throw new Error(res.status === 404 ? "the file is no longer in the cloud storage" : `download failed (HTTP ${res.status})`);
    return res.blob();
  };
  try {
    try {
      return await get(url);
    } catch (e) {
      // the browser may not download straight from the bucket (no CORS set up on it): let the local
      // pricer bridge fetch the file instead, when it is running
      if (e.name === "AbortError" || !BACKEND_URL || !(e instanceof TypeError)) throw e;
      console.warn("Direct download blocked; fetching through the pricer bridge", e);
      try { return await get(`${BACKEND_URL.replace(/\/+$/, "")}/fetch?url=${encodeURIComponent(url)}`); }
      catch (e2) { throw e2.name === "AbortError" ? e2 : new Error(`the browser may not download it from the cloud and the pricer bridge could not fetch it (${e2.message})`); }
    }
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`the download took longer than ${Math.round(timeoutMs / 1000)} s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
export const readFile = (storagePath) => downloadFile(storagePath);

/**
 * Store edits made in the app (no re-compute): new parameters + re-priced results.
 * If the latest version is already an in-app edit by this user, it is updated; otherwise a new
 * version is created that reuses the latest version's files. Returns {version, created}.
 */
export async function saveEditedVersion(user, pid, latest, parameters, results, note) {
  const entry = { at: now(), by: who(user), note: note || null };
  const project = { parameters, name: parameters.project?.name, parametersUpdatedAt: now(), parametersUpdatedBy: who(user), updatedAt: now() };
  if (latest?.edited_in_app && latest.createdBy?.uid === user.uid && latest.folder) {
    const n = latest.version;
    await uploadBytes(ref(storage, `${latest.folder}/project_parameters.json`), jsonBlob(parameters));
    await uploadBytes(ref(storage, `${latest.folder}/results.json`), jsonBlob(results));
    await updateDoc(versionRef(user.uid, pid, n), {
      parameters, results, edit_log: [...(latest.edit_log || []), entry], updatedAt: now(),
    });
    await updateDoc(projRef(user.uid, pid), project);
    return { version: n, created: false };
  }
  const n = await runTransaction(db, async (tx) => {
    const snap = await tx.get(projRef(user.uid, pid));
    const next = (snap.data().currentVersion || 0) + 1;
    tx.update(projRef(user.uid, pid), { currentVersion: next, ...project });
    return next;
  });
  const vdir = `${base(user.uid, pid)}/versions/${vName(n)}`;
  const paramsBlob = jsonBlob(parameters);
  await uploadBytes(ref(storage, `${vdir}/project_parameters.json`), paramsBlob);
  await uploadBytes(ref(storage, `${vdir}/results.json`), jsonBlob(results));
  const manifest = {
    version: n, projectId: pid, projectName: parameters.project?.name || null, createdAt: now(), createdBy: who(user),
    note: note || "Edited in the app", folder: vdir, files: latest.files, parametersPath: `${vdir}/project_parameters.json`,
    parametersSha256: await sha(paramsBlob), parameters, results, status: "computed",
    edited_in_app: true, based_on_version: latest.version, edit_log: [entry],
    changedSincePrevious: { tender: false, catalog: false, productivity: false, parameters: true }, warnings: [],
  };
  await uploadBytes(ref(storage, `${vdir}/manifest.json`), jsonBlob(manifest));
  await setDoc(versionRef(user.uid, pid, n), manifest);
  return { version: n, created: true };
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
