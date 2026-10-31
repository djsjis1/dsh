/**
 * Personal WeChat adapter (optional, needs a padlocal token). The QR event
 * streams the login code straight into the settings page.
 *
 * wechaty and the padlocal puppet are optional dependencies: a plain install
 * succeeds without them and this adapter reports a clear hint instead of
 * breaking the host.
 */

export class PadlocalAdapter {
  constructor(config, logger, onReply) {
    this.config = config;
    this.log = logger;
    this.onReply = onReply;
    this.bot = undefined;
    this.qrDataUrl = "";
    this.state = "idle";
    this.user = "";
    this.lastError = "";
  }

  get cfg() {
    return this.config().padlocal || {};
  }

  isConfigured() {
    return Boolean(this.cfg.token);
  }

  status() {
    return {
      adapter: "padlocal",
      configured: this.isConfigured(),
      state: this.state,
      user: this.user,
      hasQr: Boolean(this.qrDataUrl),
      error: this.lastError,
    };
  }

  async qr() {
    if (this.qrDataUrl) return { kind: "image", url: this.qrDataUrl, expireSeconds: 0 };
    if (!this.isConfigured()) return { kind: "none", hint: "请在配置里填写 padlocal token。" };
    if (this.state === "online") return { kind: "none", hint: `已登录：${this.user}` };
    return { kind: "none", hint: "正在连接 padlocal，二维码即将出现，请稍后刷新。" };
  }

  async start() {
    if (this.bot) await this.stop();
    const token = this.cfg.token;
    if (!token) {
      this.state = "idle";
      return;
    }
    this.state = "starting";
    this.lastError = "";
    try {
      const { WechatyBuilder } = await import("wechaty");
      const bot = new WechatyBuilder().build({
        name: "dsh-wechat-bridge",
        puppet: "wechaty-puppet-padlocal",
        puppetOptions: { token },
      });
      this.bot = bot;

      bot.on("scan", (qrcode, status) => {
        if (status === 2) return;
        // wechaty renders login codes as an image; no local QR library needed.
        this.qrDataUrl = `https://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}`;
        this.state = "scan";
      });
      bot.on("login", (user) => {
        this.state = "online";
        this.user = user.name();
        this.qrDataUrl = "";
        this.log.info("padlocal: logged in as %s", this.user);
      });
      bot.on("logout", (user, reason) => {
        this.state = "idle";
        this.user = "";
        this.qrDataUrl = "";
        this.log.warn("padlocal: logged out: %s", reason || "unknown");
      });
      bot.on("message", async (message) => {
        if (message.self()) return;
        if (message.room()) return;
        const text = message.text().trim();
        if (!text) return;
        await this.onReply(message.talker(), text);
      });
      bot.on("error", (error) => {
        this.lastError = error.message;
        this.log.warn("padlocal: %s", error.message);
      });

      await bot.start();
    } catch (error) {
      this.state = "error";
      this.lastError = /Cannot find package|ERR_MODULE_NOT_FOUND/.test(error.message)
        ? "未安装 wechaty / wechaty-puppet-padlocal：请执行 npm install wechaty wechaty-puppet-padlocal。"
        : error.message;
      this.log.warn("padlocal: start failed: %s", this.lastError);
    }
  }

  async stop() {
    if (!this.bot) return;
    try {
      await this.bot.stop();
    } catch {
      /* stopping an already-dead puppet is fine */
    }
    this.bot = undefined;
    this.qrDataUrl = "";
    this.state = "idle";
  }
}
