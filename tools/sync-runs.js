#!/usr/bin/env node
"use strict";
// Uploads new Slay the Spire 2 run files to your STS2 Tracker profile, straight from disk.
//
//   node tools/sync-runs.js            (or: npm run sync)
//
// Why this exists: browsers refuse to let a website open anything inside AppData, which is
// where the game keeps its runs, so the website's Sync button can't reach them. This script
// runs on your computer and has no such limit.
//
// First run asks for the site address, your username and password. It keeps the site address,
// the game folder and a 30-day sign-in token in ~/.sts2-tracker.json (never the password), so
// later runs need no typing. Only files changed since the last sync are uploaded.
//
// Options:  --all            upload every run file again (the server skips duplicates)
//           --folder <path>  use this folder instead of finding the game's history folder
//           --url <address>  site address (saved for next time)
//           --logout         forget the saved sign-in
// Environment: STS2_URL, STS2_USER, STS2_PASS skip the prompts; STS2_CONFIG moves the config file.

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const CONFIG_FILE =
  process.env.STS2_CONFIG || path.join(os.homedir(), ".sts2-tracker.json");
const OVERLAP_MS = 2 * 60 * 1000; // re-check files modified just before the last sync
const MAX_BATCH_BYTES = 3 * 1024 * 1024; // the server accepts up to 4 MB per request
const MAX_DEPTH = 8;

// ---------- config ----------
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ---------- prompts ----------
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      // Nobody can type an answer (scheduled task, pipe): fail clearly instead of waiting forever.
      return reject(
        new Error(
          `Can't ask "${question.replace(/:\s*$/, "").trim()}" without a terminal.\nRun this in a terminal window, or set STS2_URL, STS2_USER and STS2_PASS.`,
        ),
      );
    }
    if (!hidden) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }
    // Hidden input for the password: read keys ourselves so nothing is echoed.
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (char === "\u0003") process.exit(130); // Ctrl+C
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

// ---------- finding the run files ----------
// Default location: <AppData>/SlayTheSpire2/steam/<steam id>/profile<N>/saves/history
function findHistoryFolders() {
  const base = path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "SlayTheSpire2",
  );
  const found = [];
  const steam = path.join(base, "steam");
  if (!fs.existsSync(steam)) return found;
  for (const account of fs.readdirSync(steam, { withFileTypes: true })) {
    if (!account.isDirectory()) continue;
    const accountDir = path.join(steam, account.name);
    for (const profile of fs.readdirSync(accountDir, { withFileTypes: true })) {
      const history = path.join(accountDir, profile.name, "saves", "history");
      if (profile.isDirectory() && fs.existsSync(history)) found.push(history);
    }
  }
  return found;
}

// Every .run file under `dir` modified at/after `since` (ms).
function collectRunFiles(dir, since = 0, depth = 0) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) files.push(...collectRunFiles(full, since, depth + 1));
    } else if (entry.name.toLowerCase().endsWith(".run")) {
      if (fs.statSync(full).mtimeMs >= since) files.push(full);
    }
  }
  return files;
}

// ---------- talking to the site ----------
function normalizeUrl(input) {
  let url = String(input || "").trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  // Node tries IPv6 for "localhost", but the local server listens on IPv4 only.
  return url.replace(/^(https?:\/\/)localhost\b/i, "$1127.0.0.1");
}

async function request(config, route, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (config.session) headers.Cookie = config.session;
  let response;
  try {
    response = await fetch(`${config.url}${route}`, { ...options, headers });
  } catch (error) {
    throw new Error(`Can't reach ${config.url} (${error.cause?.code || error.message}).`);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* not JSON */
  }
  return { response, body };
}

