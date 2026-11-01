/**
 * Plugin-local persistence. Every file this plugin ever writes lives under
 * `<plugin-root>/data/`, so removing the package directory removes all state:
 * no /etc entries, no systemd units, no dotfiles outside the package.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));

export const PLUGIN_ROOT = dirname(HERE);
export const DATA_DIR = join(PLUGIN_ROOT, "data");
const CONFIG_FILE = join(DATA_DIR, "config.json");

export function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

export function defaultConfig() {
  return {
    ilink: {
      botToken: "",
    },
    dsh: {
      bin: detectDshBin(),
      home: homedir(),
      profile: "headless",
      workDir: join(homedir(), "workspace"),
      timeoutMs: 300000,
    },
    access: {
      allowedUsers: [],
      replyPrefix: "",
    },
  };
}

export function detectDshBin() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  for (const candidate of ["/usr/local/bin/dsh", "/usr/bin/dsh"]) {
    if (existsSync(candidate)) return candidate;
  }
  for (const dir of (process.env.PATH || "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "dsh");
    if (existsSync(candidate)) return candidate;
  }
  return "dsh";
}

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    if (value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" && !Array.isArray(current)) {
      out[key] = deepMerge(current, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function loadConfig() {
  ensureDataDir();
  if (!existsSync(CONFIG_FILE)) return defaultConfig();
  try {
    return deepMerge(defaultConfig(), JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(config) {
  ensureDataDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
  return config;
}

export function resetConfig() {
  if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE, { force: true });
  return defaultConfig();
}
