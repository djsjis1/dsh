window.__ModuleLoader__.load({
	id: "dsh-plugin-wechat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const h = react.createElement;

		const styles = {
			section: { display: "flex", flexDirection: "column", gap: "14px", maxWidth: "760px", color: "var(--dsw-alias-label-primary)" },
			heading: { margin: 0, fontSize: "18px", fontWeight: 600 },
			intro: { margin: 0, fontSize: "13px", color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.6 },
			card: { border: "0.5px solid var(--dsw-alias-border-l2)", borderRadius: "10px", padding: "14px 16px", display: "flex", flexDirection: "column", gap: "10px" },
			row: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" },
			label: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", marginBottom: "4px" },
			input: { width: "100%", boxSizing: "border-box", padding: "7px 10px", fontSize: "13px", borderRadius: "6px", border: "0.5px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-l1, transparent)", color: "inherit" },
			button: { padding: "7px 14px", fontSize: "13px", borderRadius: "6px", border: "0.5px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit", cursor: "pointer" },
			buttonPrimary: { padding: "7px 14px", fontSize: "13px", borderRadius: "6px", border: "none", background: "var(--dsw-alias-state-business-primary, #4f6ef7)", color: "#fff", cursor: "pointer" },
			qrBox: { display: "flex", gap: "18px", alignItems: "center", flexWrap: "wrap" },
			qrImage: { width: "200px", height: "200px", objectFit: "contain", background: "#fff", borderRadius: "8px", padding: "6px" },
			badge: { display: "inline-block", padding: "2px 8px", borderRadius: "999px", fontSize: "12px", background: "var(--dsw-alias-bg-l2, rgba(127,127,127,.12))" },
			hint: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.6, wordBreak: "break-all" },
			mono: { fontFamily: "ui-monospace, monospace", fontSize: "12px" },
		};

		function Field({ label, value, onChange, placeholder, type }) {
			return h("div", { style: { flex: "1 1 220px", minWidth: "200px" } }, [
				h("div", { key: "l", style: styles.label }, label),
				h("input", { key: "i", style: styles.input, type: type || "text", value: value || "", placeholder: placeholder || "", onChange: (e) => onChange(e.target.value) }),
			]);
		}

		function WechatSection() {
			const [status, setStatus] = react.useState(undefined);
			const [qr, setQr] = react.useState(undefined);
			const [config, setConfig] = react.useState(undefined);
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState("");

			const api = react.useCallback(async (route, init) => {
				const res = await fetch(`/wechat-bridge/${route}`, { credentials: "same-origin", ...init });
				const data = await res.json().catch(() => ({}));
				if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
				return data;
			}, []);

			const refresh = react.useCallback(async () => {
				try {
					const [nextStatus, nextQr] = await Promise.all([api("status"), api("qr")]);
					setStatus(nextStatus);
					setQr(nextQr);
				} catch (error) {
					setNotice(`加载失败：${error.message}`);
				}
			}, [api]);

			react.useEffect(() => {
				let alive = true;
				(async () => {
					try {
						const nextConfig = await api("config");
						if (alive) setConfig(nextConfig);
					} catch (error) {
						if (alive) setNotice(`读取配置失败：${error.message}`);
					}
				})();
				refresh();
				const timer = setInterval(() => {
					if (alive) refresh();
				}, 5000);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [api, refresh]);

			const save = async () => {
				setBusy(true);
				setNotice("");
				try {
					const saved = await api("config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(config) });
					setConfig(saved.config);
					await refresh();
					setNotice("已保存并重启适配器");
				} catch (error) {
					setNotice(`保存失败：${error.message}`);
				} finally {
					setBusy(false);
				}
			};

			const reloadQr = async () => {
				setBusy(true);
				try {
					const data = await api("refresh", { method: "POST" });
					setQr(data.qr);
					await refresh();
					setNotice("已刷新二维码");
				} catch (error) {
					setNotice(`刷新失败：${error.message}`);
				} finally {
					setBusy(false);
				}
			};

			const test = async () => {
				setBusy(true);
				setNotice("");
				try {
					const data = await api("test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "用一句话介绍你自己" }) });
					setNotice(data.ok ? `✅ 测试成功：${data.output}` : `❌ 测试失败：${data.error}`);
				} catch (error) {
					setNotice(`测试失败：${error.message}`);
				} finally {
					setBusy(false);
				}
			};

			const set = (path, value) => {
				setConfig((prev) => {
					const next = structuredClone(prev);
					const keys = path.split(".");
					let cursor = next;
					for (let i = 0; i < keys.length - 1; i += 1) cursor = cursor[keys[i]];
					cursor[keys[keys.length - 1]] = value;
					return next;
				});
			};

			const mode = config?.mode || "official";
			const adapterStatus = status?.adapter || {};
			const callbackUrl = `http://${typeof location !== "undefined" ? location.hostname : "服务器IP"}:${config?.port || 3099}/callback`;

			return h("div", { style: styles.section }, [
				h("h2", { key: "h", style: styles.heading }, "微信接入"),
				h("p", { key: "i", style: styles.intro }, "扫码绑定后即可在微信里给 DSH 下发任务。所有状态保存在插件目录内，卸载插件即彻底失效、不残留任何文件。"),

				h("div", { key: "status", style: styles.card }, [
					h("div", { key: "r", style: styles.row }, [
						h("span", { key: "b", style: styles.badge }, `模式：${mode === "padlocal" ? "个人微信（padlocal）" : mode === "off" ? "已关闭" : "公众号"}`),
						h("span", { key: "s", style: styles.badge }, `回调端口：${config?.port || 3099}`),
						status ? h("span", { key: "a", style: styles.badge }, adapterStatus.state ? `状态：${adapterStatus.state}` : adapterStatus.configured ? "已配置" : "未配置") : null,
					]),
					h("div", { key: "c", style: styles.hint }, [
						"微信服务器回调地址（需在公众号后台填写）：",
						h("div", { key: "u", style: styles.mono }, callbackUrl),
					]),
				]),

				h("div", { key: "qr", style: styles.card }, [
					h("div", { key: "t", style: { fontSize: "14px", fontWeight: 600 } }, "扫码绑定"),
					h("div", { key: "b", style: styles.qrBox }, [
						qr?.kind === "image" || qr?.kind === "dataurl"
							? h("img", { key: "img", src: qr.url, alt: "微信二维码", style: styles.qrImage })
							: h("div", { key: "none", style: { ...styles.qrImage, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", color: "#888", textAlign: "center", padding: "12px" } }, qr?.hint || "等待二维码…"),
						h("div", { key: "side", style: { flex: "1 1 260px", display: "flex", flexDirection: "column", gap: "8px" } }, [
							h("div", { key: "hint", style: styles.hint }, qr?.hint || (mode === "official" ? "用微信扫码关注公众号，随后在公众号会话里直接发任务。" : "用要绑定的微信扫码登录。")),
							h("div", { key: "row", style: styles.row }, [
								h("button", { key: "r", style: styles.button, onClick: reloadQr, disabled: busy }, "刷新二维码"),
								h("button", { key: "t", style: styles.button, onClick: test, disabled: busy }, "测试任务"),
							]),
						]),
					]),
				]),

				h("div", { key: "cfg", style: styles.card }, [
					h("div", { key: "t", style: { fontSize: "14px", fontWeight: 600 } }, "配置"),
					h("div", { key: "mode", style: { ...styles.row, gap: "8px" } }, [
						h("button", { key: "o", style: mode === "official" ? styles.buttonPrimary : styles.button, onClick: () => set("mode", "official") }, "公众号（免费）"),
						h("button", { key: "p", style: mode === "padlocal" ? styles.buttonPrimary : styles.button, onClick: () => set("mode", "padlocal") }, "个人微信 padlocal"),
						h("button", { key: "x", style: mode === "off" ? styles.buttonPrimary : styles.button, onClick: () => set("mode", "off") }, "关闭"),
					]),

					mode === "official"
						? h("div", { key: "of", style: { display: "flex", flexDirection: "column", gap: "10px" } }, [
							h("div", { key: "r1", style: styles.row }, [
								h(Field, { key: "id", label: "AppID", value: config?.official?.appId, onChange: (v) => set("official.appId", v) }),
								h(Field, { key: "sec", label: "AppSecret", value: config?.official?.appSecret, onChange: (v) => set("official.appSecret", v), placeholder: "留空则不修改" }),
							]),
							h("div", { key: "r2", style: styles.row }, [
								h(Field, { key: "tok", label: "服务器 Token（回调校验）", value: config?.official?.token, onChange: (v) => set("official.token", v), placeholder: "留空则不修改" }),
								h(Field, { key: "qr", label: "二维码图片地址（可选，无带参二维码权限时用）", value: config?.official?.qrImageUrl, onChange: (v) => set("official.qrImageUrl", v) }),
							]),
						])
						: mode === "padlocal"
							? h("div", { key: "pd", style: styles.row }, [
								h(Field, { key: "t", label: "padlocal token", value: config?.padlocal?.token, onChange: (v) => set("padlocal.token", v), placeholder: "留空则不修改" }),
							])
							: h("div", { key: "off", style: styles.hint }, "插件已关闭，微信侧不会响应。"),

					h("div", { key: "dsh", style: styles.row }, [
						h(Field, { key: "bin", label: "dsh 可执行文件", value: config?.dsh?.bin, onChange: (v) => set("dsh.bin", v) }),
						h(Field, { key: "prof", label: "profile", value: config?.dsh?.profile, onChange: (v) => set("dsh.profile", v) }),
						h(Field, { key: "port", label: "回调端口", value: String(config?.port || 3099), onChange: (v) => set("port", v) }),
					]),
					h("div", { key: "allow", style: styles.row }, [
						h(Field, { key: "w", label: "白名单（逗号分隔，留空=所有人）", value: (config?.access?.allowedUsers || []).join(","), onChange: (v) => set("access.allowedUsers", v.split(",").map((s) => s.trim()).filter(Boolean)) }),
						h(Field, { key: "k", label: "模型 API Key（可选，留空自动读取 dsh 凭据）", value: config?.dsh?.apiKey, onChange: (v) => set("dsh.apiKey", v), placeholder: "留空则不修改" }),
					]),

					h("div", { key: "acts", style: styles.row }, [
						h("button", { key: "s", style: styles.buttonPrimary, onClick: save, disabled: busy }, busy ? "处理中…" : "保存并应用"),
					]),
					notice ? h("div", { key: "n", style: styles.hint }, notice) : null,
				]),
			]);
		}

		/** Mount the WeChat section into the Settings navigation. */
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "wechat",
				order: 40,
				label: () => "微信接入",
			}, WechatSection));
		}

		exports.apply = apply;
		return module.exports;
	},
});
