# dsh-plugin-wechat

基于腾讯 **iLink Bot API**（官方开放接口）的微信机器人插件，扫码绑定个人微信后即可在微信里给 DSH 下发任务。

## 特性

- ✅ **官方合法**：使用腾讯 2026 年开放的 iLink Bot API，无封号风险
- ✅ **零依赖**：不安装任何第三方包，所有代码自包含
- ✅ **扫码即用**：微信扫描二维码即可登录，无需公众号或付费 token
- ✅ **卸载无残留**：所有状态保存在插件 `data/` 目录，删除插件即彻底清除
- ✅ **插件页集成**：以卡片形式出现在 DSH「插件 → 内置插件配置」中，点开即见二维码

## 安装

```bash
# 在 DSH web profile 目录下安装
cd ~/.dsh/profiles/web
npm install github:djsjis1/dsh
```

然后在 `cordis.patch.yml` 中添加：

```yaml
- insert:
    - id: wechat-bridge
      name: dsh-plugin-wechat
```

重启 DSH 后，打开 Web UI → 插件页面 →「内置插件配置」中的「微信接入」卡片。

## 使用流程

1. **打开插件页面**：DSH Web UI → 插件 → 内置插件配置 → 微信接入
2. **扫描二维码**：用微信扫描卡片页面里的二维码
3. **自动绑定**：手机确认后插件自动切到已连接，无需手动刷新
4. **开始使用**：在微信里给机器人发消息即可调用 DSH

## 技术架构

### iLink Bot API

腾讯通过 OpenClaw 框架开放的个人微信 Bot API，接入域名 `ilinkai.weixin.qq.com`：

```
用户微信扫码 → 获取 bot_token → 长轮询 getUpdates 收消息 → sendMessage 回复
```

**核心接口**：
- `GET /ilink/bot/get_bot_qrcode?bot_type=3` - 获取登录二维码
- `GET /ilink/bot/get_qrcode_status?qrcode=xxx` - 轮询扫码状态
- `POST /ilink/bot/getupdates` - 长轮询接收消息
- `POST /ilink/bot/sendmessage` - 发送回复

### 插件结构

```
dsh-plugin-wechat/
├── lib/
│   ├── index.js          # 插件主入口，Bridge 类
│   ├── client.js         # 浏览器端 UI（注册到 plugins.item 卡片槽位）
│   ├── server.js         # HTTP API 路由（无需独立回调端口）
│   ├── config.js         # 配置持久化（data/config.json）
│   ├── runner.js         # dsh headless 调用
│   ├── qr.js             # 二维码矩阵 → SVG
│   ├── qr/               # 内联的 MIT 二维码编码器（Kazuhiko Arase）
│   └── adapters/
│       └── ilink.js      # iLink Bot API 适配器
├── data/                 # 运行时状态（bot_token、配置）
├── package.json          # 零依赖
└── README.md
```

### 零依赖设计

- **无 npm 依赖**：不安装 wechaty、padlocal 等第三方包
- **内置实现**：
  - HTTP 请求：Node.js 原生 `fetch`
  - 二维码编码：内联在 `lib/qr/`（MIT，源同 qrcode-generator）
  - 二维码输出：`/wechat-bridge/qr.svg` 同源返回 SVG，不依赖任何外链
  - 配置持久化：JSON 文件

> 为什么自己画二维码：iLink 返回的 `qrcode_img_content` 是一个由 JS 渲染的页面，不能直接当图片用；官方页面里二维码编码的是该页面 URL（`location.href`），因此插件把这条链接编码成 SVG 由自己输出。

## 配置说明

所有配置在插件页面编辑，保存在 `data/config.json`：

| 字段 | 说明 |
|------|------|
| `dsh.bin` | dsh 可执行文件路径 |
| `dsh.profile` | DSH profile 名称（默认 `headless`） |
| `dsh.apiKey` | 模型 API Key（可选，留空自动读取 dsh 凭据） |
| `access.allowedUsers` | 白名单（逗号分隔，留空=所有人） |

## 卸载

```bash
# 从 cordis.patch.yml 移除 insert 条目，然后
cd ~/.dsh/profiles/web
npm uninstall dsh-plugin-wechat
```

删除插件目录即彻底清除，`data/` 目录随之删除，无残留。

## 与旧方案对比

| 方案 | 协议 | 依赖 | 端口 | 封号风险 |
|------|------|------|------|----------|
| **iLink Bot API（本插件）** | 腾讯官方 | 零 | 无需 | 无 |
| 公众号 | 微信官方 | 零 | 需回调端口 | 无 |
| padlocal | 逆向 iPad 协议 | wechaty + padlocal | 无需 | 高 |
| wechat4u | 网页微信（已死） | wechaty + wechat4u | 无需 | 极高 |

## 安全说明

- iLink Bot API 是腾讯官方开放接口，有《微信 ClawBot 功能使用条款》法律文件背书
- 插件运行 `dsh headless` 在服务器本地，微信消息会到达服务器 shell
- 在共享部署场景下，建议配置 `access.allowedUsers` 白名单
- `bot_token` 保存在 `data/config.json`，权限应限制为仅插件可读

## 许可证

MIT
