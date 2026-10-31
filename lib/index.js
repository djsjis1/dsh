/**
 * dsh-plugin-wechat — host half.
 *
 * Uses the official iLink Bot API (腾讯开放的个人微信 Bot 接口) to receive
 * messages via long polling and send replies. All state lives in data/.
 * Uninstalling the plugin removes everything.
 */
import { loadConfig, saveConfig, resetConfig } from "./config.js";
import { runTask } from "./runner.js";
import { ILinkAdapter } from "./adapters/ilink.js";
import { BridgeServer, publicConfig } from "./server.js";

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

/** Command surface for chat messages. */
function interpret(text) {
  const norm = text.trim().toLowerCase();
  if (norm === "帮助" || norm === "/help" || norm === "help") {
    return {
      kind: "text",
      text: "🤖 DSH 微信桥\n\n直接发送任务即可，例如：\n· 列出当前目录的文件\n· 查看磁盘占用\n· 帮我写一个脚本\n\n指令：\n· 帮助 —— 本说明",
    };
  }
  return { kind: "task", prompt: text.trim() };
}

class Bridge {
  constructor(logger) {
    this.log = logger;
    this.cfg = loadConfig();
    this.ilink = new ILinkAdapter(() => this.cfg, logger, (msg) => this.handleMessage(msg));
    this.server = new BridgeServer({ bridge: this, logger });
  }

  config() {
    return this.cfg;
  }

  async start() {
    await this.ilink.start();
  }

  async stop() {
    await this.ilink.stop();
  }

  async status() {
    return {
      adapter: this.ilink.status(),
    };
  }

  async qr() {
    return this.ilink.qr();
  }

  async refreshQR() {
    await this.ilink.getQRCode();
    return this.ilink.qr();
  }

  async checkQRStatus() {
    return this.ilink.checkQRStatus();
  }

  async updateConfig(incoming) {
    const next = structuredClone(this.cfg);
    const take = (value) => (typeof value === "string" && value && !value.includes("•") ? value : undefined);

    for (const key of ["bin", "home", "profile", "workDir"]) {
      const value = take(incoming.dsh?.[key]);
      if (value !== undefined) next.dsh[key] = value;
    }
    if (incoming.dsh?.timeoutMs && Number.isFinite(Number(incoming.dsh.timeoutMs))) {
      next.dsh.timeoutMs = Number(incoming.dsh.timeoutMs);
    }
    const apiKey = take(incoming.dsh?.apiKey);
    if (apiKey !== undefined) next.dsh.apiKey = apiKey;

    if (Array.isArray(incoming.access?.allowedUsers)) {
      next.access.allowedUsers = incoming.access.allowedUsers.map(String).map((s) => s.trim()).filter(Boolean);
    }
    if (typeof incoming.access?.replyPrefix === "string") next.access.replyPrefix = incoming.access.replyPrefix;

    this.cfg = next;
    saveConfig(this.cfg);
    this.log.info("config saved");
    return this.cfg;
  }

  async resetConfig() {
    this.cfg = resetConfig();
    await this.ilink.stop();
    await this.ilink.start();
    return this.cfg;
  }

  publicConfig() {
    return publicConfig(this.cfg);
  }

  allows(user) {
    const list = this.cfg.access.allowedUsers;
    if (!list || list.length === 0) return true;
    return list.includes(user);
  }

  /** Run one prompt with the shared dsh guardrails. */
  async runPrompt(prompt) {
    const result = await runTask(this.cfg, prompt);
    return { ok: result.ok, output: clip(result.output), error: result.error };
  }

  /** Handle an incoming message from iLink long polling. */
  async handleMessage(msg) {
    const fromUser = msg.from_user_id;
    const text = msg.item_list?.[0]?.text_item?.text || "";
    const contextToken = msg.context_token;

    if (!this.allows(fromUser)) {
      await this.ilink.sendMessage(fromUser, "⛔ 你不在白名单中，无权使用。", contextToken);
      return;
    }

    const command = interpret(text);

    if (command.kind === "text") {
      await this.ilink.sendMessage(fromUser, command.text, contextToken);
      return;
    }

    await this.ilink.sendMessage(fromUser, "⏳ 正在执行，请稍候…", contextToken);
    const result = await this.runPrompt(command.prompt);
    const reply = result.ok ? clip(result.output) : `❌ ${result.error || "执行失败"}`;
    await this.ilink.sendMessage(fromUser, reply, contextToken);
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
