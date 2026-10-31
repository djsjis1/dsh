/**
 * Official Account adapter (free, stable): a scan-to-follow QR code plus the
 * WeChat server callback. Inbound messages run through dsh headless; replies
 * go out passively within WeChat's 5s window or through the customer-service
 * message API when the account has that permission.
 */
import { createHash } from "node:crypto";

const API = "https://api.weixin.qq.com";

/** Read one flat WeChat callback field, CDATA or plain. */
function pick(xml, tag) {
  const cdata = new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`).exec(xml);
  if (cdata) return cdata[1];
  const plain = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return plain ? plain[1].trim() : "";
}

function cdata(value) {
  return `<![CDATA[${String(value).replaceAll("]]>", "]]&gt;")}]]>`;
}

export class OfficialAdapter {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.accessToken = "";
    this.expiresAt = 0;
    this.lastResult = null;
    this.pendingByUser = new Map();
  }

  get cfg() {
    return this.config().official || {};
  }

  isConfigured() {
    const { appId, appSecret, token } = this.cfg;
    return Boolean(appId && appSecret && token);
  }

  status() {
    const { appId, appSecret, token, qrImageUrl } = this.cfg;
    return {
      adapter: "official",
      configured: this.isConfigured(),
      hasAppId: Boolean(appId),
      hasAppSecret: Boolean(appSecret),
      hasToken: Boolean(token),
      hasManualQr: Boolean(qrImageUrl),
      tokenValid: Boolean(this.accessToken) && Date.now() < this.expiresAt - 60_000,
    };
  }

  async getAccessToken(force = false) {
    if (!force && this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
    const { appId, appSecret } = this.cfg;
    if (!appId || !appSecret) throw new Error("未配置 AppID / AppSecret");
    const url = `${API}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.access_token) throw new Error(`获取 access_token 失败: ${data.errmsg || JSON.stringify(data)}`);
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + (data.expires_in || 7200) * 1000;
    return this.accessToken;
  }

  /** Resolve a scannable follow QR: generated ticket first, manual URL fallback. */
  async qr() {
    const { qrImageUrl } = this.cfg;
    if (this.isConfigured()) {
      try {
        const accessToken = await this.getAccessToken();
        const res = await fetch(`${API}/cgi-bin/qrcode/create?access_token=${accessToken}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expire_seconds: 604800,
            action_name: "QR_STR_SCENE",
            action_info: { scene: { scene_str: "dsh-bind" } },
          }),
        });
        const data = await res.json();
        if (data.ticket) {
          return {
            kind: "image",
            url: `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(data.ticket)}`,
            expireSeconds: data.expire_seconds,
          };
        }
        this.log.warn("official: qrcode/create rejected: %s", data.errmsg || JSON.stringify(data));
      } catch (error) {
        this.log.warn("official: qrcode/create failed: %s", error.message);
      }
    }
    if (qrImageUrl) return { kind: "image", url: qrImageUrl, expireSeconds: 0 };
    return {
      kind: "none",
      hint: "尚未配置 AppID/AppSecret，或该账号没有带参二维码权限。可先填写 AppID、AppSecret、Token，或在“二维码图片地址”里粘贴公众号后台下载的二维码图片 URL。",
    };
  }

  verifySignature(query) {
    const { signature, timestamp, nonce, echostr } = query;
    if (!signature || !timestamp || !nonce) return { ok: false };
    const parts = [this.cfg.token || "", timestamp, nonce].sort().join("");
    const digest = createHash("sha1").update(parts).digest("hex");
    return { ok: digest === signature, echostr };
  }

  parseMessage(xml) {
    if (!xml || !xml.includes("<xml")) return undefined;
    return {
      toUser: pick(xml, "ToUserName"),
      fromUser: pick(xml, "FromUserName"),
      type: pick(xml, "MsgType"),
      content: pick(xml, "Content"),
      createTime: pick(xml, "CreateTime"),
    };
  }

  passiveReply(toUser, fromUser, content) {
    return [
      "<xml>",
      `<ToUserName>${cdata(toUser)}</ToUserName>`,
      `<FromUserName>${cdata(fromUser)}</FromUserName>`,
      `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>`,
      `<MsgType>${cdata("text")}</MsgType>`,
      `<Content>${cdata(content)}</Content>`,
      "</xml>",
    ].join("");
  }

  async sendActive(openId, content) {
    try {
      const accessToken = await this.getAccessToken();
      const res = await fetch(`${API}/cgi-bin/message/custom/send?access_token=${accessToken}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ touser: openId, msgtype: "text", text: { content } }),
      });
      const data = await res.json();
      if (data.errcode) {
        this.log.warn("official: custom/send rejected: %s %s", data.errcode, data.errmsg);
        return false;
      }
      return true;
    } catch (error) {
      this.log.warn("official: custom/send failed: %s", error.message);
      return false;
    }
  }

  remember(user, prompt, result) {
    this.lastResult = { at: Date.now(), user, prompt, ...result };
    this.pendingByUser.set(user, this.lastResult);
  }

  takePending(user) {
    const hit = this.pendingByUser.get(user);
    if (!hit) return undefined;
    this.pendingByUser.delete(user);
    return hit;
  }
}
