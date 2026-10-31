/**
 * Two HTTP surfaces, each with its own trust story:
 *
 *  - UI endpoints are registered on the dsh web server, so they inherit the
 *    deployment's session/nginx authentication and stay same-origin for the
 *    settings page.
 *  - The WeChat callback listens on its own port because WeChat's servers can
 *    never present a dsh cookie; the port closes the moment the plugin stops,
 *    which is what keeps an uninstall fully inert.
 */
import { createServer } from "node:http";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Strip secrets before any configuration leaves the host. */
export function publicConfig(config) {
  return {
    mode: config.mode,
    port: config.port,
    official: {
      appId: config.official.appId,
      appSecret: config.official.appSecret ? "••••••••" : "",
      token: config.official.token ? "••••••••" : "",
      qrImageUrl: config.official.qrImageUrl,
    },
    padlocal: {
      token: config.padlocal.token ? "••••••••" : "",
    },
    dsh: {
      bin: config.dsh.bin,
      home: config.dsh.home,
      profile: config.dsh.profile,
      workDir: config.dsh.workDir,
      timeoutMs: config.dsh.timeoutMs,
      apiKey: config.dsh.apiKey ? "••••••••" : "",
    },
    access: {
      allowedUsers: config.access.allowedUsers,
      replyPrefix: config.access.replyPrefix,
    },
  };
}

/** Keep masked values from overwriting real secrets on save. */
export function mergeIncoming(current, incoming) {
  const next = structuredClone(current);
  const take = (value) => (typeof value === "string" && value && !value.includes("•") ? value : undefined);

  if (typeof incoming.mode === "string") next.mode = incoming.mode;
  if (incoming.port && Number.isFinite(Number(incoming.port))) next.port = Number(incoming.port);

  for (const key of ["appId", "qrImageUrl"]) {
    const value = take(incoming.official?.[key]);
    if (value !== undefined) next.official[key] = value;
  }
  for (const key of ["appSecret", "token"]) {
    const value = take(incoming.official?.[key]);
    if (value !== undefined) next.official[key] = value;
  }
  const padToken = take(incoming.padlocal?.token);
  if (padToken !== undefined) next.padlocal.token = padToken;

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
    next.access.allowedUsers = incoming.access.allowedUsers.map(String).map((name) => name.trim()).filter(Boolean);
  }
  if (typeof incoming.access?.replyPrefix === "string") next.access.replyPrefix = incoming.access.replyPrefix;

  return next;
}

export class BridgeServer {
  /**
   * @param options.bridge - the bridge owning adapters, config persistence and task execution
   */
  constructor({ bridge, logger }) {
    this.bridge = bridge;
    this.log = logger;
    this.callbackServer = undefined;
  }

  /** Register same-origin UI endpoints on the dsh web server (web profile only). */
  registerUi(webServer) {
    if (!webServer || typeof webServer.register !== "function") {
      this.log.warn("wechat-bridge: web server unavailable, settings UI endpoints disabled");
      return () => {};
    }
    return webServer.register({
      kind: "prefix",
      path: "/wechat-bridge/",
      handler: (req, res) => this.handleUi(req, res),
    });
  }

  async handleUi(req, res) {
    const url = new URL(req.url || "/", "http://dsh.local");
    const route = url.pathname.replace(/^\/wechat-bridge\/?/, "");

    if (req.method === "OPTIONS") {
      res.writeHead(204, JSON_HEADERS);
      res.end();
      return;
    }

    try {
      if (route === "status" && req.method === "GET") {
        sendJson(res, 200, await this.bridge.status());
        return;
      }
      if (route === "qr" && req.method === "GET") {
        sendJson(res, 200, await this.bridge.qr());
        return;
      }
      if (route === "config" && req.method === "GET") {
        sendJson(res, 200, publicConfig(this.bridge.config()));
        return;
      }
      if (route === "config" && req.method === "POST") {
        const body = JSON.parse(await readBody(req) || "{}");
        const saved = await this.bridge.updateConfig(body);
        sendJson(res, 200, { ok: true, config: publicConfig(saved) });
        return;
      }
      if (route === "refresh" && req.method === "POST") {
        await this.bridge.restartAdapter();
        sendJson(res, 200, { ok: true, qr: await this.bridge.qr() });
        return;
      }
      if (route === "test" && req.method === "POST") {
        const body = JSON.parse(await readBody(req) || "{}");
        const result = await this.bridge.runPrompt(String(body.prompt || "列出当前目录的文件"));
        sendJson(res, 200, { ok: result.ok, ...result });
        return;
      }
      sendJson(res, 404, { ok: false, error: "unknown route" });
    } catch (error) {
      this.log.warn("wechat-bridge: ui route %s failed: %s", route, error.message);
      sendJson(res, 500, { ok: false, error: error.message });
    }
  }

  /** Start the WeChat callback listener on its own port. */
  async startCallback() {
    await this.stopCallback();
    const config = this.bridge.config();
    const server = createServer((req, res) => this.handleCallback(req, res));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, "0.0.0.0", resolve);
    });
    this.callbackServer = server;
    this.log.info("wechat-bridge: callback listening on :%s/callback", config.port);
  }

  async stopCallback() {
    if (!this.callbackServer) return;
    const server = this.callbackServer;
    this.callbackServer = undefined;
    await new Promise((resolve) => server.close(resolve));
  }

  async handleCallback(req, res) {
    const url = new URL(req.url || "/", "http://dsh.local");
    if (url.pathname !== "/callback") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("dsh-plugin-wechat: plugin is running");
      return;
    }

    try {
      if (req.method === "GET") {
        const verified = this.bridge.verifyCallback(url.searchParams);
        if (!verified.ok) {
          res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          res.end("invalid signature");
          return;
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(verified.echostr || "");
        return;
      }
      if (req.method === "POST") {
        const xml = await readBody(req);
        const reply = await this.bridge.handleInbound(xml);
        res.writeHead(200, { "content-type": "application/xml; charset=utf-8" });
        res.end(reply || "success");
        return;
      }
      res.writeHead(405);
      res.end();
    } catch (error) {
      this.log.warn("wechat-bridge: callback failed: %s", error.message);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("success");
    }
  }
}
