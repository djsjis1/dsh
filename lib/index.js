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
import { qrSvg } from "./qr.js";
import { createLogger } from "./log.js";

const MAX_REPLY_CHARS = 1800;

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
    this.queue = Promise.resolve();
    this.pending = 0;
    this.ilink = new ILinkAdapter(() => this.cfg, logger, (msg) => this.handleMessage(msg));
    this.server = new BridgeServer({ bridge: this, logger });
  }

  /**
   * Run one task at a time. A headless run costs a few hundred MB, so letting
   * every inbound message start one in parallel starves the machine and turns
   * replies into timeouts.
   */
  enqueue(work) {
    this.pending += 1;
    const run = this.queue.then(work, work);
    this.queue = run
      .catch(() => {})
      .finally(() => {
        this.pending -= 1;
      });
    return run;
  }

  config() {
    return this.cfg;
  }

  async start() {
    this.log.info("bridge: 启动，已保存 token=%s", this.cfg.ilink?.botToken ? "是" : "否");
    await this.ilink.start();
    this.log.info("bridge: 适配器状态=%s", this.ilink.status().state);
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

  /** SVG bind code, or null when there is nothing to scan. */
  qrImage() {
    const text = this.ilink.qrText();
    return text ? qrSvg(text) : null;
  }

  async refreshQR() {
    await this.ilink.getQRCode();
    this.ilink.startWaiting();
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

  /** Run one prompt with the shared dsh guardrails (queued, never parallel). */
  async runPrompt(prompt) {
    this.log.info("bridge: 排队执行任务");
    return this.enqueue(() => runTask(this.cfg, prompt).then((result) => ({
      ok: result.ok,
      output: clip(result.output),
      error: result.error,
    })));
  }

  /** Handle an incoming message from iLink long polling. */
  async handleMessage(msg) {
    const fromUser = msg.from_user_id || "";
    const text = msg.text || msg.item_list?.[0]?.text_item?.text || "";
    const contextToken = msg.context_token || "";
    this.log.info("bridge: 处理消息 from=%s text=%s", fromUser, text.slice(0, 80));

    if (!this.allows(fromUser)) {
      this.log.warn("bridge: %s 不在白名单", fromUser);
      await this.ilink.sendMessage(fromUser, "⛔ 你不在白名单中，无权使用。", contextToken);
      return;
    }

    const command = interpret(text);

    if (command.kind === "text") {
      await this.ilink.sendMessage(fromUser, command.text, contextToken);
      return;
    }

    await this.ilink.sendMessage(
      fromUser,
      this.pending > 0 ? "⏳ 已收到，前面还有任务，稍后自动执行…" : "⏳ 正在执行，请稍候…",
      contextToken,
    );
    this.log.info("bridge: 开始执行任务（队列 %d）", this.pending);
    const started = Date.now();
    const result = await this.runPrompt(command.prompt);
    this.log.info("bridge: 执行完成 ok=%s 耗时=%ds", result.ok, Math.round((Date.now() - started) / 1000));
    const reply = result.ok ? clip(result.output) : `❌ ${clip(result.error || "执行失败")}`;
    await this.ilink.sendMessage(fromUser, reply || "（没有输出）", contextToken);
  }
}

function apply(ctx) {
  const logger = createLogger(ctx?.logger);
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
