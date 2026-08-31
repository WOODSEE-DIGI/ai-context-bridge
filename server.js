#!/usr/bin/env node
/**
 * AI Context Bridge — Global MCP Server v4.1
 *
 * Unified memory system + build bridge for all AI agents.
 * Memory stored at: ~/.ai-context/memory/ (QwenURI addressing)
 * Legacy read path: ~/.ai-context/data/ (read-only, not written to)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execSync, spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import https from "https";
import { createMemoryIndex } from "./memory-index.js";

const HOME        = os.homedir();
// Repos live on an external volume by default (see user setup), with projects
// nested in category folders (e.g. AI-ML-Agents/SwiftMaestro). Override the
// root via AI_GITHUB_ROOT; fall back to a neutral Documents/GitHub path.
const GITHUB_ROOT = process.env.AI_GITHUB_ROOT
  || path.join(HOME, "Documents", "GitHub");
const DATA_ROOT   = path.join(HOME, ".ai-context", "data");
const MEMORY_ROOT = path.join(HOME, ".ai-context", "memory");
const VAULT       = path.join(HOME, "Obsidian");
const SWIFTMAESTRO_CONFIG_PATH = path.join(HOME, "Library", "Application Support", "SwiftMaestro", "configs.json");
const SM_SUPPORT_DIR = path.join(HOME, "Library", "Application Support", "SwiftMaestro");
const SM_CHATS_DIR = path.join(SM_SUPPORT_DIR, "chats");
const SM_WORKSPACE = path.join(SM_SUPPORT_DIR, "workspace.json");
// Skill roots scanned by list_skills/read_skill (first existing wins per name).
const SKILLS_ROOTS = [path.join(HOME, ".ai-context", "skills"), path.join(HOME, ".agents", "skills")];
const WHISPERKIT_SWITCH_SCRIPT = process.env.WHISPERKIT_SWITCH_SCRIPT || path.join(HOME, "bin", "whisperkit-transcribe-switch.zsh");
const WHISPERKIT_STATE_DIR = process.env.WHISPERKIT_STATE_DIR || path.join(HOME, ".cache", "whisperkit-stream");
const WHISPERKIT_LOG_FILE = process.env.WHISPERKIT_LOG_FILE || path.join(WHISPERKIT_STATE_DIR, "transcribe.log");
const WHISPERKIT_CURRENT_REPORT_FILE = process.env.WHISPERKIT_CURRENT_REPORT_FILE || path.join(WHISPERKIT_STATE_DIR, "current_report_path.txt");
const CONTEXT_MEMORY_INDEXER = process.env.CONTEXT_MEMORY_INDEXER || path.join(HOME, ".ai-context", "scripts", "context-memory-index.py");

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
// Convert a glob (*, **, ?) to an anchored RegExp for matching file paths.
function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$");
}
function triggerContextIndexRefresh() {
  if (!fs.existsSync(CONTEXT_MEMORY_INDEXER)) return;
  try {
    const child = spawn("python3", [CONTEXT_MEMORY_INDEXER, "build", "--quiet"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch {}
}

function activeProject() {
  // Read from unified memory first
  const memFile = path.join(MEMORY_ROOT, "context", "active-project.json");
  if (fs.existsSync(memFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(memFile, "utf8"));
      if (data.content) return data.content.trim();
    } catch {}
  }
  // Fallback to legacy for migration period
  const legacyFile = path.join(DATA_ROOT, "global", "session.md");
  if (fs.existsSync(legacyFile)) {
    const text = fs.readFileSync(legacyFile, "utf8");
    const matches = [...text.matchAll(/\*\*active_project:\*\*\s*(.+)/g)];
    if (matches.length) return matches[matches.length - 1][1].trim();
  }
  return null;
}
function resolveProject(args) { return args?.project || activeProject() || "global"; }
function findXcodeproj(root) {
  if (!fs.existsSync(root)) return null;
  const p = fs.readdirSync(root).find(e => e.endsWith(".xcodeproj"));
  return p ? path.join(root, p) : null;
}
// Resolve a project name to its directory. Handles nesting: projects may live
// directly under GITHUB_ROOT or one level down inside a category folder
// (e.g. AI-ML-Agents/SwiftMaestro). Cached after first lookup.
const _projectRootCache = {};
function projectRoot(name) {
  if (!name || name === "global") return GITHUB_ROOT;
  if (_projectRootCache[name]) return _projectRootCache[name];
  const direct = path.join(GITHUB_ROOT, name);
  if (fs.existsSync(direct)) { _projectRootCache[name] = direct; return direct; }
  try {
    for (const e of fs.readdirSync(GITHUB_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const candidate = path.join(GITHUB_ROOT, e.name, name);
      if (fs.existsSync(candidate)) { _projectRootCache[name] = candidate; return candidate; }
    }
  } catch {}
  _projectRootCache[name] = direct;  // fallback (may not exist)
  return direct;
}
// Map SwiftMaestro agent id -> display name (from workspace.json).
function swiftMaestroAgentNames() {
  try {
    const ws = JSON.parse(fs.readFileSync(SM_WORKSPACE, "utf8"));
    const map = {};
    for (const a of ws.agents || []) map[a.id] = a.name;
    return map;
  } catch { return {}; }
}
function readSwiftMaestroConfigs() {
  try {
    if (!fs.existsSync(SWIFTMAESTRO_CONFIG_PATH)) return [];
    const raw = fs.readFileSync(SWIFTMAESTRO_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function readKeychainSecret(service, account) {
  try {
    return execSync(`security find-generic-password -s "${service}" -a "${account}" -w`, {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch {
    return "";
  }
}
function readSwiftMaestroEndpoint() {
  const configs = readSwiftMaestroConfigs();
  if (!configs.length) return "";
  const preferred = configs.find(c => c.modelIdentifier === "google/gemma-4-31b") ?? configs[0];
  return (preferred?.endpointURL || "").toString().trim();
}
function readSwiftMaestroModelIdentifier() {
  const configs = readSwiftMaestroConfigs();
  if (!configs.length) return "";
  const preferred = configs.find(c => c.modelIdentifier === "google/gemma-4-31b") ?? configs[0];
  return (preferred?.modelIdentifier || "").toString().trim();
}
function forcePort1234(rawUrl) {
  if (!rawUrl) return "";
  try {
    const u = new URL(rawUrl);
    u.port = "1234";
    return u.origin;
  } catch {
    return rawUrl;
  }
}
function readSwiftMaestroAPIKey() {
  const configs = readSwiftMaestroConfigs();
  for (const cfg of configs) {
    if (!cfg?.id || !cfg?.requiresAPIKey) continue;
    const secret = readKeychainSecret("com.woodseedigi.SwiftMaestro", `apikey.${cfg.id}`);
    if (secret) return secret;
  }
  return "";
}
const PAL_BASE_URL = (process.env.PAL_BASE_URL || "http://127.0.0.1:1235").replace(/\/+$/, "");
const PAL_BEARER_TOKEN =
  process.env.PAL_BEARER_TOKEN ||
  readKeychainSecret("PAL_BEARER_TOKEN", "pal-mcp") ||
  readSwiftMaestroAPIKey() ||
  "";
const PAL_FALLBACK_MODEL = process.env.PAL_FALLBACK_MODEL || readSwiftMaestroModelIdentifier() || "google/gemma-4-31b";
const OBSIDIAN_REST_BASE_URL = (process.env.OBSIDIAN_REST_BASE_URL || "https://127.0.0.1:27124").replace(/\/+$/, "");
const OBSIDIAN_REST_AUTH_HEADER = process.env.OBSIDIAN_REST_AUTH_HEADER || "Authorization";
const OBSIDIAN_REST_API_KEY =
  process.env.OBSIDIAN_REST_API_KEY ||
  readKeychainSecret("OBSIDIAN_LOCAL_REST_API_KEY", "people-vault") ||
  "";
function formatText(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
function runWhisperkitSwitch(action) {
  if (!fs.existsSync(WHISPERKIT_SWITCH_SCRIPT)) {
    throw new Error(`WhisperKit switch script not found: ${WHISPERKIT_SWITCH_SCRIPT}`);
  }
  const result = spawnSync(WHISPERKIT_SWITCH_SCRIPT, [action], { encoding: "utf8" });
  if (result.error) throw result.error;
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  if (result.status !== 0) {
    throw new Error(`WhisperKit ${action} failed (${result.status}): ${combined || "no output"}`);
  }
  return combined || `(no output from ${action})`;
}
function tailFileLines(filepath, maxLines = 80) {
  if (!filepath || !fs.existsSync(filepath)) return "";
  const count = Math.max(1, Math.min(2000, Number(maxLines) || 80));
  const result = spawnSync("tail", ["-n", String(count), filepath], { encoding: "utf8" });
  if (result.error) throw result.error;
  return (result.stdout || "").trim();
}
function normalizeWhisperLine(input) {
  if (!input) return "";
  let s = String(input).trim();
  if (!s || s === "Waiting for speech...") return "";
  s = s.replace(/<\|[^>]+\|>/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (["[inaudible]", "[inaudible"].includes(s.toLowerCase())) return "";
  if (/^\[[A-Za-z]{0,3}\]?$/.test(s)) return "";
  return s;
}
function extractWhisperLiveText(logTail, maxItems = 40) {
  const limit = Math.max(1, Math.min(200, Number(maxItems) || 40));
  const emitted = [];
  let pending = "";
  let lastEmitted = "";
  const minWordsDelta = 4;
  function emitOnce(text) {
    const cleaned = normalizeWhisperLine(text);
    if (!cleaned || cleaned === lastEmitted) return;
    emitted.push(cleaned);
    lastEmitted = cleaned;
  }
  for (const line of String(logTail || "").split(/\r?\n/)) {
    const match = line.match(/Current text:\s*(.+)$/);
    if (!match) continue;
    const cleaned = normalizeWhisperLine(match[1]);
    if (!cleaned) continue;
    if (pending && cleaned.startsWith(pending)) {
      pending = cleaned;
      const wordsPending = pending.split(/\s+/).length;
      const wordsLast = lastEmitted ? lastEmitted.split(/\s+/).length : 0;
      const wordsDelta = Math.max(0, wordsPending - wordsLast);
      if (/[.!?]["']?$/.test(cleaned) || wordsDelta >= minWordsDelta) {
        emitOnce(cleaned);
        pending = "";
      }
      continue;
    }
    if (pending && pending.startsWith(cleaned)) {
      pending = cleaned;
      continue;
    }
    if (pending) emitOnce(pending);
    pending = cleaned;
    if (/[.!?]["']?$/.test(cleaned)) {
      emitOnce(cleaned);
      pending = "";
    }
  }
  if (pending) emitOnce(pending);
  return emitted.slice(-limit);
}
function readCurrentWhisperReportPath() {
  if (!fs.existsSync(WHISPERKIT_CURRENT_REPORT_FILE)) return "";
  return (fs.readFileSync(WHISPERKIT_CURRENT_REPORT_FILE, "utf8") || "").trim();
}
function normalizeRestPath(pathname = "/") {
  const trimmed = String(pathname || "/").trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
// Root containing all Obsidian vaults. Each vault that enables the Local REST
// API stores its own apiKey in .obsidian/plugins/obsidian-local-rest-api/data.json.
const OBSIDIAN_ROOT = path.join(HOME, "Obsidian");
let _obsidianResolvedKey = null;

// Low-level request to the Obsidian REST API. The plugin serves HTTPS with a
// self-signed cert on its secure port (27124); accept it for this localhost
// call only (no global TLS weakening).
function obsidianRawRequest(pathPart, { method = "GET", headers = {}, body } = {}) {
  const url = new URL(`${OBSIDIAN_REST_BASE_URL}${pathPart}`);
  const isHttps = url.protocol === "https:";
  const mod = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      { method, headers, ...(isHttps ? { rejectUnauthorized: false } : {}) },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { data += c; });
        res.on("end", () => resolve({ status: res.statusCode || 0, raw: data }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// Candidate keys: explicit override/Keychain first, then every vault under
// ~/Obsidian that has the Local REST API plugin configured.
function collectObsidianApiKeys() {
  const keys = [];
  const seen = new Set();
  const add = (k) => { if (k && !seen.has(k)) { seen.add(k); keys.push(k); } };
  add(OBSIDIAN_REST_API_KEY);
  try {
    for (const e of fs.readdirSync(OBSIDIAN_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const cfg = path.join(OBSIDIAN_ROOT, e.name, ".obsidian", "plugins", "obsidian-local-rest-api", "data.json");
      if (!fs.existsSync(cfg)) continue;
      try { add((JSON.parse(fs.readFileSync(cfg, "utf8")).apiKey || "").trim()); } catch {}
    }
  } catch {}
  return keys;
}

// Probe whether a key authenticates against the running REST instance.
async function obsidianKeyAuthenticates(key) {
  try {
    const { status, raw } = await obsidianRawRequest("/", {
      headers: { Accept: "application/json", [OBSIDIAN_REST_AUTH_HEADER]: `Bearer ${key}` },
    });
    if (status < 200 || status >= 300) return false;
    let parsed; try { parsed = JSON.parse(raw); } catch { return false; }
    return parsed?.authenticated === true;
  } catch { return false; }
}

// Resolve the key for whichever vault is currently serving the REST API.
async function resolveObsidianApiKey(force = false) {
  if (!force && _obsidianResolvedKey) return _obsidianResolvedKey;
  for (const key of collectObsidianApiKeys()) {
    if (await obsidianKeyAuthenticates(key)) { _obsidianResolvedKey = key; return key; }
  }
  _obsidianResolvedKey = OBSIDIAN_REST_API_KEY || null;  // best-effort fallback
  return _obsidianResolvedKey;
}

async function callObsidianRest(pathname, options = {}) {
  const pathPart = normalizeRestPath(pathname);
  const method = (options.method || "GET").toUpperCase();
  const contentType = options.contentType || "application/json";
  const baseHeaders = { Accept: "application/json", ...(options.headers || {}) };
  let body;
  if (options.body !== undefined && options.body !== null) {
    baseHeaders["Content-Type"] = contentType;
    if (typeof options.body === "string") body = options.body;
    else if (contentType.includes("json")) body = JSON.stringify(options.body);
    else body = String(options.body);
  }
  async function attempt(force) {
    const key = await resolveObsidianApiKey(force);
    if (!key) {
      throw new Error("No Obsidian Local REST API key found. Enable the Local REST API plugin in a vault under ~/Obsidian (or set OBSIDIAN_REST_API_KEY).");
    }
    const headers = { ...baseHeaders, [OBSIDIAN_REST_AUTH_HEADER]: `Bearer ${key}` };
    return obsidianRawRequest(pathPart, { method, headers, body });
  }
  let { status, raw } = await attempt(false);
  if (status === 401) ({ status, raw } = await attempt(true));  // serving vault may have changed
  let parsed = raw;
  try { parsed = JSON.parse(raw); } catch {}
  if (status < 200 || status >= 300) {
    throw new Error(`Obsidian REST request failed (${status}) ${method} ${pathPart}: ${formatText(parsed).slice(0, 800)}`);
  }
  return { status, method, path: pathPart, data: parsed };
}
function isMissingPalEndpointError(message) {
  const text = (message || "").toLowerCase();
  return text.includes("unexpected endpoint or method") || text.includes("status 404") || text.includes("not found");
}
async function callPal(pathname, body = {}) {
  const base = PAL_BASE_URL.replace(/\/+$/, "");
  const url = `${base}${pathname}`;
  const headers = { "Content-Type": "application/json" };
  if (PAL_BEARER_TOKEN) headers.Authorization = `Bearer ${PAL_BEARER_TOKEN}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed = raw;
  try { parsed = JSON.parse(raw); } catch {}
  if (!response.ok) {
    throw new Error(`PAL request failed (${response.status}) at ${pathname}: ${formatText(parsed).slice(0, 800)}`);
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.error) {
    throw new Error(`PAL API error at ${pathname}: ${formatText(parsed.error).slice(0, 800)}`);
  }
  return parsed;
}
async function callOpenAIChat(message, modelIdentifier = PAL_FALLBACK_MODEL) {
  const base = PAL_BASE_URL.replace(/\/+$/, "");
  const url = `${base}/v1/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (PAL_BEARER_TOKEN) headers.Authorization = `Bearer ${PAL_BEARER_TOKEN}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelIdentifier,
      messages: [{ role: "user", content: message }],
      stream: false,
      temperature: 0.2,
      max_tokens: 512,
    }),
  });
  const raw = await response.text();
  let parsed = raw;
  try { parsed = JSON.parse(raw); } catch {}
  if (!response.ok) {
    throw new Error(`OpenAI-compatible request failed (${response.status}) at /v1/chat/completions: ${formatText(parsed).slice(0, 800)}`);
  }
  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
  const messageObj = choice?.message || {};
  const content = (messageObj.content || "").toString().trim();
  const reasoning = (messageObj.reasoning_content || "").toString().trim();
  return {
    model: parsed?.model || modelIdentifier,
    response: content || reasoning,
    finish_reason: choice?.finish_reason || null,
    fallback: "lmstudio-chat-completions",
  };
}

// --- Unified memory helpers ---
const MEMORY_KINDS = { memory: "conversations", knowledge: "knowledge", context: "context", skill: "skills" };
function memoryDir(kind, subpath) {
  const base = path.join(MEMORY_ROOT, MEMORY_KINDS[kind] || kind);
  ensureDir(base);
  return subpath ? path.join(base, ...subpath.split("/").filter(Boolean)) : base;
}
function parseQwenURI(uri) {
  if (!uri || !uri.startsWith("qwen://")) return null;
  const body = uri.slice(7);
  const parts = body.split("/").filter(Boolean);
  const kind = parts[0];
  if (!MEMORY_KINDS[kind]) return null;
  return { kind, path: parts.slice(1) };
}
function memoryEntryPath(kind, entryPath) {
  const dir = memoryDir(kind, entryPath);
  ensureDir(path.dirname(dir));
  return dir;
}
function writeMemoryEntry(entry) {
  const id = entry.id || crypto.randomUUID();
  const ts = entry.timestamp || new Date().toISOString();
  const uri = entry.uri || `qwen://${entry.kind}/${entry.path || ""}`;
  const parsed = parseQwenURI(uri);
  const kind = parsed ? parsed.kind : (entry.kind || "knowledge");
  const subpath = parsed ? parsed.path.join("/") : (entry.path || "");
  const basePath = memoryEntryPath(kind, subpath);
  // Write JSON
  const jsonData = { id, uri, source: entry.source || "unknown", timestamp: ts, type: entry.type || "note", project: entry.project || "global", content: entry.content, tags: entry.tags || [] };
  const jsonFile = basePath.endsWith(".json") ? basePath : basePath + ".json";
  ensureDir(path.dirname(jsonFile));
  fs.writeFileSync(jsonFile, JSON.stringify(jsonData, null, 2), "utf8");
  // Write companion MD
  const mdFile = jsonFile.replace(/\.json$/, ".md");
  const mdContent = `\n---\nFROM: ${entry.source || "unknown"}\nTIMESTAMP: ${ts}\nPROJECT: ${entry.project || "global"}\nTYPE: ${entry.type || "note"}\nURI: ${uri}\n---\n\n${entry.content}\n`;
  fs.appendFileSync(mdFile, mdContent, "utf8");
  triggerContextIndexRefresh();
  return { id, uri, jsonFile, mdFile };
}
function readMemoryEntry(kind, subpath) {
  const basePath = memoryEntryPath(kind, subpath);
  const jsonFile = basePath.endsWith(".json") ? basePath : basePath + ".json";
  const mdFile = basePath.endsWith(".md") ? basePath : (basePath.endsWith(".json") ? basePath.replace(/\.json$/, ".md") : basePath + ".md");
  let jsonData = null, mdData = null;
  if (fs.existsSync(jsonFile)) { try { jsonData = JSON.parse(fs.readFileSync(jsonFile, "utf8")); } catch {} }
  if (fs.existsSync(mdFile)) { mdData = fs.readFileSync(mdFile, "utf8"); }
  if (!jsonData && !mdData) {
    // Try as directory listing
    if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
      const entries = fs.readdirSync(basePath).filter(f => !f.startsWith("."));
      return { kind, path: subpath, type: "directory", entries };
    }
    return null;
  }
  return jsonData || { content: mdData, kind, path: subpath };
}
function searchMemoryFiles(query, maxResults = 20) {
  const q = query.toLowerCase();
  const matches = [];
  function walk(dir) {
    if (matches.length >= maxResults || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "index") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith(".md") && !e.name.endsWith(".json")) continue;
      let content; try { content = fs.readFileSync(full, "utf8"); } catch { continue; }
      if (content.toLowerCase().includes(q)) {
        const rel = path.relative(MEMORY_ROOT, full);
        const lines = content.split("\n");
        const matchLine = lines.findIndex(l => l.toLowerCase().includes(q));
        const snippet = lines.slice(Math.max(0, matchLine - 1), matchLine + 3).join("\n");
        matches.push({ file: rel, line: matchLine + 1, snippet: snippet.slice(0, 500) });
      }
    }
  }
  walk(MEMORY_ROOT);
  return matches;
}
function listMemoryEntries(kind, project) {
  const dir = memoryDir(kind);
  if (!fs.existsSync(dir)) return [];
  const entries = [];
  function walk(d, prefix) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "index") continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path.join(d, e.name), rel); continue; }
      if (!e.name.endsWith(".json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(d, e.name), "utf8"));
        if (project && data.project !== project && data.project !== "global") continue;
        entries.push({ uri: data.uri || `qwen://${kind}/${rel.replace(/\.json$/, "")}`, type: data.type, project: data.project, timestamp: data.timestamp, tags: data.tags });
      } catch {}
    }
  }
  walk(dir, "");
  return entries.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
}

import crypto from "crypto";

// --- SQLite FTS5 memory index (adopted from SwiftMaestro MemorySearchEngine) ---
//
// A derived SQLite FTS5 search index over the shared ~/.ai-context/memory store.
// It turns the file-walking `searchMemoryFiles` scan into a sub-millisecond FTS
// query. `memory_index` is null when better-sqlite3 isn't installed or the index
// can't be built — `memory_search` then transparently falls back to the file-walk.
let memoryIndex = null;
let memoryIndexStarted = false;

async function startMemoryIndex() {
  if (memoryIndexStarted) return;
  memoryIndexStarted = true;
  try {
    memoryIndex = await createMemoryIndex();
    if (memoryIndex) {
      // Warm the index in the background (first build is the only slow one).
      memoryIndex.ensureWarm();
    }
  } catch {
    memoryIndex = null;
  }
}

/** Best-effort: keep the index fresh within its cooldown (mirrors SwiftMaestro). */
function refreshMemoryIndex() {
  if (!memoryIndex) return;
  try { memoryIndex.refreshIfStale(); } catch {}
}

