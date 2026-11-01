/**
 * Plugin-local diagnostic log.
 *
 * The host logger's output is not visible anywhere on this deployment, so the
 * plugin keeps its own append-only log next to its state. It stays under data/,
 * so removing the package removes the log with it.
 */
import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ensureDataDir } from "./config.js";

const LOG_FILE = join(DATA_DIR, "bridge.log");
const MAX_BYTES = 512 * 1024;

/** printf-style substitution for the `%s`/`%d` calls the adapter already makes. */
function format(args) {
  const [template, ...rest] = args;
  let index = 0;
  const text = String(template).replace(/%[sd]/g, () => {
    if (index >= rest.length) return "";
    const value = rest[index++];
    return typeof value === "string" ? value : String(value);
  });
  return index < rest.length ? `${text} ${rest.slice(index).map(String).join(" ")}` : text;
}

function write(level, args) {
  const line = `${new Date().toISOString()} [${level}] ${format(args)}\n`;
  try {
    ensureDataDir();
    try {
      if (statSync(LOG_FILE).size > MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {
      // 首次写入或轮转失败都不该影响主流程
    }
    appendFileSync(LOG_FILE, line, "utf8");
  } catch {
    // 日志永远不能把插件拖垮
  }
}

/**
 * Build the logger handed to the bridge and its adapter.
 * @param hostLogger - optional ctx.logger; kept so host-side diagnostics still happen.
 */
export function createLogger(hostLogger) {
  const forward = (level, args) => {
    if (hostLogger && typeof hostLogger[level] === "function") hostLogger[level](...args);
  };
  return {
    info: (...args) => {
      write("info", args);
      forward("info", args);
    },
    warn: (...args) => {
      write("warn", args);
      forward("warn", args);
    },
    error: (...args) => {
      write("error", args);
      forward("error", args);
    },
  };
}

export { LOG_FILE };
