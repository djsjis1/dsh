/**
 * dsh-plugin-wechat — host half.
 *
 * Scanned binding lives entirely inside this package: the QR, the session, the
 * adapter state and the saved configuration all sit under `data/`, the callback
 * listener dies with the plugin, and nothing is installed outside the package
 * directory. Uninstalling the plugin therefore leaves no trace anywhere.
 */
import { loadConfig, saveConfig, resetConfig } from "./config.js";
import { runTask } from "./runner.js";
import { OfficialAdapter } from "./adapters/official.js";
import { PadlocalAdapter } from "./adapters/padlocal.js";
import { BridgeServer, mergeIncoming, publicConfig } from "./server.js";

const PASSIVE_WINDOW_MS = 4500;
const MAX_REPLY_CHARS = 1800;

function makeLogger(ctx) {
  const sink = ctx?.logger;
  const emit = (level, args) => {
    const message = `[wechat-bridge] ${args[0]}`;
    if (sink && typeof sink[level] === "function") sink[level](message, ...args.slice(1));
    else (level === "info" ? console.log : console[level] || console.log)(message, ...args.slice(1));
  };
  return {
    info: (...args) => emit("info", args),
    warn: (...args) => emit("warn", args),
    error: (...args) => emit("error", args),
  };
}

function clip(text) {
  const value = String(text || "").trim();
  return value.length > MAX_REPLY_CHARS ? `${value.slice(0, MAX_REPLY_CHARS)}\n…(已截断)` : value;
}

/** Command surface shared by every adapter. */
function interpret(text) {
  const norm = text.trim().toLowerCase();
  if (norm === "帮助" || norm === "/help" || norm === "help") {
    return {
      kind: "text",
      text: "🤖 DSH 微信桥\n\n直接发送任务即可，例如：\n· 列出当前目录的文件\n· 查看磁盘占用\n· 帮我写一个脚本\n\n指令：\n· 结果 / /last —— 取回上次未及时返回的结果\n· 帮助 —— 本说明",
    };
  }
  if (norm === "结果" || norm === "/last" || norm === "last") return { kind: "last" };
  return { kind: "task", prompt: text.trim() };
}

class Bridge {
  constructor(logger) {
    this.log = logger;
    this.cfg = loadConfig();
    this.official = new OfficialAdapter(() => this.cfg, logger);
    this.padlocal = new PadlocalAdapter(() => this.cfg, logger, (contact, text) => this.replyViaPadlocal(contact, text));
    this.server = new BridgeServer({ bridge: this, logger });
  }

  config() {
    return this.cfg;
  }

  async start() {
    await this.startAdapter();
    await this.server.startCallback();
  }

  async stop() {
    await this.server.stopCallback();
    await this.padlocal.stop();
  }

  adapter() {
    return this.cfg.mode === "padlocal" ? this.padlocal : this.official;
  }

  async startAdapter() {
    if (this.cfg.mode === "padlocal") {
      await this.padlocal.start();
    } else {
      await this.padlocal.stop();
      if (this.cfg.mode === "official" && this.official.isConfigured()) {
        try {
          await this.official.getAccessToken();
        } catch (error) {
          this.log.warn("official: initial token fetch failed: %s", error.message);
        }
      }
    }
  }

  async restartAdapter() {
    await this.startAdapter();
  }

  async status() {
    const adapter = this.adapter();
    return {
      mode: this.cfg.mode,
      port: this.cfg.port,
      callbackPath: "/callback",
      adapter: adapter.status(),
      lastResult: this.official.lastResult
        ? { at: this.official.lastResult.at, ok: this.official.lastResult.ok }
        : undefined,
    };
  }

  async qr() {
    return this.adapter().qr();
  }

  async updateConfig(incoming) {
    this.cfg = mergeIncoming(this.cfg, incoming);
    saveConfig(this.cfg);
    this.log.info("config saved (mode=%s, port=%s)", this.cfg.mode, this.cfg.port);
    await this.server.startCallback();
    await this.restartAdapter();
    return this.cfg;
  }

  async resetConfig() {
    this.cfg = resetConfig();
    await this.server.startCallback();
    await this.restartAdapter();
    return this.cfg;
  }