async function signIn(config) {
  // STS2_USER / STS2_PASS skip the prompts (handy for scheduled runs).
  const username =
    process.env.STS2_USER || (await ask("Username: ")) || config.username || "";
  const password =
    process.env.STS2_PASS || (await ask("Password: ", { hidden: true }));
  const { response, body } = await request(config, "/api/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(body?.error || `Sign-in failed (${response.status}).`);
  const cookies = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") || ""];
  const session = cookies.map((c) => c.split(";")[0]).find((c) => c.startsWith("sts2_session="));
  if (!session) throw new Error("The site didn't return a sign-in token.");
  config.session = session;
  config.username = body.profile.username;
  saveConfig(config);
  console.log(`Signed in as ${config.username}.`);
}

// ---------- main ----------
async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(`--${name}`);
  const option = (name) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };

  const config = loadConfig();
  if (flag("logout")) {
    delete config.session;
    saveConfig(config);
    console.log("Signed out. Your next sync will ask for your password again.");
    return;
  }

  const url = normalizeUrl(option("url") || process.env.STS2_URL || config.url ||
    (await ask("Site address (for example https://yoursite.vercel.app): ")));
  if (!url) throw new Error("A site address is required.");
  if (url !== config.url) {
    // A different site means a different account, so drop the old token.
    delete config.session;
    delete config.lastSync;
  }
  config.url = url;

  // Which folders to scan
  const custom = option("folder") || config.folder;
  const folders = custom ? [custom] : findHistoryFolders();
  if (!folders.length) {
    throw new Error(
      "Couldn't find your Slay the Spire 2 run folder.\nRun again with --folder \"<path to your history folder>\".",
    );
  }
  for (const folder of folders) {
    if (!fs.existsSync(folder)) throw new Error(`Folder not found: ${folder}`);
  }
  if (option("folder")) config.folder = option("folder");

  // Sign in if needed (the saved token lasts 30 days)
  if (config.session) {
    const { body } = await request(config, "/api/me");
    if (!body?.profile) {
      console.log("Your saved sign-in has expired.");
      delete config.session;
    } else {
      config.username = body.profile.username;
    }
  }
  if (!config.session) await signIn(config);

  // Pick the files to send
  const startedAt = Date.now();
  const since = flag("all") || !config.lastSync ? 0 : config.lastSync - OVERLAP_MS;
  const files = folders.flatMap((folder) => collectRunFiles(folder, since));
  console.log(
    `${config.username}: ${files.length} ${flag("all") || !config.lastSync ? "run file(s)" : "new or changed run file(s)"} to check.`,
  );

  const totals = { imported: 0, duplicate: 0, multiplayer: 0, invalid: 0, abandoned: 0 };
  let batch = [];
  let batchBytes = 2;
  let sentFiles = 0;
  const send = async () => {
    if (!batch.length) return;
    const { response, body } = await request(config, "/api/import", {
      method: "POST",
      body: JSON.stringify(batch),
    });
    if (!response.ok) throw new Error(body?.error || `Upload failed (${response.status}).`);
    for (const key of Object.keys(totals)) totals[key] += body[key] || 0;
    sentFiles += batch.length;
    batch = [];
    batchBytes = 2;
    process.stdout.write(`\r  uploaded ${sentFiles} of ${files.length}...`);
  };

  for (const file of files) {
    let run;
    try {
      run = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      totals.invalid++; // unreadable or half-written; picked up next time if it changes
      continue;
    }
    const size = Buffer.byteLength(JSON.stringify(run)) + 1;
    if (size > MAX_BATCH_BYTES) {
      totals.invalid++;
      continue;
    }
    if (batch.length && batchBytes + size > MAX_BATCH_BYTES) await send();
    batch.push(run);
    batchBytes += size;
  }
  await send();
  if (files.length) process.stdout.write("\n");

  config.lastSync = startedAt;
  saveConfig(config);

  if (!files.length) {
    console.log("Already up to date. No new run files found.");
    return;
  }
  const parts = [`${totals.imported} imported`];
  if (totals.abandoned) parts[0] += ` (${totals.abandoned} abandoned, not counted in stats)`;
  if (totals.duplicate) parts.push(`${totals.duplicate} already added`);
  if (totals.multiplayer) parts.push(`${totals.multiplayer} multiplayer skipped`);
  if (totals.invalid) parts.push(`${totals.invalid} invalid`);
  console.log(`Done: ${parts.join(", ")}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { collectRunFiles, findHistoryFolders, normalizeUrl };