/** True once the index has rows; before that, memory_search falls back to file-walk. */
function isMemoryIndexReady() {
  return !!memoryIndex && memoryIndex.indexedCount() > 0;
}

const server = new Server({ name: "ai-context-bridge", version: "4.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  // Legacy Xcode "build bridge" tools (list_projects, build_project,
  // get_build_errors, list_source_files, open_in_xcode) were retired: they
  // collided with the dedicated xcodebuildmcp server (discover_projs,
  // build_macos/build_sim, etc.) and caused agents to misroute Xcode builds.
  // Their switch-case handlers below are now dead code (kept for git history).
  { name: "set_active_project", description: "Set the active project in the unified memory store.", inputSchema: { type: "object", required: ["project"], properties: { project: { type: "string" } } } },
  { name: "read_file", description: "Read a source file from any project.", inputSchema: { type: "object", required: ["filepath"], properties: { project: { type: "string" }, filepath: { type: "string" } } } },
  { name: "write_file", description: "Create, overwrite, or append a file at any host path (absolute, or relative to a project repo via the project arg). Creates parent directories. Use for writing code, config, or any text file.", inputSchema: { type: "object", required: ["filepath", "content"], properties: { filepath: { type: "string" }, content: { type: "string" }, append: { type: "boolean", description: "Append instead of overwrite (default false)." }, project: { type: "string" } } } },
  { name: "edit_file", description: "Exact string replacement in a file. Replaces the first occurrence of `search` with `replace` (set replace_all:true for every occurrence). Errors if `search` is not found, or appears multiple times while replace_all is false — include enough surrounding context to make `search` unique.", inputSchema: { type: "object", required: ["filepath", "search", "replace"], properties: { filepath: { type: "string" }, search: { type: "string" }, replace: { type: "string" }, replace_all: { type: "boolean" }, project: { type: "string" } } } },
  { name: "list_dir", description: "List files and folders in a directory (absolute, or relative to a project repo via the project arg).", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" }, project: { type: "string" } } } },
  { name: "grep_code", description: "Search file contents by regex under a directory (ripgrep-backed) and return file:line: match. Respects common ignore dirs (.git, node_modules, DerivedData, .build) and .gitignore. Prefer this over execute_command for code search. To target a specific repo, pass project (e.g. 'SwiftMaestro') and a repo-relative path like 'Sources', OR pass an absolute path.", inputSchema: { type: "object", required: ["pattern"], properties: { pattern: { type: "string", description: "Regex (ERE) to search for." }, path: { type: "string", description: "Directory to search: an ABSOLUTE path, or relative to the given project's repo. Default: whole GitHub tree." }, file_glob: { type: "string", description: "Optional file filter, e.g. '*.swift'." }, ignore_case: { type: "boolean" }, max_results: { type: "number" }, project: { type: "string", description: "Repo name to scope to, e.g. 'SwiftMaestro'." } } } },
  { name: "glob_files", description: "Find files by name/glob pattern under a directory. Returns matching file paths. Supports *, **, ?. To target a specific repo, pass project (e.g. 'SwiftMaestro') and a repo-relative path, OR pass an absolute path.", inputSchema: { type: "object", required: ["pattern"], properties: { pattern: { type: "string", description: "Glob like '*.swift' or '**/Model*.ts'." }, path: { type: "string", description: "Root to search: an ABSOLUTE path, or relative to the given project's repo. Default: whole GitHub tree." }, max_depth: { type: "number" }, max_results: { type: "number" }, project: { type: "string", description: "Repo name to scope to, e.g. 'SwiftMaestro'." } } } },
  { name: "search_conversation_history", description: "Full-text search across SwiftMaestro's past chat histories (all agents). Returns matching messages with the agent name, role, and a snippet. Use to recall earlier discussion.", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, max_results: { type: "number" } } } },
  { name: "list_skills", description: "List available agent skills (reusable instruction modules) with short descriptions. Check this when a task might match a skill.", inputSchema: { type: "object", properties: {} } },
  { name: "read_skill", description: "Read a skill's SKILL.md instructions by name (from list_skills), then follow its guidance for the current task.", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
  { name: "add_decision", description: "Log an architectural decision to the unified memory store.", inputSchema: { type: "object", required: ["title","decision"], properties: { project: { type: "string" }, title: { type: "string" }, decision: { type: "string" }, rationale: { type: "string" } } } },
  { name: "report_error", description: "Log an error to the unified memory store.", inputSchema: { type: "object", required: ["error"], properties: { project: { type: "string" }, error: { type: "string" }, context: { type: "string" }, severity: { type: "string", enum: ["low","medium","high","critical"] } } } },
  { name: "update_session", description: "Update session context in the unified memory store.", inputSchema: { type: "object", required: ["key","value"], properties: { project: { type: "string" }, key: { type: "string" }, value: { type: "string" } } } },
  { name: "add_todo", description: "Add a task to the unified memory store.", inputSchema: { type: "object", required: ["task"], properties: { project: { type: "string" }, task: { type: "string" }, priority: { type: "string", enum: ["low","medium","high"] }, assignee: { type: "string" } } } },
  { name: "list_active_contexts", description: "List all projects with memory entries in the unified store.", inputSchema: { type: "object", properties: {} } },
  { name: "list_vault", description: "List notes/folders in the Obsidian vault.", inputSchema: { type: "object", properties: { subfolder: { type: "string" }, depth: { type: "number" } } } },
  { name: "search_vault", description: "Full-text search across all Obsidian vault notes.", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, max_results: { type: "number" } } } },
  { name: "read_note", description: "Read a note from the Obsidian vault.", inputSchema: { type: "object", required: ["filepath"], properties: { filepath: { type: "string" } } } },
  { name: "write_note", description: "Create, overwrite, or append a note file in any Obsidian vault under ~/Obsidian. Works across all vaults regardless of which one the Local REST API is serving. filepath is relative to ~/Obsidian (e.g. 'Tech Configs/Network Settings/router.md') or an absolute path inside it. Parent folders are created automatically; Obsidian picks up the change live.", inputSchema: { type: "object", required: ["filepath", "content"], properties: { filepath: { type: "string", description: "Vault-relative path (under ~/Obsidian), e.g. 'OSINTIAN/Notes/foo.md'." }, content: { type: "string" }, append: { type: "boolean", description: "Append to the file instead of overwriting (default false)." } } } },
  { name: "read_notes", description: "Read MULTIPLE Obsidian notes in ONE call. Strongly prefer this over many separate read_note calls when you need several files (e.g. summarizing a folder) — it is far faster. Each path is relative to ~/Obsidian or absolute within it.", inputSchema: { type: "object", required: ["filepaths"], properties: { filepaths: { type: "array", items: { type: "string" }, description: "List of vault-relative note paths to read." } } } },
  { name: "execute_command", description: "Execute a shell command on the host macOS system. Long-running commands are allowed (default 10 min timeout; pass timeout_ms or 0 to disable).", inputSchema: { type: "object", required: ["command"], properties: { command: { type: "string", description: "The shell command to execute." }, cwd: { type: "string", description: "Optional working directory." }, timeout_ms: { type: "number", description: "Max run time in ms (default 600000; 0 = no timeout)." } } } },
  { name: "obsidian_rest_health", description: "Check Obsidian Local REST API connectivity/authentication.", inputSchema: { type: "object", properties: {} } },
  { name: "obsidian_rest_request", description: "Make a direct request to Obsidian Local REST API for vault automation.", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" }, method: { type: "string" }, content_type: { type: "string" }, body: {}, headers: { type: "object", additionalProperties: { type: "string" } } } } },
  { name: "whisperkit_transcribe_control", description: "Control local WhisperKit stream transcription using the switch script.", inputSchema: { type: "object", required: ["action"], properties: { action: { type: "string", enum: ["start","stop","status","repair","toggle"] } } } },
  { name: "whisperkit_transcribe_snapshot", description: "Read recent live text and file tails from WhisperKit transcription logs/reports.", inputSchema: { type: "object", properties: { max_log_lines: { type: "number" }, max_live_items: { type: "number" }, max_report_lines: { type: "number" } } } },
  { name: "memory_write", description: "Write a memory entry to the unified shared memory store. All tools (Warp, Qwen Code, QwenAgent, LM Studio) share this store.", inputSchema: { type: "object", required: ["content"], properties: { uri: { type: "string", description: "QwenURI e.g. qwen://knowledge/projects/myapp/architecture" }, kind: { type: "string", enum: ["memory","knowledge","context","skill"], description: "Memory kind (if no URI provided)" }, path: { type: "string", description: "Sub-path within kind (if no URI provided)" }, content: { type: "string" }, source: { type: "string", description: "Who is writing (e.g. warp-oz, qwen-code, user)" }, type: { type: "string", description: "Entry type: decision, note, session-update, fact, preference" }, project: { type: "string" }, tags: { type: "array", items: { type: "string" } } } } },
  { name: "memory_read", description: "Read a memory entry by QwenURI or kind+path from the unified shared memory store.", inputSchema: { type: "object", properties: { uri: { type: "string", description: "QwenURI e.g. qwen://knowledge/decisions" }, kind: { type: "string", enum: ["memory","knowledge","context","skill"] }, path: { type: "string" } } } },
  { name: "memory_search", description: "Full-text search across the entire unified shared memory store.", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, max_results: { type: "number" } } } },
  { name: "memory_list", description: "List memory entries by kind, optionally filtered by project.", inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["memory","knowledge","context","skill"] }, project: { type: "string" } } } },
  { name: "memory_index", description: "Inspect or rebuild the SQLite FTS5 memory search index. Returns the index path, memory root, indexed file count, and whether it is ready. Pass rebuild:true to force a full reindex (runs in the background for large stores).", inputSchema: { type: "object", properties: { rebuild: { type: "boolean", description: "Force a full reindex (default false)." } } } }
]}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "list_projects": {
        const entries = fs.readdirSync(GITHUB_ROOT, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith("."));
        const projects = entries.map(e => {
          const root = path.join(GITHUB_ROOT, e.name);
          const files = fs.readdirSync(root);
          let type = "unknown";
          if (files.some(f => f.endsWith(".xcodeproj")||f.endsWith(".xcworkspace"))) type = "Xcode";
          else if (files.includes("Package.swift")) type = "Swift Package";
          else if (files.includes("package.json")) type = "Node.js";
          else if (files.includes("requirements.txt")||files.includes("setup.py")) type = "Python";
          else if (files.includes("Makefile")) type = "Make";
          else if (files.includes("Cargo.toml")) type = "Rust";
          return `  ${e.name.padEnd(40)} [${type}]`;
        });
        const active = activeProject();
        return { content: [{ type: "text", text: `GitHub projects (${projects.length}):\n${projects.join("\n")}${active ? `\n\n→ Active: ${active}` : ""}` }] };
      }
      case "set_active_project": {
        writeMemoryEntry({ uri: `qwen://context/active-project`, content: args.project, source: "user", type: "session-update", project: args.project, tags: ["active-project"] });
        return { content: [{ type: "text", text: `✓ Active project: ${args.project}` }] };
      }
      case "build_project":
      case "get_build_errors": {
        const project = resolveProject(args);
        const root = projectRoot(project);
        const xp = findXcodeproj(root);
        const errorsOnly = name === "get_build_errors";
        const config = args?.configuration ?? "Debug";
        let cmd, output;
        if (xp) {
          const scheme = path.basename(xp, ".xcodeproj");
          cmd = `xcodebuild -project "${xp}" -scheme "${scheme}" -configuration ${config} -destination "platform=macOS" CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO 2>&1`;
        } else if (fs.existsSync(path.join(root, "package.json"))) {
          cmd = `cd "${root}" && npm run build 2>&1`;
        } else if (fs.existsSync(path.join(root, "Makefile"))) {
          cmd = `cd "${root}" && make 2>&1`;
        } else {
          return { content: [{ type: "text", text: `No known build system in ${root}` }] };
        }
        try { output = execSync(cmd, { maxBuffer: 10*1024*1024 }).toString(); }
        catch (e) { output = e.stdout?.toString() ?? e.message; }
        if (errorsOnly) {
          const lines = output.split("\n");
          const errors = lines.filter(l => /\berror:/.test(l));
          const warnings = lines.filter(l => /\bwarning:/.test(l) && !l.includes("DVTPlugin") && !l.includes("appintents"));
          const ok = output.includes("BUILD SUCCEEDED") || output.includes("successfully");
          return { content: [{ type: "text", text: [`Build: ${ok?"✓ SUCCEEDED":"✗ FAILED"}`,`\nErrors (${errors.length}):`,errors.length?errors.join("\n"):"  None",`\nWarnings (${warnings.length}):`,warnings.length?warnings.join("\n"):"  None"].join("\n") }] };
        }
        const ok = output.includes("BUILD SUCCEEDED") || output.includes("successfully");
        const issues = output.split("\n").filter(l => /error:|warning:/.test(l) && !l.includes("DVTPlugin"));
        return { content: [{ type: "text", text: `Project: ${project}\nStatus: ${ok?"✓ SUCCEEDED":"✗ FAILED"}\nIssues:\n${issues.join("\n")||"None"}\n\n${output}` }] };
      }
      case "list_source_files": {
        const project = resolveProject(args); const root = projectRoot(project); const ext = args?.extension;
        const files = [];
        function walk(dir) {
          if (!fs.existsSync(dir)) return;
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name.startsWith(".")||e.name==="node_modules"||e.name==="DerivedData") continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (!ext || e.name.endsWith(`.${ext}`)) files.push(full.replace(root+"/",""));
          }
        }
        walk(root);
        return { content: [{ type: "text", text: `Files in ${project} (${files.length}):\n${files.join("\n")}` }] };
      }
      case "read_file": {
        const project = resolveProject(args);
        let fp = args.filepath;
        if (!path.isAbsolute(fp)) fp = path.join(projectRoot(project), fp);
        if (!fs.existsSync(fp)) return { content: [{ type: "text", text: `Not found: ${fp}` }] };
        return { content: [{ type: "text", text: fs.readFileSync(fp, "utf8") }] };
      }
      case "write_file": {
        if (!args?.filepath) return { content: [{ type: "text", text: "Error: filepath is required" }], isError: true };
        let fp = args.filepath;
        if (!path.isAbsolute(fp)) fp = path.join(projectRoot(resolveProject(args)), fp);
        const content = typeof args.content === "string" ? args.content : String(args.content ?? "");
        ensureDir(path.dirname(fp));
        if (args?.append) fs.appendFileSync(fp, content, "utf8");
        else fs.writeFileSync(fp, content, "utf8");
        return { content: [{ type: "text", text: `✓ ${args?.append ? "Appended to" : "Wrote"} ${fp} (${Buffer.byteLength(content, "utf8")} bytes)` }] };
      }
      case "edit_file": {
        if (!args?.filepath) return { content: [{ type: "text", text: "Error: filepath is required" }], isError: true };
        let fp = args.filepath;
        if (!path.isAbsolute(fp)) fp = path.join(projectRoot(resolveProject(args)), fp);
        if (!fs.existsSync(fp)) return { content: [{ type: "text", text: `Not found: ${fp}` }], isError: true };
        const search = String(args.search ?? "");
        if (!search) return { content: [{ type: "text", text: "Error: search string is required" }], isError: true };
        const replace = String(args.replace ?? "");
        const orig = fs.readFileSync(fp, "utf8");
        const count = orig.split(search).length - 1;
        if (count === 0) return { content: [{ type: "text", text: `search string not found in ${fp}` }], isError: true };
        if (count > 1 && !args.replace_all) {
          return { content: [{ type: "text", text: `search string appears ${count} times in ${fp}; pass replace_all:true or add more surrounding context to make it unique` }], isError: true };
        }
        let out;
        if (args.replace_all) {
          out = orig.split(search).join(replace);
        } else {
          const idx = orig.indexOf(search);
          out = orig.slice(0, idx) + replace + orig.slice(idx + search.length);
        }
        fs.writeFileSync(fp, out, "utf8");
        return { content: [{ type: "text", text: `✓ Replaced ${args.replace_all ? count : 1} occurrence(s) in ${fp}` }] };
      }
      case "list_dir": {
        let dir = args?.path;
        if (!dir) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };
        if (!path.isAbsolute(dir)) dir = path.join(projectRoot(resolveProject(args)), dir);
        if (!fs.existsSync(dir)) return { content: [{ type: "text", text: `Not found: ${dir}` }], isError: true };
        const entries = fs.readdirSync(dir, { withFileTypes: true })
          .filter(e => !e.name.startsWith("."))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(e => e.isDirectory() ? `[DIR]  ${e.name}/` : `[FILE] ${e.name}`);
        return { content: [{ type: "text", text: `${dir} (${entries.length}):\n${entries.join("\n") || "(empty)"}` }] };
      }
      case "grep_code": {
        const pattern = String(args?.pattern ?? "");
        if (!pattern) return { content: [{ type: "text", text: "Error: pattern is required" }], isError: true };
        let root = args?.path ? String(args.path) : GITHUB_ROOT;
        if (!path.isAbsolute(root)) root = path.join(projectRoot(resolveProject(args)), root);
        if (!fs.existsSync(root)) return { content: [{ type: "text", text: `Not found: ${root}` }], isError: true };
        const maxResults = Math.max(1, Math.min(2000, Number(args?.max_results) || 200));
        const ignore = ["!.git", "!node_modules", "!DerivedData", "!.build"];
        // No-shell spawn: the regex is passed as an argv element (no injection).
        const rgArgs = ["-n", "--no-heading", "--color=never"];
        rgArgs.push(args?.ignore_case ? "-i" : "-S");
        for (const g of ignore) rgArgs.push("-g", g);
        if (args?.file_glob) rgArgs.push("-g", String(args.file_glob));
        rgArgs.push("-e", pattern, root);
        let r = spawnSync("rg", rgArgs, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
        let text;
        if (r.error && r.error.code === "ENOENT") {
          const gArgs = ["-rnI", "--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude-dir=DerivedData", "--exclude-dir=.build"];
          if (args?.ignore_case) gArgs.push("-i");
          if (args?.file_glob) gArgs.push(`--include=${args.file_glob}`);
          gArgs.push("-E", pattern, root);
          const g = spawnSync("grep", gArgs, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
          text = g.stdout || "";
        } else {
          text = r.stdout || "";
        }
        const lines = text.split("\n").filter(Boolean);
        const shown = lines.slice(0, maxResults).map(l =>
          l.startsWith(root + "/") ? l.slice(root.length + 1) : l);
        const more = lines.length > maxResults ? ` (showing ${maxResults})` : "";
        return { content: [{ type: "text", text: `${lines.length} match(es)${more} for /${pattern}/ in ${root}:\n${shown.join("\n") || "(no matches)"}` }] };
      }
      case "glob_files": {
        const pattern = String(args?.pattern ?? "");
        if (!pattern) return { content: [{ type: "text", text: "Error: pattern is required" }], isError: true };
        let root = args?.path ? String(args.path) : GITHUB_ROOT;
        if (!path.isAbsolute(root)) root = path.join(projectRoot(resolveProject(args)), root);
        if (!fs.existsSync(root)) return { content: [{ type: "text", text: `Not found: ${root}` }], isError: true };
        const maxDepth = Math.max(1, Math.min(20, Number(args?.max_depth) || 12));
        const maxResults = Math.max(1, Math.min(5000, Number(args?.max_results) || 500));
        const rx = globToRegex(pattern);
        const ignoreDirs = new Set([".git", "node_modules", "DerivedData", ".build"]);
        const out = [];
        (function walk(dir, depth) {
          if (out.length >= maxResults || depth > maxDepth) return;
          let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (out.length >= maxResults) return;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
              if (!e.name.startsWith(".") && !ignoreDirs.has(e.name)) walk(full, depth + 1);
            } else {
              const rel = path.relative(root, full);
              if (rx.test(rel) || rx.test(e.name)) out.push(rel);
            }
          }
        })(root, 1);
        return { content: [{ type: "text", text: `${out.length} file(s) matching '${pattern}' under ${root}:\n${out.join("\n") || "(none)"}` }] };
      }
      case "search_conversation_history": {
        const q = String(args?.query ?? "").toLowerCase();
        if (!q) return { content: [{ type: "text", text: "Error: query is required" }], isError: true };
        const maxResults = Math.max(1, Math.min(200, Number(args?.max_results) || 30));
        if (!fs.existsSync(SM_CHATS_DIR)) return { content: [{ type: "text", text: "No chat histories found." }] };
        const names = swiftMaestroAgentNames();
        const matches = [];
        for (const f of fs.readdirSync(SM_CHATS_DIR)) {
          if (!f.endsWith(".json") || matches.length >= maxResults) continue;
          const agent = names[f.replace(/\.json$/, "")] || f.replace(/\.json$/, "");
          let msgs; try { msgs = JSON.parse(fs.readFileSync(path.join(SM_CHATS_DIR, f), "utf8")); } catch { continue; }
          if (!Array.isArray(msgs)) continue;
          for (const m of msgs) {
            if (matches.length >= maxResults) break;
            const content = String(m?.content ?? "");
            const i = content.toLowerCase().indexOf(q);
            if (i < 0) continue;
            const snippet = content.slice(Math.max(0, i - 60), i + 120).replace(/\s+/g, " ").trim();
            matches.push(`[${agent} · ${m.role || "?"}] …${snippet}…`);
          }
        }
        return { content: [{ type: "text", text: matches.length ? `${matches.length} match(es) for "${args.query}":\n\n${matches.join("\n")}` : `No conversation matches for "${args.query}".` }] };
      }
      case "list_skills": {
        const seen = new Set(); const rows = [];
        for (const root of SKILLS_ROOTS) {
          if (!fs.existsSync(root)) continue;
          for (const e of fs.readdirSync(root, { withFileTypes: true })) {
            if (!e.isDirectory() || e.name.startsWith(".") || seen.has(e.name)) continue;
            const md = path.join(root, e.name, "SKILL.md");
            if (!fs.existsSync(md)) continue;
            seen.add(e.name);
            let desc = "";
            try {
              const lines = fs.readFileSync(md, "utf8").split("\n");
              const di = lines.findIndex(l => /^description:/i.test(l));
              if (di >= 0) {
                const inline = lines[di].replace(/^description:\s*/i, "").trim().replace(/^["']|["']$/g, "");
                if (inline && !/^[|>][+-]?$/.test(inline)) {
                  desc = inline;
                } else {
                  // YAML block scalar (description: |): gather indented lines.
                  const collected = [];
                  for (let j = di + 1; j < lines.length; j++) {
                    if (/^\s+\S/.test(lines[j])) collected.push(lines[j].trim());
                    else if (lines[j].trim() === "") continue;
                    else break;
                  }
                  desc = collected.join(" ");
                }
              }
              if (!desc) {
                desc = lines.map(l => l.trim()).find(l =>
                  l && !l.startsWith("---") && !l.startsWith("#") && !/^(name|description):/i.test(l)) || "";
              }
            } catch {}
            rows.push(`- ${e.name}${desc ? `: ${desc.slice(0, 200)}` : ""}`);
          }
        }
        return { content: [{ type: "text", text: rows.length ? `Available skills (${rows.length}):\n${rows.join("\n")}` : "No skills found." }] };
      }
      case "read_skill": {
        const name = String(args?.name ?? "");
        if (!name) return { content: [{ type: "text", text: "Error: name is required" }], isError: true };
        for (const root of SKILLS_ROOTS) {
          const md = path.join(root, name, "SKILL.md");
          if (fs.existsSync(md)) return { content: [{ type: "text", text: fs.readFileSync(md, "utf8") }] };
        }
        return { content: [{ type: "text", text: `Skill not found: ${name}` }], isError: true };
      }
      case "open_in_xcode": {
        const project = resolveProject(args);
        let fp = args.filepath;
        if (!path.isAbsolute(fp)) fp = path.join(projectRoot(project), fp);
        execSync(`open -a Xcode "${fp}"`);
        return { content: [{ type: "text", text: `Opened: ${fp}` }] };
      }
      // --- Unified Memory Tools ---
      case "memory_write": {
        const result = writeMemoryEntry({
          uri: args?.uri, kind: args?.kind || "knowledge", path: args?.path,
          content: args.content, source: args?.source || "mcp-client",
          type: args?.type || "note", project: args?.project || "global",
          tags: args?.tags || [],
        });
        // Refresh the FTS index within its cooldown so the new entry is
        // searchable promptly (bounded cost; no per-write full scan).
        refreshMemoryIndex();
        return { content: [{ type: "text", text: `✓ Memory written: ${result.uri}\n  JSON: ${result.jsonFile}\n  MD: ${result.mdFile}` }] };
      }
      case "memory_read": {
        let kind, subpath;
        if (args?.uri) {
          const parsed = parseQwenURI(args.uri);
          if (!parsed) return { content: [{ type: "text", text: `Invalid QwenURI: ${args.uri}` }], isError: true };
          kind = parsed.kind; subpath = parsed.path.join("/");
        } else {
          kind = args?.kind || "knowledge"; subpath = args?.path || "";
        }
        const data = readMemoryEntry(kind, subpath);
        if (!data) return { content: [{ type: "text", text: `No memory found at ${kind}/${subpath}` }] };
        return { content: [{ type: "text", text: formatText(data) }] };
      }
      case "memory_search": {
        const limit = Math.max(1, Math.min(Number(args?.max_results) || 20, 100));
        const query = String(args?.query ?? "");
        if (!query) return { content: [{ type: "text", text: "Error: query is required" }], isError: true };

        // Fast path: SQLite FTS5 index (sub-millisecond, ranked). `search`
        // returns null only while the index is still cold, in which case we
        // fall through to the file-walking scan for an immediate (correct)
        // answer until the background build finishes.
        if (memoryIndex) {
          refreshMemoryIndex();
          const hits = memoryIndex.search(query, limit);
          if (hits !== null) {
            if (!hits.length) return { content: [{ type: "text", text: `No results for "${query}" in memory.` }] };
            const formatted = hits.map(r => `--- ${r.path} ---\n${r.snippet}`).join("\n\n");
            const note = isMemoryIndexReady() ? "" : "\n\n(index still warming — results from current index)";
            return { content: [{ type: "text", text: `${hits.length} result(s):\n\n${formatted}${note}` }] };
          }
        }

        const results = searchMemoryFiles(query, limit);
        if (!results.length) return { content: [{ type: "text", text: `No results for "${query}" in memory.` }] };
        const formatted = results.map(r => `--- ${r.file} (line ${r.line}) ---\n${r.snippet}`).join("\n\n");
        return { content: [{ type: "text", text: `${results.length} result(s):\n\n${formatted}` }] };
      }
      case "memory_list": {
        const kind = args?.kind || "knowledge";
        const entries = listMemoryEntries(kind, args?.project);
        if (!entries.length) return { content: [{ type: "text", text: `No entries in ${kind}${args?.project ? ` for project ${args.project}` : ""}.` }] };
        const formatted = entries.map(e => `  ${e.uri}  [${e.type}] ${e.project} ${e.timestamp || ""} ${(e.tags||[]).map(t=>`#${t}`).join(" ")}`).join("\n");
        return { content: [{ type: "text", text: `${entries.length} entries in ${kind}:\n${formatted}` }] };
      }
      case "memory_index": {
        if (args?.rebuild) {
          if (memoryIndex) memoryIndex.reindexSync();
          else return { content: [{ type: "text", text: "Memory index not available (better-sqlite3 not installed). Falling back to file-walking search." }] };
        }
        if (!memoryIndex) {
          return { content: [{ type: "text", text: "Memory index: UNAVAILABLE (better-sqlite3 not installed). memory_search will use the slower file-walking scan." }] };
        }
        const ready = isMemoryIndexReady();
        return { content: [{ type: "text", text: formatText({
          available: true,
          ready,
          note: ready ? "" : "still warming — first build runs in the background",
          index_path: memoryIndex.indexPath,
          memory_root: memoryIndex.memoryRoot,
          indexed_files: memoryIndex.indexedCount(),
        }) }] };
      }
      case "execute_command": {
        const cwd = args?.cwd || GITHUB_ROOT;
        // Default 10-min timeout (builds/installs take a while); 0 disables it.
        const timeout = args?.timeout_ms === 0 ? undefined : (Number(args?.timeout_ms) || 600000);
        let output;
        try { output = execSync(args.command, { cwd, maxBuffer: 64*1024*1024, timeout }).toString(); }
        catch (e) { output = (e.stdout?.toString() || "") + "\n" + (e.stderr?.toString() || e.message); }
        return { content: [{ type: "text", text: output }] };
      }
      case "add_decision": {
        const p = resolveProject(args);
        const body = `**${args.title}**\n\n${args.decision}${args.rationale ? `\n\n*Rationale:* ${args.rationale}` : ""}`;
        writeMemoryEntry({ uri: `qwen://knowledge/projects/${p}/decisions`, content: body, source: "AI Agent", type: "decision", project: p, tags: ["decision"] });
        return { content: [{ type: "text", text: `✓ Decision logged to memory: qwen://knowledge/projects/${p}/decisions` }] };
      }
      case "report_error": {
        const p = resolveProject(args);
        const body = `**Severity:** ${args.severity ?? "unspecified"}\n\n${args.error}${args.context ? `\n\n*Context:* ${args.context}` : ""}`;
        writeMemoryEntry({ uri: `qwen://knowledge/projects/${p}/errors`, content: body, source: "AI Agent", type: "error", project: p, tags: ["error", args.severity || "unspecified"] });
        return { content: [{ type: "text", text: `✓ Error logged to memory: qwen://knowledge/projects/${p}/errors` }] };
      }
      case "update_session": {
        const p = resolveProject(args);
        writeMemoryEntry({ uri: `qwen://context/projects/${p}/session`, content: `**${args.key}:** ${args.value}`, source: "AI Agent", type: "session-update", project: p, tags: ["session", args.key] });
        return { content: [{ type: "text", text: `✓ Session updated in memory: ${args.key}=${args.value} for ${p}` }] };
      }
      case "add_todo": {
        const p = resolveProject(args);
        const body = `- [ ]${args.priority ? ` [${args.priority.toUpperCase()}]` : ""}${args.assignee ? ` → ${args.assignee}` : ""} ${args.task}`;
        writeMemoryEntry({ uri: `qwen://knowledge/projects/${p}/todos`, content: body, source: "AI Agent", type: "todo", project: p, tags: ["todo", args.priority || "medium"] });
        return { content: [{ type: "text", text: `✓ Todo added to memory: qwen://knowledge/projects/${p}/todos` }] };
      }
      case "list_active_contexts": {
        // List projects from unified memory
        const memProjectsDir = path.join(MEMORY_ROOT, "knowledge", "projects");
        const rows = [];
        if (fs.existsSync(memProjectsDir)) {
          const names = fs.readdirSync(memProjectsDir, { withFileTypes: true })
            .filter(e => e.isDirectory()).map(e => e.name).sort();
          for (const name of names) {
            const dir = path.join(memProjectsDir, name);
            const files = fs.readdirSync(dir).filter(f => !f.startsWith(".") && !f.startsWith("_"));
            let latestMtime = 0;
            for (const f of files) {
              const stat = fs.statSync(path.join(dir, f));
              if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
            }
            const age = latestMtime ? new Date(latestMtime).toISOString().replace("T"," ").slice(0,16) : "never";
            const fileList = files.map(f => f.replace(/\.(md|json)$/, "")).filter((v,i,a) => a.indexOf(v) === i);
            rows.push(`  ${name.padEnd(35)} ${age}  [${fileList.join(", ")||"empty"}]`);
          }
        }
        // Also check context/projects/ for session data
        const ctxProjectsDir = path.join(MEMORY_ROOT, "context", "projects");
        if (fs.existsSync(ctxProjectsDir)) {
          const ctxNames = fs.readdirSync(ctxProjectsDir, { withFileTypes: true })
            .filter(e => e.isDirectory()).map(e => e.name);
          for (const name of ctxNames) {
            if (!rows.some(r => r.trim().startsWith(name))) {
              rows.push(`  ${name.padEnd(35)} (context only)`);
            }
          }
        }
        return { content: [{ type: "text", text: rows.length
          ? `Active projects (${rows.length}):\n\nPROJECT                             LAST MODIFIED    ENTRIES\n${rows.join("\n")}\n\nMemory store: ~/.ai-context/memory/knowledge/projects/`
          : "No project contexts yet. Use add_decision/add_todo/memory_write to start one." }] };
      }
      case "list_vault": {
        const base = args?.subfolder ? path.join(VAULT, args.subfolder) : VAULT;
        const maxDepth = args?.depth ?? 1; const results = [];
        function walkVault(dir, d) {
          if (d > maxDepth) return;
          let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (e.name.startsWith(".")) continue;
            const rel = path.relative(VAULT, path.join(dir, e.name));
            if (e.isDirectory()) { results.push(`[DIR]  ${rel}/`); walkVault(path.join(dir, e.name), d+1); }
            else results.push(`[FILE] ${rel}`);
          }
        }
        walkVault(base, 1);
        return { content: [{ type: "text", text: results.length ? `Vault (${results.length}):\n${results.join("\n")}` : "Empty." }] };
      }
      case "search_vault": {
        const query = args.query.toLowerCase(); const maxResults = args?.max_results ?? 20; const matches = [];
        function searchVault(dir) {
          if (matches.length >= maxResults) return;
          let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (e.name.startsWith(".")) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { searchVault(full); continue; }
            if (!e.name.endsWith(".md")) continue;
            let content; try { content = fs.readFileSync(full, "utf8"); } catch { continue; }
            const lines = content.split("\n");
            lines.forEach((line, i) => {
              if (matches.length >= maxResults || !line.toLowerCase().includes(query)) return;
              matches.push(`--- ${path.relative(VAULT,full)} (line ${i+1}) ---\n${lines.slice(Math.max(0,i-1),i+3).join("\n")}`);
            });
          }
        }
        searchVault(VAULT);
        return { content: [{ type: "text", text: matches.length ? `${matches.length} result(s):\n\n${matches.join("\n\n")}` : `No results for "${args.query}".` }] };
      }
      case "read_note": {
        let np = args.filepath;
        if (!path.isAbsolute(np)) np = path.join(VAULT, np);
        if (!fs.existsSync(np)) return { content: [{ type: "text", text: `Not found: ${np}` }] };
        return { content: [{ type: "text", text: fs.readFileSync(np, "utf8") }] };
      }
      case "read_notes": {
        const fps = Array.isArray(args?.filepaths) ? args.filepaths : [];
        if (!fps.length) return { content: [{ type: "text", text: "Error: filepaths (array) is required" }], isError: true };
        const parts = [];
        for (const raw of fps) {
          let np = String(raw);
          if (!path.isAbsolute(np)) np = path.join(VAULT, np);
          let body;
          if (!fs.existsSync(np)) body = "(not found)";
          else { try { body = fs.readFileSync(np, "utf8"); } catch (e) { body = `(error: ${e.message})`; } }
          parts.push(`===== ${path.relative(VAULT, np)} =====\n${body}`);
        }
        return { content: [{ type: "text", text: parts.join("\n\n") }] };
      }
      case "write_note": {
        if (!args?.filepath) return { content: [{ type: "text", text: "Error: filepath is required" }], isError: true };
        let np = args.filepath;
        if (!path.isAbsolute(np)) np = path.join(VAULT, np);
        // Safety: confine writes to the Obsidian root.
        const resolved = path.resolve(np);
        const vaultRoot = path.resolve(VAULT);
        if (resolved !== vaultRoot && !resolved.startsWith(vaultRoot + path.sep)) {
          return { content: [{ type: "text", text: `Refused: path escapes the Obsidian root (${VAULT})` }], isError: true };
        }
        const content = typeof args.content === "string" ? args.content : String(args.content ?? "");
        ensureDir(path.dirname(resolved));
        if (args?.append) fs.appendFileSync(resolved, content, "utf8");
        else fs.writeFileSync(resolved, content, "utf8");
        return { content: [{ type: "text", text: `✓ ${args?.append ? "Appended to" : "Wrote"} ${path.relative(VAULT, resolved)} (${Buffer.byteLength(content, "utf8")} bytes)` }] };
      }
      case "obsidian_rest_health": {
        const result = await callObsidianRest("/");
        return { content: [{ type: "text", text: formatText({ base_url: OBSIDIAN_REST_BASE_URL, ...result }) }] };
      }
      case "obsidian_rest_request": {
        const result = await callObsidianRest(args.path, {
          method: args?.method || "GET",
          contentType: args?.content_type || "application/json",
          body: args?.body,
          headers: args?.headers || {},
        });
        return { content: [{ type: "text", text: formatText(result) }] };
      }
      case "whisperkit_transcribe_control": {
        const action = String(args?.action || "").trim();
        if (!["start", "stop", "status", "repair", "toggle"].includes(action)) {
          return { content: [{ type: "text", text: "Invalid action. Use one of: start, stop, status, repair, toggle." }], isError: true };
        }
        const output = runWhisperkitSwitch(action);
        return {
          content: [{ type: "text", text: formatText({ action, script: WHISPERKIT_SWITCH_SCRIPT, output }) }],
        };
      }
      case "whisperkit_transcribe_snapshot": {
        const maxLogLines = Math.max(20, Math.min(2000, Number(args?.max_log_lines) || 400));
        const maxLiveItems = Math.max(1, Math.min(200, Number(args?.max_live_items) || 60));
        const maxReportLines = Math.max(20, Math.min(1000, Number(args?.max_report_lines) || 120));
        const logTail = tailFileLines(WHISPERKIT_LOG_FILE, maxLogLines);
        const liveText = extractWhisperLiveText(logTail, maxLiveItems);
        const currentReportPath = readCurrentWhisperReportPath();
        const reportTail = currentReportPath ? tailFileLines(currentReportPath, maxReportLines) : "";
        return {
          content: [{
            type: "text",
            text: formatText({
              log_file: WHISPERKIT_LOG_FILE,
              current_report_path: currentReportPath || null,
              live_text: liveText,
              log_tail: logTail,
              report_tail: reportTail || null,
            }),
          }],
        };
      }
      default: return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();

// Warm the SQLite FTS5 memory index in the background; this returns immediately
// and never blocks server startup. Until it finishes, memory_search falls back
// to the (correct but slower) file-walking scan.
startMemoryIndex();

await server.connect(transport);
