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
    }
  }

  async stop() {
    this.polling = false;
    this.abortController?.abort();
    this.botToken = null;
    this.qrCode = null;
    this.qrUrl = null;
  }

  async qr() {
    if (this.qrUrl) {
      return { kind: "image", url: this.qrUrl, hint: "用微信扫码登录" };
    }
    if (this.qrCode) {
      const qrImageUrl = `https://wechaty.js.org/qrcode/${encodeURIComponent(this.qrCode)}`;
      return { kind: "image", url: qrImageUrl, hint: "用微信扫码登录" };
    }
    return { kind: "none", hint: "正在获取二维码…" };
  }

  async getQRCode() {
    try {
      const headers = this.makeHeaders();
      const res = await fetch(`${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`, { headers });
      const data = await res.json();
      if (data.ret !== 0) {
        throw new Error(data.errmsg || `获取二维码失败: ret=${data.ret}`);
      }
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
      if (data.ret !== 0) {
        throw new Error(data.errmsg || `查询状态失败: ret=${data.ret}`);
      }
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
        if (data.ret !== 0) {
          throw new Error(data.errmsg || `getupdates 失败: ret=${data.ret}`);
        }
        this.getUpdatesBuf = data.get_updates_buf || this.getUpdatesBuf;
        if (data.msgs?.length > 0) {
          for (const msg of data.msgs) {
            if (msg.message_type !== 1) continue;
            const text = msg.item_list?.[0]?.text_item?.text;
            if (text) {
              this.onMessage(msg).catch((error) => {
                this.log.error("ilink: onMessage handler failed: %s", error.message);
              });
            }
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
      });
      const data = await res.json();
      if (data.ret !== 0) {
        throw new Error(data.errmsg || `sendmessage 失败: ret=${data.ret}`);
      }
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
