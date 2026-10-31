/**
 * dsh headless runner: one chat message in, one task out.
 *
 * headless does not read `.credentials.yaml` on its own, so the provider key is
 * resolved here (config override first, then the profile's credential store)
 * and injected as DEEPSEEK_API_KEY into the child environment.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

/** Read `refs.<NAME>` out of the dsh credential store without a YAML dependency. */
export function readCredentialRef(home, name) {
  const file = join(home, ".dsh", ".credentials.yaml");
  if (!existsSync(file)) return undefined;
  try {
    const text = readFileSync(file, "utf8");
    const refsStart = text.search(/^refs:\s*$/m);
    if (refsStart === -1) return undefined;
    const block = text.slice(refsStart);
    const match = block.match(new RegExp(`^\\s+${name}:\\s*(.+)$`, "m"));
    return match ? match[1].trim().replace(/^["']|["']$/g, "") : undefined;
  } catch {
    return undefined;
  }
}

export function resolveApiKey(config) {
  if (config.dsh && config.dsh.apiKey) return config.dsh.apiKey;
  return readCredentialRef(config.dsh.home, "DEEPSEEK_API_KEY") || readCredentialRef(config.dsh.home, "XIAOMI_TOKEN_PLAN_CN_API_KEY");
}

/**
 * Run one headless task.
 * @returns {Promise<{ ok: boolean, output: string, error?: string }>}
 */
export function runTask(config, prompt) {
  const apiKey = resolveApiKey(config);
  if (!apiKey) {
    return Promise.resolve({
      ok: false,
      output: "",
      error: "未找到模型凭据：请先在 DSH「设置 → 模型」配置 API Key，或在插件里填写 apiKey。",
    });
  }

  const { bin, profile, workDir, timeoutMs, home } = config.dsh;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(bin, ["--profile", profile, prompt], {
      cwd: existsSync(workDir) ? workDir : home,
      env: { ...process.env, HOME: home, DEEPSEEK_API_KEY: apiKey },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      settled = true;
      resolve({ ok: false, output: stdout.trim(), error: `任务超时（>${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(-4 * 1024 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, output: "", error: `无法启动 dsh: ${error.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = stdout.trim();
      if (code === 0) resolve({ ok: true, output });
      else resolve({ ok: false, output, error: stderr.trim() || `dsh 退出码 ${code}` });
    });
  });
}
