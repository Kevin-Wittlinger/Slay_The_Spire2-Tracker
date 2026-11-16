"use strict";
// "Sync runs": remember the folder of .run files once, then re-scan it with one click and
// upload only the new files. Uses the File System Access API: available in Chrome and Edge,
// switched off by default in Brave (brave://flags/#file-system-access-api), and missing in
// Firefox and Safari. Where it is unavailable the button explains that and "Import run folder"
// still works everywhere.
//
// The browser stores the folder handle in IndexedDB, per profile. A handle can only be read
// with the user's permission, so after a browser restart the browser may ask "Allow?" once.
// Needs app.js: state, $, setStatus, importFiles, openAccountPanel.

const SYNC_OVERLAP_MS = 2 * 60 * 1000; // re-check files modified shortly before the last sync
const SYNC_MAX_DEPTH = 8;

// Walks a directory handle and returns every .run File modified at/after `minModified`.
// Only touches the handle API (values(), getFile()), so it can be tested with fakes.
async function collectRunFiles(directory, minModified = 0, depth = 0) {
  const files = [];
  for await (const entry of directory.values()) {
    if (entry.kind === "directory") {
      if (depth < SYNC_MAX_DEPTH)
        files.push(
          ...(await collectRunFiles(entry, minModified, depth + 1)),
        );
    } else if (entry.name.toLowerCase().endsWith(".run")) {
      const file = await entry.getFile();
      if (file.lastModified >= minModified) files.push(file);
    }
  }
  return files;
}

// ---- tiny IndexedDB key-value store for the folder handle ----
function openSyncDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("spire-ledger", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("folders");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function syncStore(mode, run) {
  const db = await openSyncDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("folders", mode);
      const request = run(tx.objectStore("folders"));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const syncKey = () => `folder:${state.me.id}`;
async function loadSyncRecord() {
  try {
    // Give up after 3 seconds so a stalled browser store can't freeze the button.
    const stalled = new Promise((resolve) => setTimeout(() => resolve(null), 3000));
    return (await Promise.race([syncStore("readonly", (s) => s.get(syncKey())), stalled])) || null;
  } catch {
    return null; // storage blocked: behave as if nothing is saved
  }
}
async function saveSyncRecord(record) {
  try {
    await syncStore("readwrite", (s) => s.put(record, syncKey()));
  } catch {
    /* works for this session even if it can't be remembered */
  }
}
async function forgetSyncRecord() {
  try {
    await syncStore("readwrite", (s) => s.delete(syncKey()));
  } catch {
    /* nothing to forget */
  }
}

const syncSupported = () =>
  typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";

function unsupportedMessage() {
  return typeof navigator !== "undefined" && navigator.brave
    ? "Sync is turned off in Brave by default. Open brave://flags/#file-system-access-api, set it to Enabled and restart Brave. Until then, use Import run folder."
    : "Sync needs Chrome, Edge or Brave. In this browser, use Import run folder instead.";
}

// Shows the Sync buttons for signed-in users. Where the browser can't do it, the button
// stays visible and explains why when clicked.
async function updateSyncButtons() {
  $("syncButton").hidden = !state.me;
  $("syncButton").disabled = state.importing;
  if (!state.me || !syncSupported()) {
    $("changeFolderButton").hidden = true;
    if (state.me) $("syncButton").title = unsupportedMessage();
    return;
  }
  const record = await loadSyncRecord();
  $("changeFolderButton").hidden = !record;
  $("syncButton").title = record
    ? "Look for new runs in your saved folder and add them to your profile"
    : "Choose your run folder once; after that this button finds new runs for you";
}

async function syncRuns({ chooseNew = false } = {}) {
  if (!state.me) {
    openAccountPanel("login");
    return;
  }
  if (!syncSupported()) {
    setStatus(unsupportedMessage(), "warn");
    return;
  }
  if (state.importing) return;
  let record = chooseNew ? null : await loadSyncRecord();
  try {
    let handle = record?.handle;
    if (!handle) {
      setStatus("Choose the folder that contains your .run files...");
      handle = await window.showDirectoryPicker({ id: "sts2-runs", mode: "read" });
      record = { handle, lastSync: null };
      await saveSyncRecord(record);
      updateSyncButtons();
    }
    const options = { mode: "read" };
    if (
      (await handle.queryPermission(options)) !== "granted" &&
      (await handle.requestPermission(options)) !== "granted"
    ) {
      setStatus("Sync needs permission to read that folder.", "warn");
      return;
    }

    setStatus("Looking for new runs...");
    const startedAt = Date.now();
    const since = record.lastSync ? record.lastSync - SYNC_OVERLAP_MS : 0;
    const files = await collectRunFiles(handle, since);
    let ok = true;
    if (files.length) ok = await importFiles(files);
    else setStatus("Already up to date. No new run files found.", "live");
    if (ok) {
      record.lastSync = startedAt;
      await saveSyncRecord(record);
    }
  } catch (error) {
    if (error.name === "AbortError") {
      // picker closed without choosing: put the normal status line back
      updateStatus().catch(() => {});
      updateSyncButtons();
      return;
    }
    if (error.name === "NotFoundError" || error.name === "NotAllowedError") {
      await forgetSyncRecord();
      setStatus(
        "Can't open that folder any more. Click Sync runs to choose it again.",
        "warn",
      );
    } else {
      setStatus(`Sync failed: ${error.message}`, "warn");
    }
    updateSyncButtons();
  }
}

if (typeof module !== "undefined") module.exports = { collectRunFiles };
