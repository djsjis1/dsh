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
import { loadState, saveState, saveConfig } from "../config.js";

const ILINK_BASE = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "1.0.2";
/** Server-side long-poll hold; a request that outlives this is a dead connection. */
const LONG_POLL_TIMEOUT_MS = 35000;
const POLL_TIMEOUT_MS = LONG_POLL_TIMEOUT_MS + 25000;
/** sendmessage is a normal request; don't let one stalled socket eat the reply. */
const SEND_TIMEOUT_MS = 25000;
/** How many message ids to remember across restarts (iLink client_id ~ 90 chars). */
const MAX_SEEN_IDS = 100;

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
    this.baseUrl = configGetter()?.ilink?.baseUrl?.replace(/\/$/, "") || ILINK_BASE;
    // A fresh process would otherwise restart the cursor at "" and let the
    // server replay the backlog; keep it (and a dedupe window) on disk.
    const state = loadState();
    this.getUpdatesBuf = typeof state.getUpdatesBuf === "string" ? state.getUpdatesBuf : "";
    this.seenIds = new Set(
      Array.isArray(state.seenIds)
        ? state.seenIds.filter((id) => typeof id === "string").slice(-MAX_SEEN_IDS)
        : [],
    );
    this.lastPollAt = 0;
    this.lastMessageAt = 0;
    this.lastError = null;
    // Latest route token per user, like the official SDKs cache. A long task's
    // reply must use the newest token, not the one from the message that started it.
    this.contextTokens = new Map();
  }

  persistState() {
    try {
      saveState({ getUpdatesBuf: this.getUpdatesBuf, seenIds: [...this.seenIds] });
    } catch {
      // 状态文件写失败不应该影响收消息
    }
  }

  /** iLink redelivers when a poll is cut mid-flight; client_id is stable per message. */
  messageKey(msg) {
    const key = msg?.client_id || msg?.message_id || msg?.msg_id;
    return key === undefined || key === null ? "" : String(key);
  }

  isDuplicate(msg) {
    const key = this.messageKey(msg);
    if (!key) return false;
    if (this.seenIds.has(key)) return true;
    this.seenIds.add(key);
    while (this.seenIds.size > MAX_SEEN_IDS) {
      const oldest = this.seenIds.values().next().value;
      this.seenIds.delete(oldest);
    }
    return false;
  }

  status() {
    return {
      state: this.botToken ? "online" : this.qrCode ? "waiting_scan" : "offline",
      configured: !!this.getConfig().ilink?.botToken,
      polling: this.polling,
      lastPollAt: this.lastPollAt || null,
      lastMessageAt: this.lastMessageAt || null,
      lastError: this.lastError,
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
        // 绑定回包里带的是这个 bot 的专属接入地址，出站必须回到它上面
        this.baseUrl = (data.baseurl || data.base_url || ILINK_BASE).replace(/\/$/, "");
        this.log.info("ilink: 绑定回包 %s", JSON.stringify(data).slice(0, 600));
        const config = this.getConfig();
        config.ilink = { ...config.ilink, botToken: data.bot_token, baseUrl: this.baseUrl };
        saveConfig(config);
        // 换了 bot，旧游标属于旧 token；不清掉会以为旧消息都收过了
        this.getUpdatesBuf = "";
        this.seenIds.clear();
        this.contextTokens.clear();
        this.persistState();
        this.log.info("ilink: 扫码成功，bot_token 与 baseurl 已保存");
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
        // 长轮询本身会挂起 35s；再给 25s 余量。没有这个超时，一次半开连接
        // 就能让收消息静默停摆几分钟，微信那头看起来就是「已连接但不回」。
        const signal = AbortSignal.any([
          this.abortController.signal,
          AbortSignal.timeout(POLL_TIMEOUT_MS),
        ]);
        const res = await fetch(`${this.baseUrl}/ilink/bot/getupdates`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            get_updates_buf: this.getUpdatesBuf,
            base_info: { channel_version: CHANNEL_VERSION },
          }),
          signal,
        });
        if (!res.ok) throw new Error(`getupdates HTTP ${res.status}`);
        const data = await res.json().catch(() => {
          throw new Error("getupdates 响应不是 JSON");
        });
        const failure = apiError(data);
        if (failure) throw new Error(`getupdates: ${failure}`);
        this.lastPollAt = Date.now();
        this.lastError = null;
        const nextBuf = typeof data.get_updates_buf === "string" ? data.get_updates_buf : "";
        if (nextBuf && nextBuf !== this.getUpdatesBuf) {
          this.getUpdatesBuf = nextBuf;
          this.persistState();
        }
        if (data.msgs?.length > 0) {
          this.lastMessageAt = Date.now();
          this.log.info("ilink: 收到 %d 条原始消息: %s", data.msgs.length, JSON.stringify(data.msgs).slice(0, 2000));
          for (const msg of data.msgs) {
            const text = extractText(msg);
            if (!text) {
              this.log.warn("ilink: 跳过无文本消息 type=%s: %s", msg?.message_type, JSON.stringify(msg).slice(0, 400));
              continue;
            }
            if (this.isDuplicate(msg)) {
              this.log.warn("ilink: 跳过重复消息 id=%s", this.messageKey(msg));
              this.persistState();
              continue;
            }
            this.persistState();
            const from = extractSender(msg);
            const contextToken = extractContextToken(msg);
            if (contextToken) this.contextTokens.set(from, contextToken);
            this.log.info("ilink: 派发消息 from=%s type=%s", from, msg?.message_type);
            this.onMessage({ ...msg, text, from_user_id: from, context_token: contextToken }).catch((error) => {
              this.log.error("ilink: onMessage handler failed: %s", error.message);
            });
          }
        }
      } catch (error) {
        if (!this.polling || this.abortController?.signal.aborted) break;
        if (error.name === "TimeoutError") {
          this.lastError = `getupdates 超过 ${Math.round(POLL_TIMEOUT_MS / 1000)}s 未返回，已重连`;
          this.log.warn("ilink: %s", this.lastError);
          continue;
        }
        this.lastError = error.message;
        this.log.error("ilink: pollLoop error: %s", error.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  /**
   * iLink 会静默丢弃「没有 client_id」的第二条出站消息：HTTP 照样 200、
   * 也返回 message_id，但微信里不出现。官方 SDK 每条都带唯一 client_id。
   */
  makeClientId() {
    return `ilink-${Date.now()}-${randomBytes(6).toString("hex")}`;
  }

  async sendMessage(toUserId, text, contextToken) {
    if (!this.botToken) throw new Error("未登录");
    try {
      const headers = this.makeHeaders(this.botToken);
      // Prefer the newest token seen for this chat; the original one may be stale
      // by the time a long task finishes.
      const routeToken = this.contextTokens.get(toUserId) || contextToken || "";
      const clientId = this.makeClientId();
      const res = await fetch(`${this.baseUrl}/ilink/bot/sendmessage`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          base_info: { channel_version: CHANNEL_VERSION },
          msg: {
            from_user_id: "",
            to_user_id: toUserId,
            client_id: clientId,
            message_type: 2,
            message_state: 2,
            context_token: routeToken,
            item_list: [{ type: 1, text_item: { text } }],
          },
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      const raw = await res.text();
      let data;
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error(`sendmessage HTTP ${res.status}: ${raw.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`sendmessage HTTP ${res.status}: ${data.errmsg || raw.slice(0, 200)}`);
      const sendFailure = apiError(data);
      if (sendFailure) throw new Error(`sendmessage: ${sendFailure}`);
      this.log.info(
        "ilink: 消息已发送给 %s（HTTP %d，client_id=%s，回包 %s）",
        toUserId,
        res.status,
        clientId,
        JSON.stringify(data).slice(0, 600),
      );
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
