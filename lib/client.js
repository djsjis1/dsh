window.__ModuleLoader__.load({
	id: "dsh-plugin-wechat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const h = react.createElement;

		const NS = "wechat";

		const zh = {
			title: "微信接入",
			description: "扫码绑定个人微信，在微信里直接给 DSH 下发任务。",
			bound: "已连接",
			unbound: "未连接",
			scan: "用微信扫描二维码，确认后自动完成绑定。",
			refresh: "刷新二维码",
			reset: "解除绑定",
			allow: "允许使用的微信昵称（逗号分隔，留空不限制）",
			timeout: "单次任务超时（秒）",
			save: "保存",
			saved: "已保存",
		};

		const en = {
			title: "WeChat",
			description: "Scan to bind WeChat and send DSH tasks from chat.",
			bound: "Connected",
			unbound: "Not connected",
			scan: "Scan the code with WeChat to finish binding.",
			refresh: "Refresh code",
			reset: "Unbind",
			allow: "Allowed WeChat names (comma separated, empty allows all)",
			timeout: "Task timeout (seconds)",
			save: "Save",
			saved: "Saved",
		};

		const styles = {
			wrap: { display: "flex", flexDirection: "column", gap: "16px", maxWidth: "640px" },
			row: { display: "flex", gap: "16px", alignItems: "flex-start", flexWrap: "wrap" },
			qr: { width: "180px", height: "180px", borderRadius: "10px", background: "#fff", border: "0.5px solid var(--dsw-alias-border-l2)", padding: "6px", boxSizing: "border-box" },
			empty: { width: "180px", height: "180px", borderRadius: "10px", border: "0.5px dashed var(--dsw-alias-border-l3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", textAlign: "center", padding: "12px", boxSizing: "border-box" },
			col: { display: "flex", flexDirection: "column", gap: "10px", flex: "1 1 240px", minWidth: "220px" },
			state: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "var(--dsw-alias-label-secondary)" },
			dot: (on) => ({ width: "7px", height: "7px", borderRadius: "50%", background: on ? "#22c55e" : "#9ca3af", flex: "none" }),
			hint: { fontSize: "12px", lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary)", margin: 0 },
			actions: { display: "flex", gap: "8px", flexWrap: "wrap" },
			button: { padding: "6px 12px", fontSize: "13px", borderRadius: "6px", border: "0.5px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit", cursor: "pointer" },
			field: { display: "flex", flexDirection: "column", gap: "4px" },
			label: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" },
			input: { width: "100%", boxSizing: "border-box", padding: "7px 10px", fontSize: "13px", borderRadius: "6px", border: "0.5px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit" },
			divider: { height: "0.5px", background: "var(--dsw-alias-border-l2)" },
		};

		function request(route, init) {
			return fetch(`/wechat-bridge/${route}`, { credentials: "same-origin", ...init }).then(async (res) => {
				const data = await res.json().catch(() => ({}));
				if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
				return data;
			});
		}

		function WechatCard(props) {
			const { t } = props;
			const [online, setOnline] = react.useState(false);
			const [hasCode, setHasCode] = react.useState(false);
			const codeRef = react.useRef(false);
			const markCode = (value) => {
				codeRef.current = value;
				setHasCode(value);
			};
			const [generation, setGeneration] = react.useState(0);
			const [config, setConfig] = react.useState(null);
			const [note, setNote] = react.useState("");
			const [busy, setBusy] = react.useState(false);

			const readCode = react.useCallback(async () => {
				const qr = await request("qr");
				return qr.kind === "svg";
			}, []);

			react.useEffect(() => {
				// 摘要视图只交代一句话，不必轮询后端
				if (props.view === "summary") return undefined;
				let alive = true;
				const tick = async () => {
					try {
						const status = await request("status");
						if (!alive) return;
						const next = status.adapter?.state === "online";
						setOnline(next);
						// 只补拉一次：已经有码就不再重复请求
						if (!next && !codeRef.current) {
							const code = await readCode();
							if (alive) markCode(code);
						}
					} catch {
						// 后端重启中的短暂失败不打扰界面
					}
				};
				request("config")
					.then((data) => alive && setConfig(data))
					.catch(() => {});
				readCode()
					.then((code) => alive && markCode(code))
					.catch(() => {});
				const timer = setInterval(tick, 2000);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [readCode, props.view]);

			if (props.view === "summary") return t("description");

			const refresh = async () => {
				setBusy(true);
				setNote("");
				try {
					const qr = await request("refresh", { method: "POST" });
					markCode(qr.kind === "svg");
					setGeneration((n) => n + 1);
				} catch (error) {
					setNote(error.message);
				} finally {
					setBusy(false);
				}
			};

			const reset = async () => {
				setBusy(true);
				setNote("");
				try {
					const data = await request("reset", { method: "POST" });
					setConfig(data.config);
					setOnline(false);
					markCode(await readCode());
					setNote(t("reset"));
				} catch (error) {
					setNote(error.message);
				} finally {
					setBusy(false);
				}
			};

			const save = async () => {
				if (!config) return;
				setBusy(true);
				setNote("");
				try {
					const data = await request("config", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ access: config.access, dsh: { timeoutMs: config.dsh?.timeoutMs } }),
					});
					setConfig(data.config);
					setNote(t("saved"));
				} catch (error) {
					setNote(error.message);
				} finally {
					setBusy(false);
				}
			};

			const edit = (path, value) =>
				setConfig((prev) => {
					if (!prev) return prev;
					const next = JSON.parse(JSON.stringify(prev));
					const keys = path.split(".");
					let cursor = next;
					for (let i = 0; i < keys.length - 1; i += 1) cursor = cursor[keys[i]];
					cursor[keys[keys.length - 1]] = value;
					return next;
				});

			const code = online
				? null
				: hasCode
					? h("img", { key: "img", src: `/wechat-bridge/qr.svg?g=${generation}`, alt: "微信二维码", style: styles.qr })
					: h("div", { key: "none", style: styles.empty }, "正在获取二维码…");

			return h("div", { style: styles.wrap }, [
				h("div", { key: "row", style: styles.row }, [
					code,
					h("div", { key: "col", style: styles.col }, [
						h("span", { key: "s", style: styles.state }, [
							h("span", { key: "d", style: styles.dot(online) }),
							online ? t("bound") : t("unbound"),
						]),
						h("p", { key: "hint", style: styles.hint }, online ? t("description") : t("scan")),
						h("div", { key: "acts", style: styles.actions }, [
							h("button", { key: "r", style: styles.button, onClick: refresh, disabled: busy || online }, t("refresh")),
							h("button", { key: "x", style: styles.button, onClick: reset, disabled: busy }, t("reset")),
						]),
					]),
				]),
				h("div", { key: "div", style: styles.divider }),
				config
					? h("div", { key: "cfg", style: { display: "flex", flexDirection: "column", gap: "12px" } }, [
							h("div", { key: "allow", style: styles.field }, [
								h("label", { key: "l", style: styles.label }, t("allow")),
								h("input", {
									key: "i",
									style: styles.input,
									value: (config.access?.allowedUsers || []).join(", "),
									onChange: (e) =>
										edit("access.allowedUsers", e.target.value.split(",").map((s) => s.trim()).filter(Boolean)),
								}),
							]),
							h("div", { key: "timeout", style: styles.field }, [
								h("label", { key: "l", style: styles.label }, t("timeout")),
								h("input", {
									key: "i",
									style: styles.input,
									type: "number",
									min: "10",
									value: Math.round((config.dsh?.timeoutMs || 120000) / 1000),
									onChange: (e) => edit("dsh.timeoutMs", Math.max(10, Number(e.target.value) || 120) * 1000),
								}),
							]),
							h("div", { key: "foot", style: { display: "flex", alignItems: "center", gap: "10px" } }, [
								h("button", { key: "s", style: styles.button, onClick: save, disabled: busy }, t("save")),
								note ? h("span", { key: "n", style: styles.hint }, note) : null,
							]),
					  ])
					: null,
			]);
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-plugin-wechat: dictionaries");
			ctx.slots.inject("plugins.item", () =>
				ctx.slots.register(
					{
						name: "plugins.item",
						id: "wechat",
						order: 40,
						label: () => t("title"),
						locale: NS,
					},
					WechatCard,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