  publicConfig() {
    return publicConfig(this.cfg);
  }

  verifyCallback(searchParams) {
    const query = Object.fromEntries(searchParams.entries());
    return this.official.verifySignature(query);
  }

  /** Run one prompt with the shared dsh guardrails. */
  async runPrompt(prompt) {
    const result = await runTask(this.cfg, prompt);
    return { ok: result.ok, output: clip(result.output), error: result.error };
  }

  allows(user) {
    const list = this.cfg.access.allowedUsers;
    if (!list || list.length === 0) return true;
    return list.includes(user);
  }

  /** Adapter-neutral inbound entry: XML from WeChat's servers. */
  async handleInbound(xml) {
    const message = this.official.parseMessage(xml);
    if (!message || message.type !== "text") return "success";
    const command = interpret(message.content || "");
    const reply = (text) => this.official.passiveReply(message.fromUser, message.toUser, text);

    if (!this.allows(message.fromUser)) return reply("⛔ 你不在白名单中，无权使用。");

    if (command.kind === "text") return reply(command.text);
    if (command.kind === "last") {
      const pending = this.official.takePending(message.fromUser);
      if (!pending) return reply("没有待取回的结果。");
      return reply(pending.ok ? clip(pending.output) : `❌ ${pending.error || "执行失败"}`);
    }

    // Race the task against WeChat's 5s passive-reply window.
    const task = this.runPrompt(command.prompt);
    const raced = await Promise.race([
      task,
      new Promise((resolve) => setTimeout(() => resolve(undefined), PASSIVE_WINDOW_MS)),
    ]);

    if (raced) {
      this.official.remember(message.fromUser, command.prompt, raced);
      return reply(raced.ok ? clip(raced.output) : `❌ ${raced.error || "执行失败"}`);
    }

    if (!this.official.pendingByUser.has(message.fromUser)) {
      // Hint that the task is still running; the result lands via /last or the
      // customer-service push below.
    }
    task.then(async (result) => {
      this.official.remember(message.fromUser, command.prompt, result);
      const text = result.ok ? clip(result.output) : `❌ ${result.error || "执行失败"}`;
      const pushed = await this.official.sendActive(message.fromUser, text);
      if (!pushed) this.log.warn("official: result kept for /last (no customer-service permission)");
    });
    return reply(`⏳ 已受理：${command.prompt.slice(0, 60)}\n任务完成后回复「结果」获取输出。`);
  }

  /** padlocal path: reply straight on the conversation. */
  async replyViaPadlocal(contact, text) {
    const command = interpret(text);
    const say = (chunk) => contact.say(chunk).catch((error) => this.log.warn("padlocal: say failed: %s", error.message));

    if (!this.allows(contact.name())) return say("⛔ 你不在白名单中，无权使用。");
    if (command.kind === "text") return say(command.text);
    if (command.kind === "last") {
      const pending = this.official.takePending(contact.id);
      if (!pending) return say("没有待取回的结果。");
      return say(pending.ok ? clip(pending.output) : `❌ ${pending.error || "执行失败"}`);
    }

    await say("⏳ 正在执行，请稍候…");
    const result = await this.runPrompt(command.prompt);
    this.official.remember(contact.id, command.prompt, result);
    return say(result.ok ? clip(result.output) : `❌ ${result.error || "执行失败"}`);
  }
}

function apply(ctx) {
  const logger = makeLogger(ctx);
  const bridge = new Bridge(logger);

  ctx.effect(() => {
    bridge.start().catch((error) => logger.error("start failed: %s", error.message));
    return () => {
      bridge.stop().catch(() => {});
    };
  }, "wechat-bridge: lifecycle");

  ctx.inject(["webServer"], (webCtx) => {
    try {
      const dispose = bridge.server.registerUi(webCtx.webServer);
      webCtx.effect(() => () => dispose?.(), "wechat-bridge: ui routes");
      logger.info("ui routes mounted at /wechat-bridge");
    } catch (error) {
      logger.error("ui route registration failed: %s", error.message);
    }
  });
}

export { apply };
