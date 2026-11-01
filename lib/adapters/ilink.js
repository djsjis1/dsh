/**
 * iLink Bot API adapter — 腾讯官方开放的个人微信 Bot 接口
 * 
 * 文档：https://github.com/hao-ji-xing/cc-weixin/blob/main/weixin-bot-api.md
 * 接入域名：ilinkai.weixin.qq.com
 * 
 * 流程：
 * 1. 调用 get_bot_qrcode 获取二维码
 * 2. 用户微信扫码后，调用 get_qrcode_status 获取 bot_token
 * 3. 长轮询 getupdates 收消息
 * 4. 调用 sendmessage 回复
 */
import { randomBytes } from "node:crypto";

const ILINK_BASE = "https://ilinkai.weixin.qq.com";
const LONG_POLL_TIMEOUT_MS = 35000;

/**
 * Resolve a transport result to an error message, if any.
 *
 * getupdates answers a successful long poll without any `ret` field, so a
 * missing code means success; only an explicit non-zero code is a failure.
 */
function apiError(data) {
  if (!data || typeof data !== "object") return "响应不是 JSON 对象";
  if (data.ret === undefined || data.ret === null || data.ret === 0) return null;
  return data.errmsg || `ret=${data.ret}`;
}

/** Text carried by an inbound item list, tolerating the shapes iLink may use. */
function extractText(msg) {
  const items = Array.isArray(msg?.item_list) ? msg.item_list : [];
  for (const item of items) {
    const text = item?.text_item?.text ?? item?.text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return "";
}

/** Sender identity, whichever field this deployment populates. */
function extractSender(msg) {
  return msg?.from_user_id || msg?.from_user_name || msg?.from_user || msg?.sender_id || "";
}

/** Conversation token the reply has to echo back. */
function extractContextToken(msg) {
  return msg?.context_token || msg?.contextToken || msg?.context?.token || "";
}

export class ILinkAdapter {
  constructor(configGetter, logger, onMessage) {
    this.getConfig = configGetter;
    this.log = logger;
    this.onMessage = onMessage;
    this.botToken = null;
    this.getUpdatesBuf = "";
    this.polling = false;
    this.abortController = null;
    this.qrCode = null;
    this.qrUrl = null;
    this.waiting = false;
  }

  status() {
    return {
      state: this.botToken ? "online" : this.qrCode ? "waiting_scan" : "offline",
      configured: !!this.getConfig().ilink?.botToken,
    };
  }

  async start() {
    const config = this.getConfig();
    if (config.ilink?.botToken) {
      this.botToken = config.ilink.botToken;
      this.log.info("ilink: 复用已保存的 bot_token");
      this.startPolling();
    } else {
      await this.getQRCode();
      this.startWaiting();
    }
  }

  async stop() {
    this.polling = false;
    this.waiting = false;
    this.abortController?.abort();
    this.botToken = null;
    this.qrCode = null;
    this.qrUrl = null;
  }

  /**
   * Payload the bind code must carry. The official page draws its QR from
   * `location.href`, so the code has to encode the link rather than the token.
   */
  qrText() {
    return this.qrUrl || this.qrCode;
  }

  async qr() {
    if (this.qrCode) return { kind: "svg", url: "/wechat-bridge/qr.svg", hint: "用微信扫码登录" };
    return { kind: "none", hint: this.botToken ? "已连接" : "正在获取二维码…" };
  }

  /** Poll the scan state so binding completes without the page asking. */
  startWaiting() {
    if (this.waiting) return;
    this.waiting = true;
    const tick = async () => {
      while (this.waiting && this.qrCode && !this.botToken) {
        try {
          const result = await this.checkQRStatus();
          if (result?.status === "confirmed") {
            this.waiting = false;
            return;
          }
        } catch {
          // 网络抖动时继续重试，扫码窗口内不中断
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      this.waiting = false;
    };
    tick().catch(() => {});
  }

  async getQRCode() {
    try {
      const headers = this.makeHeaders();
      const res = await fetch(`${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`, { headers });
      const data = await res.json();
      const failure = apiError(data);
      if (failure) throw new Error(failure);
      this.qrCode = data.qrcode;
      this.qrUrl = data.qrcode_img_content || null;
      this.log.info("ilink: 二维码已获取，等待扫码");
      return { qrcode: data.qrcode, url: data.url || this.qrUrl };
    } catch (error) {
      this.log.error("ilink: getQRCode failed: %s", error.message);
      throw error;
    }
  }

  async checkQRStatus() {
    if (!this.qrCode) return null;
    try {
      const headers = this.makeHeaders();
      const res = await fetch(`${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${this.qrCode}`, { headers });
      const data = await res.json();
      const statusFailure = apiError(data);
      if (statusFailure) throw new Error(statusFailure);
      if (data.status === "confirmed") {
        this.botToken = data.bot_token;
        const config = this.getConfig();
        config.ilink = { botToken: data.bot_token };
        const { saveConfig } = await import("../config.js");
        saveConfig(config);
        this.log.info("ilink: 扫码成功，bot_token 已保存");
        this.qrCode = null;
        this.qrUrl = null;
        this.startPolling();
        return { status: "confirmed", botToken: data.bot_token };
      }
      return { status: data.status };
    } catch (error) {
      this.log.error("ilink: checkQRStatus failed: %s", error.message);
      throw error;
    }
  }

  startPolling() {
    if (this.polling) return;
    this.polling = true;
    this.abortController = new AbortController();
    this.pollLoop();
  }

  async pollLoop() {
    while (this.polling && this.botToken) {
      try {
        const headers = this.makeHeaders(this.botToken);
        const res = await fetch(`${ILINK_BASE}/ilink/bot/getupdates`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            get_updates_buf: this.getUpdatesBuf,
            base_info: { channel_version: "1.0.2" },
          }),
          signal: this.abortController.signal,
        });
        const data = await res.json();
        const failure = apiError(data);
        if (failure) throw new Error(`getupdates: ${failure}`);
        this.getUpdatesBuf = data.get_updates_buf || this.getUpdatesBuf;
        if (data.msgs?.length > 0) {
          this.log.info("ilink: 收到 %d 条原始消息: %s", data.msgs.length, JSON.stringify(data.msgs).slice(0, 2000));
          for (const msg of data.msgs) {
            const text = extractText(msg);
            if (!text) {
              this.log.warn("ilink: 跳过无文本消息 type=%s: %s", msg?.message_type, JSON.stringify(msg).slice(0, 400));
              continue;
            }
            const from = extractSender(msg);
            this.log.info("ilink: 派发消息 from=%s type=%s", from, msg?.message_type);
            this.onMessage({ ...msg, text, from_user_id: from, context_token: extractContextToken(msg) }).catch((error) => {
              this.log.error("ilink: onMessage handler failed: %s", error.message);
            });
          }
        }
      } catch (error) {
        if (error.name === "AbortError") break;
        this.log.error("ilink: pollLoop error: %s", error.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  async sendMessage(toUserId, text, contextToken) {
    if (!this.botToken) throw new Error("未登录");
    try {
      const headers = this.makeHeaders(this.botToken);
      const res = await fetch(`${ILINK_BASE}/ilink/bot/sendmessage`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          msg: {
            to_user_id: toUserId,
            message_type: 2,
            message_state: 2,
            context_token: contextToken,
            item_list: [{ type: 1, text_item: { text } }],
          },
        }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      const sendFailure = apiError(data);
      if (sendFailure) throw new Error(`sendmessage: ${sendFailure}`);
      this.log.info("ilink: 消息已发送给 %s", toUserId);
      return data;
    } catch (error) {
      this.log.error("ilink: sendMessage failed: %s", error.message);
      throw error;
    }
  }

  makeHeaders(bearerToken = null) {
    const uin = randomBytes(4).readUInt32BE(0);
    const xWechatUin = Buffer.from(String(uin)).toString("base64");
    const headers = {
      "Content-Type": "application/json",
      "AuthorizationType": "ilink_bot_token",
      "X-WECHAT-UIN": xWechatUin,
    };
    if (bearerToken) {
      headers.Authorization = `Bearer ${bearerToken}`;
    }
    return headers;
  }
}
