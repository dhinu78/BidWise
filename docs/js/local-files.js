// Files kept in this browser (IndexedDB), keyed by their sha256: every uploaded tender, catalogue
// and productivity file. Compute and the priced PDF use them instead of downloading the files again.
// Best effort: every failure (private window, storage blocked or cleared) just means "not kept here".

const DB = "bidwise-files", STORE = "files", KEEP = 12;    // newest files kept per browser

function open() {
  return new Promise((ok, no) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => ok(req.result);
    req.onerror = () => no(req.error);
  });
}

function tx(mode, fn) {
  return open().then((db) => new Promise((ok, no) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); ok(out?.result ?? out); };
    t.onerror = t.onabort = () => { db.close(); no(t.error); };
  }));
}

/** Keep a file; drops the oldest ones beyond KEEP. */
export async function putFile(sha256, blob, name = "") {
  try {
    await tx("readwrite", (s) => s.put({ blob, name, at: Date.now() }, sha256));
    const all = await tx("readonly", (s) => s.getAll());
    const keys = await tx("readonly", (s) => s.getAllKeys());
    const old = keys.map((k, i) => [k, all[i].at]).sort((a, b) => b[1] - a[1]).slice(KEEP);
    if (old.length) await tx("readwrite", (s) => old.forEach(([k]) => s.delete(k)));
  } catch (e) { console.warn("File not kept in this browser", e); }
}

/** A kept file as a Blob, or null. */
export async function getFile(sha256) {
  try { return (await tx("readonly", (s) => s.get(sha256)))?.blob || null; }
  catch { return null; }
}
