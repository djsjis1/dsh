# dsh-plugin-wechat

Scan-to-bind WeChat bridge for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).
Binding a WeChat account shows up as a first-class **setting page inside the dsh Web UI**: open
「设置 → 微信接入」, scan the QR code with your phone, then chat with dsh straight from WeChat.

Everything the plugin owns — QR, session, configuration, cached results — lives in
`<plugin>/data/`. Removing the package removes all of it: no `/etc` entries, no systemd units,
no files outside the package directory.

## Two adapters

| Mode | What you scan | Cost | Notes |
| --- | --- | --- | --- |
| **Official Account** (default) | Follow-QR of your 公众号 | Free | Official WeChat API; requires a registered 公众号 (subscription account works) |
| **Personal WeChat (padlocal)** | Real personal-WeChat login QR | Paid padlocal token | Needs `wechaty` + `wechaty-puppet-padlocal` |

> Individual personal WeChat scanning used to be free through the web protocol
> (`wechat4u`). WeChat shut that protocol down; the puppet now fakes a successful
> login and receives nothing. This plugin therefore ships Official Account as the
> free default and treats padlocal as the paid personal-account option.

## Install into a dsh profile

```bash
# from the profile directory (for the web profile: ~/.dsh/profiles/web)
npm install github:djsjis1/dsh
```

Then insert the plugin row in `cordis.patch.yml`:

```yaml
- insert:
    - id: wechat-bridge
      name: dsh-plugin-wechat
```

Restart dsh, open the Web UI and pick **设置 → 微信接入**.

## Official Account setup

1. Register a 公众号 and open 设置与开发 → 基本配置.
2. Copy **AppID** and **AppSecret** into the plugin page.
3. Set **服务器配置**:
   - URL: `http://<your-host>:3099/callback`
   - Token: any random string — paste the same value into the plugin page
   - Message encryption: plaintext (明文模式)
4. Add your server IP to the 公众号 IP 白名单.
5. Back in the plugin page, press **保存并应用** and scan the QR code.

If the account has no 带参二维码 permission, paste the QR image URL from the
公众号后台 into **二维码图片地址**.

Replies: within WeChat's 5-second passive window the answer comes straight back.
Longer tasks acknowledge immediately; the result is pushed through the
customer-service API when the account has that permission, otherwise reply
`结果` to fetch it.

## Configuration reference

All fields are editable in the page and stored in `data/config.json`:

| Field | Meaning |
| --- | --- |
| `mode` | `official` \| `padlocal` \| `off` |
| `port` | Callback listener port (default `3099`) |
| `official.appId` / `appSecret` / `token` | 公众号 credentials |
| `official.qrImageUrl` | Manual QR image fallback |
| `padlocal.token` | padlocal puppet token |
| `dsh.bin` / `profile` / `workDir` / `timeoutMs` | How to launch `dsh headless` |
| `dsh.apiKey` | Optional override; otherwise read from `<home>/.dsh/.credentials.yaml` |
| `access.allowedUsers` | Comma-separated allowlist (empty = everyone) |

## Uninstall

```bash
# remove the insert row from cordis.patch.yml, then
npm uninstall dsh-plugin-wechat
```

The callback port closes with the plugin and `data/` disappears with the package,
so the binding is dead and nothing remains on the host.

## Security

- The callback listener is necessarily unauthenticated (WeChat cannot send a dsh
  cookie); every request is verified against the 公众号 Token signature.
- The plugin runs `dsh headless` on the host, i.e. chat messages reach the shell.
  Keep `access.allowedUsers` narrow on shared deployments.
- UI endpoints are served by the dsh web server, so they inherit its session and
  reverse-proxy authentication.

## License

MIT
