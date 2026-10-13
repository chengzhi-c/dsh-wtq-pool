window.__ModuleLoader__.load({
	id: "dsh-wtq-pool",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		//#region src/panel-route.ts
		/**
		* The panel's route prefix.
		*
		* Both halves of this plugin need the same location: the host half mounts the
		* panel's routes under it, and the settings card frames that same address.
		* Sharing the one literal is what stops the two from drifting into a frame that
		* points at nothing.
		*
		* @module dsh-wtq-pool/panel-route
		*/
		/** The route prefix every panel route sits under. */
		const PANEL_BASE = "/plugins/dsh-wtq-pool";
		//#endregion
		//#region src/client/panel-url.ts
		/** The panel's URL, carrying the appearance the embedding page is showing. */
		function panelUrl(appearance) {
			const params = new URLSearchParams({
				base: appearance.base === "dark" ? "dark" : "light",
				lang: appearance.lang.toLowerCase().startsWith("en") ? "en" : "zh-CN"
			});
			return `${PANEL_BASE}/panel?${params.toString()}`;
		}
		//#endregion
		//#region src/client/composer.tsx
		/**
		* The composer credit readout.
		*
		* Sits in the composer's tool row and shows the balance of the account that will
		* serve the next request, but only while the selected model belongs to this
		* plugin. That condition is the point: the row is shared with the shell's own
		* controls, so a plugin that drew there unconditionally would be occupying space
		* the user did not ask it to occupy. The host hands every entry the session's
		* selection through `useProjection('modelSelection')`, which is what the model
		* picker writes and what the next request will use, so the readout cannot
		* disagree with the model actually in effect.
		*
		* Everything shown comes from the plugin's own host half over the panel bridge:
		* this module makes no upstream call of its own and never reads a token.
		*
		* @module dsh-wtq-pool/client/composer
		*/
		const composerZh = {
			"composer.title": "账号积分",
			"composer.account": "账号",
			"composer.balance": "积分",
			"composer.switching": "切换中…",
			"composer.click": "点击切换账号",
			"composer.refresh": "刷新积分",
			"composer.refreshing": "正在刷新…",
			"composer.refused": "这个账号无法切换，刷新后重试",
			"composer.saved": "已设为优先；积分面板暂不可用，恢复后自动生效",
			"composer.unavailable": "已设为优先，但该账号现在不能服务（冷却或已停用），恢复后自动生效",
			"composer.planQuota": "套餐",
			"composer.addOnQuota": "资源包",
			"composer.never": "不过期",
			"composer.monthly": "月度",
			"composer.days": "天"
		};
		const composerEn = {
			"composer.title": "Account credits",
			"composer.account": "Account",
			"composer.balance": "Credits",
			"composer.switching": "Switching…",
			"composer.click": "Click to switch account",
			"composer.refresh": "Refresh credits",
			"composer.refreshing": "Refreshing…",
			"composer.refused": "That account cannot be switched; refresh and try again",
			"composer.saved": "Set as preferred; the credits panel is unavailable right now and it takes over once it recovers",
			"composer.unavailable": "Set as preferred, but that account cannot serve right now (cooling or switched off); it takes over once it recovers",
			"composer.planQuota": "Plan",
			"composer.addOnQuota": "Add-on",
			"composer.never": "never expires",
			"composer.monthly": "monthly",
			"composer.days": " days"
		};
		/**
		* How often the readout re-reads a cached balance, once it has one.
		*
		* A credit balance moves on the scale of model calls, not seconds, and the host
		* answers from the account probe's own cache - so this is a poll of a cached
		* value, not an upstream read per tick. The host half is what guarantees that:
		* `xd.composerPoints` answers from cache, and the only network it can start is
		* the one background refresh that fills a stale cache.
		*/
		const REFRESH_INTERVAL_MS = 3e5;
		/**
		* How often the readout asks again while it has no number yet.
		*
		* The host answers `total: null` for an account whose credits it has not read
		* yet - the first seconds after a session starts, while the account probe is
		* still filling its cache. That is "not read yet", not "no credits": treating it
		* as final would leave the readout showing a dash for a full refresh interval,
		* which is the whole of the time the user is looking at it.
		*/
		const WARMUP_INTERVAL_MS = 5e3;
		/** How long the faster cadence may run before the readout settles down. */
		const WARMUP_WINDOW_MS = 12e4;
		/**
		* The id the readout registers under.
		*
		* Stable and namespaced so a reload replaces its own entry rather than adding a
		* second one beside it.
		*/
		const COMPOSER_SLOT_ID = "dsh-wtq-pool-composer-points";
		function packageText(pack, t) {
			const name = pack.packageName || t(pack.nameKey === "credits.planQuota" ? "composer.planQuota" : pack.nameKey === "credits.addOnQuota" ? "composer.addOnQuota" : "composer.balance");
			const at = typeof pack.roundExpiresAtMs === "number" ? pack.roundExpiresAtMs : pack.expiresAtMs;
			let when = "";
			if (typeof at === "number" && at > Date.now()) {
				const date = new Date(at);
				when = date.getMonth() + 1 + "/" + date.getDate();
			} else if (pack.neverExpires === true) when = t("composer.never");
			else if (pack.monthly === true) when = t("composer.monthly");
			else if (typeof pack.validDays === "number") when = pack.validDays + t("composer.days");
			const remain = typeof pack.remain === "number" ? formatCredits(pack.remain) : "—";
			return name + " " + remain + (when === "" ? "" : " · " + when);
		}
		/** The selected route, out of the host's `modelSelection` projection. */
		function selectionOf(projection) {
			if (projection === null || typeof projection !== "object") return void 0;
			const row = projection.next ?? projection.lastUsed;
			if (row === null || typeof row !== "object") return void 0;
			const provider = row.provider;
			const model = row.model;
			if (typeof provider !== "string" || provider === "") return void 0;
			if (typeof model !== "string" || model === "") return void 0;
			return {
				provider,
				model
			};
		}
		/**
		* How long one panel-channel call may take from the client side.
		*
		* The refresh channel spends up to its own server-side budget re-probing
		* accounts; everything else answers from cache. The figure covers the former
		* with margin, so a cache read never times out while a real pass still fits.
		*/
		const INVOKE_TIMEOUT_MS = 2e4;
		/**
		* Ask the plugin's own host half one channel, over the panel bridge's route.
		*
		* The fetch carries its own deadline: the host side bounds what a channel may
		* spend, but the panel bridge itself imposes no call-length cap, so a stuck
		* route would otherwise leave the readout's promise pending forever.
		*/
		async function invoke(channel, payload) {
			const response = await fetch(`${PANEL_BASE}/invoke`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify({
					channel,
					payload
				}),
				signal: AbortSignal.timeout(INVOKE_TIMEOUT_MS)
			});
			const body = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
			return body.result ?? {};
		}
		/** Group the digits so a four-figure balance stays readable in a narrow row. */
		function formatCredits(value) {
			return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(void 0, { maximumFractionDigits: 2 });
		}
		/** The one balance the readout shows, or undefined when there is none yet. */
		function balanceOf(document) {
			return document !== null && typeof document.total === "number" ? document.total : void 0;
		}
		/** The margin kept between the popup and the edge of the window. */
		const PANEL_MARGIN = 8;
		/** The popup's own width cap, in px. */
		const PANEL_MAX_WIDTH = 360;
		/** How tall the popup is allowed to get, in px. */
		const PANEL_MAX_HEIGHT = 320;
		/**
		* Where the popup sits, given its trigger's box.
		*
		* Anchored above the trigger and right-aligned to it - the composer row is at
		* the bottom of the window, so above is where the room is. Flipped below when
		* the trigger is near the top and the popup would not fit above it: a fixed
		* position is not scrolled into view by anything, so the rows above the trigger
		* would simply be cut off, and so would the popup's own first rows. The width is
		* capped to the window for the same reason, rather than trusting the viewport
		* to be wider than the stylesheet's own cap.
		*/
		function positionStyle(rect) {
			const width = typeof window === "undefined" ? PANEL_MAX_WIDTH : Math.max(0, Math.min(PANEL_MAX_WIDTH, window.innerWidth - 16));
			const above = rect.top - PANEL_MARGIN >= PANEL_MAX_HEIGHT;
			return {
				width: width + "px",
				left: Math.max(PANEL_MARGIN, rect.right - width) + "px",
				top: (above ? rect.top - PANEL_MARGIN : rect.bottom + PANEL_MARGIN) + "px",
				transform: above ? "translateY(-100%)" : void 0
			};
		}
		const CSS = `
.xd-points{position:relative;display:inline-flex;align-items:center;min-width:0}
.xd-points-btn{border:0;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;display:inline-flex;align-items:center;gap:5px;padding:4px 7px;border-radius:999px;cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xd-points-btn:hover{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.12))}
.xd-points-mark{display:inline-block;width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:var(--dsw-alias-state-success-primary,#4f9f7c)}
.xd-points-panel{position:fixed;z-index:40;min-width:240px;max-width:${PANEL_MAX_WIDTH}px;max-height:${PANEL_MAX_HEIGHT}px;overflow:auto;padding:8px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#1c1d21);color:var(--dsw-alias-label-primary,#e8e8ea);box-shadow:0 8px 28px rgba(0,0,0,.28);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}
.xd-points-table{width:100%;border-collapse:collapse;font-size:12px}
.xd-points-table th{text-align:left;font-weight:600;padding:4px 6px;color:var(--dsw-alias-label-tertiary,#8b8d93)}
.xd-points-table td{padding:4px 6px;vertical-align:top}
.xd-points-row{cursor:pointer}
.xd-points-row:hover{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.12))}
.xd-points-row.is-active{cursor:default}
.xd-points-dot{display:inline-block;width:6px;height:6px;margin-right:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#4f9f7c);vertical-align:middle}
.xd-points-packs{margin:2px 0 0;padding:0;list-style:none;color:var(--dsw-alias-label-tertiary,#8b8d93)}
.xd-points-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.xd-points-refresh{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b8d93);font:inherit;font-size:12px;padding:3px 8px;border-radius:999px;cursor:pointer}
.xd-points-refresh:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#e8e8ea)}
.xd-points-refresh:disabled{opacity:.5;cursor:default}
`;
		/**
		* Inject the readout's stylesheet once per document.
		*
		* Keyed on the tag's own data attribute so a plugin reload does not stack a
		* second copy, and guarded because the module is evaluated where a document may
		* not exist at all.
		*/
		function injectStyle() {
			if (typeof document === "undefined") return;
			const id = "dsh-wtq-pool/composer-points.css";
			if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset["plugin"] = "dsh-wtq-pool";
			tag.dataset["pluginCss"] = id;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		injectStyle();
		/**
		* The readout.
		*
		* Returns nothing at all - not a hidden node - while the switch is off or the
		* selected model is another plugin's. The row is shared, so the honest state is
		* to be absent from it.
		*/
		function ComposerPoints(props) {
			const t = (key) => {
				return (typeof document !== "undefined" && document.documentElement.lang.toLowerCase().startsWith("en") ? composerEn : composerZh)[key] ?? composerEn[key] ?? key;
			};
			const useProjection = props.useProjection;
			const selection = selectionOf(useProjection === void 0 ? void 0 : useProjection("modelSelection"));
			const provider = selection?.provider ?? "";
			const model = selection?.model ?? "";
			const route = provider + "\n" + model;
			const routeRef = react.useRef({ route });
			if (routeRef.current.route !== route) routeRef.current = { route };
			const [points, setPoints] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [refreshing, setRefreshing] = react.useState(false);
			const [open, setOpen] = react.useState(false);
			const [errorFor, setErrorFor] = react.useState("");
			const [error, setError] = react.useState("");
			const rootRef = react.useRef(null);
			const panelRef = react.useRef(null);
			const restartPollRef = react.useRef(() => {});
			react.useEffect(() => {
				if (provider === "" || model === "") {
					setPoints(null);
					return;
				}
				setPoints(null);
				let stopped = false;
				let timer = 0;
				let startedAt = Date.now();
				const schedule = (current) => {
					const ours = current !== null && current.ours === true;
					const settled = current !== null && typeof current.total === "number";
					const warming = ours && Date.now() - startedAt < WARMUP_WINDOW_MS;
					window.clearTimeout(timer);
					timer = window.setTimeout(pull, settled || !warming ? REFRESH_INTERVAL_MS : WARMUP_INTERVAL_MS);
				};
				const pull = () => {
					invoke("xd.composerPoints", {
						provider,
						model
					}).then((next) => {
						if (stopped) return;
						const shown = next.show === true ? next : null;
						setPoints(shown);
						schedule(next);
					}).catch(() => {
						if (stopped) return;
						setPoints(null);
						schedule(null);
					});
				};
				restartPollRef.current = () => {
					window.clearTimeout(timer);
					startedAt = Date.now();
					pull();
				};
				pull();
				return () => {
					stopped = true;
					window.clearTimeout(timer);
					restartPollRef.current = () => {};
				};
			}, [provider, model]);
			react.useEffect(() => {
				if (!open) return void 0;
				const onPointer = (event) => {
					const target = event.target;
					if (target === null) return;
					if (rootRef.current?.contains(target) === true) return;
					if (panelRef.current?.contains(target) === true) return;
					setOpen(false);
				};
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onPointer, true);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("pointerdown", onPointer, true);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);
			react.useEffect(() => {
				setOpen(false);
				setError("");
				setErrorFor("");
				setBusy(false);
				setRefreshing(false);
			}, [provider, model]);
			react.useEffect(() => {
				if (errorFor === "") return;
				if ((points?.accounts ?? []).find((account) => account.id === errorFor)?.active === true) {
					setError("");
					setErrorFor("");
				}
			}, [points, errorFor]);
			const balance = balanceOf(points);
			if (points === null) return null;
			const pick = (account) => {
				if (busy || account.active === true) return;
				const requestedRoute = routeRef.current;
				setBusy(true);
				setError("");
				invoke("xd.composerPrefer", {
					provider,
					model,
					source: points.source ?? "",
					region: points.region ?? "",
					accountId: account.id ?? "",
					accountLabel: account.label ?? ""
				}).then((next) => {
					if (routeRef.current !== requestedRoute) return;
					setBusy(false);
					if (next.saved !== true) {
						setError(t("composer.refused"));
						setErrorFor("");
						return;
					}
					if (next.show !== true) {
						setError(t("composer.saved"));
						setErrorFor(account.id ?? "");
						return;
					}
					setPoints(next);
					restartPollRef.current();
					if (next.unavailable === true) {
						setError(t("composer.unavailable"));
						setErrorFor(account.id ?? "");
						return;
					}
					setOpen(false);
				}).catch((failure) => {
					if (routeRef.current !== requestedRoute) return;
					setBusy(false);
					setError(failure instanceof Error ? failure.message : String(failure));
				});
			};
			const refresh = () => {
				if (refreshing || busy) return;
				const requestedRoute = routeRef.current;
				setRefreshing(true);
				setError("");
				invoke("xd.composerRefresh", {
					provider,
					model
				}).then((next) => {
					if (routeRef.current !== requestedRoute) return;
					setRefreshing(false);
					if (next.show === true) setPoints(next);
				}).catch((failure) => {
					if (routeRef.current !== requestedRoute) return;
					setRefreshing(false);
					setError(failure instanceof Error ? failure.message : String(failure));
				});
			};
			const accounts = Array.isArray(points.accounts) ? points.accounts : [];
			const rect = open && rootRef.current !== null ? rootRef.current.getBoundingClientRect() : null;
			return react.createElement("span", {
				className: "xd-points",
				ref: rootRef
			}, react.createElement("button", {
				type: "button",
				className: "xd-points-btn",
				title: t("composer.click"),
				"aria-expanded": open,
				onClick: () => setOpen((value) => !value)
			}, react.createElement("span", {
				className: "xd-points-mark",
				"aria-hidden": "true"
			}), balance === void 0 ? "—" : formatCredits(balance)), open && rect !== null ? react.createElement("div", {
				className: "xd-points-panel",
				ref: panelRef,
				role: "dialog",
				"aria-label": t("composer.title"),
				style: positionStyle(rect)
			}, react.createElement("div", { className: "xd-points-bar" }, react.createElement("span", null, t("composer.title")), react.createElement("button", {
				type: "button",
				className: "xd-points-refresh",
				disabled: refreshing || busy,
				onClick: refresh
			}, refreshing ? t("composer.refreshing") : t("composer.refresh"))), error === "" ? null : react.createElement("p", { role: "alert" }, error), busy ? react.createElement("p", null, t("composer.switching")) : null, react.createElement("table", { className: "xd-points-table" }, react.createElement("thead", null, react.createElement("tr", null, react.createElement("th", null, t("composer.account")), react.createElement("th", null, t("composer.balance")))), react.createElement("tbody", null, accounts.map((account, index) => react.createElement("tr", {
				key: account.id ?? account.label ?? String(index),
				className: "xd-points-row" + (account.active === true ? " is-active" : "")
			}, react.createElement("td", null, account.active === true ? react.createElement("span", {
				className: "xd-points-dot",
				"aria-hidden": "true"
			}) : null, react.createElement("button", {
				type: "button",
				className: "xd-points-btn",
				disabled: account.active === true || busy,
				onClick: () => pick(account)
			}, account.label ?? "—")), react.createElement("td", null, typeof account.total === "number" ? formatCredits(account.total) : account.plan ?? "—", points.source === "qoder" && Array.isArray(account.packages) ? react.createElement("ul", { className: "xd-points-packs" }, account.packages.map((pack, index) => react.createElement("li", { key: index }, packageText(pack, t)))) : null)))))) : null);
		}
		//#endregion
		//#region src/ids.ts
		/**
		* The two names this plugin is identified by.
		*
		* The client half has to key its Plugins-page entries with them, and the host
		* half has to register under the same row id: a keyed slot's key is
		* `<package name>#<loader row id>`, so a mismatch in either half silently costs
		* the plugin its Configure control. Keeping both literals here is what stops the
		* two halves from drifting apart.
		*
		* @module dsh-wtq-pool/ids
		*/
		/** The npm package name this plugin is published and installed under. */
		const PLUGIN_NAME = "dsh-wtq-pool";
		/**
		* The loader row id this plugin's own patch inserts.
		*
		* `cordis.patch.yml` inserts this id, the host reads it back to key the plugin's
		* row page, and the settings namespace is this same id - so the entry's settings
		* form and its client card address one another by it.
		*/
		const ROW_ID = "llm-dsh-xdpool";
		//#endregion
		//#region src/client/index.tsx
		/**
		* The card this plugin puts on the Plugins page.
		*
		* The card is deliberately thin: it frames the panel, and the panel itself is
		* the whole surface. A card that re-implemented the pool in React would be a
		* second surface to keep in step with the first, so the card owns text,
		* placement and the state a settings form needs - nothing else.
		*
		* @module dsh-wtq-pool/client
		*/
		const inject = ["slots", "locale"];
		/** The locale namespace this card's copy lives under. */
		const NAMESPACE = "settings.dsh-wtq-pool";
		const zh = {
			"row.title": "WTQ Pool",
			"row.desc": "把本机 WorkBuddy、Trae、Qoder 的桌面登录合并成一个会自动换号的模型池。",
			"card.title": "账号池",
			"card.hint": "下方是完整面板：账号、模型选择、签到与连接检查都在这一页里。",
			"card.open": "重新载入面板",
			"card.frameTitle": "账号池面板",
			"card.missing": "面板资源没有装好，重新安装这个插件即可。"
		};
		const en = {
			"row.title": "WTQ Pool",
			"row.desc": "Merges this machine’s WorkBuddy, Trae and Qoder desktop sign-ins into one model pool that fails over on its own.",
			"card.title": "Account pool",
			"card.hint": "The full panel sits below: accounts, model selection, check-in and the connection check are all on this page.",
			"card.open": "Reload panel",
			"card.frameTitle": "Account pool panel",
			"card.missing": "The panel assets are missing; reinstalling this plugin restores them."
		};
		/**
		* The embedded panel.
		*
		* of the Plugins page and the Plugins page's out of the panel: the panel was
		* written as a whole page, and the frame is the boundary that lets it stay one.
		*
		* The frame is only mounted for the full page. The row's inline summary is asked
		* for on the list itself, where a 70vh frame would be the wrong control
		* entirely - the host supplies `view` for exactly that distinction.
		*/
		function PanelCard({ t, view }) {
			const [generation, setGeneration] = react.useState(0);
			const frameRef = react.useRef(null);
			const appearance = react.useMemo(() => {
				if (typeof document === "undefined") return {
					base: "light",
					lang: "zh-CN"
				};
				const root = document.documentElement;
				return {
					base: root.dataset["base"] === "dark" || root.dataset["base"] === void 0 && typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true ? "dark" : "light",
					lang: root.lang === "" ? "zh-CN" : root.lang
				};
			}, [generation]);
			if (view === "summary") return react.createElement("p", { style: SUMMARY_STYLE }, t("row.desc"));
			return react.createElement("section", { style: CARD_STYLE }, react.createElement("header", { style: HEAD_STYLE }, react.createElement("div", null, react.createElement("strong", null, t("card.title")), react.createElement("p", { style: HINT_STYLE }, t("card.hint"))), react.createElement("button", {
				type: "button",
				style: BUTTON_STYLE,
				onClick: () => {
					setGeneration((value) => value + 1);
					const frame = frameRef.current;
					if (frame !== null) frame.src = panelUrl(appearance);
				}
			}, t("card.open"))), react.createElement("iframe", {
				key: generation,
				ref: frameRef,
				title: t("card.frameTitle"),
				src: panelUrl(appearance),
				style: FRAME_STYLE
			}));
		}
		const SUMMARY_STYLE = {
			margin: 0,
			opacity: .75,
			fontSize: 13
		};
		const CARD_STYLE = {
			display: "flex",
			flexDirection: "column",
			gap: 12
		};
		const HEAD_STYLE = {
			display: "flex",
			alignItems: "flex-start",
			justifyContent: "space-between",
			gap: 12
		};
		const HINT_STYLE = {
			margin: "4px 0 0",
			opacity: .7,
			fontSize: 12
		};
		const BUTTON_STYLE = {
			flex: "0 0 auto",
			cursor: "pointer"
		};
		const FRAME_STYLE = {
			width: "100%",
			height: "72vh",
			minHeight: 460,
			border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))",
			borderRadius: 10,
			background: "transparent"
		};
		/**
		* Register the card on the Plugins page.
		*
		* Two seats, because the host keys them differently and shows them in different
		* places: the bundle page (opened from the plugin's own card) keys on the
		* package name, and the row page (the "Configure" control beside the plugin's
		* loader row) keys on `<package name>#<row id>`. Registering both is what puts
		* the panel where the plugin is configured rather than in the generic settings
		* list.
		*
		* Every step is guarded: a slot this host line does not declare must cost the
		* card, not the provider. The host services keep serving either way.
		*/
		function apply(ctx) {
			try {
				ctx.effect(() => ctx.locale.register(NAMESPACE, {
					zh: {
						...zh,
						...composerZh
					},
					en: {
						...en,
						...composerEn
					}
				}), "dsh-wtq-pool: copy");
				ctx.locale.bind(NAMESPACE);
			} catch (error) {
				console.error("[dsh-wtq-pool] the copy did not register (the labels fall back to their keys):", error);
			}
			try {
				const seat = (slotName, key) => {
					try {
						ctx.slots.inject(slotName, () => ctx.slots.register({
							name: slotName,
							key,
							locale: NAMESPACE
						}, PanelCard));
					} catch (error) {
						console.error(`[dsh-wtq-pool] the card did not mount into ${slotName} (the providers are unaffected):`, error);
					}
				};
				seat("plugins.bundle.config", PLUGIN_NAME);
				seat("plugins.row.config", `${PLUGIN_NAME}#${ROW_ID}`);
				try {
					ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
						name: "conversation.input.left",
						id: COMPOSER_SLOT_ID,
						order: 4
					}, ComposerPoints));
				} catch (error) {
					console.error("[dsh-wtq-pool] the composer readout did not mount (the providers are unaffected):", error);
				}
			} catch (error) {
				console.error("[dsh-wtq-pool] the cards did not mount (the providers are unaffected):", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
