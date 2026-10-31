/**
 * UI endpoints registered on the dsh web server. No separate callback port
 * needed — iLink uses long polling, not webhooks.
 */

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
    ilink: {
      botToken: config.ilink?.botToken ? "••••••••" : "",
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

export class BridgeServer {
  constructor({ bridge, logger }) {
    this.bridge = bridge;
    this.log = logger;
  }

  registerUi(webServer) {
    if (!webServer || typeof webServer.register !== "function") {
      this.log.warn("wechat-bridge: web server unavailable, settings UI endpoints disabled");
      return () => {};
    }
    return webServer.register({
      kind: "prefix",
      path: "/wechat-bridge",
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
      if (route === "qr.svg" && req.method === "GET") {
        const svg = this.bridge.qrImage();
        if (!svg) {
          sendJson(res, 404, { ok: false, error: "no qr code" });
          return;
        }
        res.writeHead(200, {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(svg);
        return;
      }
      if (route === "refresh" && req.method === "POST") {
        sendJson(res, 200, await this.bridge.refreshQR());
        return;
      }
      if (route === "check" && req.method === "POST") {
        const result = await this.bridge.checkQRStatus();
        sendJson(res, 200, result || { status: "unknown" });
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
      if (route === "reset" && req.method === "POST") {
        const saved = await this.bridge.resetConfig();
        sendJson(res, 200, { ok: true, config: publicConfig(saved) });
        return;
      }
      if (route === "test" && req.method === "POST") {
        const body = JSON.parse(await readBody(req) || "{}");
        const result = await this.bridge.runPrompt(String(body.prompt || "用一句话介绍你自己"));
        sendJson(res, 200, { ok: result.ok, ...result });
        return;
      }
      sendJson(res, 404, { ok: false, error: "unknown route" });
    } catch (error) {
      this.log.warn("wechat-bridge: ui route %s failed: %s", route, error.message);
      sendJson(res, 500, { ok: false, error: error.message });
    }
  }
}
