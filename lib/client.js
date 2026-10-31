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
			badgeOnline: { display: "inline-block", padding: "2px 8px", borderRadius: "999px", fontSize: "12px", background: "rgba(34,197,94,.15)", color: "#16a34a" },
			hint: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.6, wordBreak: "break-all" },
			mono: { fontFamily: "ui-monospace, monospace", fontSize: "12px" },
		};

		function Field({ label, value, onChange, placeholder, type }) {
			return h("div", { style: { flex: "1 1 220px", minWidth: "200px" } }, [
				h("div", { key: "l", style: styles.label }, label),
				h("input", { key: "i", style: styles.input, type: type || "text", value: value || "", placeholder: placeholder || "", onChange: (e) => onChange(e.target.value) }),
			]);
		}

		function WechatPluginTab() {
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
					setNotice("已保存");
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
					setQr(data);
					await refresh();
					setNotice("已刷新二维码");
				} catch (error) {
					setNotice(`刷新失败：${error.message}`);
				} finally {
					setBusy(false);
				}
			};

			const reset = async () => {
				setBusy(true);
				setNotice("");
				try {
					const data = await api("reset", { method: "POST" });
					setConfig(data.config);
					await refresh();
					setNotice("已重置，请重新扫码");
				} catch (error) {
					setNotice(`重置失败：${error.message}`);
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

			const adapterState = status?.adapter?.state || "offline";
			const isOnline = adapterState === "online";

			return h("div", { style: styles.section }, [
				h("h2", { key: "h", style: styles.heading }, "微信接入"),
				h("p", { key: "i", style: styles.intro }, "基于腾讯 iLink Bot API（官方开放接口），扫码绑定个人微信后即可在微信里给 DSH 下发任务。零外部依赖，所有状态保存在插件目录内，卸载插件即彻底清除。"),

				h("div", { key: "status", style: styles.card }, [
					h("div", { key: "r", style: styles.row }, [
						h("span", { key: "b", style: isOnline ? styles.badgeOnline : styles.badge }, isOnline ? "● 已连接" : "○ 未连接"),
						h("span", { key: "s", style: styles.badge }, `状态：${adapterState}`),
					]),
				]),

				h("div", { key: "qr", style: styles.card }, [
					h("div", { key: "t", style: { fontSize: "14px", fontWeight: 600 } }, "扫码绑定"),
					h("div", { key: "b", style: styles.qrBox }, [
						qr?.kind === "image"
							? h("img", { key: "img", src: qr.url, alt: "微信二维码", style: styles.qrImage })
							: h("div", { key: "none", style: { ...styles.qrImage, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", color: "#888", textAlign: "center", padding: "12px" } }, qr?.hint || "等待二维码…"),
						h("div", { key: "side", style: { flex: "1 1 260px", display: "flex", flexDirection: "column", gap: "8px" } }, [
							h("div", { key: "hint", style: styles.hint }, isOnline ? "已连接，在微信里给机器人发消息即可使用。" : "用微信扫描左侧二维码，确认登录后自动开始消息监听。"),
							h("div", { key: "row", style: styles.row }, [
								h("button", { key: "r", style: styles.button, onClick: reloadQr, disabled: busy || isOnline }, "刷新二维码"),
								h("button", { key: "t", style: styles.button, onClick: test, disabled: busy }, "测试任务"),
								h("button", { key: "x", style: styles.button, onClick: reset, disabled: busy }, "重置绑定"),
							]),
						]),
					]),
				]),

				h("div", { key: "cfg", style: styles.card }, [
					h("div", { key: "t", style: { fontSize: "14px", fontWeight: 600 } }, "配置"),
					h("div", { key: "dsh", style: styles.row }, [
						h(Field, { key: "bin", label: "dsh 可执行文件", value: config?.dsh?.bin, onChange: (v) => set("dsh.bin", v) }),
						h(Field, { key: "prof", label: "Profile", value: config?.dsh?.profile, onChange: (v) => set("dsh.profile", v) }),
					]),
					h("div", { key: "allow", style: styles.row }, [
						h(Field, { key: "w", label: "白名单（逗号分隔，留空=所有人）", value: (config?.access?.allowedUsers || []).join(","), onChange: (v) => set("access.allowedUsers", v.split(",").map((s) => s.trim()).filter(Boolean)) }),
						h(Field, { key: "k", label: "模型 API Key（可选，留空自动读取 dsh 凭据）", value: config?.dsh?.apiKey, onChange: (v) => set("dsh.apiKey", v), placeholder: "留空则不修改" }),
					]),
					h("div", { key: "acts", style: styles.row }, [
						h("button", { key: "s", style: styles.buttonPrimary, onClick: save, disabled: busy }, busy ? "处理中…" : "保存"),
					]),
					notice ? h("div", { key: "n", style: styles.hint }, notice) : null,
				]),
			]);
		}

		/** Required client services (cordis fiber inject). */
		const inject = ["slots", "locale"];

		/** Register as a tab in the Plugins management page. */
		function apply(ctx) {
			const NS = "wechat-bridge";
			ctx.effect(() => ctx.locale.register(NS, {
				zh: { tab: "微信接入" },
				en: { tab: "WeChat" },
			}), "wechat-bridge: dictionaries");

			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "wechat",
				order: 40,
				label: () => ctx.locale.bind(NS)("tab"),
				locale: NS,
			}, WechatPluginTab));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
