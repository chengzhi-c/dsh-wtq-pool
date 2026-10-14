import * as path from "node:path";
import { basename, dirname, join, resolve } from "node:path";
import * as os from "node:os";
import { cpus, homedir, hostname, release } from "node:os";
import * as fs from "node:fs/promises";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as piAi from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import z from "@deepseek-ai/schemastery";
import * as net from "node:net";
import { isIP } from "node:net";
import * as fs$1 from "node:fs";
import { existsSync } from "node:fs";
import { constants, createCipheriv, createDecipheriv, createHash, publicEncrypt, randomUUID } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { Readable } from "node:stream";
//#region src/pi-compat.ts
let bridge = {};
/** Install the host bridge. Called once, before the core's `onLoad`. */
function installPi(next) {
	bridge = next;
}
/** Report a host without this capability: an optional member is a refusal. */
function absent() {
	throw new Error("this host does not expose that capability");
}
/**
* The object the core is written against.
*
* Methods forward to {@link installPi}'s bridge. A capability the host does not
* provide throws rather than silently succeeding, so the core's own error
* handling decides what a missing capability means at that call site - and its
* call sites already wrap these in try/catch.
*/
const pi = {
	plugin: {
		getSettings: () => {
			if (bridge.getSettings === void 0) return Promise.reject(/* @__PURE__ */ new Error("no settings service"));
			return Promise.resolve(bridge.getSettings());
		},
		setSettings: async (patch) => {
			if (bridge.setSettings === void 0) absent();
			await bridge.setSettings(patch);
		},
		getDataPath: async () => {
			if (bridge.getDataPath === void 0) absent();
			return await bridge.getDataPath();
		}
	},
	events: {
		on: (name, handler) => {
			if (name === "plugin:settingsChanged" && bridge.onSettingsChanged !== void 0) {
				bridge.onSettingsChanged(handler);
				return;
			}
			absent();
		},
		off: (name, handler) => {
			if (name === "plugin:settingsChanged" && bridge.offSettingsChanged !== void 0) {
				bridge.offSettingsChanged(handler);
				return;
			}
			absent();
		}
	},
	commands: {
		register: async (spec) => {
			if (bridge.registerCommand === void 0) absent();
			await bridge.registerCommand(spec);
		},
		unregister: async (id) => {
			if (bridge.unregisterCommand === void 0) absent();
			await bridge.unregisterCommand(id);
		}
	},
	ui: {
		showToast: async (text, kind) => {
			if (bridge.notify === void 0) return;
			await bridge.notify(text, kind === "warn" ? "warn" : "info");
		},
		openPanel: async () => {
			if (bridge.openPanel === void 0) absent();
			await bridge.openPanel();
		}
	},
	services: { 
	/**
	* The core registers one background service whose `start` brings every
	* gateway up. Cordis has no second lifecycle stage to hang that on, so the
	* start hook is stashed here for the entry to run itself; `stop` is what the
	* entry's cleanup calls.
	*/
register: (service) => {
		serviceStart = service.start;
		serviceStop = service.stop;
	} },
	/**
	* Publish provider rows.
	*
	* The host registers providers at runtime rather than reading them from a
	* file, so the callers see the same argument and the same result shape with
	* nothing to reconcile on disk.
	*/
	declareProviders: (descriptors) => {
		if (bridge.declareProviders === void 0) return {
			ok: false,
			changed: false,
			error: "no provider channel"
		};
		return bridge.declareProviders(descriptors);
	}
};
let serviceStart;
let serviceStop;
/** Run the single service the core registered, if it did. */
async function startRegisteredService() {
	if (serviceStart !== void 0) await serviceStart();
}
/** Stop the single service the core registered, if it did. */
async function stopRegisteredService() {
	if (serviceStop !== void 0) await serviceStop();
}
//#endregion
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
//#region src/loopback.ts
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** Strip the port, and unwrap an IPv6 bracket, so only the host name remains. */
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/**
* Host must name loopback.
*
* Used by the gateway handlers. The panel routes rely on the peer and Origin
* checks instead: a browser that could reach the panel is already same-origin
* loopback, so a forged Host adds nothing there.
*/
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/** A present Origin must be loopback; non-browser clients send none and pass. */
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
/** Chat POSTs must carry a JSON body type (blocks simple-request CSRF). */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
/**
* Whether a chat request's bearer may reach the gateway.
*
* These endpoints are registered with `authKind: 'none'`, so the host sends no
* `Authorization` header at all or echoes the sentinel
* `Bearer dsh-no-auth`. A provider row the user added by hand — which is
* how a reasoning menu can be attached to these models at all, because the
* host discards `thinkingLevels` from a plugin declaration — is created as
* `api_key_and_base_url` and therefore always sends `Bearer <its own key>`.
* Refusing that shape would leave the workaround with a 401.
*
* The header is not a credential for this endpoint: the real token comes from
* the pool. The loopback bind and the Host / Origin guards are what bound it.
*/
function bearerAccepted(req) {
	const header = req.headers.authorization;
	if (typeof header !== "string") return true;
	return /^Bearer\s+(.+)$/i.test(header.trim());
}
function writeJson$1(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** The error shape every OpenAI-compatible client expects. */
function writeOpenAIError(res, status, kind, message) {
	writeJson$1(res, status, { error: {
		message: redactSecrets(message),
		type: kind,
		code: kind
	} });
}
/**
* Credential shapes in any text that leaves this process.
*
* The log path redacts these in the host entry; this is the client path, which runs
* before anything reaches a log and so had no redaction at all. An upstream that
* quotes the request it was sent — Trae's 401 echoes the `Cloud-IDE-JWT` header —
* put a live token in the response body the caller reads.
*
* Both shapes an echo actually takes are covered: the header form, with whatever
* scheme the vendor uses (`Bearer COSY.…` for Qoder, `Cloud-IDE-JWT …`,
* `X-Cloudide-Token …` and `X-Ide-Token …` for Trae, `X-Refresh-Token:` for
* WorkBuddy), and the field form, in the camelCase spelling this plugin itself
* sends and parses (`accessToken`, `refreshToken`) as well as the snake_case
* one a query string carries. The three-part JWT needs no key at all: it is
* recognisable on its own, and the opaque prefixes are Qoder's own.
*
* Trae's tokens are opaque, not JWTs, so only the scheme rules cover them -
* which is why every header name the plugin itself sends is listed there. A
* space-separated echo of one the list missed printed the whole credential.
*/
const REDACTIONS = [
	[/\b(Bearer|Cosy-Key|Cloud-IDE-JWT|X-Cloudide-Token|X-Ide-Token|X-Refresh-Token|X-Api-Key)\b([\s:="'\\]{1,6})[A-Za-z0-9_+/.=~-]{8,}/gi, "$1$2[redacted]"],
	[/\beyJ[A-Za-z0-9_+/.=-]+(?:\.[A-Za-z0-9_+/.=-]+){0,2}/g, "[redacted token]"],
	[/\b(qoder-oauth-token-)[A-Za-z0-9_+/.=-]+/g, "$1[redacted]"],
	[/\b(rt_)[A-Za-z0-9_+/.=-]+/g, "$1[redacted]"],
	[/((?:\\{0,2}["']?)(?:access_?token|refresh_?token|id_?token|auth_?token|oauth_?token|api_?key|secret|token)(?:\\{0,2}["']?\s*[:=]\s*\\{0,2}["']?))(?=[A-Za-z0-9_+/.=-]{6,})(?=[A-Za-z0-9_+/.=-]*[A-Za-z_-])[A-Za-z0-9_+/.=-]+/gi, "$1[redacted]"],
	[/\b[A-Za-z]:[\\/][^\r\n"'<>|]*/g, "[redacted path]"],
	[/\\\\[^\r\n"'<>|]+/g, "[redacted path]"],
	[/(['"])(\/(?!\/)[^'"\r\n]+)\1/g, "$1[redacted path]$1"]
];
/**
* Strip credential shapes out of text bound for a client.
*
* Applied at the one place every gateway error passes through, so a new caller
* cannot introduce a second unredacted path.
*/
function redactSecrets(text) {
	let out = typeof text === "string" ? text : String(text);
	for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
	return out;
}
/**
* Models a discovery answer may name.
*
* The host rebuilds the picker from `GET /v1/models`, so these ids are the
* ones the manifest publishes. An empty publication falls back to the
* directory: an empty discovery answer makes the host drop the provider.
*/
function listedModels(directory, listedIds) {
	if (listedIds.length === 0) return directory;
	const allowed = new Set(listedIds);
	const picked = directory.filter((model) => allowed.has(model.id));
	return picked.length > 0 ? picked : directory;
}
/** The largest chat body a gateway will buffer before refusing the request. */
const REQUEST_BODY_LIMIT = 67108864;
/** Raised when a request body passes {@link REQUEST_BODY_LIMIT}. */
var BodyTooLargeError = class extends Error {};
/**
* Buffer one request body, refusing anything past {@link REQUEST_BODY_LIMIT}.
*
* A body that arrives in pieces is counted as it arrives, so an endless upload
* is cut off by size rather than by the client finishing it. Live here for the
* same reason as the guards above: three gateways each reading their own limit
* is three limits to keep in step.
*
* The rejection carries the reason through to the caller so the answer is a
* 413 the client can act on, not a 500 that reads as a bug in this plugin.
*/
function readRequestBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(new BodyTooLargeError("request body too large"));
				setImmediate(() => {
					if (!req.destroyed) req.destroy();
				});
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
/**
* Answer one request, absorbing everything the handler can throw.
*
* A gateway hands work to a socket the other side may hang up on at any
* moment — the host's own fetch times out, the user cancels a stream, a panel
* refresh is abandoned. Node reports that as an `error` event on the response,
* and an `error` event with no listener throws inside the process: in a plugin
* subprocess that is a dead plugin. So the sink is installed in one place,
* beside the loopback guards it belongs with, rather than in three gateways.
*/
async function answerRequest(res, handle, log) {
	res.on("error", (error) => {
		log?.warn?.("dsh-wtq-pool: response socket closed mid-write", error);
	});
	try {
		await handle();
	} catch (error) {
		log?.warn?.("dsh-wtq-pool: request failed", error);
		try {
			if (!res.headersSent) {
				if (error instanceof BodyTooLargeError) {
					writeOpenAIError(res, 413, "request_too_large", String(error.message));
					return;
				}
				writeOpenAIError(res, 500, "internal", String(error));
			} else res.end();
		} catch (writeError) {
			log?.warn?.("dsh-wtq-pool: could not answer a failed request", writeError);
		}
	}
}
/**
* Apply the three request guards, answering the refusal itself.
*
* Answers `true` when the request may be routed and `false` once a refusal has
* been written, so a gateway's `handle` reads as "guarded, then routed". The
* refusals live here for the same reason the predicates do: three gateways
* spelling out 403/403/401 is three chances to answer a different status, and
* the Host and Origin refusals have no caller of their own to test them.
*/
function guardsPass(req, res) {
	if (!hostIsLoopback(req.headers.host)) {
		writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
		return false;
	}
	if (!originIsLoopback(req.headers.origin)) {
		writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
		return false;
	}
	if (!bearerAccepted(req)) {
		writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
		return false;
	}
	return true;
}
//#endregion
//#region src/web-panel.ts
/**
* The channels the panel bridge serves.
*
* Every channel the panel or the composer readout asks for has to appear in one
* of these, or it is refused. The split is by effect, not by caller: a read-only
* channel may be polled, a mutating one may not, and the appearance channel the
* page asks for is answered here without reaching the plugin.
*/
const READ_ONLY_CHANNELS = /* @__PURE__ */ new Set(["xd.state", "xd.composerPoints"]);
/** The channels that change state; a polled read cannot reach these. */
const MUTATING_CHANNELS = /* @__PURE__ */ new Set([
	"xd.composerPrefer",
	"xd.composerRefresh",
	"xd.checkin",
	"xd.checkinAll",
	"xd.doctor",
	"xd.preferAccount",
	"xd.preferSourceAccount",
	"xd.rescan",
	"xd.resetCooldowns",
	"xd.runCheckinNow",
	"xd.saveModels",
	"xd.setAccountState",
	"xd.distribution",
	"xd.setAutoCheckin",
	"xd.setComposerPoints",
	"xd.setCreditReserve",
	"xd.setRegionEnabled",
	"xd.setSource",
	"xd.sourceCheckin",
	"xd.sourceDistribution"
]);
/** Largest panel request body accepted, so a hung or oversized body cannot pin memory. */
const MAX_BODY_BYTES = 65536;
function peerIsLoopback(req) {
	const address = req.socket.remoteAddress;
	if (address === void 0) return false;
	if (isIP(address) === 4) return address.startsWith("127.");
	if (isIP(address) !== 6) return false;
	try {
		const host = new URL(`http://[${address}]`).hostname;
		return host === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
	} catch {
		return false;
	}
}
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		"Cache-Control": "no-store"
	});
	res.end(payload);
}
/**
* The message as the panel shows it: redacted and bounded.
*
* An upstream that echoes the request it was sent puts a live credential in the
* text its client throws with, and this is the path that text leaves by - the
* same reason `host.ts` redacts the copy it reports.
*/
function safeMessage$1(error) {
	return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500);
}
/** Read a bounded JSON body; an empty or malformed body reads as `{}`. */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let settled = false;
		const fail = (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				fail(Object.assign(/* @__PURE__ */ new Error("request body too large"), { code: "BODY_TOO_LARGE" }));
				return;
			}
			chunks.push(chunk);
		});
		req.on("error", fail);
		req.on("end", () => {
			if (settled) return;
			settled = true;
			const raw = Buffer.concat(chunks).toString("utf8");
			if (raw.trim() === "") {
				resolve({});
				return;
			}
			try {
				const parsed = JSON.parse(raw);
				resolve(parsed !== null && typeof parsed === "object" ? parsed : {});
			} catch {
				resolve({});
			}
		});
	});
}
/** Answer with one file's bytes, uncached so an edited asset is picked up. */
function sendFile(res, file, type) {
	const body = fs$1.readFileSync(file);
	res.writeHead(200, {
		"Content-Type": type,
		"Content-Length": body.length,
		"Cache-Control": "no-store"
	});
	res.end(body);
}
/**
* Resolve one panel asset inside this package.
*
* The resolved path is proved to stay under `renderer/`, so a crafted request
* cannot read a file elsewhere in the package or on disk.
*/
function panelAsset(pluginRoot, name) {
	if (!/^[A-Za-z0-9._-]+$/.test(name)) return void 0;
	const dir = path.join(pluginRoot, "renderer");
	const full = path.join(dir, name);
	if (!full.startsWith(dir + path.sep)) return void 0;
	return fs$1.existsSync(full) ? full : void 0;
}
/**
* The panel page.
*
* The markup is this package's own `renderer/index.html`, with two changes:
* the host-chrome metas it carried in its previous embedding are dropped, and
* the bridge that talks to this plugin is injected ahead of its own script. The
* panel therefore stays one page with one host dependency, and nothing about
* its markup is duplicated here.
*/
function panelHtml(pluginRoot, base, lang) {
	const file = panelAsset(pluginRoot, "index.html");
	if (file === void 0) return void 0;
	const safeBase = base === "dark" ? "dark" : "light";
	const safeLang = lang.toLowerCase().startsWith("en") ? "en" : "zh-CN";
	const bridge = `<script>
/*
 * The panel's one host dependency. Every channel it asks for is answered by
 * this plugin's own core over the same origin, so the page needs no host API
 * of its own and works unchanged in either embedding.
 */
document.documentElement.dataset.base = ${JSON.stringify(safeBase)};
window.pluginBridge = {
  invoke: function (channel, payload) {
    return fetch(${JSON.stringify(PANEL_BASE + "/invoke")}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        channel: channel,
        payload: payload || {},
        base: ${JSON.stringify(safeBase)},
        lang: ${JSON.stringify(safeLang)}
      })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (response.ok) return body && 'result' in body ? body.result : body;
        throw new Error((body && body.error) || ('HTTP ' + response.status));
      });
    });
  },
  // This host gives the page no event channel; the panel's own poll keeps it
  // current, which is why this listener is an accepted no-op.
  on: function () { return function () {}; }
};
<\/script>`;
	return fs$1.readFileSync(file, "utf8").replace(/\s*<meta name="pi-plugin-chrome"[^>]*>/i, "").replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i, "").replace("</head>", `${bridge}\n</head>`);
}
function registerPanelRoutes(ctx, deps) {
	try {
		deps.effect(() => {
			const disposers = [];
			const release = () => {
				for (const dispose of disposers) try {
					dispose();
				} catch (error) {
					deps.logger.warn?.("dsh-wtq-pool: a panel route did not release cleanly", error);
				}
			};
			const mount = (route) => {
				disposers.push(ctx.webServer.register(route));
			};
			try {
				mount({
					kind: "exact",
					path: `${PANEL_BASE}/panel`,
					handler: (req, res) => {
						if (!peerIsLoopback(req)) return writeJson(res, 403, { error: "peer-not-loopback" });
						if (req.method !== "GET") return writeJson(res, 405, { error: "method not allowed" });
						if (!originIsLoopback(req.headers.origin)) return writeJson(res, 403, { error: "origin-not-trusted" });
						const url = new URL(req.url ?? "/", "http://localhost");
						const body = panelHtml(deps.pluginRoot, url.searchParams.get("base") ?? "light", url.searchParams.get("lang") ?? "zh-CN");
						if (body === void 0) return writeJson(res, 404, { error: "missing renderer/index.html" });
						res.writeHead(200, {
							"Content-Type": "text/html; charset=utf-8",
							"Content-Length": Buffer.byteLength(body),
							"Cache-Control": "no-store"
						});
						res.end(body);
					}
				});
				mount({
					kind: "exact",
					path: `${PANEL_BASE}/panel.css`,
					handler: (req, res) => {
						if (!peerIsLoopback(req)) return writeJson(res, 403, { error: "peer-not-loopback" });
						if (req.method !== "GET") return writeJson(res, 405, { error: "method not allowed" });
						if (!originIsLoopback(req.headers.origin)) return writeJson(res, 403, { error: "origin-not-trusted" });
						const file = panelAsset(deps.pluginRoot, "panel.css");
						if (file === void 0) return writeJson(res, 404, { error: "missing panel.css" });
						sendFile(res, file, "text/css; charset=utf-8");
					}
				});
				mount({
					kind: "exact",
					path: `${PANEL_BASE}/panel.js`,
					handler: (req, res) => {
						if (!peerIsLoopback(req)) return writeJson(res, 403, { error: "peer-not-loopback" });
						if (req.method !== "GET") return writeJson(res, 405, { error: "method not allowed" });
						if (!originIsLoopback(req.headers.origin)) return writeJson(res, 403, { error: "origin-not-trusted" });
						const file = panelAsset(deps.pluginRoot, "panel.js");
						if (file === void 0) return writeJson(res, 404, { error: "missing panel.js" });
						sendFile(res, file, "text/javascript; charset=utf-8");
					}
				});
				mount({
					kind: "exact",
					path: `${PANEL_BASE}/invoke`,
					handler: async (req, res) => {
						if (!peerIsLoopback(req)) return writeJson(res, 403, { error: "peer-not-loopback" });
						if (req.method !== "POST") return writeJson(res, 405, { error: "method not allowed" });
						if (!originIsLoopback(req.headers.origin)) return writeJson(res, 403, { error: "origin-not-trusted" });
						try {
							const body = await readJsonBody(req);
							const channel = typeof body["channel"] === "string" ? body["channel"] : "";
							if (channel === "") return writeJson(res, 400, { error: "channel is required" });
							if (channel === "app.getAppearance") return writeJson(res, 200, { result: {
								base: body["base"] === "dark" ? "dark" : "light",
								locale: typeof body["lang"] === "string" ? body["lang"] : "zh-CN"
							} });
							if (!channel.startsWith("xd.")) return writeJson(res, 400, { error: `unsupported channel: ${channel}` });
							if (READ_ONLY_CHANNELS.has(channel) === false && MUTATING_CHANNELS.has(channel) === false) return writeJson(res, 400, { error: `unsupported channel: ${channel}` });
							const payload = body["payload"] !== null && typeof body["payload"] === "object" ? body["payload"] : {};
							const result = await deps.invoke(channel, payload);
							writeJson(res, 200, { result: result === void 0 ? null : result });
						} catch (error) {
							if (error.code === "BODY_TOO_LARGE") {
								writeJson(res, 413, { error: safeMessage$1(error) });
								return;
							}
							writeJson(res, 500, { error: safeMessage$1(error) });
						}
					}
				});
			} catch (error) {
				release();
				throw error;
			}
			return release;
		});
	} catch (error) {
		deps.logger.warn?.("dsh-wtq-pool: the panel routes could not be mounted", error);
	}
}
//#endregion
//#region src/ids.ts
/**
* The loader row id this plugin's own patch inserts.
*
* `cordis.patch.yml` inserts this id, the host reads it back to key the plugin's
* row page, and the settings namespace is this same id - so the entry's settings
* form and its client card address one another by it.
*/
const ROW_ID = "llm-dsh-xdpool";
//#endregion
//#region package.json
var version = "1.0.2";
//#endregion
//#region src/upstream.ts
/**
* WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client.
*
* 参考：corrinehu/dsh-workbuddy-connect（MIT, Copyright (c) 2026 Corrine Hu）
*       dingminhua/dsh-connect-workbuddy（MIT, Copyright (c) 2026 LaoDing）
*   — 端点与 wire behavior（按 domain 选 CN/global base、/v2 路径、强制
*     stream:true、tool_choice 压平为字符串、chat 请求绝不携带 refresh
*     token 的安全红线、developer→system role 转换、刷新走独立
*     X-Refresh-Token 头、错误分类、积分按套餐聚合）经 dingminhua 实测
*     验证，此处沿用并适配本插件的凭据接口与多账户池。
*
* @module dsh-wtq-pool/upstream
*/
/**
* True when adopting the first buddy was refused for an unmet conversation
* threshold. Expected, not an account problem: the caller records the day and
* retries tomorrow instead of hammering the upstream.
*/
function isBuddyThresholdIncomplete(message) {
	return typeof message === "string" && message.toLowerCase().includes("first_buddy task not completed yet");
}
/** CN chat base per dingminhua's on-machine probe (HTTP 200 for chat/models). */
const CN_CHAT_BASE = "https://copilot.tencent.com";
/** Billing/console base — `www.codebuddy.cn` is the billing origin. */
const CN_BILLING_BASE = "https://www.codebuddy.cn";
/** Global base for `workbuddy.ai` logins. */
const GLOBAL_BASE = "https://www.workbuddy.ai";
/** Chat UA: the official desktop client's three-segment spelling. */
const CLIENT_UA = "WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1";
/**
* Desktop app UA. The global gateway serves its product config only to this
* client channel: the CLI UA gets a truncated roster (or an HTTP 500), which
* is why the international catalog must be read with the desktop spelling.
*/
const DESKTOP_UA = "WorkBuddy/5.5.2";
/** CN model catalog. */
const MODELS_CATALOG_PATH = "/v2/enterprises/personal/models";
/** Global product config, which carries the international model roster. */
const GLOBAL_CONFIG_PATH = "/v3/config";
const JSON_TIMEOUT_MS = 3e4;
const ERROR_BODY_LIMIT = 4096;
/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
	"insufficient credit",
	"no credit",
	"credit exhausted",
	"out of credit",
	"quota exceeded",
	"quota exhaust",
	"payment required",
	"credit not enough",
	"not enough credit",
	"积分不足",
	"额度不足",
	"余额不足",
	"积分用完",
	"额度用尽",
	"没有积分"
];
/**
* Session-invalidation markers that mean "sign in again in the WorkBuddy app".
*
* `12153` is matched as an envelope value, not as a bare substring: a plain
* `12153` turns up inside ids and timestamps, and on a rate-limited body it
* would reclassify a cooldown as a dead session - which rotates without ever
* cooling the account, so the same limited account is hit on every attempt.
*/
const SESSION_DEAD_PATTERN = /Offline user session not found|"code"\s*:\s*"?12153\b/u;
/**
* Hosts the international product answers on, once each has been stripped of a
* leading label. The WorkBuddy AI desktop app signs in at `workbuddy.ai` (and
* the desktop client itself lists `workbuddy.cc` alongside it); the CodeBuddy
* CLI signs the same international account in at `codebuddy.ai`. All are served
* by one gateway stack, so all are `global` — missing a spelling sends those
* tokens to the CN gateway, which rejects them at the openresty layer with an
* HTML 401 instead of a business JSON error.
*/
const GLOBAL_HOSTS = [
	"workbuddy.ai",
	"workbuddy.cc",
	"codebuddy.ai"
];
/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
function regionOf(domain) {
	const lowered = domain.trim().toLowerCase();
	for (const host of GLOBAL_HOSTS) if (lowered === host || lowered.endsWith(`.${host}`)) return "global";
	return "cn";
}
/**
* Gateway for a global credential.
*
* International accounts are NOT interchangeable across brand domains: a token
* issued at `codebuddy.ai` is rejected by the `workbuddy.ai` gateway and vice
* versa, so the base must follow the credential's own domain rather than one
* hardcoded host. Anything unrecognised falls back to the desktop app's gateway.
*/
function globalBase(credential) {
	const lowered = credential.domain.trim().toLowerCase();
	if (lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")) return "https://www.codebuddy.ai";
	return GLOBAL_BASE;
}
function chatBase(credential) {
	return regionOf(credential.domain) === "global" ? globalBase(credential) : CN_CHAT_BASE;
}
function billingBase(credential) {
	return regionOf(credential.domain) === "global" ? globalBase(credential) : CN_BILLING_BASE;
}
/** Headers every upstream request shares. */
function commonHeaders(credential) {
	return {
		"Accept": "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		"Origin": billingBase(credential),
		"Referer": `${billingBase(credential)}/`,
		"User-Agent": CLIENT_UA,
		"X-CodeBuddy-Request": "1"
	};
}
/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential) {
	return {
		...commonHeaders(credential),
		"Content-Type": "application/json",
		"Authorization": `Bearer ${credential.accessToken}`,
		...credential.uid === "" || credential.uid === void 0 ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid },
		...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? { "X-No-Enterprise-Id": "1" } : { "X-Enterprise-Id": credential.enterpriseId },
		...credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain },
		"X-Product": "SaaS"
	};
}
/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential) {
	const headers = {
		...commonHeaders(credential),
		"X-Refresh-Token": credential.refreshToken,
		"X-Auth-Refresh-Source": "workbuddy"
	};
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") headers["X-Enterprise-Id"] = credential.enterpriseId;
	return headers;
}
/** Billing request headers. */
function billingHeaders(credential) {
	const headers = {
		"Authorization": `Bearer ${credential.accessToken}`,
		"Accept": "application/json",
		"Content-Type": "application/json",
		"X-CodeBuddy-Request": "1"
	};
	if (credential.uid !== "" && credential.uid !== void 0) headers["X-User-Id"] = credential.uid;
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
		headers["X-Enterprise-Id"] = credential.enterpriseId;
		headers["X-Tenant-Id"] = credential.enterpriseId;
	}
	if (credential.domain !== "") headers["X-Domain"] = credential.domain;
	return headers;
}
/**
* Gateway denials that arrive as an HTML page rather than a JSON envelope.
*
* openresty / APISIX reject a request before it reaches the product when the
* credential is one the gateway no longer honours — most often a stale sign-in
* left in the auth directory. The status alone (401) is not actionable and the
* HTML body leaks nothing useful, so this turns it into a sentence the user can
* act on.
*/
function isGatewayHtmlRejection(status, text) {
	if (status !== 401 && status !== 403) return false;
	const head = text.slice(0, 512).toLowerCase();
	return head.includes("<html") || head.includes("openresty") || head.includes("apisix");
}
async function readEnvelope(response) {
	const text = await response.text();
	if (isGatewayHtmlRejection(response.status, text)) throw new Error(`the WorkBuddy gateway rejected this credential (http ${response.status}). This usually means the account is using a stale sign-in the upstream no longer accepts: sign in again in the WorkBuddy desktop app, then pick the account on the plugin card. Run the WTQ Pool connection check (the command palette entry, or the panel's connection tab) to list every credential found.`);
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${redactSecrets(text).slice(0, 160)}`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`);
	const document = parsed;
	return {
		code: typeof document["code"] === "number" ? document["code"] : 0,
		msg: typeof document["msg"] === "string" ? document["msg"] : "",
		data: "data" in document ? document["data"] : void 0
	};
}
/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status, envelope) {
	const kind = classifyUpstreamError(status, envelope.msg);
	return /* @__PURE__ */ new Error(`workbuddy upstream ${kind} (http ${status}): ${redactSecrets(envelope.msg).slice(0, 160)}`);
}
/**
* Classify an upstream failure from its HTTP status and body excerpt.
*
* A body marker only refines a status that has not already said something
* more specific. When the status is about the sign-in, the only thing that may
* reclassify it is a session marker - otherwise a 401 quoting "quota exceeded"
* reads as a billing failure, which answers 402 and skips the token refresh.
* And a session marker never fires on any other status, or a rate limit whose
* text happens to carry the code would rotate without cooling the account.
*/
function classifyUpstreamError(status, body) {
	if (status === 402) return "hard_credit";
	const aboutSignIn = status === 401 || status === 403;
	if (aboutSignIn && SESSION_DEAD_PATTERN.test(body)) return "session_dead";
	if (!aboutSignIn) {
		const lower = body.toLowerCase();
		for (const marker of HARD_CREDIT_MARKERS) if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
		if (SESSION_DEAD_PATTERN.test(body)) return "session_dead";
	}
	if (status === 429) return "soft_rate";
	if (body.includes("soft_rate") || body.includes("\"code\":6004") || body.includes("频率限制")) return "soft_rate";
	if (status === 403 && !body.includes("\"code\":") && !body.includes("\"msg\":")) return "waf_block";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	return "client";
}
/**
* Parse the reset time the upstream reports for a rate limit, when present.
* Recognises an epoch-millisecond field and the Chinese-localised sentence
* form, so the pool can resume exactly when the window reopens.
*
* The localised form is a Beijing wall clock with no zone on it, so it is read
* as UTC+8 rather than as whatever the host machine is set to. Parsing it as
* local time puts the reset 13 hours out on a US host — the account stays out
* of rotation all day — and 3 hours early in Sydney, where it comes back while
* still limited and the request rotates again. China has had no DST since
* 1991, so the fixed offset is exact and needs no timezone dependency.
*/
const UPSTREAM_CLOCK_OFFSET_MS = 288e5;
/**
* Longest a parsed reset may push an account out of rotation. The upstream's
* own soft-cooldown ceiling is 2h; anything beyond that is a stale or
* mis-parsed timestamp, and sleeping a whole day on it is worse than coming
* back early to a still-limited account (the next 429 re-cools it anyway).
*/
const RATE_RESET_CAP_MS = 72e5;
/** Clamp a parsed reset into [now, now + cap]; the past stays past. */
function capRateReset(value) {
	const now = Date.now();
	if (value <= now) return value;
	return Math.min(value, now + RATE_RESET_CAP_MS);
}
function parseRateLimitReset(body) {
	const epochMs = /"(?:resetAt|reset_at|resetTime|reset_time)"\s*:\s*(\d{13})/.exec(body);
	if (epochMs !== null) return capRateReset(Number(epochMs[1]));
	const localized = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/.exec(body);
	if (localized !== null) {
		const asUtc = Date.parse(localized[1].replace(" ", "T") + "Z");
		if (!Number.isNaN(asUtc)) return capRateReset(asUtc - UPSTREAM_CLOCK_OFFSET_MS);
	}
}
/** Parse the upstream's `credits` string into a multiplier. */
function parseCreditMultiplier(value) {
	if (typeof value !== "string") return void 0;
	const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value);
	if (match === null) return void 0;
	const parsed = Number(match[1]);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : void 0;
}
/**
* The effort ladder the upstream's plural-form payloads declare across both
* gateways (the live union of every `supportedEfforts` list seen; `minimal` has
* never appeared). Both gateways also accept every level of it on
* singular-form models — medium/xhigh fold into high, low/max answer with their
* own budgets — so a singular `effort` value is a DEFAULT, never the model's
* only level.
*/
const SINGULAR_EFFORT_LADDER = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/**
* True when `reasoning` arrives in the singular spelling: an `effort` string,
* with none of the plural-form fields alongside it. Seen on CN
* `deepseek-v4.1-flash` / `kimi-k3-1` / `glm-5.2` and global
* `deepseek-v4.1-flash` / `kimi-k3` / `gemini-3.5-flash`.
*/
function isSingularEffortForm(raw) {
	return typeof raw["effort"] === "string" && !Array.isArray(raw["supportedEfforts"]) && typeof raw["defaultEffort"] !== "string" && typeof raw["canDisableThinking"] !== "boolean";
}
/**
* Fold a singular-form `effort` into the plural shape the rest of the plugin
* already understands. Probes on both gateways show these models answer with
* distinct `reasoning_content` across the whole ladder — and do not think at
* all when no `reasoning_effort` is sent — so the fold widens
* `supportedEfforts` and carries the declared value into `defaultEffort`. An
* unrecognized `effort` passes through as the lone level.
*/
function singularEffortLadder(raw) {
	const effort = typeof raw["effort"] === "string" ? raw["effort"] : void 0;
	if (effort === void 0) return void 0;
	return SINGULAR_EFFORT_LADDER.includes(effort) ? [...SINGULAR_EFFORT_LADDER] : [effort];
}
/**
* Parse the upstream's `reasoning` object; unknown shapes degrade to
* `undefined`. Both spellings normalize here: the plural form passes through as
* declared, and the singular `effort` form folds via
* {@link singularEffortLadder}.
*/
function parseReasoning(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const raw = value;
	const singularForm = isSingularEffortForm(raw);
	const effort = typeof raw["effort"] === "string" ? raw["effort"] : void 0;
	const supportedEfforts = Array.isArray(raw["supportedEfforts"]) ? raw["supportedEfforts"].filter((entry) => typeof entry === "string") : singularEffortLadder(raw);
	const defaultEffort = typeof raw["defaultEffort"] === "string" ? raw["defaultEffort"] : effort;
	const canDisableThinking = typeof raw["canDisableThinking"] === "boolean" ? raw["canDisableThinking"] : singularForm ? true : void 0;
	if (supportedEfforts === void 0 && defaultEffort === void 0 && canDisableThinking === void 0) return;
	return {
		...supportedEfforts === void 0 || supportedEfforts.length === 0 ? {} : { supportedEfforts },
		...defaultEffort === void 0 ? {} : { defaultEffort },
		...canDisableThinking === void 0 ? {} : { canDisableThinking }
	};
}
function numberField(record, key) {
	const value = record[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
/**
* Flatten one upstream task entry.
*
* Progress is reported two ways depending on the task: flat `current`/`target`
* fields, or a nested `progress: {current, target}`. The nested form wins when
* it carries anything, because a task that reports both puts the live counter
* there. Entries without a usable `task_code` are dropped — without one the
* claim path cannot be built.
*/
function parseTask(value) {
	const raw = asRecord(value);
	const taskCode = typeof raw["task_code"] === "string" ? raw["task_code"] : "";
	if (taskCode === "") return void 0;
	let current = numberField(raw, "current");
	let target = numberField(raw, "target");
	const nested = asRecord(raw["progress"]);
	const nestedCurrent = numberField(nested, "current");
	const nestedTarget = numberField(nested, "target");
	if (nestedTarget > 0 || nestedCurrent > 0) {
		current = nestedCurrent;
		target = nestedTarget;
	}
	const acceptStatus = typeof raw["accept_status"] === "string" ? raw["accept_status"] : "";
	const claimed = acceptStatus === "claimed";
	return {
		taskCode,
		title: typeof raw["title"] === "string" && raw["title"] !== "" ? raw["title"] : taskCode,
		credit: numberField(raw, "reward_credit"),
		energy: numberField(raw, "reward_energy"),
		target,
		current,
		acceptStatus,
		claimable: !claimed && target > 0 && current >= target,
		claimed,
		locked: raw["locked"] === true
	};
}
/** Parse one catalog entry; entries without usable token limits are dropped. */
function parseUpstreamModel(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	const id = typeof raw["id"] === "string" ? raw["id"] : "";
	if (id === "" || raw["disabled"] === true) return void 0;
	const input = typeof raw["maxInputTokens"] === "number" ? raw["maxInputTokens"] : 0;
	const output = typeof raw["maxOutputTokens"] === "number" ? raw["maxOutputTokens"] : 0;
	if (input <= 0 || output <= 0) return void 0;
	const name = typeof raw["name"] === "string" && raw["name"] !== "" ? raw["name"] : id;
	const creditMultiplier = parseCreditMultiplier(raw["credits"]);
	const reasoning = parseReasoning(raw["reasoning"]);
	const supportsImages = typeof raw["supportsImages"] === "boolean" ? raw["supportsImages"] : void 0;
	return {
		id,
		name,
		contextWindow: input,
		maxTokens: output,
		...creditMultiplier === void 0 ? {} : { creditMultiplier },
		...reasoning === void 0 ? {} : { reasoning },
		...supportsImages === void 0 ? {} : { supportsImages }
	};
}
var WorkBuddyUpstreamClient = class {
	fetchImpl;
	constructor(options = {}) {
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
	}
	/**
	* Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
	* force `stream: true` (the upstream rejects non-streaming), convert the
	* DSH `developer` role into `system` (upstream rejects `developer` with
	* business code 11128), and flatten `tool_choice` into its string form.
	*/
	prepareChatBody(raw) {
		let body;
		try {
			body = JSON.parse(raw);
		} catch {
			return raw;
		}
		if (typeof body !== "object" || body === null || Array.isArray(body)) return raw;
		const obj = body;
		obj["stream"] = true;
		delete obj["stream_options"];
		if (Array.isArray(obj["messages"])) for (const value of obj["messages"]) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
			const message = value;
			if (message["role"] === "developer") message["role"] = "system";
		}
		const choice = obj["tool_choice"];
		if (typeof choice === "string") {
			if (choice.trim().toLowerCase() === "none") {
				delete obj["tool_choice"];
				delete obj["tools"];
				delete obj["functions"];
			}
		} else if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
			const wrapped = choice;
			const type = typeof wrapped["type"] === "string" ? wrapped["type"].trim().toLowerCase() : "";
			if (type === "none") {
				delete obj["tool_choice"];
				delete obj["tools"];
				delete obj["functions"];
			} else if (type === "auto" || type === "required") obj["tool_choice"] = type;
			else if (type === "function") {
				const fn = typeof wrapped["function"] === "object" && wrapped["function"] !== null ? wrapped["function"] : void 0;
				let name = typeof fn?.["name"] === "string" ? fn["name"] : "";
				if (name === "" && typeof wrapped["name"] === "string") name = wrapped["name"];
				obj["tool_choice"] = name.trim() !== "" ? name.trim() : "auto";
			} else delete obj["tool_choice"];
		}
		return JSON.stringify(obj);
	}
	/** Forward one chat completion. Never throws for upstream failures. */
	async chatStream(credential, prepared, signal) {
		let response;
		try {
			response = await this.fetchImpl(`${chatBase(credential)}/v2/chat/completions`, {
				redirect: "error",
				method: "POST",
				headers: chatHeaders(credential),
				body: prepared,
				...signal === void 0 ? {} : { signal }
			});
		} catch (error) {
			return {
				ok: false,
				kind: "server",
				status: 0,
				message: `transport error: ${String(error)}`
			};
		}
		if (response.ok) return {
			ok: true,
			response
		};
		const text = (await response.text().catch(() => "")).slice(0, ERROR_BODY_LIMIT);
		return {
			ok: false,
			kind: classifyUpstreamError(response.status, text),
			status: response.status,
			message: text
		};
	}
	/** POST the token-refresh endpoint; the caller merges the outcome. */
	async refreshToken(credential) {
		const response = await this.fetchImpl(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
			redirect: "error",
			method: "POST",
			headers: refreshHeaders(credential),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
		if (accessToken === "") throw new Error("workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app");
		const outcome = { accessToken };
		if (typeof data["refreshToken"] === "string" && data["refreshToken"] !== "") outcome.refreshToken = data["refreshToken"];
		if (typeof data["expiresIn"] === "number" && data["expiresIn"] > 0) outcome.expiresInSec = data["expiresIn"];
		if (typeof data["domain"] === "string" && data["domain"] !== "") outcome.domain = data["domain"];
		return outcome;
	}
	/**
	* Fetch the model catalog, keeping the `cli` agent's models only.
	*
	* The two gateways are read differently, because they answer differently:
	*
	* - **CN** serves the roster at `/v2/enterprises/personal/models` and expects
	*   the CLI client spelling.
	* - **Global** serves it as part of the product config at `/v3/config`, and
	*   only to the DESKTOP client channel. Asking the global host with the CLI UA
	*   yields a truncated roster, and the CN path answers HTTP 500 there — which
	*   is what left the international provider on its static fallback.
	*
	* Both documents share the `{ models, agents }` entry shape, so the parsing
	* below is common to the two branches.
	*/
	async fetchModels(credential, signal) {
		const global = regionOf(credential.domain) === "global";
		const url = global ? `${globalBase(credential)}${GLOBAL_CONFIG_PATH}` : `${chatBase(credential)}${MODELS_CATALOG_PATH}`;
		const headers = global ? {
			"Authorization": `Bearer ${credential.accessToken}`,
			"Accept": "application/json",
			...credential.uid === void 0 || credential.uid === "" ? {} : { "X-User-Id": credential.uid },
			...credential.domain === "" ? {} : { "X-Domain": credential.domain },
			"X-Product": "SaaS",
			"X-Requested-With": "XMLHttpRequest",
			"Connection": "close",
			"User-Agent": DESKTOP_UA
		} : {
			"Authorization": `Bearer ${credential.accessToken}`,
			"Accept": "application/json",
			"Origin": billingBase(credential),
			"Referer": `${billingBase(credential)}/`,
			"User-Agent": CLIENT_UA
		};
		if (!global && credential.enterpriseId !== void 0 && credential.enterpriseId !== "") headers["X-Enterprise-Id"] = credential.enterpriseId;
		const response = await this.fetchImpl(url, {
			redirect: "error",
			headers,
			...signal === void 0 ? {} : { signal }
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const rawModels = Array.isArray(data["models"]) ? data["models"] : [];
		const agents = Array.isArray(data["agents"]) ? data["agents"] : [];
		let cliIds;
		for (const agent of agents) if (typeof agent === "object" && agent !== null) {
			const wrapped = agent;
			if (wrapped["name"] === "cli" && Array.isArray(wrapped["models"])) {
				cliIds = wrapped["models"].filter((id) => typeof id === "string");
				break;
			}
		}
		const byId = /* @__PURE__ */ new Map();
		for (const model of rawModels) {
			const parsed = parseUpstreamModel(model);
			if (parsed !== void 0) byId.set(parsed.id, parsed);
		}
		const models = (cliIds !== void 0 && cliIds.length > 0 ? cliIds : [...byId.keys()]).map((id) => byId.get(id)).filter((model) => model !== void 0);
		if (models.length === 0) throw new Error("workbuddy model catalog resolved to an empty list");
		return models;
	}
	/** Read-only credits query, aggregated by package. Does not consume credits. */
	async fetchCredits(credential) {
		const now = /* @__PURE__ */ new Date();
		const fmt = (date) => {
			const p = (n) => n.toString().padStart(2, "0");
			return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
		};
		const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
			redirect: "error",
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({
				PageNumber: 1,
				PageSize: 100,
				ProductCode: "p_tcaca",
				Status: [0, 3],
				PackageEndTimeRangeBegin: fmt(now),
				PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 3185136e6))
			}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const wrapper = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const data = typeof wrapper["Response"] === "object" && wrapper["Response"] !== null ? wrapper["Response"] : {};
		const inner = typeof data["Data"] === "object" && data["Data"] !== null ? data["Data"] : {};
		const rawAccounts = Array.isArray(inner["Accounts"]) ? inner["Accounts"] : [];
		let total = 0;
		let expiringSoon = 0;
		let nearestExpiryMs;
		const SOON_MS = 2592e5;
		const parseDate = (raw) => {
			if (typeof raw === "number" && raw > 0xe8d4a51000) return raw;
			if (typeof raw === "string" && raw !== "") {
				const parsed = Date.parse(raw);
				if (!Number.isNaN(parsed)) return parsed;
			}
		};
		const packages = [];
		for (const raw of rawAccounts) {
			if (typeof raw !== "object" || raw === null) continue;
			const account = raw;
			const monthly = numberField(account, "CapacityType") === 4;
			const size = monthly ? numberField(account, "CycleCapacitySize") : numberField(account, "CapacitySize");
			const remain = monthly ? numberField(account, "CycleCapacityRemain") : numberField(account, "CapacityRemain");
			const capped = remain < 0 ? 0 : remain;
			const cycleEndMs = parseDate(account["CycleEndTime"]);
			const expiresAtMs = monthly ? void 0 : parseDate(account["ExpiredTime"]) ?? cycleEndMs;
			const refreshAtMs = monthly ? cycleEndMs === void 0 ? void 0 : cycleEndMs + 1e3 : void 0;
			if (capped <= 0 || !monthly && expiresAtMs !== void 0 && expiresAtMs <= Date.now()) continue;
			total += capped;
			if (expiresAtMs !== void 0 && expiresAtMs - Date.now() <= SOON_MS) expiringSoon += capped;
			if (expiresAtMs !== void 0 && (nearestExpiryMs === void 0 || expiresAtMs < nearestExpiryMs)) nearestExpiryMs = expiresAtMs;
			packages.push({
				packageName: typeof account["PackageName"] === "string" ? account["PackageName"] : "(unnamed)",
				remain: capped,
				size,
				monthly,
				...refreshAtMs === void 0 ? {} : { refreshAtMs },
				...expiresAtMs === void 0 ? {} : { expiresAtMs }
			});
		}
		return {
			total,
			packages,
			expiringSoon,
			...nearestExpiryMs === void 0 ? {} : { nearestExpiryMs }
		};
	}
	/** Query today's check-in status without changing account state. */
	async fetchCheckinStatus(credential) {
		const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/checkin-activity-status`, {
			redirect: "error",
			method: "POST",
			headers: billingHeaders(credential),
			body: "{}",
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		return {
			active: data["active"] === true,
			todayCheckedIn: data["today_checked_in"] === true,
			streakDays: numberField(data, "streak_days"),
			dailyCredit: numberField(data, "daily_credit"),
			todayCredit: numberField(data, "today_credit"),
			isStreakDay: data["is_streak_day"] === true,
			nextStreakDay: numberField(data, "next_streak_day"),
			streakBonusCredit: numberField(data, "streak_bonus_credit")
		};
	}
	/** Claim today's check-in reward. The browser route guards this mutation. */
	async claimDailyCheckin(credential) {
		const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/daily-checkin`, {
			redirect: "error",
			method: "POST",
			headers: billingHeaders(credential),
			body: "{}",
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		return {
			credit: numberField(data, "credit"),
			streakDays: numberField(data, "streak_days"),
			isStreakDay: data["is_streak_day"] === true
		};
	}
	/**
	* Query the account's buddy profile; null means no buddy yet.
	*
	* Null, missing and empty-object shapes all read as "no buddy" — the
	* upstream answers whichever it feels like, and the caller adopts in all
	* three cases.
	*/
	async fetchBuddyInfo(credential) {
		const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/buddy/info`, {
			redirect: "error",
			headers: billingHeaders(credential),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const raw = (typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {})["buddy"];
		if (raw === null || raw === void 0) return null;
		if (typeof raw !== "object" || Array.isArray(raw)) return null;
		const profile = raw;
		return {
			id: typeof profile["id"] === "number" ? profile["id"] : 0,
			name: typeof profile["name"] === "string" ? profile["name"] : ""
		};
	}
	/** Query the cat-travel state for one account. */
	async fetchTravelStatus(credential) {
		const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/buddy/travel/status`, {
			redirect: "error",
			headers: billingHeaders(credential),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		return {
			state: typeof data["state"] === "string" ? data["state"] : "",
			dailyLimitReached: data["daily_limit_reached"] === true,
			recordId: numberField(data, "record_id")
		};
	}
	/**
	* Dispatch the buddy to travel. Location 4 (ancient-town inn): the four
	* locations share the same reward/duration range, so there is no optimum —
	* the number just has to be one the upstream accepts.
	*/
	async departTravel(credential, locationId = 4) {
		const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/buddy/travel/depart`, {
			redirect: "error",
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({ location_id: locationId }),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
	}
	/**
	* Claim the arrival reward. A missing reward field is not a failure — the
	* caller logs 0 and moves on, matching the upstream's own tolerance.
	*/
	async claimTravelReward(credential, recordId) {
		const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/buddy/travel/claim`, {
			redirect: "error",
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({ record_id: recordId }),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		return numberField(typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {}, "reward_credit");
	}
	/** Accept the buddy agreement. Idempotent: safe to repeat. */
	async agreeBuddy(credential) {
		const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/buddy/agreement`, {
			redirect: "error",
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({ agree: true }),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
	}
	/** Adopt the first buddy. Throws the threshold refusal when unqualified. */
	async adoptBuddy(credential) {
		const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/buddy/first`, {
			redirect: "error",
			method: "POST",
			headers: billingHeaders(credential),
			body: "{}",
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
	}
	/**
	* Report one chat activity. The full event shape, not a minimal subset: the
	* upstream lights growth streak and unlocks the first-buddy task on this,
	* and a trimmed event risks a future tightening. `userId` is the account
	* uid — without it the upstream answers 200 yet silently drops the report.
	*/
	async reportChatActivity(credential, conversationId) {
		const uid = credential.uid ?? credential.uin ?? "";
		if (uid === "") throw new Error("workbuddy report needs a uid-bearing credential");
		const now = Date.now();
		const event = {
			eventCode: "chat_request_send",
			timestamp: now,
			reportDelay: 0,
			mode: "craft",
			conversationId,
			requestId: conversationId,
			inputLength: 12,
			requestModelId: "deepseek-v4-flash",
			requestModelName: "DeepSeek V4 Flash",
			isPlan: false,
			isAutoExecuteTerminal: false,
			isAutoModify: false,
			codebaseEnable: false,
			maxToken: 0,
			maxSteps: 0,
			temperature: 0,
			maxRetries: 0,
			mentionContexts: [],
			knowledgeId: [],
			knowledgeName: [],
			codebaseId: "",
			mentionContextCount: 0,
			command: "",
			expertId: "",
			recommendId: "",
			skillId: "",
			skillCount: 0,
			totalCount: 0,
			fileUri: "",
			presentAt: now,
			traceId: "",
			rootRequestId: conversationId,
			parentConversationId: conversationId,
			agentName: "default",
			agentType: "conversation",
			userId: uid
		};
		const response = await this.fetchImpl(`${billingBase(credential)}/v2/report`, {
			redirect: "error",
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify([event]),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
	}
	/**
	* Call a growth-domain endpoint and return its unwrapped `data`.
	*
	* These endpoints live on the chat host with the billing header set, and
	* carry the same envelope as everything else. Centralised here because every
	* growth call needs the identical envelope check. The path carries NO `/v2`
	* prefix: asking for the `/v2` form does not 404, it answers with a body that
	* has no streak object at all.
	*/
	async growthJson(credential, method, path, body) {
		const response = await this.fetchImpl(`${chatBase(credential)}${path}`, {
			redirect: "error",
			method,
			headers: billingHeaders(credential),
			...body === void 0 ? {} : { body: JSON.stringify(body) },
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		return asRecord(envelope.data);
	}
	/**
	* The full streak picture: days, tier unlock state, and what each tier pays.
	*
	* Read before redeeming, because the tier state is the only honest answer to
	* "is there anything to claim": the redeem endpoint answers 403 for a locked
	* tier, which is indistinguishable from a real failure once the response is
	* just an error. The counter is nested as `data.streak.days`, not `data.days`.
	*/
	async growthStreakFull(credential) {
		const data = await this.growthJson(credential, "GET", "/activity/growth/streak");
		const streak = asRecord(data["streak"]);
		const redemption = asRecord(data["redemption_status"]);
		const tiers = [];
		if (Array.isArray(redemption["tiers"])) for (const entry of redemption["tiers"]) {
			const tier = asRecord(entry);
			const name = typeof tier["tier"] === "string" ? tier["tier"] : "";
			if (name === "") continue;
			tiers.push({
				tier: name,
				days: numberField(tier, "days"),
				credit: numberField(tier, "credit"),
				energy: numberField(tier, "energy"),
				status: String(redemption[`tier_${name}_status`] ?? "").toLowerCase()
			});
		}
		return {
			days: numberField(streak, "days"),
			nextTier: typeof streak["next_tier"] === "string" ? streak["next_tier"] : "",
			nextTierRemaining: numberField(streak, "next_tier_remaining"),
			tiers
		};
	}
	/**
	* Redeem one unlocked streak tier.
	*
	* A locked tier answers 403 ("连续登录天数不足"); callers check the status from
	* {@link growthStreakFull} first, so this only throws for genuine failures.
	* The client token is the upstream's idempotency key — a fresh one per attempt
	* keeps a retry from being read as a duplicate of the last one.
	*/
	async redeemStreakTier(credential, tier) {
		await this.growthJson(credential, "POST", "/activity/growth/redeem", {
			tier,
			client_token: randomUUID()
		});
	}
	/**
	* Fetch the growth task list for one account.
	*
	* The upstream answers `data.tasks[]`, and `claimable` is derived locally —
	* the upstream does not mark it. The task list is the one growth endpoint
	* that DOES carry the `/v2` prefix.
	*/
	async listTasks(credential) {
		const response = await this.fetchImpl(`${chatBase(credential)}/v2/activity/growth/tasks`, {
			redirect: "error",
			headers: chatHeaders(credential),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const raw = Array.isArray(asRecord(envelope.data)["tasks"]) ? asRecord(envelope.data)["tasks"] : [];
		const out = [];
		for (const entry of raw) {
			const parsed = parseTask(entry);
			if (parsed !== void 0) out.push(parsed);
		}
		return out;
	}
	/**
	* Accept (enrol in) tasks by code.
	*
	* Accepting is the "sign up" half: it produces no progress by itself, and the
	* upstream answers success for an already-accepted task, so replaying this is
	* safe. Progress is lit by real activity (a chat, an activity report).
	*/
	async acceptTasks(credential, taskCodes) {
		if (taskCodes.length === 0) return;
		const response = await this.fetchImpl(`${chatBase(credential)}/v2/activity/growth/tasks/accept`, {
			redirect: "error",
			method: "POST",
			headers: chatHeaders(credential),
			body: JSON.stringify({ task_codes: [...taskCodes] }),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
	}
	/**
	* Claim one task's reward.
	*
	* Two details differ from list/accept and are load-bearing:
	*
	* - The task code rides the PATH, not the body.
	* - It is served by the web origin, not the chat host, and only when the
	*   request carries the growth-centre Origin/Referer plus
	*   `x-client-platform: web`. The chat host's `/reward/claim` path does not
	*   exist and answers 400 "task not completed".
	*
	* A repeat claim answers `already_claimed` with zero credit, which is treated
	* as success so the caller can stay idempotent.
	*/
	async claimTaskReward(credential, taskCode) {
		const headers = {
			...billingHeaders(credential),
			"Accept": "application/json, text/plain, */*",
			"Origin": "https://www.workbuddy.cn",
			"Referer": "https://www.workbuddy.cn/profile/growth-center",
			"x-client-platform": "web",
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
		};
		const response = await this.fetchImpl(`https://www.workbuddy.cn/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`, {
			method: "POST",
			redirect: "error",
			headers,
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = asRecord(envelope.data);
		if (data["already_claimed"] === true) return {
			credit: 0,
			energy: 0
		};
		return {
			credit: numberField(data, "credit"),
			energy: numberField(data, "energy")
		};
	}
};
//#endregion
//#region src/at-rest.ts
/**
* Open WorkBuddy 5.6+ `$wbEncrypted` credential fields.
*
* The desktop app seals accessToken / refreshToken / nickname. The key is not
* on disk: ask the installed WorkBuddy binary (run as plain Node) for its
* at-rest payload, derive the field key, and keep it in memory only.
*/
const AAD_DOMAIN = Buffer.from("WB-AAD\0", "ascii");
const KEY_FETCH_TIMEOUT_MS = 3e4;
const KEY_FAILURE_BACKOFF_MS = 6e4;
const APP_EXECUTABLE_NAMES = ["WorkBuddy.exe", "WorkBuddyAI.exe"];
const WORKBUDDY_APP_EXECUTABLE_ENV = "WORKBUDDY_APP_EXECUTABLE";
function encodeUint32(value) {
	const bytes = Buffer.allocUnsafe(4);
	bytes.writeUInt32BE(value);
	return bytes;
}
function encodeLengthPrefixed(value) {
	const bytes = Buffer.from(value, "utf8");
	return Buffer.concat([encodeUint32(bytes.length), bytes]);
}
function fieldAad(keyId, suite) {
	if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error("workbuddy: envelope keyId is malformed");
	return Buffer.concat([
		AAD_DOMAIN,
		Buffer.from([1]),
		encodeLengthPrefixed("WBEV1"),
		encodeLengthPrefixed("sym-v1"),
		encodeUint32(suite),
		encodeLengthPrefixed(keyId),
		Buffer.from([2]),
		Buffer.from([0]),
		Buffer.from([0])
	]);
}
function isEncryptedFieldWrapper(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const wrapper = value;
	const keys = Object.keys(wrapper).sort();
	return keys.length === 2 && keys[0] === "$wbEncrypted" && keys[1] === "envelope" && wrapper["$wbEncrypted"] === 1 && typeof wrapper["envelope"] === "string";
}
function deriveAtRestKeyId(key) {
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
function deriveAtRestKey(payloadJson) {
	let payload;
	try {
		payload = JSON.parse(payloadJson);
	} catch {
		throw new Error("workbuddy: at-rest key payload is not valid JSON");
	}
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("workbuddy: at-rest key payload is not an object");
	const secret = payload["atRestSecretKey"];
	if (typeof secret !== "string" || secret === "") throw new Error("workbuddy: at-rest key payload carries no atRestSecretKey");
	return createHash("sha256").update(secret, "utf8").digest();
}
function encryptedFieldKeyId(field) {
	try {
		const record = JSON.parse(Buffer.from(field.envelope, "base64").toString("utf8"));
		return typeof record["keyId"] === "string" ? record["keyId"] : void 0;
	} catch {
		return;
	}
}
function openEncryptedField(field, key) {
	let envelope;
	try {
		envelope = JSON.parse(Buffer.from(field.envelope, "base64").toString("utf8"));
	} catch {
		throw new Error("workbuddy: encrypted field envelope is not valid JSON");
	}
	if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) throw new Error("workbuddy: encrypted field envelope is not an object");
	const record = envelope;
	const suite = record["suite"];
	const keyId = record["keyId"];
	const nonce = record["nonce"];
	const authTag = record["authTag"];
	const ciphertext = record["ciphertext"];
	if (typeof suite !== "number" || typeof keyId !== "string") throw new Error("workbuddy: encrypted field envelope is missing suite or keyId");
	if (typeof nonce !== "string" || typeof authTag !== "string" || typeof ciphertext !== "string") throw new Error("workbuddy: encrypted field envelope is missing nonce, authTag or ciphertext");
	const expectedKeyId = deriveAtRestKeyId(key);
	if (keyId !== expectedKeyId) throw new Error(`workbuddy: encrypted field belongs to key ${keyId}, not the available key ${expectedKeyId}`);
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"), { authTagLength: 16 });
	decipher.setAAD(fieldAad(keyId, suite));
	decipher.setAuthTag(Buffer.from(authTag, "base64"));
	return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}
function cleanIconPath(raw) {
	return raw.replace(/^"/u, "").replace(/",-?\d+$/u, "").replace(/,-?\d+$/u, "").trim();
}
function windowsRegistryAppPaths() {
	if (process.platform !== "win32") return [];
	const script = [
		"$ErrorActionPreference='SilentlyContinue'",
		"try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}",
		"$roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
		"foreach($r in $roots){",
		"  Get-ItemProperty -Path $r | ForEach-Object {",
		"    $dn=[string]$_.DisplayName; $di=[string]$_.DisplayIcon; $il=[string]$_.InstallLocation",
		"    if($dn -match 'WorkBuddy|CodeBuddy' -or $di -match 'WorkBuddy|CodeBuddy'){",
		"      if($di -ne ''){ Write-Output $di }",
		"      if($il -ne ''){ Write-Output $il }",
		"    }",
		"  }",
		"}"
	].join("\n");
	let stdout;
	try {
		stdout = execFileSync("powershell", [
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script
		], {
			encoding: "utf8",
			timeout: 2e4,
			windowsHide: true,
			maxBuffer: 8388608
		});
	} catch {
		return [];
	}
	const out = [];
	for (const line of stdout.split(/\r?\n/u)) {
		const cleaned = cleanIconPath(line.trim());
		if (cleaned !== "") out.push(cleaned);
	}
	return out;
}
function statExecutables(candidates) {
	const files = [];
	for (const candidate of candidates) {
		if (candidate === "") continue;
		try {
			if (existsSync(candidate)) files.push(candidate);
		} catch {}
	}
	return files;
}
function executableCandidates(env = process.env) {
	const override = env[WORKBUDDY_APP_EXECUTABLE_ENV]?.trim();
	const known = override === void 0 ? [] : [override];
	if (process.platform === "win32") {
		const local = env["LOCALAPPDATA"]?.trim();
		const roots = [
			env["ProgramFiles"],
			env["ProgramFiles(x86)"],
			local === void 0 || local === "" ? join(homedir(), "AppData", "Local", "Programs") : join(local, "Programs")
		];
		for (const root of roots) {
			if (!root) continue;
			for (const name of APP_EXECUTABLE_NAMES) {
				known.push(join(root, "WorkBuddy", name));
				known.push(join(root, "WorkBuddy AI", name));
			}
		}
	} else if (process.platform === "darwin") {
		const home = homedir();
		for (const bundle of ["WorkBuddy.app", "WorkBuddy AI.app"]) for (const base of ["/Applications", join(home, "Applications")]) known.push(join(base, bundle, "Contents", "MacOS", "Electron"));
	}
	const standard = statExecutables(known);
	if (standard.length > 0 || process.platform !== "win32") return standard;
	return statExecutables(windowsRegistryAppPaths());
}
function fetchAtRestKeyPayload(executable) {
	return new Promise((resolve, reject) => {
		execFile(executable, ["-e", "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}"], {
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1"
			},
			timeout: KEY_FETCH_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: 1048576
		}, (error, stdout, stderr) => {
			if (error !== null) {
				reject(/* @__PURE__ */ new Error(`workbuddy: the desktop app did not provide its at-rest key (${stderr.trim() || error.message})`));
				return;
			}
			const payload = stdout.trim();
			if (payload === "") {
				reject(/* @__PURE__ */ new Error("workbuddy: the desktop app returned an empty at-rest key payload"));
				return;
			}
			resolve(payload);
		});
	});
}
const atRestKeyById = /* @__PURE__ */ new Map();
let inflightKeys;
let lastKeyFailureAtMs = 0;
function ensureAtRestKeys() {
	if (atRestKeyById.size > 0) return Promise.resolve();
	if (Date.now() - lastKeyFailureAtMs < KEY_FAILURE_BACKOFF_MS) return Promise.resolve();
	inflightKeys ??= (async () => {
		const candidates = executableCandidates();
		if (candidates.length === 0) {
			lastKeyFailureAtMs = Date.now();
			return;
		}
		let anySuccess = false;
		await Promise.all(candidates.map(async (executable) => {
			try {
				const key = deriveAtRestKey(await fetchAtRestKeyPayload(executable));
				atRestKeyById.set(deriveAtRestKeyId(key), key);
				anySuccess = true;
			} catch {}
		}));
		lastKeyFailureAtMs = anySuccess ? 0 : Date.now();
	})().finally(() => {
		inflightKeys = void 0;
	});
	return inflightKeys;
}
async function encryptedFieldOpener() {
	await ensureAtRestKeys();
	if (atRestKeyById.size === 0) return void 0;
	return (value) => {
		if (!isEncryptedFieldWrapper(value)) throw new Error("workbuddy: not an encrypted field wrapper");
		const keyId = encryptedFieldKeyId(value);
		if (keyId === void 0) throw new Error("workbuddy: encrypted field has no key id");
		const key = atRestKeyById.get(keyId);
		if (key === void 0) throw new Error("workbuddy: no at-rest key available for this encrypted field");
		return openEncryptedField(value, key);
	};
}
//#endregion
//#region src/accounts.ts
/**
* Account pool: discovers every WorkBuddy credential snapshot the desktop app
* has left on this machine and hands out one healthy account per request,
* rotating away from any account the upstream has rate-limited.
*
* Discovery is read-only: the desktop app's files are never written. Each
* account is keyed by its billing identity (`uin`, falling back to `uid`), so
* re-logging the same account refreshes in place instead of creating a duplicate.
*
* @module dsh-wtq-pool/accounts
*/
/** Live auth file name the WorkBuddy desktop app writes. */
const WORKBUDDY_LIVE_FILENAME = "workbuddy-desktop.info";
/** Env override for the auth file or its directory. */
const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
function nonEmptyEnv(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/**
* Platform-default directories holding the desktop app's auth files.
* Windows probes Local before Roaming; a redirected profile still resolves
* through the env location.
*/
function defaultDesktopAuthDirs(platform = process.platform, home = homedir(), env = process.env) {
	if (platform === "darwin") return [join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth")];
	if (platform === "win32") {
		const local = nonEmptyEnv(env["LOCALAPPDATA"]) ?? join(home, "AppData", "Local");
		const roaming = nonEmptyEnv(env["APPDATA"]) ?? join(home, "AppData", "Roaming");
		return [join(local, "CodeBuddyExtension", "Data", "Public", "auth"), join(roaming, "CodeBuddyExtension", "Data", "Public", "auth")];
	}
	if (platform === "linux") {
		const config = nonEmptyEnv(env["XDG_CONFIG_HOME"]) ?? join(home, ".config");
		return [join(config, "CodeBuddyExtension", "Data", "Public", "auth")];
	}
	return [];
}
/**
* Any expiry past this is unusable input rather than a date: 2100-01-01.
*
* A saved sign-in whose `expiresAt` is a hand-edited or upstream-garbled
* sentinel (1e15, 1e16) otherwise reads as a token that never expires, so the
* pool skips its refresh forever and serves a dead token as live. Past
* 8.64e15 `new Date(…).toISOString()` also throws, which failed the whole
* panel document rather than the one row.
*/
const MAX_EXPIRY_MS = 41024448e5;
/**
* Normalize an expiry that may arrive in seconds or milliseconds.
*
* Anything past {@link MAX_EXPIRY_MS} is unusable input, not a date, so it
* reads as "no expiry" (0) - the same answer a sign-in without an `expiresAt`
* gives. The caller must not treat that as "fresh": see {@link refreshExpiryMs}.
*/
function expiryToMs(value) {
	if (!Number.isFinite(value) || value <= 0) return 0;
	const ms = value > 0xe8d4a51000 ? value : value * 1e3;
	return ms > MAX_EXPIRY_MS ? 0 : ms;
}
/**
* Absolute expiry for a refreshed token.
*
* `expiresIn` comes from the vendor's own answer, so it is bounded here rather
* than trusted: a garbled one (Infinity, 1e300) would otherwise store a
* timestamp past `Date`'s range, and the panel's `toISOString()` for that row
* then threw, failing the whole document rather than the one field. A value
* this function refuses falls back to the assumed lifetime, not to 0: 0 means
* "never expires", which would leave a token that really was not fresh being
* served as if it were.
*/
function refreshExpiryMs(expiresInSec) {
	const assumed = () => Date.now() + ASSUMED_TOKEN_LIFETIME_MS;
	if (typeof expiresInSec !== "number" || !Number.isFinite(expiresInSec) || expiresInSec <= 0) return assumed();
	const at = expiryToMs(Date.now() + expiresInSec * 1e3);
	return at === 0 ? assumed() : at;
}
function optionalString$1(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/**
* Parse a WorkBuddy auth document. Accepts the nested desktop shape
* `{"auth":{...},"account":{...}}` and the flat panel shape; returns undefined
* when there is no usable access token.
*/
function parseWorkBuddyAuth(text, sourcePath, decrypt) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	let auth;
	let identity;
	if (typeof document["auth"] === "object" && document["auth"] !== null) {
		auth = document["auth"];
		identity = typeof document["account"] === "object" && document["account"] !== null ? document["account"] : {};
	} else {
		auth = document;
		identity = document;
	}
	const accessToken = decryptableString(auth["accessToken"], decrypt);
	if (accessToken === "") return void 0;
	const refreshExpiresAtMs = typeof auth["refreshExpiresAt"] === "number" ? expiryToMs(auth["refreshExpiresAt"]) : void 0;
	if (refreshExpiresAtMs !== void 0 && refreshExpiresAtMs > 0 && refreshExpiresAtMs < Date.now()) return;
	const lastRefreshAtMs = typeof auth["lastRefreshTime"] === "number" ? expiryToMs(auth["lastRefreshTime"]) : void 0;
	const nickname = optionalString$1(decryptableString(identity["nickname"], decrypt));
	return {
		accessToken,
		refreshToken: decryptableString(auth["refreshToken"], decrypt),
		expiresAtMs: typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		...lastRefreshAtMs === void 0 ? {} : { lastRefreshAtMs },
		...nickname === void 0 ? {} : { nickname },
		...optionalString$1(identity["uin"]) === void 0 ? {} : { uin: optionalString$1(identity["uin"]) },
		...optionalString$1(identity["uid"]) === void 0 ? {} : { uid: optionalString$1(identity["uid"]) },
		...optionalString$1(identity["enterpriseId"]) === void 0 ? {} : { enterpriseId: optionalString$1(identity["enterpriseId"]) },
		domain: typeof auth["domain"] === "string" ? auth["domain"] : "",
		sourcePath
	};
}
/**
* A credential field is either a plain string (older builds) or the desktop
* app's `$wbEncrypted` envelope (5.6.0+, both platforms). An encrypted field
* that cannot be opened is an empty string so the caller skips the file
* instead of treating a sealed token as "not signed in".
*/
function decryptableString(value, decrypt) {
	if (typeof value === "string") return value;
	if (isEncryptedFieldWrapper(value) && decrypt !== void 0) try {
		return decrypt(value);
	} catch {}
	return "";
}
/**
* True when `path` is the desktop app's live sign-in (as opposed to a backup
* snapshot it left behind). The live file always wins: it is the session the
* app itself is using.
*/
function isLiveAuthFile(path) {
	return basename(path) === WORKBUDDY_LIVE_FILENAME;
}
/**
* Which of two credentials for the same account the pool should keep.
*
* Ordering, highest first:
*
* 1. the live file the desktop app is signed in with;
* 2. the credential the upstream issued most recently (`lastRefreshAtMs`);
* 3. the longer stored expiry, as a fallback for documents that carry no issue
*    time (the plugin's own refreshed copy, older builds).
*
* The stored expiry alone is NOT a freshness signal: the upstream does not
* rewrite it when it revokes a token, so a long-dead backup can claim to expire
* later than the token that actually works. Selecting on it made every upstream
* call return 401 while a perfectly good credential sat in the same directory.
*/
function compareFreshness(a, b) {
	const aLive = isLiveAuthFile(a.sourcePath) ? 1 : 0;
	const bLive = isLiveAuthFile(b.sourcePath) ? 1 : 0;
	if (aLive !== bLive) return bLive - aLive;
	const aIssued = a.lastRefreshAtMs ?? 0;
	const bIssued = b.lastRefreshAtMs ?? 0;
	if (aIssued !== bIssued) return bIssued - aIssued;
	return b.expiresAtMs - a.expiresAtMs;
}
/** True when `candidate` should replace `incumbent` for the same account. */
function isFresher(candidate, incumbent) {
	return compareFreshness(candidate, incumbent) < 0;
}
function workbuddyAccountId(credential) {
	const stable = credential.uin ?? credential.uid ?? credential.nickname ?? "unknown";
	return createHash("sha256").update(`workbuddy\0${stable}`).digest("hex").slice(0, 16);
}
/** Human label; the nickname alone, so the pool reads as names rather than keys. */
function accountLabel(credential) {
	return credential.nickname ?? "WorkBuddy";
}
/**
* Give the accounts that read alike a uid prefix, and leave the rest clean.
*
* The prefix is what tells two accounts apart, so it is worth its width only
* where there is something to tell apart. Two sign-ins can share a nickname,
* and a credential with none falls back to `WorkBuddy`, which makes every
* nickname-less account identical. Every other row keeps the name the user
* knows it by.
*/
function disambiguateLabels(accounts) {
	const counts = /* @__PURE__ */ new Map();
	for (const account of accounts) counts.set(account.label, (counts.get(account.label) ?? 0) + 1);
	for (const account of accounts) {
		if ((counts.get(account.label) ?? 0) < 2) continue;
		const discriminator = (account.credential.uid ?? account.credential.uin ?? "").slice(0, 8);
		if (discriminator !== "") account.label = `${account.label}#${discriminator}`;
	}
}
/**
* Credential files in one auth directory, freshest first.
*
* Every `*.info` file counts, not just the timestamped `workbuddy-desktop.*`
* snapshots: the international client signs in as `workbuddy-desktop-ai.info`
* (a hyphen, not a dot), so a prefix test silently dropped every global
* credential and the global provider then saw an empty pool.
*
* Filenames are plain strings, and the ordering here is only a first pass —
* `isFresher` makes the real call once each file has been parsed.
*/
async function authFilesIn(dir) {
	let entries;
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	const files = entries.filter((name) => name.endsWith(".info"));
	files.sort((a, b) => a < b ? 1 : a > b ? -1 : 0);
	return files.map((name) => join(dir, name));
}
async function readCredential(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return;
	}
	const decrypt = text.includes("\"$wbEncrypted\"") ? await encryptedFieldOpener() : void 0;
	return parseWorkBuddyAuth(text, path, decrypt);
}
/** Refresh a credential this long before its expiry, so a request never rides one that dies mid-flight. */
const REFRESH_MARGIN_MS = 3e5;
/**
* Longest one penalize may cool an account: same 2h ceiling as the parse
* layer, so a raw caller-supplied timestamp cannot sleep a pool all day.
*/
const PENALIZE_CAP_MS = 72e5;
/**
* Lifetime assumed for a refreshed token whose answer carries no `expiresIn`.
*
* It must exceed {@link REFRESH_MARGIN_MS}, or the refreshed
* credential would read as already-expiring and every request would refresh
* again. An hour is comfortably past the five-minute margin and far short of the
* two-hour cap, so a token with a real lifetime always replaces it in time.
*/
const ASSUMED_TOKEN_LIFETIME_MS = 36e5;
/** Soonest future one-off expiry. Missing or past sorts last. None left → list head. */
function pickSoonestExpiry(pool, expiryMs, now) {
	let best;
	let bestAt = Infinity;
	for (const account of pool) {
		const at = expiryMs.get(account.id);
		if (at === void 0 || at <= now) continue;
		if (at < bestAt) {
			best = account;
			bestAt = at;
		}
	}
	return best ?? pool[0];
}
function candidateAuthDirs(env = process.env) {
	const dirs = [];
	const override = nonEmptyEnv(env[WORKBUDDY_AUTH_FILE_ENV]);
	if (override !== void 0) dirs.push(override.toLowerCase().endsWith(".info") ? resolve(override, "..") : override);
	dirs.push(...defaultDesktopAuthDirs());
	return dirs;
}
/**
* True when two directory lists name the same places.
*
* Order does not matter: discovery walks them in order, so only the SET decides
* whether the accounts already held can still be valid.
*/
function sameDirs(a, b) {
	if (a.length !== b.length) return false;
	return a.every((dir) => b.includes(dir));
}
/**
* Read-only pool of every discovered WorkBuddy account, with rate-limit
* cooldown and round-robin failover.
*/
var WorkBuddyAccountPool = class {
	logger;
	authDirs;
	cooldownMs;
	client;
	accounts = [];
	distribution;
	/**
	* Account ids the user switched off on the panel.
	*
	* Disabling is a user preference, not a property of the credential: scan()
	* rebuilds every account from the auth files, so the set has to be re-applied
	* from settings and only filters at pick time.
	*/
	disabledIds = /* @__PURE__ */ new Set();
	/** Cursor for round-robin and the next new sticky conversation. */
	cursor = 0;
	/** Sticky mode: conversation key → account id. Content stays out of memory. */
	sticky = /* @__PURE__ */ new Map();
	lastScanAtMs = 0;
	preferredIds = /* @__PURE__ */ new Map();
	/**
	* Account ids the user removed from the pool for good.
	*
	* Enforced while scan() assembles its result, so a removed account cannot
	* re-enter the pool when the desktop app rewrites its sign-in file. That is
	* the difference from {@link disabledIds}, which leaves the account listed,
	* readable and restorable with one switch.
	*/
	removedIds = /* @__PURE__ */ new Set();
	/**
	* Per-account credit floor, keyed by account id. 0 (or absent) means "spend it
	* all".
	*
	* A reserve is protection, not a limit the upstream knows about: the pool
	* simply stops picking an account once its last known balance is at or below
	* the floor, so the user keeps a cushion for their own use.
	*/
	creditReserves = /* @__PURE__ */ new Map();
	/**
	* Last known credit balance per account.
	*
	* Fed by the panel's read-only probes. An account with no reading stays
	* usable: refusing to pick an account whose balance has not been checked yet
	* would strand a healthy pool, and the first 402 still cools it as before.
	*/
	creditBalances = /* @__PURE__ */ new Map();
	/** Soonest remaining one-off pack, ms. Cleared when that pack is spent or past. */
	creditExpiries = /* @__PURE__ */ new Map();
	refreshInflight = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		this.logger = options.logger;
		this.authDirs = options.authDirs ?? candidateAuthDirs();
		this.cooldownMs = options.cooldownMs ?? 6e4;
		this.client = options.client;
		this.distribution = options.distribution ?? "priority";
	}
	/**
	* Re-apply configuration that only affects discovery and cooldown policy,
	* without rebuilding the pool. A later `scan()` uses the new auth dirs and
	* cooldown window; existing accounts keep their in-memory state.
	*/
	applyConfig(options) {
		if (options.authDirs !== void 0 && options.authDirs.length > 0) {
			if (!sameDirs(this.authDirs, options.authDirs)) this.accounts = [];
			this.authDirs = options.authDirs;
		}
		if (options.cooldownMs !== void 0 && options.cooldownMs >= 1e3) this.cooldownMs = options.cooldownMs;
		if (options.distribution !== void 0) this.distribution = options.distribution;
		if (options.disabledAccountIds !== void 0) this.disabledIds = new Set(options.disabledAccountIds);
		if (options.creditReserves !== void 0) {
			const next = /* @__PURE__ */ new Map();
			for (const [id, value] of Object.entries(options.creditReserves)) {
				const floor = Number(value);
				if (id !== "" && Number.isFinite(floor) && floor > 0) next.set(id, Math.floor(floor));
			}
			this.creditReserves = next;
		}
	}
	/** Remember an account's last known balance, from the panel's probe. */
	setCreditBalance(accountId, total, nearestExpiryMs) {
		if (!Number.isFinite(total) || total < 0) return;
		this.creditBalances.set(accountId, total);
		if (typeof nearestExpiryMs === "number" && Number.isFinite(nearestExpiryMs) && nearestExpiryMs > Date.now()) this.creditExpiries.set(accountId, nearestExpiryMs);
		else this.creditExpiries.delete(accountId);
	}
	/** True when a known balance has reached the floor set for this account. */
	reserveHolds(accountId) {
		const floor = this.creditReserves.get(accountId);
		if (floor === void 0 || floor <= 0) return false;
		const balance = this.creditBalances.get(accountId);
		return balance !== void 0 && balance <= floor;
	}
	/** Whether this account was switched off on the panel. */
	isDisabled(accountId) {
		return this.disabledIds.has(accountId);
	}
	/**
	* Replace the permanent removal list.
	*
	* The list only filters what is handed out, so both directions take effect at
	* once: a removed account disappears without a rescan, and restoring one does
	* not wait for the next scan to bring it back.
	*/
	applyRemoved(ids) {
		this.removedIds = new Set(ids);
	}
	/** Drop every account, e.g. when the source is switched off. A later `scan()` rebuilds from disk. */
	clear() {
		this.accounts = [];
	}
	/** Rescan the auth directories and merge newly discovered accounts. */
	async scan() {
		const found = [];
		const readableDirs = /* @__PURE__ */ new Set();
		for (const dir of this.authDirs) {
			const files = await authFilesIn(dir);
			if (files === void 0) continue;
			readableDirs.add(resolve(dir));
			for (const file of files) {
				const credential = await readCredential(file);
				if (credential !== void 0) found.push(credential);
			}
		}
		const byId = /* @__PURE__ */ new Map();
		for (const account of this.accounts) byId.set(account.id, account);
		for (const credential of found) {
			const id = workbuddyAccountId(credential);
			const existing = byId.get(id);
			if (existing === void 0) {
				byId.set(id, {
					id,
					label: accountLabel(credential),
					credential,
					cooldownUntilMs: 0,
					modelCooldowns: {},
					rateLimitHits: 0
				});
				continue;
			}
			if (isFresher(credential, existing.credential)) existing.credential = credential;
		}
		const foundIds = new Set(found.map((credential) => workbuddyAccountId(credential)));
		for (const [id, account] of byId) {
			const home = resolve(dirname(account.credential.sourcePath));
			if (readableDirs.has(home) && !foundIds.has(id)) byId.delete(id);
		}
		const ordered = [...byId.values()];
		ordered.sort((a, b) => compareFreshness(a.credential, b.credential));
		for (const account of ordered) account.label = accountLabel(account.credential);
		disambiguateLabels(ordered);
		this.accounts = ordered;
		this.lastScanAtMs = Date.now();
		return this.accounts;
	}
	/** All accounts, cooldown state included. */
	list(region) {
		const kept = this.accounts.filter((account) => !this.removedIds.has(account.id));
		if (region === void 0) return kept;
		return kept.filter((account) => regionOf(account.credential.domain) === region);
	}
	/**
	* Accounts currently eligible to serve a request.
	*
	* With a `modelId`, an account is eligible when it is not account-wide cooled
	* AND that model is not cooling on it — so a 429 on `hy4-preview` only keeps
	* that model out while `hy3` on the same account stays usable. Without a
	* model id the legacy account-wide check applies (callers that cannot name a
	* model, e.g. CLI diagnostics). The panel asks this same question to mark the
	* account the next request will use: a hand-rolled filter there once marked a
	* switched-off account as next up, which is what this being the only answer is
	* for.
	*/
	available(now, modelId, region) {
		return this.accounts.filter((account) => {
			if (this.removedIds.has(account.id)) return false;
			if (this.disabledIds.has(account.id)) return false;
			if (this.reserveHolds(account.id)) return false;
			if (account.cooldownUntilMs > now) return false;
			if (modelId !== void 0 && (account.modelCooldowns[modelId] ?? 0) > now) return false;
			if (region !== void 0 && regionOf(account.credential.domain) !== region) return false;
			return true;
		});
	}
	/**
	* Pick the account to serve a request.
	*
	* Two distributions, chosen by the `distribution` setting:
	*
	* - **priority** (default, and what the card ships with): one account serves
	*   every request until it is rate-limited, then the next in order takes over.
	*   Credits drain one account at a time, and a cooling account returns to the
	*   head of the queue the moment its window resets — it was never consumed, so
	*   it resumes straight away.
	* - **round-robin**: consecutive requests rotate through the pool so spend
	*   spreads evenly across every account.
	*
	* In both modes an explicit user selection (`prefer`) heads the list, a
	* cooling account is skipped for that model only, and an unrecognised setting
	* falls back to priority.
	*
	* Scans on first use, and rescans when every known account is cooling down: a
	* fresh desktop login is the usual way out of an exhausted pool.
	*/
	async acquire(modelId, region, conversationKey) {
		if (this.accounts.length === 0) await this.scan();
		let pool = this.available(Date.now(), modelId, region);
		if (pool.length === 0) {
			await this.scan();
			pool = this.available(Date.now(), modelId, region);
		}
		if (pool.length === 0) return void 0;
		const preferredId = this.preferredIds.get(region);
		const account = pool.find((item) => item.id === preferredId) ?? this.pick(pool, conversationKey);
		if (account === void 0) return void 0;
		await this.ensureFresh(account);
		return account;
	}
	pick(pool, conversationKey) {
		if (this.distribution === "expiry") return this.pickByExpiry(pool);
		if (this.distribution === "sticky" && conversationKey !== void 0) {
			const bound = this.sticky.get(conversationKey);
			const kept = bound === void 0 ? void 0 : pool.find((account) => account.id === bound);
			if (kept !== void 0) return kept;
			const account = pool[this.cursor % pool.length];
			if (account === void 0) return void 0;
			this.sticky.set(conversationKey, account.id);
			this.cursor = (this.cursor + 1) % pool.length;
			while (this.sticky.size > 200) {
				const oldest = this.sticky.keys().next().value;
				if (oldest === void 0) break;
				this.sticky.delete(oldest);
			}
			return account;
		}
		const index = this.distribution === "round-robin" ? this.cursor % pool.length : 0;
		const account = pool[index];
		if (account !== void 0 && this.distribution === "round-robin") this.cursor = (index + 1) % pool.length;
		return account;
	}
	pickByExpiry(pool) {
		return pickSoonestExpiry(pool, this.creditExpiries, Date.now());
	}
	/** Next account the card may name. Rotating modes have none. Does not move the cursor. */
	preview(eligible) {
		if (eligible.length === 0) return void 0;
		if (this.distribution === "expiry") return this.pickByExpiry(eligible);
		if (this.distribution === "priority") return eligible[0];
	}
	/** Prefer one billing account per gateway; undefined restores automatic use. */
	prefer(accountId, region) {
		if (accountId === void 0) this.preferredIds.delete(region);
		else this.preferredIds.set(region, accountId);
	}
	/**
	* Refresh one account after a session-dead upstream answer, ignoring the
	* stored expiry: a revocation does not rewrite it. False when the access
	* token is unchanged, so the caller stops retrying the same dead token.
	*/
	async refreshAccount(accountId) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) return false;
		const previous = account.credential.accessToken;
		await this.ensureFresh(account, true);
		return account.credential.accessToken !== previous;
	}
	/**
	* Refresh the account's access token when it is within the margin (or already
	* expired), in-flight de-duped per account. A failed refresh keeps the
	* existing token when it has not yet expired, so an unreachable refresh
	* endpoint never takes down a working session.
	*/
	async ensureFresh(account, forced = false) {
		if (this.client === void 0) return;
		const credential = account.credential;
		if (!(forced || credential.expiresAtMs <= 0 || credential.expiresAtMs <= Date.now() + REFRESH_MARGIN_MS)) return;
		const existing = this.refreshInflight.get(account.id);
		if (existing !== void 0) {
			await existing;
			return;
		}
		const run = (async () => {
			if (credential.refreshToken === "") {
				if (credential.expiresAtMs > Date.now() + 3e4) return;
				this.logger?.warn(`dsh-wtq-pool: ${account.label} token expired with no refresh token; sign in again`);
				return;
			}
			try {
				const outcome = await this.client.refreshToken(credential);
				if (account.credential !== credential) return;
				account.credential = {
					...credential,
					accessToken: outcome.accessToken,
					...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
					expiresAtMs: refreshExpiryMs(outcome.expiresInSec),
					...outcome.domain === void 0 || outcome.domain === "" ? {} : { domain: outcome.domain }
				};
				this.logger?.info?.(`dsh-wtq-pool: refreshed token for ${account.label}`);
			} catch (error) {
				if (credential.expiresAtMs > Date.now() + 3e4) this.logger?.warn?.(`dsh-wtq-pool: token refresh failed but token still valid for ${account.label}`, error);
				else this.logger?.error?.(`dsh-wtq-pool: token refresh failed and token expired for ${account.label}`, error);
			}
		})();
		this.refreshInflight.set(account.id, run);
		try {
			await run;
		} finally {
			this.refreshInflight.delete(account.id);
		}
	}
	/**
	* Mark an account (or one of its models) rate-limited.
	*
	* With `modelId`, only that model on the account is cooled — the account's
	* other models stay in rotation, matching the upstream's per-model rate
	* limit ("可切换其他模型继续使用"). Without a model id the whole account is
	* cooled, which callers should reserve for limits that truly span every model.
	*/
	penalize(accountId, resetAtMs, modelId) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) return;
		account.rateLimitHits += 1;
		const now = Date.now();
		const raw = resetAtMs !== void 0 && resetAtMs > now ? resetAtMs : now + this.cooldownMs;
		const until = Math.min(raw, now + PENALIZE_CAP_MS);
		if (modelId !== void 0 && modelId !== "") {
			account.modelCooldowns[modelId] = Math.max(account.modelCooldowns[modelId] ?? 0, until);
			this.logger?.warn(`dsh-wtq-pool: ${account.label} rate-limited on model ${modelId}; cooling that model until ${new Date(until).toISOString()}`);
			return;
		}
		account.cooldownUntilMs = Math.max(account.cooldownUntilMs, until);
		this.logger?.warn(`dsh-wtq-pool: account ${account.label} rate-limited; cooling until ${new Date(until).toISOString()}`);
	}
	/** Clear all cooldowns (account-wide and per-model), e.g. from a reset command. */
	resetCooldowns() {
		for (const account of this.accounts) {
			account.cooldownUntilMs = 0;
			account.modelCooldowns = {};
			account.rateLimitHits = 0;
		}
	}
	/** Diagnostics snapshot. Account-wide cooling count (per-model cooling excluded:
	*  the account as a whole stays usable when only one model is limited). */
	status() {
		const now = Date.now();
		return {
			count: this.accounts.length,
			cooling: this.accounts.filter((account) => account.cooldownUntilMs > now).length,
			lastScanAtMs: this.lastScanAtMs
		};
	}
};
//#endregion
//#region src/catalog.ts
/** Static fallback used before the first live catalog fetch. */
const FALLBACK_WORKBUDDY_MODELS = [
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		contextWindow: 2e5,
		maxOutputTokens: 128e3,
		supportsImages: true
	},
	{
		id: "glm-5.3-flash",
		name: "GLM-5.3-Flash",
		contextWindow: 2e5,
		maxOutputTokens: 128e3,
		supportsImages: true
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: 2e5,
		maxOutputTokens: 128e3,
		supportsImages: true
	},
	{
		id: "glm-5.1",
		name: "GLM-5.1",
		contextWindow: 2e5,
		maxOutputTokens: 128e3,
		supportsImages: false
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek-V4-Pro",
		contextWindow: 2e5,
		maxOutputTokens: 128e3,
		supportsImages: true
	},
	{
		id: "deepseek-v4-flash",
		name: "DeepSeek-V4-Flash",
		contextWindow: 2e5,
		maxOutputTokens: 128e3,
		supportsImages: true
	},
	{
		id: "kimi-k3",
		name: "Kimi-K3",
		contextWindow: 2e5,
		maxOutputTokens: 128e3,
		supportsImages: true
	},
	{
		id: "minimax-m3",
		name: "MiniMax-M3",
		contextWindow: 2e5,
		maxOutputTokens: 128e3,
		supportsImages: true
	},
	{
		id: "hy3",
		name: "Hy3",
		contextWindow: 2e5,
		maxOutputTokens: 128e3,
		supportsImages: true
	},
	{
		id: "hy4-preview",
		name: "Hy4-Preview",
		contextWindow: 1e6,
		maxOutputTokens: 128e3,
		supportsImages: true
	}
];
/** Live catalog with a static fallback behind it. */
var WorkBuddyCatalog = class {
	models = FALLBACK_WORKBUDDY_MODELS;
	/** User's model selection. Empty object = follow the catalog unfiltered. */
	selection = {};
	/** The catalog as the upstream advertises it, before any override. */
	current() {
		return this.models;
	}
	/**
	* The models the provider actually serves, after the user's selection:
	* disabled models are dropped, and each survivor carries its own override.
	*
	* An absent `enabledModelIds` means "everything" - a fresh install with no
	* saved selection must not present an empty picker.
	*/
	visible() {
		const enabled = this.selection.enabledModelIds;
		const allow = enabled === void 0 ? void 0 : new Set(enabled);
		const overrides = this.selection.overrides ?? {};
		return this.models.filter((model) => allow === void 0 || allow.has(model.id)).map((model) => applyOverride(model, overrides[model.id]));
	}
	/**
	* Replace the catalog with the upstream's own list.
	*
	* An empty list keeps what is there: a read that failed is not the upstream
	* saying it has no models, and the fallback behind this class is what a fresh
	* install starts from.
	*/
	update(models) {
		if (models.length === 0) return;
		this.models = models;
	}
	/** Replace the user's selection; the model list is rebuilt from `visible()`. */
	applySelection(selection) {
		this.selection = selection;
	}
	/** Replace the catalog from the live upstream list; keeps the fallback if empty. */
	updateFromUpstream(models) {
		this.update(catalogFromUpstream(models));
	}
};
/**
* Fold one override onto a catalog entry.
*
* A non-positive window or ceiling is ignored rather than stored: the host
* rejects a zero value, so writing one would drop the row's number entirely.
*/
function applyOverride(model, override) {
	const next = { ...model };
	if (override === void 0) return next;
	if (override.alias !== void 0) {
		const alias = override.alias.trim();
		if (alias === "") delete next.alias;
		else next.alias = alias;
	}
	if (override.contextWindow !== void 0 && override.contextWindow > 0) next.contextWindow = override.contextWindow;
	if (override.maxOutputTokens !== void 0 && override.maxOutputTokens > 0) next.maxOutputTokens = override.maxOutputTokens;
	if (override.supportsImages !== void 0) next.supportsImages = override.supportsImages;
	if (override.thinkingLevels !== void 0 && override.thinkingLevels.length > 0) next.supportedEfforts = override.thinkingLevels;
	if (override.defaultThinkingLevel !== void 0) next.defaultThinkingLevel = override.defaultThinkingLevel;
	return next;
}
/** True when the override changes at least one field, i.e. the row shows "高级". */
function hasOverride(override) {
	if (override === void 0) return false;
	return override.alias !== void 0 || override.contextWindow !== void 0 || override.maxOutputTokens !== void 0 || override.supportsImages !== void 0 || override.thinkingLevels !== void 0 || override.defaultThinkingLevel !== void 0;
}
/** Convert one upstream catalog entry into the plugin's model-info shape. */
function toModelInfo(model) {
	return {
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		supportsImages: model.supportsImages ?? false,
		...model.creditMultiplier === void 0 ? {} : { multiplier: model.creditMultiplier },
		...model.reasoning?.supportedEfforts === void 0 ? {} : { supportedEfforts: model.reasoning.supportedEfforts },
		...model.reasoning?.canDisableThinking === void 0 ? {} : { canDisableThinking: model.reasoning.canDisableThinking }
	};
}
/** Map the live upstream list, falling back to the static list when empty. */
function catalogFromUpstream(models) {
	if (models.length === 0) return FALLBACK_WORKBUDDY_MODELS;
	return models.map(toModelInfo);
}
//#endregion
//#region src/trae-sse.ts
/** Incremental SSE decoder supporting CRLF, chunk splits and multi-line data. */
/** One unterminated line may not grow without bound; chat deltas are small. */
const MAX_LINE_CHARS$1 = 8388608;
var SseDecoder = class {
	buffer = "";
	event;
	id;
	retry;
	data = [];
	push(chunk) {
		this.buffer += chunk;
		const events = [];
		while (true) {
			const match = /\r?\n/.exec(this.buffer);
			if (match === null || match.index === void 0) break;
			const line = this.buffer.slice(0, match.index);
			this.buffer = this.buffer.slice(match.index + match[0].length);
			const emitted = this.consumeLine(line);
			if (emitted !== void 0) events.push(emitted);
		}
		if (this.buffer.length > MAX_LINE_CHARS$1) {
			this.buffer = "";
			throw new Error("sse line exceeded 8388608 characters without a newline");
		}
		return events;
	}
	/** Flush a trailing event the upstream never terminated with a blank line. */
	finish() {
		const events = [];
		if (this.buffer !== "") {
			const emitted = this.consumeLine(this.buffer);
			this.buffer = "";
			if (emitted !== void 0) events.push(emitted);
		}
		const final = this.dispatch();
		if (final !== void 0) events.push(final);
		return events;
	}
	consumeLine(line) {
		if (line === "") return this.dispatch();
		if (line.startsWith(":")) return void 0;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") this.event = value;
		else if (field === "data") this.data.push(value);
		else if (field === "id" && !value.includes("\0")) this.id = value;
		else if (field === "retry" && /^\d+$/.test(value)) this.retry = Number(value);
	}
	dispatch() {
		if (this.data.length === 0) {
			this.event = void 0;
			this.retry = void 0;
			return;
		}
		const result = {
			...this.event === void 0 || this.event === "" ? {} : { event: this.event },
			data: this.data.join("\n"),
			...this.id === void 0 ? {} : { id: this.id },
			...this.retry === void 0 ? {} : { retry: this.retry }
		};
		this.event = void 0;
		this.retry = void 0;
		this.data = [];
		return result;
	}
};
/** Normalise one decoded SSE event. Never throws on malformed payloads. */
function decodeTraeEvent(event) {
	if (event.data === "[DONE]") return {
		type: "done",
		finishReason: "stop"
	};
	let payload;
	try {
		payload = JSON.parse(event.data);
	} catch {
		return {
			type: "unknown",
			...event.event === void 0 ? {} : { event: event.event },
			data: event.data
		};
	}
	const record = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {};
	if (event.event === "request_wait_in_queue") return {
		type: "queue",
		...typeof record["position"] === "number" ? { position: record["position"] } : {}
	};
	if (event.event === "progress_notice") return {
		type: "progress",
		notice: payload
	};
	if (event.event === "token_usage") return {
		type: "usage",
		...typeof record["prompt_tokens"] === "number" ? { inputTokens: record["prompt_tokens"] } : {},
		...typeof record["completion_tokens"] === "number" ? { outputTokens: record["completion_tokens"] } : {},
		...typeof record["total_tokens"] === "number" ? { totalTokens: record["total_tokens"] } : {},
		...typeof record["reasoning_tokens"] === "number" ? { reasoningTokens: record["reasoning_tokens"] } : {},
		...typeof record["cache_read_input_tokens"] === "number" ? { cacheReadTokens: record["cache_read_input_tokens"] } : {},
		...typeof record["cache_creation_input_tokens"] === "number" ? { cacheWriteTokens: record["cache_creation_input_tokens"] } : {}
	};
	const delta = {
		type: "delta",
		text: typeof record["response"] === "string" ? record["response"] : "",
		...typeof record["reasoning_content"] === "string" ? { reasoning: record["reasoning_content"] } : {},
		...record["tool_calls"] === void 0 || record["tool_calls"] === null ? {} : { toolCalls: record["tool_calls"] },
		...typeof record["finish_reason"] === "string" ? { finishReason: record["finish_reason"] } : event.event === "done" ? { finishReason: "stop" } : {}
	};
	if (delta.text !== "" || delta.reasoning !== void 0 && delta.reasoning !== "" || Array.isArray(delta.toolCalls) && delta.toolCalls.length > 0) return delta;
	if (event.event === "done" || delta.finishReason !== void 0) return {
		type: "done",
		finishReason: delta.finishReason ?? "stop"
	};
	if (event.event === "output" || record["response"] !== void 0 || record["reasoning_content"] !== void 0 || delta.toolCalls !== void 0) return delta;
	return {
		type: "unknown",
		...event.event === void 0 ? {} : { event: event.event },
		data: payload
	};
}
//#endregion
//#region src/shim.ts
/**
* Loopback OpenAI-compatible endpoint with multi-account failover.
*
* The pi-ai provider points here. Each chat request acquires an account from
* the pool; when the upstream answers with a rate limit, the shim cools that
* account down, takes the next one, and retries in the same request — so a
* `429 soft_rate` never reaches the user as a turn failure.
*
* Security model: the server binds 127.0.0.1 only, rejects a non-loopback Host
* or Origin, and caps the body. The bearer header is not a credential here — the
* real token comes from the pool — so it is only required to have the Bearer
* shape. The guards follow corrinehu/dsh-workbuddy-connect (MIT, Copyright
* (c) 2026 Corrine Hu), which designed and validated them.
*
* @module dsh-wtq-pool/shim
*/
/**
* Loopback guards and the request body bound live in `./loopback` — one copy,
* shared with the Trae and Qoder gateways.
*/
/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS = {
	hard_credit: 402,
	soft_rate: 429,
	session_dead: 401,
	waf_block: 502,
	not_found: 502,
	server: 502,
	client: 400
};
/** Stable key for one conversation: a hash of its first user message. */
function conversationKeyOf(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed.messages)) return void 0;
		for (const entry of parsed.messages) {
			if (typeof entry !== "object" || entry === null) continue;
			const message = entry;
			if (message["role"] !== "user") continue;
			const content = typeof message["content"] === "string" ? message["content"] : JSON.stringify(message["content"] ?? "");
			return createHash("sha256").update(content).digest("hex").slice(0, 32);
		}
	} catch {
		return;
	}
}
/** True when an upstream failure body means the request overran the model's
*  context window (OpenAI `context_length_exceeded`, WorkBuddy code 11115 /
*  "input length too long"). Surfaced as a friendly hint, never auto-truncated. */
function isContextTooLong(body) {
	if (body.includes("context_length_exceeded")) return true;
	if (body.includes("input length too long")) return true;
	if (body.includes("\"code\":11115")) return true;
	if (/exceeds?\s+(the\s+)?(model\s+)?context\s+(window|limit)/iu.test(body)) return true;
	return false;
}
function createWorkBuddyShim(options) {
	const { pool, client, catalog } = options;
	const region = options.region;
	const logger = options.logger;
	const maxAttempts = 8;
	const server = createServer((req, res) => {
		answerRequest(res, () => handle(req, res), logger);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(options.port ?? 0, "127.0.0.1");
	server.on("error", (error) => {
		logger?.warn?.("dsh-wtq-pool: workbuddy shim server error", error);
	});
	/** The bound port, or 0 before `listening` (or after close). */
	const port = () => {
		const address = server.address();
		return address === null || typeof address === "string" ? 0 : address.port;
	};
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("workbuddy shim has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	async function handle(req, res) {
		if (!guardsPass(req, res)) return;
		const url = req.url ?? "/";
		if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
			writeJson$1(res, 200, {
				ok: true,
				pool: pool.status()
			});
			return;
		}
		if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
			const selected = catalog.visible();
			const directory = selected.length > 0 ? selected : catalog.current();
			const ids = options.listedIds?.();
			writeJson$1(res, 200, {
				object: "list",
				data: (ids === void 0 ? directory : listedModels(directory, ids)).map((model) => ({
					id: model.id,
					object: "model",
					created: 0,
					owned_by: "workbuddy"
				}))
			});
			return;
		}
		if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
			await chatCompletions(req, res);
			return;
		}
		writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
	}
	/**
	* Serve one chat completion, rotating accounts on rate limits.
	*
	* A rate-limited account is cooled for exactly the window the upstream
	* reports (when parseable) and the next account is tried immediately, so a
	* pool with any healthy member never surfaces a 429 to the caller.
	*/
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		const controller = new AbortController();
		res.on("close", () => controller.abort());
		const raw = (await readRequestBody(req)).toString("utf8");
		const prepared = client.prepareChatBody(raw);
		const conversationKey = conversationKeyOf(raw);
		let modelId;
		try {
			const parsed = JSON.parse(raw);
			modelId = typeof parsed.model === "string" && parsed.model !== "" ? parsed.model : void 0;
		} catch {
			modelId = void 0;
		}
		if (modelId === void 0) {
			writeOpenAIError(res, 400, "invalid_request_error", "model is required");
			return;
		}
		const tried = [];
		let last;
		let exhaustedByRateLimit = false;
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			if (controller.signal.aborted) return;
			const account = await pool.acquire(modelId, region, conversationKey);
			if (account === void 0) {
				if (exhaustedByRateLimit && last !== void 0) {
					const model = modelId === void 0 ? "" : ` for model ${modelId}`;
					const subject = last.kind === "waf_block" ? "every WorkBuddy account was blocked by the upstream gateway (WAF)" : last.kind === "hard_credit" ? `every WorkBuddy account is out of credits${model}` : last.kind === "session_dead" ? `every WorkBuddy sign-in is no longer accepted${model}` : `every account is rate-limited${model}`;
					const advice = last.kind === "soft_rate" ? "resets at the upstream window" : "sign in again in the desktop app";
					writeOpenAIError(res, KIND_STATUS[last.kind], last.kind, `${subject} (tried ${tried.length}: ${tried.join(", ")}); ${advice} — ${last.message.slice(0, 200)}`);
					return;
				}
				const regionAccounts = pool.list(region);
				const switchedOff = regionAccounts.filter((account) => pool.isDisabled(account.id));
				if (regionAccounts.length > 0 && switchedOff.length === regionAccounts.length) {
					writeOpenAIError(res, 403, "accounts_switched_off", `every account for this gateway is switched off in the plugin panel (${switchedOff.map((account) => account.label).join(", ")}); switch one back on`);
					return;
				}
				if (regionAccounts.length > 0) {
					const now = Date.now();
					const resets = regionAccounts.filter((account) => !pool.isDisabled(account.id)).map((account) => Math.max(account.cooldownUntilMs, account.modelCooldowns[modelId] ?? 0));
					if (resets.every((until) => until > now)) {
						res.setHeader("Retry-After", String(Math.max(1, Math.ceil((Math.min(...resets) - now) / 1e3))));
						writeOpenAIError(res, 429, "soft_rate", `every account is rate-limited for model ${modelId}`);
					} else writeOpenAIError(res, 503, "accounts_unavailable", "no account is available within its configured credit reserve");
					return;
				}
				writeOpenAIError(res, 401, "not_signed_in", "no WorkBuddy credential found; sign in on the desktop app (or set WORKBUDDY_AUTH_FILE)");
				return;
			}
			tried.push(account.label);
			let result = await client.chatStream(account.credential, prepared, controller.signal);
			if (!result.ok && result.kind === "session_dead" && await pool.refreshAccount(account.id)) result = await client.chatStream(account.credential, prepared, controller.signal);
			if (result.ok) {
				if (result.response.body === null) {
					writeOpenAIError(res, 502, "upstream_error", "workbuddy returned no stream");
					return;
				}
				logger?.info?.(`dsh-wtq-pool: served by ${account.label}`);
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					"Connection": "keep-alive",
					"X-Accel-Buffering": "no"
				});
				let sawDone = false;
				const decoder = new TextDecoder();
				const sse = new SseDecoder();
				const body = Readable.fromWeb(result.response.body);
				body.on("error", (error) => {
					if (!controller.signal.aborted) logger?.warn("dsh-wtq-pool: upstream stream failed mid-flight", error);
					res.destroy(error instanceof Error ? error : new Error(String(error)));
				});
				body.on("end", () => {
					closeWithoutDone();
				});
				/** End the response with `[DONE]` unless the upstream already sent it. */
				function closeWithoutDone() {
					if (sawDone || !res.writable) return;
					logger?.warn?.("dsh-wtq-pool: upstream stream ended without [DONE]");
					res.end("data: [DONE]\n\n");
				}
				body.pipe(res);
				body.on("data", (chunk) => {
					try {
						if (!sse.push(decoder.decode(chunk, { stream: true })).some((event) => event.data === "[DONE]")) return;
						sawDone = true;
						body.unpipe(res);
						res.end();
						body.destroy();
					} catch (error) {
						body.destroy(error instanceof Error ? error : new Error(String(error)));
					}
				});
				return;
			}
			last = {
				kind: result.kind,
				status: result.status,
				message: result.message
			};
			/**
			* Rotate past every failure that is a property of the ACCOUNT rather than
			* of the request.
			*
			* A 429 cools one model, because the upstream itself allows switching
			* models on the same account. A WAF page, a spent billing account and a
			* dead session all speak for the whole account. Any of them left uncooled
			* stays at the head of the queue in the default `priority` mode — the
			* account is still `available()`, nothing else moved it — so every later
			* request walks straight back into the same failure while the healthy
			* accounts behind it sit idle. That was a permanent lock, not a slow
			* failure: a 402 never clears on its own, and the session-dead retry above
			* has already spent the one refresh that could fix it.
			*/
			if (result.kind !== "soft_rate" && result.kind !== "waf_block" && result.kind !== "hard_credit" && result.kind !== "session_dead") break;
			exhaustedByRateLimit = true;
			if (result.kind === "soft_rate") pool.penalize(account.id, parseRateLimitReset(result.message), modelId);
			else pool.penalize(account.id);
			logger?.warn(`dsh-wtq-pool: ${account.label} ${result.kind} on ${modelId} (attempt ${attempt + 1}/${maxAttempts}); rotating`);
		}
		if (last === void 0) {
			writeOpenAIError(res, 500, "internal", "chat request exhausted without a result");
			return;
		}
		if (isContextTooLong(last.message)) {
			writeOpenAIError(res, 400, "context_length_exceeded", `${modelId === void 0 ? "the conversation exceeds this model's context window" : `the conversation exceeds ${modelId}'s context window`}. Shorten the conversation, start a new chat, or pick a model with a larger window (e.g. hy4-preview).`);
			return;
		}
		writeOpenAIError(res, KIND_STATUS[last.kind], last.kind, `workbuddy upstream ${last.kind} (http ${last.status}) after ${tried.length} account(s) [${tried.join(" → ")}]: ${last.message.slice(0, 400)}`);
	}
	return {
		ready,
		port,
		baseUrl,
		close: () => new Promise((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		})
	};
}
//#endregion
//#region src/promo.ts
/**
* Promotions in force.
*
* Source: the WorkBuddy announcement extending Hy4-preview's night window
* (23:00-08:00 domestic, "其余时间正常消耗积分") to 2026-10-31.
*
* When a promotion is extended or a new one starts, edit this table. When one
* ends, either delete the row or let `until` lapse — both stop the badge.
*/
const PROMO_RULES = [{
	idPrefix: "hy4-preview",
	region: "cn",
	hours: [
		23,
		0,
		1,
		2,
		3,
		4,
		5,
		6,
		7
	],
	until: "2026-10-31"
}];
/** The first hour the window reopens, searching forward from `hour`. */
function nextWindowHour(rule, hour) {
	for (let step = 1; step <= 24; step += 1) {
		const candidate = (hour + step) % 24;
		if (rule.hours.includes(candidate)) return candidate;
	}
}
/** The hour the CURRENT window closes, searching forward from `hour`. */
function windowEndHour(rule, hour) {
	for (let step = 1; step <= 24; step += 1) {
		const candidate = (hour + step) % 24;
		if (!rule.hours.includes(candidate)) return candidate;
	}
	return hour;
}
/**
* The promotion status of one model at `clock`, for `region`.
*
* Returns `undefined` for a model with no promotion, for one whose price is
* already zero (the catalog says "free" and the panel already shows it, so a
* second badge would only repeat it), and for every rule whose window is not
* this model's.
*/
function promoStatusFor(model, clock, region) {
	if (model.multiplier === 0) return void 0;
	for (const rule of PROMO_RULES) {
		if (rule.region !== region) continue;
		if (!model.id.startsWith(rule.idPrefix)) continue;
		if (clock.day > rule.until) continue;
		if (rule.hours.includes(clock.hour)) return {
			kind: "night",
			untilHour: windowEndHour(rule, clock.hour)
		};
		const nextHour = nextWindowHour(rule, clock.hour);
		if (nextHour !== void 0) return {
			kind: "night-later",
			nextHour
		};
	}
}
//#endregion
//#region src/trae-discovery.ts
/**
* Trae read-only credential discovery.
*
* Finds every Trae desktop sign-in on this machine. Nothing here writes to the
* Trae apps' files; failures carry paths and error text, never token material.
*/
const TRAE_AUTH_STORAGE_KEY = "iCubeAuthInfo://icube.cloudide";
const TRAE_CLI_TOKEN_FILENAME = "trae-jwt-token";
const CLI_DEFAULT_HOST = "https://api.trae.cn";
const SALT_A = Uint8Array.from([
	82,
	9,
	106,
	213,
	48,
	54,
	165,
	56,
	191,
	64,
	163,
	158,
	129,
	243,
	215,
	251,
	124,
	227,
	57,
	130,
	155,
	47,
	255,
	135,
	52,
	142,
	67,
	68,
	196,
	222,
	233,
	203,
	84,
	123,
	148,
	50,
	166,
	194,
	35,
	61,
	238,
	76,
	149,
	11,
	66,
	250,
	195,
	78,
	8,
	46,
	161,
	102,
	40,
	217,
	36,
	178,
	118,
	91,
	162,
	73,
	109,
	139,
	209,
	37
]);
const SALT_B = Uint8Array.from([
	31,
	221,
	168,
	51,
	136,
	7,
	199,
	49,
	177,
	18,
	16,
	89,
	39,
	128,
	236,
	95,
	96,
	81,
	127,
	169,
	25,
	181,
	74,
	13,
	45,
	229,
	122,
	159,
	147,
	201,
	156,
	239,
	160,
	224,
	59,
	77,
	174,
	42,
	245,
	176,
	200,
	235,
	187,
	60,
	131,
	83,
	153,
	97,
	23,
	43,
	4,
	126,
	186,
	119,
	214,
	38,
	225,
	105,
	20,
	99,
	85,
	33,
	12,
	125
]);
const SALT_C = Uint8Array.from([
	191,
	192,
	216,
	250,
	122,
	246,
	220,
	97,
	31,
	254,
	98,
	27,
	8,
	72,
	71,
	176,
	135,
	99,
	96,
	18,
	127,
	101,
	203,
	104,
	211,
	102,
	191,
	125,
	37,
	72,
	150,
	156,
	51,
	229,
	121,
	35,
	17,
	153,
	141,
	177,
	110,
	131,
	150,
	128,
	172,
	255,
	254,
	6,
	18,
	140,
	55,
	62,
	236,
	249,
	135,
	64,
	135,
	12,
	117,
	4,
	89,
	149,
	168,
	209
]);
const SALT_D = Uint8Array.from([
	246,
	204,
	26,
	232,
	232,
	70,
	129,
	109,
	223,
	146,
	169,
	242,
	23,
	241,
	105,
	145,
	50,
	196,
	165,
	42,
	254,
	120,
	3,
	54,
	244,
	207,
	209,
	85,
	53,
	6,
	138,
	106,
	175,
	148,
	31,
	204,
	186,
	186,
	165,
	182,
	87,
	142,
	49,
	10,
	39,
	110,
	26,
	154,
	86,
	56,
	173,
	125,
	18,
	64,
	198,
	225,
	99,
	99,
	83,
	82,
	191,
	134,
	76,
	170
]);
function xor(a, b) {
	return Buffer.from(a.map((value, index) => value ^ (b[index] ?? 0)));
}
function encryptionType(header) {
	if (header.equals(Buffer.from([
		116,
		99,
		5,
		16,
		0,
		0
	]))) return "aes";
	if (header.equals(Buffer.from([
		18,
		57,
		32,
		32,
		2,
		3
	]))) return "aes-private";
	throw new Error("unsupported Trae auth encryption header");
}
/** Open one encrypted desktop auth value (reference: dsh-connect-trae decrypt.ts). */
function decryptTraeStorageValue(encoded) {
	const buffer = Buffer.from(encoded, "base64");
	if (buffer.length <= 102) throw new Error("Trae auth ciphertext is too short");
	const type = encryptionType(buffer.subarray(0, 6));
	const random = buffer.subarray(6, 38);
	const encrypted = buffer.subarray(38);
	const salt = type === "aes-private" ? xor(SALT_C, SALT_D) : xor(SALT_A, SALT_B);
	const first = createHash("sha512").update(random).digest();
	const derived = createHash("sha512").update(Buffer.concat([first, salt])).digest();
	const decipher = createDecipheriv("aes-128-cbc", derived.subarray(0, 16), derived.subarray(16, 32));
	const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
	if (decrypted.length < 64) throw new Error("Trae auth plaintext is too short");
	const expected = decrypted.subarray(0, 64);
	const plaintext = decrypted.subarray(64);
	const actual = createHash("sha512").update(plaintext).digest();
	if (!expected.equals(actual)) throw new Error("Trae auth integrity check failed");
	return plaintext.toString("utf8");
}
function parseTraeAuthValue(value) {
	const trimmed = value.trim();
	if (trimmed === "") throw new Error("Trae auth value is empty");
	const plaintext = trimmed.startsWith("{") ? trimmed : decryptTraeStorageValue(trimmed);
	return JSON.parse(plaintext);
}
function parseTraeStorageDocument(text) {
	const parsed = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Trae storage document must be an object");
	const value = parsed[TRAE_AUTH_STORAGE_KEY];
	if (typeof value !== "string") throw new Error(`Trae storage document has no ${TRAE_AUTH_STORAGE_KEY}`);
	return parseTraeAuthValue(value);
}
function decodeBase64UrlJson(segment) {
	try {
		const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
		const decoded = Buffer.from(padded, "base64").toString("utf8");
		const parsed = JSON.parse(decoded);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
/** Parse a CLI token file (bare JWT or a JSON envelope holding one). */
function parseTraeCliToken(text) {
	const trimmed = text.trim();
	if (trimmed === "") throw new Error("Trae CLI token file is empty");
	let token = trimmed;
	if (trimmed.startsWith("{")) {
		const envelope = JSON.parse(trimmed);
		const candidate = envelope["token"] ?? envelope["accessToken"] ?? envelope["jwt"];
		if (typeof candidate !== "string" || candidate.trim() === "") throw new Error("Trae CLI token document has no token field");
		token = candidate.trim();
	}
	const segments = token.split(".");
	if (segments.length !== 3 || segments.some((segment) => segment === "")) throw new Error("Trae CLI token is not a three-part JWT");
	const payload = decodeBase64UrlJson(segments[1]);
	if (payload === void 0) throw new Error("Trae CLI token payload is not decodable JSON");
	const data = typeof payload["data"] === "object" && payload["data"] !== null && !Array.isArray(payload["data"]) ? payload["data"] : void 0;
	const userId = typeof data?.["user_id"] === "string" ? data["user_id"] : void 0;
	if (userId === void 0 || userId === "") throw new Error("Trae CLI token has no data.user_id claim");
	const exp = payload["exp"];
	const expiresAtMs = typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1e3 : void 0;
	return {
		accessToken: token,
		userId,
		...expiresAtMs === void 0 ? {} : { expiresAtMs }
	};
}
/** Region for an edition label: the international installs belong to `ai`. */
function traeRegionOfEdition(edition) {
	return edition === "sg" || edition === "solo-sg" ? "ai" : "cn";
}
/** Region from the credential's `userRegion` claim (object or bare string, case-blind). */
function traeRegionOfUserRegion(value) {
	const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? value["region"] : value;
	if (typeof raw !== "string") return void 0;
	const lowered = raw.trim().toLowerCase();
	if (lowered === "cn") return "cn";
	if (lowered === "sg" || lowered === "ai") return "ai";
}
/** Region from a credential host (`.trae.ai` → ai, `.trae.cn`/`.trae.com.cn` → cn). */
function traeRegionOfHost(host) {
	if (host === void 0) return void 0;
	const trimmed = host.trim();
	if (trimmed === "") return void 0;
	let hostname;
	try {
		hostname = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`).hostname;
	} catch {
		return;
	}
	if (hostname === "trae.ai" || hostname.endsWith(".trae.ai")) return "ai";
	if (hostname === "trae.cn" || hostname.endsWith(".trae.cn") || hostname.endsWith(".trae.com.cn")) return "cn";
}
/** Region of a credential: `userRegion` wins, host suffix is the fallback, edition is last. */
function traeRegionOfCredential(credential) {
	return traeRegionOfUserRegion(credential.userRegion) ?? traeRegionOfHost(credential.host) ?? traeRegionOfEdition(credential.edition);
}
function optionalString(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
function timeToMs(value) {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value > 0xe8d4a51000 ? value : value * 1e3;
	if (typeof value !== "string" || value.trim() === "") return void 0;
	const numeric = Number(value);
	if (Number.isFinite(numeric) && numeric > 0) return numeric > 0xe8d4a51000 ? numeric : numeric * 1e3;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function userRegionOf(value) {
	const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? value["region"] : value;
	return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : void 0;
}
/** Normalize one decrypted desktop document into a credential (undefined = no usable token). */
function normalizeTraeCredential(raw, edition, source) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
	const value = raw;
	const accessToken = optionalString(value["token"]) ?? optionalString(value["accessToken"]);
	if (accessToken === void 0) return void 0;
	const account = typeof value["account"] === "object" && value["account"] !== null && !Array.isArray(value["account"]) ? value["account"] : void 0;
	return {
		accessToken,
		userId: optionalString(value["userId"]) ?? "",
		...optionalString(account?.["username"]) === void 0 ? {} : { accountName: optionalString(account?.["username"]) },
		...optionalString(account?.["email"]) === void 0 ? {} : { email: optionalString(account?.["email"]) },
		host: optionalString(value["host"]) ?? "",
		...userRegionOf(value["userRegion"]) === void 0 ? {} : { userRegion: userRegionOf(value["userRegion"]) },
		expiresAtMs: timeToMs(value["expiredAt"] ?? value["expiresAt"]) ?? 0,
		edition,
		source
	};
}
/**
* Identity of the account behind a credential, not the app that stored it.
*
* Trae CN, TraeWork CN (SOLO) and the CN CLI each keep a copy of the same
* account's sign-in. Keying on the edition made every copy a separate pool
* account: one account showed up twice (and was checked in twice).
*
* The region is part of the key, because the two regions are separate services
* with separate user-id sequences: folding a numeral that both happen to use
* into one entry drops whichever copy expires sooner, and that region's gateway
* is then left with no credential at all while this dedup reports success.
*/
function traeAccountKey(credential) {
	const region = traeRegionOfCredential(credential);
	const userId = credential.userId.trim();
	if (userId !== "") return `id:${region}:${userId}`;
	return `name:${region}\u0000${credential.accountName ?? credential.email ?? ""}`;
}
/**
* Of two copies of one account, the one to keep: the copy that can serve a
* request longest, then a desktop sign-in over a CLI token, then the copy that
* knows who the account is.
*/
function preferredTraeCredential(left, right) {
	if (left.expiresAtMs !== right.expiresAtMs) return left.expiresAtMs > right.expiresAtMs ? left : right;
	const rank = (credential) => (credential.source === "desktop" ? 2 : 0) + (credential.accountName ?? credential.email ? 1 : 0);
	return rank(left) >= rank(right) ? left : right;
}
const WINDOWS_APP_NAMES = {
	cn: ["Trae CN", "trae-cn"],
	sg: ["Trae"],
	solo: ["TRAE SOLO CN", "trae-solo-cn"],
	"solo-sg": ["TRAE SOLO"]
};
const LINUX_APP_NAMES = {
	cn: [
		"trae-cn",
		"Trae CN",
		"trae",
		"Trae"
	],
	sg: ["trae", "Trae"],
	solo: ["trae-solo-cn", "TRAE SOLO CN"],
	"solo-sg": ["trae-solo", "TRAE SOLO"]
};
const MAC_APP_NAMES = {
	cn: "Trae CN",
	sg: "Trae",
	solo: "TRAE SOLO CN",
	"solo-sg": "TRAE SOLO"
};
/** One edition's macOS app-support / bundle spelling. */
function traeMacAppName(edition) {
	return MAC_APP_NAMES[edition];
}
/**
* One edition's plausible Windows directory spellings, in probe order.
*
* Exported so the identity reader and this credential scanner probe the SAME
* names: they resolve different files in one installation (the install's
* `product.json` vs the per-user `storage.json`), so a spelling that works for
* one but not the other is a bug rather than a preference.
*/
function traeWindowsAppNames(edition) {
	return WINDOWS_APP_NAMES[edition];
}
const CLI_HOME_NAMES = [".trae-cn", ".trae"];
function traeCliCandidates(platform, home, env) {
	const roots = [];
	if (platform === "win32") {
		for (const value of [env.USERPROFILE, home]) if (typeof value === "string" && value !== "" && !roots.includes(value)) roots.push(value);
	} else roots.push(home);
	const result = [];
	for (const root of roots) for (const name of CLI_HOME_NAMES) result.push({
		edition: name === ".trae-cn" ? "cn" : "sg",
		path: join(root, name, TRAE_CLI_TOKEN_FILENAME),
		source: "cli"
	});
	return result;
}
/**
* Every Trae storage file to probe, in probe order. Missing files are normal
* (an edition that was never installed); the discover step skips them.
*/
function traeStorageCandidates(platform = process.platform, home = homedir(), env = process.env) {
	const result = [];
	for (const edition of [
		"cn",
		"sg",
		"solo",
		"solo-sg"
	]) {
		let roots;
		let appNames;
		if (platform === "darwin") {
			roots = [join(home, "Library", "Application Support")];
			appNames = [MAC_APP_NAMES[edition]];
		} else if (platform === "win32") {
			roots = [env.APPDATA, join(home, "AppData", "Roaming")].filter((value, index, all) => typeof value === "string" && value !== "" && all.indexOf(value) === index);
			appNames = WINDOWS_APP_NAMES[edition];
		} else if (platform === "linux") {
			roots = [env.XDG_CONFIG_HOME || join(home, ".config")];
			appNames = LINUX_APP_NAMES[edition];
		} else {
			roots = [];
			appNames = [MAC_APP_NAMES[edition]];
		}
		for (const root of roots) for (const appName of appNames) result.push({
			edition,
			path: join(root, appName, "User", "globalStorage", "storage.json"),
			source: "desktop"
		});
	}
	return [...result, ...traeCliCandidates(platform, home, env)];
}
function failureOf(candidate, error) {
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : void 0;
	if (code === "ENOENT") return {
		path: candidate.path,
		edition: candidate.edition,
		source: candidate.source,
		reason: "missing"
	};
	if (error instanceof Error && code !== void 0) return {
		path: candidate.path,
		edition: candidate.edition,
		source: candidate.source,
		reason: "unreadable",
		message: error.message
	};
	return {
		path: candidate.path,
		edition: candidate.edition,
		source: candidate.source,
		reason: code === void 0 ? "invalid" : "unreadable",
		message: error instanceof Error ? error.message : String(error)
	};
}
function credentialFrom(candidate, text) {
	let credential;
	if (candidate.source === "cli") {
		if (traeRegionOfEdition(candidate.edition) !== "cn") throw new Error(`Trae CLI tokens are only verified for the CN region; ${candidate.edition} CLI homes are not supported yet`);
		const claims = parseTraeCliToken(text);
		credential = normalizeTraeCredential({
			token: claims.accessToken,
			userId: claims.userId,
			host: CLI_DEFAULT_HOST,
			expiredAt: claims.expiresAtMs
		}, candidate.edition, "cli");
	} else credential = normalizeTraeCredential(parseTraeStorageDocument(text), candidate.edition, "desktop");
	if (credential === void 0) throw new Error(`${candidate.source} candidate could not be normalized into a credential`);
	return credential;
}
/**
* Read every candidate file and return deduplicated credentials. One stale,
* partially written or signed-out install never hides the others; failures are
* recorded token-free so diagnostics can explain a silent "not signed in".
*/
async function discoverTraeCredentials(candidates = traeStorageCandidates()) {
	const byAccount = /* @__PURE__ */ new Map();
	const failures = [];
	for (const candidate of candidates) {
		let text;
		try {
			text = await readFile(candidate.path, "utf8");
		} catch (error) {
			const failure = failureOf(candidate, error);
			if (failure.reason !== "missing") failures.push(failure);
			continue;
		}
		try {
			const credential = credentialFrom(candidate, text);
			const key = traeAccountKey(credential);
			const existing = byAccount.get(key);
			byAccount.set(key, existing === void 0 ? credential : preferredTraeCredential(existing, credential));
		} catch (error) {
			failures.push(failureOf(candidate, error));
		}
	}
	return {
		credentials: [...byAccount.values()],
		failures
	};
}
//#endregion
//#region src/trae-upstream.ts
/**
* Trae SOLO minimal upstream.
*
* Offline half of the Trae path: given a credential found by
* `trae-discovery.ts`, build exactly what the SOLO `llm_utils_chat` gateway
* expects — headers, endpoint and body — without sending anything. No disk
* reads here; tokens stay in the caller's memory.
*/
/** Verified gateway bases per region (reference: dsh-connect-trae region.ts). */
const REGION_GATEWAYS = {
	cn: {
		chat: "https://trae-api-cn.mchost.guru",
		remote: "https://solo.trae.cn/api/remote/v1",
		pay: "https://api.trae.cn"
	},
	ai: {
		chat: "https://coresg-normal.trae.ai",
		remote: "https://coresg-normal.trae.ai/api/remote/v1",
		pay: "https://growsg-normal.trae.ai"
	}
};
/** Default chat function; the directory may stamp a more specific owner. */
const TRAE_SOLO_FUNCTION = "solo_work_lite";
/**
* `llm_utils_chat` functions to union per region, in priority order.
* A model is only callable through the function that lists it, so the roster
* is the union and the first function to name a `config_name` wins.
*/
const TRAE_DIRECTORY_FUNCTIONS = {
	cn: [
		"solo_work_remote",
		TRAE_SOLO_FUNCTION,
		"solo_agent_remote",
		"chat_v3",
		"solo_coder"
	],
	ai: [
		"solo_work_remote",
		TRAE_SOLO_FUNCTION,
		"solo_agent_remote",
		"chat_v3"
	]
};
const TRAE_SOLO_CHAT_PATH = "/api/agent/v3/llm_utils_chat";
const TRAE_SOLO_MODELS_PATH = "/api/ide/v1/get_detail_param";
const TRAE_REASONING_EFFORTS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh"
];
/**
* Trae's own spelling for each advertised level.
*
* SOLO's `reasoning_effort` does not speak the OpenAI ladder: its values are
* `light` / `high` / `extra_high`, and a level it does not know is silently
* ignored — the model then answers at whatever its own default is, which is
* what made the picker look like it did nothing. `dsh-connect-trae` derives
* the same map from the official client and translates before sending.
*/
const TRAE_WIRE_EFFORTS = {
	minimal: "high",
	low: "light",
	medium: "high",
	high: "high",
	xhigh: "extra_high"
};
/**
* The value to put on the wire for a requested level.
*
* Translated when the model advertises the level, undefined when it does not.
* Undefined means the field is left out: a spelling SOLO ignores looks like a
* choice was made when none was. With no capability on hand the value passes
* through untouched.
*/
function traeWireEffort(requested, capability) {
	if (capability === void 0) return requested;
	const level = TRAE_REASONING_EFFORTS.find((entry) => entry === requested);
	if (level === void 0 || !capability.supported.includes(level)) return void 0;
	return TRAE_WIRE_EFFORTS[level];
}
/** Remote directory spells the same three levels as `light` / `high` / `extra_high`. */
const TRAE_HOST_FROM_WIRE = {
	light: "low",
	high: "high",
	extra_high: "xhigh"
};
function asTraeEffort(value) {
	if (typeof value !== "string") return void 0;
	if (TRAE_REASONING_EFFORTS.includes(value)) return value;
	return TRAE_HOST_FROM_WIRE[value];
}
/**
* Read advertised reasoning efforts from a directory row.
*
* `get_detail_param` does not carry this. The remote `/models` row does, as
* `reasoning_effort_config.options` in Trae's own spelling. A host-name list
* under `reasoning_effort_options` is still accepted.
*/
function parseTraeReasoningCapability(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const record = value;
	const config = typeof record["reasoning_effort_config"] === "object" && record["reasoning_effort_config"] !== null && !Array.isArray(record["reasoning_effort_config"]) ? record["reasoning_effort_config"] : void 0;
	const rawOptions = [...Array.isArray(record["reasoning_effort_options"]) ? record["reasoning_effort_options"] : [], ...Array.isArray(config?.["options"]) ? config["options"] : []];
	const supported = [];
	for (const item of rawOptions) {
		const effort = asTraeEffort(item);
		if (effort !== void 0 && !supported.includes(effort)) supported.push(effort);
	}
	const defaultEffort = asTraeEffort(record["default_reasoning_effort"] ?? config?.["default_level"]);
	const resolvedDefault = defaultEffort !== void 0 && supported.includes(defaultEffort) ? defaultEffort : void 0;
	if (supported.length === 0) return void 0;
	return {
		supported,
		...resolvedDefault === void 0 ? {} : { defaultEffort: resolvedDefault }
	};
}
/**
* Reasoning tables from a remote `/models` payload, keyed by model `name`.
* The first group to name an id wins; the groups agree on these facts.
*/
function collectTraeRemoteReasoning(groups) {
	const byId = /* @__PURE__ */ new Map();
	for (const group of groups) {
		if (typeof group !== "object" || group === null) continue;
		const models = group["models"];
		if (!Array.isArray(models)) continue;
		for (const raw of models) {
			if (typeof raw !== "object" || raw === null) continue;
			const record = raw;
			const id = typeof record["name"] === "string" ? record["name"] : "";
			if (id === "" || byId.has(id)) continue;
			const reasoning = parseTraeReasoningCapability(record);
			if (reasoning !== void 0) byId.set(id, reasoning);
		}
	}
	return byId;
}
/**
* Numeric version code sent when the persisted build version is not a plain
* integer. The upstream binds `x-app-version-code` as a number: a dotted
* build string (observed `2.3.76922` on TRAE SOLO CN) is rejected with
* `4001 ... parameter type does not match binding data`.
*/
const TRAE_VERSION_CODE_FALLBACK = "20260716";
/** Keep a purely numeric build version; fall back when it cannot bind. */
function normalizeTraeVersionCode(buildVersion) {
	if (buildVersion === void 0 || buildVersion.trim() === "") return TRAE_VERSION_CODE_FALLBACK;
	const trimmed = buildVersion.trim();
	return /^\d+$/.test(trimmed) ? trimmed : TRAE_VERSION_CODE_FALLBACK;
}
/** Join a gateway base and an API path without doubling slashes. */
function traeEndpoint(baseUrl, path) {
	return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
/** Headers derived from persisted identity, never a new random identity per request. */
function traeIdentityHeaders(identity) {
	return {
		"x-machine-id": identity.machineId,
		"x-device-id": identity.deviceId,
		"x-device-type": identity.platform === "darwin" ? "mac" : identity.platform === "win32" ? "windows" : identity.platform,
		...identity.deviceBrand === void 0 ? {} : { "x-device-brand": identity.deviceBrand },
		...identity.deviceCpu === void 0 ? {} : { "x-device-cpu": identity.deviceCpu },
		...identity.osVersion === void 0 ? {} : { "x-os-version": identity.osVersion },
		...identity.appVersion === void 0 ? {} : {
			"x-app-version": identity.appVersion,
			"x-ide-version": identity.appVersion
		},
		...identity.buildVersion === void 0 ? {} : {
			"x-app-version-code": identity.buildVersion,
			"x-ide-version-code": identity.buildVersion
		},
		"x-ide-version-type": "stable"
	};
}
/**
* Headers shared by every Trae edition. The same shape is accepted by both
* gateways (identical `x-app-id`, identity headers, and `Cloud-IDE-JWT` auth).
*/
function buildTraeHeaders(credential, identity, options = {}) {
	const requestId = options.requestId ?? randomUUID();
	const traceId = requestId.replaceAll("-", "").slice(0, 32);
	return {
		"Authorization": `Cloud-IDE-JWT ${credential.accessToken}`,
		"X-Ide-Token": credential.accessToken,
		"x-plugin-channel": "icube-ai",
		"User-Agent": `Trae/${identity.appVersion ?? identity.buildVersion ?? "unknown"}`,
		"x-app-id": options.appId ?? "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
		...traeIdentityHeaders(identity),
		"x-app-version-code": normalizeTraeVersionCode(identity.buildVersion),
		"x-ide-version-code": normalizeTraeVersionCode(identity.buildVersion),
		"x-custom-trace-id": traceId,
		"x-flow-traceparent": `04-${traceId}-${traceId.slice(0, 16)}-01`,
		"request-traffic-type": "prod",
		"Content-Type": "application/json",
		"X-Cloudide-Token": credential.accessToken,
		"x-uid": credential.userId,
		"x-request-id": requestId,
		"x-trae-request-id": requestId,
		"Accept": "text/event-stream"
	};
}
/**
* Build the evidenced `llm_utils_chat` envelope. The endpoint is not
* OpenAI-compatible, so only its own fields are sent: optional Pi/OpenAI
* fields (temperature, max_tokens, tool_choice, …) would fail validation.
*/
function prepareSoloBody(source, defaultModel = "glm-5.2", functionName, capability) {
	const input = JSON.parse(source);
	const model = typeof input["model"] === "string" && input["model"].trim() !== "" ? input["model"].trim() : defaultModel;
	const wireEffort = typeof input["reasoning_effort"] === "string" ? traeWireEffort(input["reasoning_effort"], capability) : void 0;
	const body = {
		...Array.isArray(input["messages"]) ? { messages: input["messages"] } : {},
		model,
		config_name: model,
		function: functionName ?? "solo_work_lite",
		stream: true,
		...Array.isArray(input["tools"]) ? { tools: input["tools"] } : {},
		...wireEffort === void 0 ? {} : { reasoning_effort: wireEffort }
	};
	if (Array.isArray(body["messages"])) for (const raw of body["messages"]) {
		if (typeof raw !== "object" || raw === null) continue;
		const message = raw;
		if (message["role"] === "developer") message["role"] = "system";
		if (typeof message["content"] === "string") message["content"] = [{
			type: "text",
			text: message["content"]
		}];
		if (message["role"] === "assistant" && Array.isArray(message["tool_calls"])) for (const rawCall of message["tool_calls"]) {
			if (typeof rawCall !== "object" || rawCall === null) continue;
			const call = rawCall;
			if (typeof call["function"] === "object" && call["function"] !== null) {
				call["function_call"] = call["function"];
				delete call["function"];
			}
		}
		if (message["role"] === "tool") {
			if (typeof message["tool_call_id"] !== "string" || message["tool_call_id"] === "") throw new Error("Trae SOLO tool message requires tool_call_id");
		}
	}
	if (Array.isArray(body["tools"])) for (const raw of body["tools"]) {
		if (typeof raw !== "object" || raw === null) continue;
		const fn = raw["function"];
		if (typeof fn !== "object" || fn === null) continue;
		const record = fn;
		if (typeof record["parameters"] === "object" && record["parameters"] !== null) record["parameters"] = JSON.stringify(record["parameters"]);
	}
	return JSON.stringify(body);
}
/** Map an HTTP status onto the failure class the future shim answers with. */
function classifyTraeUpstreamError(status) {
	if (status === 401 || status === 403) return "authentication";
	if (status === 402) return "hard_credit";
	if (status === 429) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	return "client";
}
function finitePositive(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
/**
* Read the effective credit multiplier from a `get_detail_param` row.
* The rate the Trae IDE renders lives in `display_contact_config` — a string
* holding a second JSON document — and its `consumption_rate.data.rate` is
* already the post-discount value. Rows without the field keep no multiplier.
*/
function wireCreditMultiplier(config) {
	const raw = config["display_contact_config"];
	if (typeof raw !== "string" || raw === "") return void 0;
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null) return void 0;
	const consumption = parsed["consumption_rate"];
	if (typeof consumption !== "object" || consumption === null) return void 0;
	const entry = consumption;
	if (entry["enable"] !== true) return void 0;
	const data = entry["data"];
	if (typeof data !== "object" || data === null) return void 0;
	return finitePositive(data["rate"]);
}
/**
* Merge one directory function's config list into the shared catalogue.
* First function to list a `config_name` owns it, so precedence follows
* `TRAE_DIRECTORY_FUNCTIONS` order. Pure: no network, no token logging.
*/
function collectTraeSoloModels(list, directoryFunction, byId) {
	for (const raw of list) {
		if (typeof raw !== "object" || raw === null) continue;
		const config = raw;
		const id = typeof config["config_name"] === "string" ? config["config_name"] : "";
		if (id === "") continue;
		const display = typeof config["display_config"] === "object" && config["display_config"] !== null ? config["display_config"] : {};
		const details = Array.isArray(config["model_detail_list"]) ? config["model_detail_list"] : [];
		const detail = typeof details[0] === "object" && details[0] !== null ? details[0] : {};
		const contextWindow = finitePositive((typeof config["context_window_tokens"] === "object" && config["context_window_tokens"] !== null ? config["context_window_tokens"] : {})["dev"]) ?? finitePositive(detail["prompt_max_tokens"]);
		const maxTokens = finitePositive(detail["max_tokens"]);
		const reasoning = parseTraeReasoningCapability({
			...config,
			...detail
		});
		const creditMultiplier = wireCreditMultiplier(config);
		const multimodal = display["multimodal"];
		if (byId.has(id)) continue;
		byId.set(id, {
			id,
			name: typeof display["display_name"] === "string" && display["display_name"] !== "" ? display["display_name"] : id,
			...contextWindow === void 0 ? {} : { contextWindow },
			...maxTokens === void 0 ? {} : { maxTokens },
			...reasoning === void 0 ? {} : { reasoning },
			...creditMultiplier === void 0 ? {} : { creditMultiplier },
			...typeof multimodal === "boolean" ? { supportsImages: multimodal } : {},
			function: directoryFunction
		});
	}
}
/** Daily check-in endpoints on the CN pay host (`REGION_GATEWAYS.cn.pay`). */
const TRAE_CHECKIN_STATUS_PATH = "/trae/api/v2/ug/checkin_credits/status";
const TRAE_CHECKIN_CLAIM_PATH = "/trae/api/v2/ug/checkin_credits/claim";
/**
* Headers the check-in endpoints are proven with. `x-device-id` must be the
* persisted 16-digit device number: a GUID answers 9074 ("too many
* participants"), so it comes from `identity`, never from a fresh value.
*/
function traeCheckinHeaders(credential, identity, region = "cn") {
	return {
		"Authorization": `Cloud-IDE-JWT ${credential.accessToken}`,
		"X-User-Region": region,
		"x-device-id": identity.deviceId,
		"Content-Type": "application/json",
		"Accept": "application/json"
	};
}
/**
* The international pay host's subscription answer.
*
* Measured 2026-10-07: it accepts any `X-User-Region` spelling, so the header
* follows the credential's own region rather than pretending to be CN.
*/
const TRAE_PAY_STATUS_PATH = "/trae/api/v1/pay/ide_user_pay_status";
/** Parse the `ide_user_pay_status` answer; never throws on a thin payload. */
function traePayStatusOf(payload) {
	const record = payload !== null && typeof payload === "object" ? payload : {};
	const identity = typeof record["user_pay_identity"] === "number" && Number.isFinite(record["user_pay_identity"]) ? record["user_pay_identity"] : -1;
	const named = typeof record["user_pay_identity_str"] === "string" ? record["user_pay_identity_str"].trim() : "";
	const trial = record["trial_status"] !== null && typeof record["trial_status"] === "object" ? record["trial_status"] : {};
	return {
		plan: named !== "" ? named : identity === 0 ? "Free" : identity > 0 ? `Plan ${identity}` : "",
		inTrial: trial["is_in_trial"] === true
	};
}
/** The usage endpoint with the verified totals (`POST /trae/api/v2/pay/web_user_ent_usage`). */
const TRAE_USAGE_PATH = "/trae/api/v2/pay/web_user_ent_usage";
/** True for a pack that carries credits at all: entitlement packs do not. */
function traeCreditLimitOf(record) {
	const base = record["entitlement_base_info"];
	if (base === null || typeof base !== "object" || Array.isArray(base)) return void 0;
	const quota = base["quota"];
	const limit = quota !== null && typeof quota === "object" && !Array.isArray(quota) ? traeNumber(quota["credits_limit"], NaN) : NaN;
	return Number.isFinite(limit) && limit > 0 ? limit : void 0;
}
/** The pool's own name, the way the app's usage page labels it. */
function traePackNameOf(pack, base) {
	const group = typeof pack["group_name"] === "string" ? pack["group_name"].trim() : "";
	if (group !== "") return group;
	const extra = base["product_extra"];
	const named = extra !== null && typeof extra === "object" && !Array.isArray(extra) ? extra["package_extra"] : void 0;
	const packageName = named !== null && typeof named === "object" && !Array.isArray(named) ? named["package_name"] : void 0;
	if (typeof packageName === "string" && packageName.trim() !== "") return packageName.trim();
	const described = typeof pack["display_desc"] === "string" ? pack["display_desc"].trim() : "";
	return described === "" ? "credits" : described;
}
/**
* Read the entitlement packs; the answer holds the account's only per-pool
* expiry, and the daily check-in reward is one of them. A hidden pack, a pack
* with no credits and a pack that is used up all drop out: the card shows what
* is spendable, and the totals above already answer the account-wide question.
*/
function traeCreditPacksOf(payload) {
	const list = (payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {})["user_entitlement_pack_list"];
	if (!Array.isArray(list)) return [];
	const packs = [];
	for (const entry of list) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const pack = entry;
		if (pack["is_hide"] === true) continue;
		const total = traeCreditLimitOf(pack);
		if (total === void 0) continue;
		const usage = pack["usage"];
		const consumed = usage !== null && typeof usage === "object" && !Array.isArray(usage) ? traeNumber(usage["credits_amount"], 0) : 0;
		const remaining = Math.max(0, total - consumed);
		if (remaining <= 0) continue;
		const base = pack["entitlement_base_info"];
		const expiresAt = traeNumber(pack["expire_time"], 0);
		packs.push({
			name: traePackNameOf(pack, base),
			remaining,
			total,
			...expiresAt > 0 ? { expiresAtMs: expiresAt * 1e3 } : {}
		});
	}
	return packs;
}
/** Parse one usage payload; missing digits fail loudly instead of showing 0. */
function traeUsageSummaryOf(payload) {
	const summary = (payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {})["usage_summary"];
	const record = summary !== null && typeof summary === "object" && !Array.isArray(summary) ? summary : {};
	const total = traeNumber(record["total_amount"], NaN);
	const consumed = traeNumber(record["consumed_amount"], NaN);
	if (!Number.isFinite(total) || !Number.isFinite(consumed)) throw new Error("Trae usage answer has no usable totals");
	return {
		remainingAmount: Math.max(0, total - consumed),
		packs: traeCreditPacksOf(payload)
	};
}
function traeNumber(value, fallback) {
	const n = typeof value === "string" && value.trim() !== "" ? Number(value) : typeof value === "number" ? value : NaN;
	return Number.isFinite(n) ? n : fallback;
}
function traeFlag(value) {
	return value === true || value === "true";
}
/** Read a check-in answer; numbers and booleans may arrive as strings. */
function traeCheckinStatusOf(payload) {
	const record = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
	return {
		enable: traeFlag(record["enable"]),
		checkedIn: traeFlag(record["checked_in"]),
		didCheckedIn: traeFlag(record["did_checked_in"]),
		credits: traeNumber(record["credits"], 0),
		extraCredits: traeNumber(record["extra_credits"], 0),
		code: traeNumber(record["code"], -1),
		...typeof record["message"] === "string" ? { message: record["message"] } : {}
	};
}
/**
* Trae SOLO upstream client: chat, the pay surface and the check-in status.
* `fetchImpl` is injectable for offline checks.
*/
var TraeSoloUpstreamClient = class {
	options;
	fetchImpl;
	constructor(options) {
		this.options = options;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}
	/**
	* Read the callable roster for this credential's region. Every function in
	* `TRAE_DIRECTORY_FUNCTIONS` is asked in order and their answers unioned;
	* one function failing never hides the others' rosters.
	*/
	async fetchModels(signal) {
		const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);
		const region = traeRegionOfCredential(credential);
		const base = this.options.baseUrl ?? REGION_GATEWAYS[region].chat;
		const headers = {
			...buildTraeHeaders(credential, identity),
			Accept: "application/json"
		};
		const byId = /* @__PURE__ */ new Map();
		const failures = [];
		for (const directoryFunction of TRAE_DIRECTORY_FUNCTIONS[region]) {
			let list;
			try {
				const response = await this.fetchImpl(traeEndpoint(base, TRAE_SOLO_MODELS_PATH), {
					redirect: "error",
					method: "POST",
					headers,
					body: JSON.stringify({
						function: directoryFunction,
						config_names: null,
						need_prompt: false,
						current_config_info: null,
						poly_prompt: true,
						mode_type: null,
						agent_type: null
					}),
					signal: signal ?? AbortSignal.timeout(3e4)
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const document = await response.json();
				list = Array.isArray(document["config_info_list"]) ? document["config_info_list"] : [];
			} catch (error) {
				failures.push(`${directoryFunction}: ${String(error).slice(0, 80)}`);
				continue;
			}
			collectTraeSoloModels(list, directoryFunction, byId);
		}
		const models = [...byId.values()];
		if (models.length === 0) throw new Error(`Trae SOLO models response contained no models (${failures.join("; ") || "empty directory"})`);
		const reasoning = await this.readRemoteReasoning(credential, region, signal);
		for (const model of models) {
			if (model.reasoning !== void 0) continue;
			const found = reasoning.get(model.id);
			if (found !== void 0) model.reasoning = found;
		}
		return models;
	}
	/**
	* Reasoning tables live on the remote model directory, not on
	* `get_detail_param`. A failure here leaves the roster callable and the
	* picker with no levels, rather than failing model discovery.
	*/
	async readRemoteReasoning(credential, region, signal) {
		const dressing = region === "ai" ? {
			referer: "https://coresg-normal.trae.ai/",
			timezone: "Asia/Singapore",
			language: "en"
		} : {
			referer: "https://solo.trae.cn/",
			timezone: "Asia/Shanghai",
			language: "zh-cn"
		};
		try {
			const response = await this.fetchImpl(`${REGION_GATEWAYS[region].remote}/models?functions=${TRAE_DIRECTORY_FUNCTIONS[region].join(",")}`, {
				redirect: "error",
				headers: {
					"Authorization": `Cloud-IDE-JWT ${credential.accessToken}`,
					"Content-Type": "application/json",
					"x-trae-client-type": "web",
					"x-trae-user-timezone": dressing.timezone,
					"x-preferenced-language": dressing.language,
					"Referer": dressing.referer
				},
				signal: signal ?? AbortSignal.timeout(3e4)
			});
			if (!response.ok) return /* @__PURE__ */ new Map();
			return collectTraeRemoteReasoning((await response.json()).data?.list ?? []);
		} catch {
			return /* @__PURE__ */ new Map();
		}
	}
	/** Today's check-in state for this credential (CN only). */
	async fetchCheckinStatus(signal) {
		return this.postCheckin(TRAE_CHECKIN_STATUS_PATH, signal);
	}
	/** Totals for this account (CN only): what the card shows as remaining. */
	async fetchUsageSummary(signal) {
		const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);
		if (traeRegionOfCredential(credential) !== "cn") throw new Error("Trae usage exists on CN only");
		const response = await this.fetchImpl(traeEndpoint(REGION_GATEWAYS.cn.pay, TRAE_USAGE_PATH), {
			redirect: "error",
			method: "POST",
			headers: traeCheckinHeaders(credential, identity),
			body: JSON.stringify({ require_usage: true }),
			signal: signal ?? AbortSignal.timeout(3e4)
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`Trae usage failed: HTTP ${response.status} ${text.slice(0, 200)}`);
		let payload;
		try {
			payload = JSON.parse(text);
		} catch {
			throw new Error(`Trae usage: response is not valid JSON — ${text.slice(0, 200) || "(empty)"}`);
		}
		return traeUsageSummaryOf(payload);
	}
	/**
	* This account's subscription plan (international only).
	*
	* The ai region is subscription-based: it has no Work-credit totals, so the
	* plan name is the figure its card shows. CN never calls this.
	*/
	async fetchPayStatus(signal) {
		const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);
		const region = traeRegionOfCredential(credential);
		if (region !== "ai") throw new Error("Trae pay status exists on the international region only");
		const response = await this.fetchImpl(traeEndpoint(this.options.baseUrl ?? REGION_GATEWAYS[region].pay, TRAE_PAY_STATUS_PATH), {
			redirect: "error",
			method: "POST",
			headers: traeCheckinHeaders(credential, identity, region),
			body: "{}",
			signal: signal ?? AbortSignal.timeout(3e4)
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`Trae pay status failed: HTTP ${response.status} ${text.slice(0, 200)}`);
		let payload;
		try {
			payload = JSON.parse(text);
		} catch {
			throw new Error(`Trae pay status: response is not valid JSON — ${text.slice(0, 200) || "(empty)"}`);
		}
		return traePayStatusOf(payload);
	}
	/**
	* Claim today's check-in (CN only). The answer carries no gained amount —
	* read the status again afterwards if the number matters.
	*/
	async claimCheckin(signal) {
		return this.postCheckin(TRAE_CHECKIN_CLAIM_PATH, signal);
	}
	async postCheckin(path, signal) {
		const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);
		if (traeRegionOfCredential(credential) !== "cn") throw new Error("Trae check-in exists on CN only");
		const response = await this.fetchImpl(traeEndpoint(REGION_GATEWAYS.cn.pay, path), {
			redirect: "error",
			method: "POST",
			headers: traeCheckinHeaders(credential, identity),
			body: "{}",
			signal: signal ?? AbortSignal.timeout(3e4)
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`Trae check-in failed: HTTP ${response.status} ${text.slice(0, 200)}`);
		let payload;
		try {
			payload = JSON.parse(text);
		} catch {
			throw new Error(`Trae check-in: response is not valid JSON — ${text.slice(0, 200) || "(empty)"}`);
		}
		return traeCheckinStatusOf(payload);
	}
	/** Send one chat body through the credential's regional gateway. */
	async chatStream(bodyJson, signal, functionName, capability) {
		let prepared;
		try {
			prepared = prepareSoloBody(bodyJson, void 0, functionName, capability);
		} catch {
			return {
				ok: false,
				status: 400,
				kind: "client",
				message: "invalid JSON request"
			};
		}
		const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);
		const headers = buildTraeHeaders(credential, identity);
		const base = this.options.baseUrl ?? REGION_GATEWAYS[traeRegionOfCredential(credential)].chat;
		let response;
		try {
			response = await this.fetchImpl(traeEndpoint(base, TRAE_SOLO_CHAT_PATH), {
				redirect: "error",
				method: "POST",
				headers,
				body: prepared,
				signal: signal === void 0 ? AbortSignal.timeout(12e4) : AbortSignal.any([signal, AbortSignal.timeout(12e4)])
			});
		} catch (error) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `transport error: ${String(error)}`
			};
		}
		if (response.ok) return {
			ok: true,
			response
		};
		const text = (await response.text().catch(() => "")).slice(0, 1024);
		return {
			ok: false,
			status: response.status,
			kind: classifyTraeUpstreamError(response.status),
			message: text || `Trae SOLO returned HTTP ${response.status}`
		};
	}
};
//#endregion
//#region src/trae-shim.ts
/**
* Trae SOLO ↔ OpenAI relay translation.
*
* The layer that makes a Trae model answer an OpenAI client: it translates the
* request envelope, then translates the answer back. `src/shim.ts` — which is
* bound to the WorkBuddy pool, upstream client and catalog — is untouched by
* this.
*/
/** Trae's tool calls arrive under either `function_call` or `function`. */
function normalizeTraeToolCalls(value) {
	if (!Array.isArray(value)) return [];
	const calls = [];
	for (const raw of value) {
		if (typeof raw !== "object" || raw === null) continue;
		const record = raw;
		const rawFunction = typeof record["function_call"] === "object" && record["function_call"] !== null ? record["function_call"] : typeof record["function"] === "object" && record["function"] !== null ? record["function"] : {};
		const fn = {
			...typeof rawFunction["name"] === "string" ? { name: rawFunction["name"] } : {},
			...typeof rawFunction["arguments"] === "string" ? { arguments: rawFunction["arguments"] } : {}
		};
		calls.push({
			index: typeof record["index"] === "number" ? record["index"] : calls.length,
			...typeof record["id"] === "string" ? { id: record["id"] } : {},
			...record["type"] === "function" ? { type: "function" } : {},
			...Object.keys(fn).length === 0 ? {} : { function: fn }
		});
	}
	return calls;
}
/** Recognise the failure Trae hides in an otherwise healthy stream. */
function traeFailureOf(decoded) {
	if (decoded.type !== "unknown") return void 0;
	const payload = decoded.data;
	const code = typeof payload?.["code"] === "number" ? payload["code"] : void 0;
	if (decoded.event !== "error" && !(code !== void 0 && code >= 4e3)) return void 0;
	return {
		...code === void 0 ? {} : { code },
		message: typeof payload?.["message"] === "string" ? payload["message"] : "",
		...payload?.["extra"] === void 0 ? {} : { extra: payload["extra"] }
	};
}
/**
* A readable message for a failure. Trae's own text is often a generic apology
* that contradicts the code, so it rides along as detail rather than becoming
* the message.
*/
function describeTraeFailure(failure) {
	const parts = [];
	if (failure.code !== void 0) parts.push(`code ${failure.code}`);
	if (failure.extra !== void 0) {
		const extra = typeof failure.extra === "string" ? failure.extra : JSON.stringify(failure.extra);
		if (extra !== "") parts.push(extra.slice(0, 200));
	}
	const detail = failure.message.trim();
	return redactSecrets(detail === "" ? parts.join(" · ") : `${parts.join(" · ")} · upstream: ${detail}`);
}
/**
* HTTP status + error kind for an in-stream failure.
*
* `1005` is a subscription gate: 402 is what makes a client stop rather than
* retry, and it is truthful.
*
* Everything else follows the class of Trae's own code. Trae reports its
* outages inside the stream, on the same `event: error` frame a bad request
* uses, so flattening all of them to 400 told a client that a dead upstream was
* its own fault - and a client retries 5xx, never 400. The codes are >= 4000 on
* the wire, so the leading digit is the class. A frame with no code at all is
* upstream's fault too: there is no client mistake the gateway could name.
*/
function classifyTraeFailure(failure) {
	if (failure.code === 1005) return {
		status: 402,
		kind: "hard_credit"
	};
	const code = failure.code;
	if (code === void 0) return {
		status: 502,
		kind: "server"
	};
	if (code >= 5e3) return {
		status: 502,
		kind: "server"
	};
	if (code >= 4290 && code < 4300) return {
		status: 429,
		kind: "client"
	};
	return {
		status: 400,
		kind: "client"
	};
}
/**
* Translate a Trae byte stream into an OpenAI chat-completion SSE stream.
*
* Terminal behaviour is the part worth stating: Trae may send both an `event:
* done` and a trailing `[DONE]`, so exactly one finish chunk goes out; a clean
* EOF with no done event still gets one, because a client waits for a non-null
* `finish_reason` before it stops; and exactly one `data: [DONE]` closes it.
*/
function bridgeTraeStream(source, model, options = {}) {
	const id = options.id ?? `chatcmpl-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
	const created = options.created ?? Math.floor(Date.now() / 1e3);
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const sse = new SseDecoder();
	const reader = source.getReader();
	let cancelled = false;
	let sawToolCalls = false;
	let emittedFinishReason = false;
	let upstreamDone = false;
	let usage;
	const chunk = (delta, finishReason = null) => encoder.encode(`data: ${JSON.stringify({
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: delta === null ? [] : [{
			index: 0,
			delta,
			finish_reason: finishReason
		}],
		...usage === void 0 ? {} : { usage }
	})}\n\n`);
	let started = false;
	const roleChunk = (controller) => {
		if (started) return;
		started = true;
		controller.enqueue(chunk({
			role: "assistant",
			content: ""
		}));
	};
	const consume = (event, controller) => {
		if (cancelled) return;
		const decoded = decodeTraeEvent(event);
		if (decoded.type === "done" || event.event === "done") upstreamDone = true;
		if (decoded.type === "unknown") {
			const failure = traeFailureOf(decoded);
			if (failure !== void 0) throw new Error(describeTraeFailure(failure));
			return;
		}
		if (decoded.type === "delta") {
			const delta = {};
			if (decoded.text !== "") delta["content"] = decoded.text;
			if (decoded.reasoning !== void 0 && decoded.reasoning !== "") delta["reasoning_content"] = decoded.reasoning;
			const toolCalls = normalizeTraeToolCalls(decoded.toolCalls);
			if (toolCalls.length > 0) {
				sawToolCalls = true;
				delta["tool_calls"] = toolCalls;
			}
			if (Object.keys(delta).length > 0) {
				roleChunk(controller);
				controller.enqueue(chunk(delta));
			}
			if (decoded.finishReason === void 0) return;
		}
		if (decoded.type === "usage") {
			const details = {
				...decoded.cacheReadTokens === void 0 ? {} : { cached_tokens: decoded.cacheReadTokens },
				...decoded.cacheWriteTokens === void 0 ? {} : { cache_write_tokens: decoded.cacheWriteTokens }
			};
			usage = {
				...decoded.inputTokens === void 0 ? {} : { prompt_tokens: decoded.inputTokens },
				...decoded.outputTokens === void 0 ? {} : { completion_tokens: decoded.outputTokens },
				...decoded.totalTokens === void 0 ? {} : { total_tokens: decoded.totalTokens },
				...Object.keys(details).length === 0 ? {} : { prompt_tokens_details: details }
			};
			if (emittedFinishReason) controller.enqueue(chunk(null));
			return;
		}
		if (decoded.type !== "done" && decoded.type !== "delta") return;
		if (emittedFinishReason) return;
		emittedFinishReason = true;
		controller.enqueue(chunk({}, sawToolCalls ? "tool_calls" : decoded.finishReason || "stop"));
	};
	return new ReadableStream({
		async start(controller) {
			try {
				while (!cancelled) {
					const next = await reader.read();
					if (cancelled) return;
					if (next.done) break;
					for (const event of sse.push(decoder.decode(next.value, { stream: true }))) consume(event, controller);
					if (upstreamDone) break;
				}
				if (cancelled) return;
				for (const event of sse.finish()) consume(event, controller);
				if (!emittedFinishReason) {
					emittedFinishReason = true;
					controller.enqueue(chunk({}, sawToolCalls ? "tool_calls" : "stop"));
				}
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			} catch (error) {
				if (cancelled) controller.error(error);
				else {
					if (!(error instanceof Error && error.name === "AbortError")) options.onFailure?.(error);
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({
						id,
						object: "chat.completion.chunk",
						created,
						model,
						choices: [],
						error: {
							message: redactSecrets(error instanceof Error ? error.message : String(error)),
							type: "upstream_error"
						}
					})}\n\n`));
					if (!emittedFinishReason) {
						emittedFinishReason = true;
						controller.enqueue(chunk({}, sawToolCalls ? "tool_calls" : "stop"));
					}
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				}
			} finally {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
		},
		cancel(reason) {
			cancelled = true;
			return reader.cancel(reason);
		}
	});
}
/** How far {@link openTraeResponse} reads before giving up on finding a failure. */
const PEEK_MAX_CHUNKS$1 = 64;
const PEEK_MAX_BYTES$1 = 262144;
/** Replay the bytes the peek consumed, then drain the rest of the upstream. */
function replaySource$1(buffered, reader, ended) {
	let index = 0;
	return new ReadableStream({
		async pull(controller) {
			const chunk = buffered[index];
			if (chunk !== void 0) {
				index += 1;
				controller.enqueue(chunk);
				return;
			}
			if (ended) {
				controller.close();
				return;
			}
			const next = await reader.read();
			if (next.done) {
				controller.close();
				return;
			}
			controller.enqueue(next.value);
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => {});
		}
	});
}
/**
* Turn one gateway response into something an OpenAI client can consume.
*
* A non-2xx answer becomes a JSON error. A 2xx answer is peeked briefly: a
* failure that arrives before any output is turned into a real HTTP error
* rather than a 200 stream that ends empty, and everything peeked is replayed
* so no output is lost.
*/
async function openTraeResponse(response, model, options = {}) {
	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).slice(0, 1024);
		return Response.json({ error: {
			message: detail === "" ? `Trae SOLO returned HTTP ${response.status}` : detail,
			type: "upstream_error",
			code: response.status
		} }, { status: response.status });
	}
	const source = response.body;
	if (source === null) return Response.json({ error: {
		message: `Trae SOLO response ${response.status} carried no body`,
		type: "upstream_error",
		code: 502
	} }, { status: 502 });
	const reader = source.getReader();
	const decoder = new TextDecoder();
	const sse = new SseDecoder();
	const buffered = [];
	let bufferedBytes = 0;
	let sawOutput = false;
	let failure;
	let ended = false;
	let terminal = false;
	const inspect = (events) => {
		for (const event of events) {
			const decoded = decodeTraeEvent(event);
			terminal ||= decoded.type === "done" || event.event === "done";
			if (decoded.type === "delta" && (decoded.text !== "" || decoded.reasoning !== void 0 && decoded.reasoning !== "" || normalizeTraeToolCalls(decoded.toolCalls).length > 0)) sawOutput = true;
			failure ??= traeFailureOf(decoded);
			if (sawOutput || failure !== void 0 || terminal) break;
		}
	};
	try {
		while (buffered.length < PEEK_MAX_CHUNKS$1 && bufferedBytes < PEEK_MAX_BYTES$1) {
			const next = await reader.read();
			if (next.done) {
				ended = true;
				inspect(sse.finish());
				break;
			}
			buffered.push(next.value);
			bufferedBytes += next.value.byteLength;
			inspect(sse.push(decoder.decode(next.value, { stream: true })));
			if (sawOutput || failure !== void 0 || terminal) break;
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	}
	if (failure !== void 0 && !sawOutput) {
		await reader.cancel().catch(() => {});
		const { status, kind } = classifyTraeFailure(failure);
		return Response.json({ error: {
			message: describeTraeFailure(failure),
			type: "upstream_error",
			code: kind === "hard_credit" ? 402 : status
		} }, { status });
	}
	const replayed = replaySource$1(buffered, reader, ended);
	return new Response(bridgeTraeStream(replayed, model, options), {
		status: 200,
		headers: { "Content-Type": "text/event-stream" }
	});
}
//#endregion
//#region src/trae-gateway.ts
/**
* Trae SOLO loopback gateway.
*
* Stands the Trae path up on a real 127.0.0.1 endpoint with the same routes
* and the same guards as the WorkBuddy shim.
*
* Everything the gateway needs from the outside is injected (credentials,
* identity, `fetchImpl`), so the whole path can be exercised offline.
*/
const MODELS_TTL_MS$1 = 6e5;
/** Model ids the directory says are callable, with the function that owns each. */
function functionMapOf(models) {
	const map = /* @__PURE__ */ new Map();
	for (const model of models) if (model.function !== void 0 && model.function !== "") map.set(model.id, model.function);
	return map;
}
/** What reasoning levels each model advertises, keyed by model id. */
function capabilityMapOf(models) {
	const map = /* @__PURE__ */ new Map();
	for (const model of models) map.set(model.id, model.reasoning ?? { supported: [] });
	return map;
}
function createTraeGateway(options) {
	const logger = options.logger;
	let cachedModels = [];
	let catalogAt = 0;
	let catalogInFlight;
	async function firstCredential(purpose) {
		const usable = (await options.credentials(purpose)).find((credential) => credential.accessToken !== "");
		if (usable === void 0) throw new Error("no Trae sign-in found on this machine");
		return usable;
	}
	function clientFor(credential) {
		return new TraeSoloUpstreamClient({
			credential: async () => credential,
			identity: async () => options.identity(credential),
			...options.fetchImpl === void 0 ? {} : { fetchImpl: options.fetchImpl }
		});
	}
	/** Read the directory, at most once per TTL even under concurrent requests. */
	async function models() {
		if (Date.now() - catalogAt < MODELS_TTL_MS$1 && cachedModels.length > 0) return cachedModels;
		if (catalogInFlight !== void 0) return catalogInFlight;
		catalogInFlight = (async () => {
			try {
				const read = await clientFor(await firstCredential()).fetchModels();
				cachedModels = read;
				catalogAt = Date.now();
				return read;
			} finally {
				catalogInFlight = void 0;
			}
		})();
		return catalogInFlight;
	}
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		const watcher = new AbortController();
		res.on("close", () => watcher.abort());
		const raw = (await readRequestBody(req)).toString("utf8");
		let model = "";
		try {
			model = JSON.parse(raw)["model"] ?? "";
		} catch {
			model = "";
		}
		if (typeof model !== "string" || model.trim() === "") {
			writeOpenAIError(res, 400, "invalid_request_error", "model is required");
			return;
		}
		model = model.trim();
		const directory = await models().catch(() => cachedModels);
		if (watcher.signal.aborted) return;
		let functions = functionMapOf(directory);
		if (functions.size === 0) functions = functionMapOf(cachedModels);
		if (functions.size === 0) {
			writeOpenAIError(res, 503, "upstream_unavailable", "Trae model directory is not available yet");
			return;
		}
		if (!directory.some((entry) => entry.id === model) && !cachedModels.some((entry) => entry.id === model)) {
			writeOpenAIError(res, 404, "not_found", `model not in the Trae directory: ${model}`);
			return;
		}
		let credential;
		try {
			credential = await firstCredential("chat");
		} catch (error) {
			writeOpenAIError(res, 503, "upstream_unavailable", String(error instanceof Error ? error.message : error));
			return;
		}
		if (watcher.signal.aborted) return;
		const capabilities = capabilityMapOf(directory);
		const result = await clientFor(credential).chatStream(raw, watcher.signal, functions.get(model), capabilities.get(model));
		if (!result.ok) {
			if (result.status === 0) {
				writeOpenAIError(res, 502, "upstream_error", result.message);
				return;
			}
			writeOpenAIError(res, result.status, "upstream_error", result.message);
			return;
		}
		const relayed = await openTraeResponse(result.response, model, { onFailure: (error) => {
			logger?.warn?.("dsh-wtq-pool: trae relay stream failed mid-flight", error);
		} });
		if (relayed.status !== 200) {
			const detail = await relayed.text().catch(() => "");
			writeOpenAIError(res, relayed.status, "upstream_error", detail === "" ? "Trae SOLO refused the request" : detail);
			return;
		}
		if (relayed.body === null) {
			writeOpenAIError(res, 502, "upstream_error", "Trae SOLO returned no stream");
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		const body = Readable.fromWeb(relayed.body);
		body.on("error", (error) => {
			if (!(watcher.signal.aborted || error instanceof Error && error.name === "AbortError")) logger?.warn?.("dsh-wtq-pool: trae relay stream failed mid-flight", error);
			if (res.writable) res.end();
		});
		body.pipe(res);
	}
	async function handle(req, res) {
		if (!guardsPass(req, res)) return;
		const url = req.url ?? "/";
		if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
			writeJson$1(res, 200, {
				ok: true,
				source: "trae",
				credentials: (await options.credentials().catch(() => [])).length,
				models: cachedModels.length
			});
			return;
		}
		if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
			let served;
			try {
				served = await models();
			} catch (error) {
				served = cachedModels;
				if (served.length === 0) {
					writeOpenAIError(res, 503, "upstream_unavailable", String(error instanceof Error ? error.message : error));
					return;
				}
				logger?.warn?.("dsh-wtq-pool: trae directory refresh failed; serving the cached roster");
			}
			const ids = options.listedIds?.();
			writeJson$1(res, 200, {
				object: "list",
				data: (ids === void 0 ? served : listedModels(served, ids)).map((model) => ({
					id: model.id,
					object: "model",
					created: 0,
					owned_by: "trae"
				}))
			});
			return;
		}
		if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
			await chatCompletions(req, res);
			return;
		}
		writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
	}
	const server = createServer((req, res) => {
		answerRequest(res, () => handle(req, res), logger);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(options.port ?? 0, "127.0.0.1");
	server.on("error", (error) => {
		logger?.warn?.("dsh-wtq-pool: trae gateway server error", error);
	});
	const port = () => {
		const address = server.address();
		return address === null || typeof address === "string" ? 0 : address.port;
	};
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("trae gateway has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	return {
		ready,
		baseUrl,
		port,
		models: () => cachedModels,
		close: async () => {
			server.closeAllConnections?.();
			await new Promise((resolve) => server.close(() => resolve()));
		}
	};
}
//#endregion
//#region src/trae-identity.ts
/**
* Trae request identity.
*
* The header builder in `trae-upstream.ts` needs a `TraeIdentity`; this is
* the only thing that produces one. Every field comes from an identifier the
* Trae apps themselves persist — nothing here fabricates a per-request id, and
* a machine with no stable identity fails loudly instead of sending an invented
* one.
*/
const TRAE_DEVICE_CENTER_PREFIX = "iCubeAuthInfo://icube-dc:";
/** Prefix of the "no candidate exists on disk" error; see {@link resolveTraeIdentity}. */
const TRAE_STORAGE_MISSING_PREFIX = "Trae storage was not found";
function nonEmpty(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function osVersionOf(platform) {
	return `${platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform} ${release()}`;
}
function deviceCpuOf() {
	return nonEmpty(cpus()[0]?.model.split(" ")[0]);
}
/** `x-device-id` when exactly one device-center id is persisted. */
function traeDeviceCenterId(storage) {
	const ids = Object.keys(storage).filter((key) => key.startsWith(TRAE_DEVICE_CENTER_PREFIX)).map((key) => key.slice(25)).filter(Boolean);
	return ids.length === 1 ? ids[0] : void 0;
}
async function readJsonFile(path) {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
/**
* `product.json` paths for one edition. On macOS the file sits inside the
* `.app` bundle; on Windows under `%LOCALAPPDATA%\Programs\<install dir>\
* resources\app`, where the directory name is the installer's choice — hence
* the same spelling list the credential scanner uses. Product/version is a
* display nicety, so every candidate is tried in order and absence is skipped
* rather than failing identity resolution.
*/
function productJsonPaths(edition, options) {
	const appName = traeMacAppName(edition);
	if (options.platform === "darwin") return [join("/Applications", `${appName}.app`, "Contents", "Resources", "app", "product.json")];
	if (options.platform !== "win32") return [];
	return [options.env.LOCALAPPDATA, join(options.home, "AppData", "Local")].filter((value) => typeof value === "string" && value !== "").filter((value, index, all) => all.indexOf(value) === index).flatMap((root) => traeWindowsAppNames(edition).map((spelling) => join(root, "Programs", spelling, "resources", "app", "product.json")));
}
/** Read stable identity from Trae-owned files without generating impersonated IDs. */
async function readTraeIdentity(candidate, options = {}) {
	const resolved = {
		platform: options.platform ?? process.platform,
		home: options.home ?? homedir(),
		env: options.env ?? process.env
	};
	const storage = JSON.parse(await readFile(candidate.path, "utf8"));
	const machineFile = nonEmpty(await readFile(join(dirname(dirname(dirname(candidate.path))), "machineid"), "utf8").catch(() => ""));
	const machineId = nonEmpty(storage["telemetry.machineId"]) ?? machineFile;
	if (machineId === void 0) throw new Error(`Trae ${candidate.edition} has no stable machine identity`);
	const deviceId = traeDeviceCenterId(storage) ?? nonEmpty(storage["telemetry.devDeviceId"]) ?? createHash("sha256").update(machineId).digest("hex").slice(0, 32);
	const buildVersion = nonEmpty(storage["iCubeLastVersion"]);
	let product = {};
	for (const path of productJsonPaths(candidate.edition, resolved)) {
		product = await readJsonFile(path) ?? {};
		if (Object.keys(product).length > 0) break;
	}
	const appVersion = nonEmpty(product["appVersion"]);
	const deviceBrand = resolved.platform === "darwin" ? nonEmpty(resolved.env["TRAE_DEVICE_BRAND"]) : void 0;
	const deviceCpu = deviceCpuOf();
	return {
		machineId,
		deviceId,
		...appVersion === void 0 ? {} : { appVersion },
		...buildVersion === void 0 ? {} : { buildVersion },
		...deviceBrand === void 0 ? {} : { deviceBrand },
		...deviceCpu === void 0 ? {} : { deviceCpu },
		osVersion: osVersionOf(resolved.platform),
		platform: resolved.platform
	};
}
/** Detect a missing storage file (as opposed to a parse/identity error). */
function isFileMissing(error) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
/**
* Try candidates of one edition in order and return the first valid identity;
* fail only when none work. Mirrors the credential scanner's skip-missing
* semantics, so a machine with only SOLO (no CN install) resolves instead of
* pinning the first candidate onto a file that is not there. When every
* candidate is absent the error says how many were checked - never where they
* were: this message reaches the panel and the log, and an install path is not
* the user's business. A candidate that exists but fails to parse surfaces its
* own error.
*
* `edition` is required, not decoration: the candidates arrive as one list for
* every edition and are ordered CN first, so an unfiltered walk hands an
* international sign-in the CN install's `machineId`, `deviceId` and
* `buildVersion`. Those go out as the request identity, which is a different
* machine as far as the upstream is concerned.
*/
async function pickTraeStorageIdentity(candidates, edition, options = {}) {
	const mine = candidates.filter((candidate) => candidate.edition === edition);
	let lastError;
	let anyPresent = false;
	for (const candidate of mine) try {
		return await readTraeIdentity(candidate, options);
	} catch (error) {
		if (!isFileMissing(error)) {
			lastError = error;
			anyPresent = true;
		}
	}
	const where = `${edition} desktop location(s)` + (mine.length === 0 ? " (none scanned)" : `, ${mine.length} checked`);
	if (!anyPresent) throw new Error(`${TRAE_STORAGE_MISSING_PREFIX} (${where})`);
	const code = typeof lastError === "object" && lastError !== null && "code" in lastError && typeof lastError.code === "string" ? lastError.code : "invalid storage";
	throw new Error(`Trae identity could not be resolved (${where}; ${code})`);
}
/** CLI dotfile home per edition; the CLI keeps its own home, not an app-support entry. */
const CLI_HOME_BY_EDITION = {
	cn: ".trae-cn",
	solo: ".trae-cn",
	sg: ".trae",
	"solo-sg": ".trae"
};
/**
* Deterministic identity for a machine that only has the Trae CLI.
*
* A CLI-only machine has no desktop `storage.json`, yet the headers still need
* stable machine/device ids. Everything here comes from identifiers the CLI
* itself persists (never a per-request random value): `argv.json`'s
* `crash-reporter-id`, `builtin/ide_version.json`'s `version`, and SHA-256 over
* those plus the host for the 64-char machine id the official clients send.
* With no CLI home either, it keeps failing loudly — a fabricated identity is
* worse than a visible "not signed in".
*/
async function readTraeCliIdentity(edition, options = {}) {
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const cliHome = join(home, CLI_HOME_BY_EDITION[edition]);
	const argv = await readJsonFile(join(cliHome, "argv.json"));
	const version = await readJsonFile(join(cliHome, "builtin", "ide_version.json"));
	if (argv === void 0 && version === void 0) throw new Error("Trae CLI identity was not found (its home holds neither argv.json nor ide_version.json)");
	const crashReporterId = nonEmpty(argv?.["crash-reporter-id"]);
	const hostName = nonEmpty(hostname()) ?? "unknown-host";
	const user = nonEmpty(env["USERNAME"]) ?? nonEmpty(env["USER"]) ?? "unknown-user";
	const deviceId = crashReporterId ?? createHash("sha256").update(`trae-cli\0${hostName}\0${user}`).digest("hex").slice(0, 32);
	const machineId = createHash("sha256").update(`trae-cli-machine\0${deviceId}\0${hostName}`).digest("hex");
	const appVersion = nonEmpty(version?.["version"]);
	const deviceCpu = deviceCpuOf();
	return {
		machineId,
		deviceId,
		...appVersion === void 0 ? {} : { appVersion },
		...deviceCpu === void 0 ? {} : { deviceCpu },
		osVersion: osVersionOf(platform),
		platform
	};
}
/**
* Resolve the request identity for one edition: the desktop storage identity
* when any desktop install exists, otherwise the CLI home's deterministic
* identity. This is the seam a CLI-only machine needs — it writes its token to
* `~/.trae-cn/trae-jwt-token` and no `storage.json` exists anywhere.
*/
async function resolveTraeIdentity(candidates, edition, options = {}) {
	try {
		return await pickTraeStorageIdentity(candidates, edition, options);
	} catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith("Trae storage was not found")) throw error;
		return readTraeCliIdentity(edition, options);
	}
}
//#endregion
//#region src/qoder-discovery.ts
/**
* Qoder read-only credential discovery (doctor-only wiring).
*
* Covers the first step of the Qoder merge: find every Qoder desktop sign-in
* slot on this machine without touching behaviour. `main.js` imports this
* module only for the doctor counting path, so WorkBuddy discovery, Trae
* discovery, gateways and the panel are unchanged. Nothing here writes to
* the Qoder apps' files; nothing here spawns PowerShell, opens SQLite, or
* unwraps DPAPI — those stay in the full `dsh-connect-qoder` credential
* chain for a later round. Failures carry paths and error text, never token
* material; env PAT hits report the variable NAME only, never its value.
*
* Shapes follow `dsh-connect-qoder` (MIT): new layout
* `<appDir>/auth.v1.dat` (a Chromium OSCrypt blob whose plaintext is the
* session JSON), legacy layout `<appDir>/User/globalStorage/state.vscdb`
* (VS Code style SQLite store whose secret rows are OSCrypt blobs), key
* wrapper in `<appDir>/Local State` under `os_crypt.encrypted_key`.
*
* @module dsh-wtq-pool/qoder-discovery
*/
/** CN desktop app directory names. The 0.3.x layout is probed first. */
const QODER_CN_APP_NAMES = [
	"com.qodercn.app.stable",
	"QoderCN",
	"Qoder CN",
	"QoderWork CN"
];
/** International desktop app directory names. The 0.3.x layout is probed first. */
const QODER_GLOBAL_APP_NAMES = [
	"com.qoder.app.stable",
	"Qoder",
	"QoderWork"
];
/** Machine-id file names the gateway session is bound to (any one counts). */
const QODER_MACHINE_ID_NAMES = [
	"auth.machine-id",
	"machineid",
	"machineId"
];
/**
* The per-user application-data root Qoder's Electron apps live under.
*
* Same documented order as the reference chain: Windows `%APPDATA%`
* (roaming — Electron's `userData` default) else the roaming path under the
* home directory, macOS `~/Library/Application Support`, Linux/other
* `$XDG_CONFIG_HOME` else `~/.config`.
*/
function qoderAppDataRootFor(platform = process.platform, env = process.env, home = homedir()) {
	if (platform === "win32") {
		const roaming = env["APPDATA"]?.trim();
		return roaming === void 0 || roaming === "" ? join(home, "AppData", "Roaming") : roaming;
	}
	if (platform === "darwin") return join(home, "Library", "Application Support");
	const xdg = env.XDG_CONFIG_HOME;
	if (typeof xdg === "string" && xdg.length > 0) return xdg;
	return join(home, ".config");
}
/**
* Every Qoder storage file to probe, in probe order. Missing files are normal
* (an edition that was never installed); the discover step skips them silently.
*/
function qoderStorageCandidates(platform = process.platform, home = homedir(), env = process.env) {
	const root = qoderAppDataRootFor(platform, env, home);
	if (root === "") return [];
	let roots;
	if (platform === "win32") roots = [root, join(home, "AppData", "Roaming")].filter((value, index, all) => typeof value === "string" && value !== "" && all.indexOf(value) === index);
	else roots = [root];
	const apps = [...QODER_CN_APP_NAMES.map((appName) => ({
		appName,
		region: "cn"
	})), ...QODER_GLOBAL_APP_NAMES.map((appName) => ({
		appName,
		region: "global"
	}))];
	const result = [];
	for (const rootDir of roots) for (const { appName, region } of apps) {
		const appDir = join(rootDir, appName);
		result.push({
			region,
			appName,
			appDir,
			path: join(appDir, "Local State"),
			kind: "local-state"
		});
		result.push({
			region,
			appName,
			appDir,
			path: join(appDir, "auth.v1.dat"),
			kind: "auth-v1"
		});
		result.push({
			region,
			appName,
			appDir,
			path: join(appDir, "User", "globalStorage", "state.vscdb"),
			kind: "state-vscdb"
		});
		result.push({
			region,
			appName,
			appDir,
			path: join(appDir, "User", "globalStorage", "state.vscdb.backup"),
			kind: "state-vscdb-backup"
		});
		for (const machineName of QODER_MACHINE_ID_NAMES) result.push({
			region,
			appName,
			appDir,
			path: join(appDir, machineName),
			kind: "machine-id"
		});
	}
	return result;
}
/**
* Decrypt one Chromium OSCrypt blob.
*
* Pure helper (reference: dsh-connect-qoder credentials.ts): `v10` prefix,
* 12-byte nonce, 16-byte tag, AES-256-GCM. The DPAPI unwrap that produces
* the 32-byte `key` from `Local State` is NOT here — that stays in the full
* chain for a later round.
*
* @param blob - the raw stored bytes, including the `v10` prefix.
* @param key - the 32-byte AES key unwrapped from `Local State`.
* @returns the plaintext, or `undefined` when authentication fails.
*/
function decryptQoderOscrypt(blob, key) {
	if (blob.length < 31) return void 0;
	if (blob.subarray(0, 3).toString("latin1") !== "v10") return void 0;
	const body = blob.subarray(3);
	const nonce = body.subarray(0, 12);
	const tag = body.subarray(body.length - 16);
	const ciphertext = body.subarray(12, body.length - 16);
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, nonce);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
	} catch {
		return;
	}
}
//#endregion
//#region src/qoder-credentials.ts
/**
* Qoder credential reading.
*
* `qoder-discovery.ts` can say a Qoder app is installed; this module says
* whether it is signed in, and hands the token to the caller in memory only.
* Nothing writes to the Qoder apps' files.
*/
/** Machine-id file names, newest first (0.3.x renamed `machineid`). */
const MACHINE_ID_NAMES = [
	"auth.machine-id",
	"machineid",
	"machineId"
];
/** The OSCrypt blob length prefix Chromium writes before the DPAPI payload. */
const DPAPI_PREFIX = "DPAPI";
/**
* PowerShell that unwraps one DPAPI blob and prints the result as base64.
* The blob arrives on stdin and the key leaves on stdout, so neither is ever
* passed as a command-line argument (visible in the process table) or written
* to a file.
*/
const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XdpoolDpapi {
  [StructLayout(LayoutKind.Sequential)] public struct B { public int cbData; public IntPtr pbData; }
  [DllImport("Crypt32.dll", SetLastError=true)]
  static extern bool CryptUnprotectData(ref B i, IntPtr d, IntPtr e, IntPtr r, IntPtr p, int f, ref B o);
  [DllImport("Kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
  public static byte[] U(byte[] data) {
    B i = new B(); i.cbData = data.Length; i.pbData = Marshal.AllocHGlobal(data.Length);
    Marshal.Copy(data, 0, i.pbData, data.Length);
    B o = new B();
    try {
      if (!CryptUnprotectData(ref i, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref o))
        throw new Exception("DPAPI error " + Marshal.GetLastWin32Error());
      byte[] r = new byte[o.cbData]; Marshal.Copy(o.pbData, r, 0, o.cbData); return r;
    } finally { Marshal.FreeHGlobal(i.pbData); if (o.pbData != IntPtr.Zero) LocalFree(o.pbData); }
  }
}
'@
$inputText = [Console]::In.ReadToEnd().Trim()
$blob = [Convert]::FromBase64String($inputText)
$key = [XdpoolDpapi]::U($blob)
[Console]::Out.Write([Convert]::ToBase64String($key))
`;
/** Why an unwrap failed, without naming the blob. */
var QoderKeyError = class extends Error {
	reason;
	constructor(reason, message) {
		super(message ?? `Qoder OSCrypt key ${reason}`);
		this.reason = reason;
		this.name = "QoderKeyError";
	}
};
function powershellPath(env) {
	const systemRoot = env.SystemRoot ?? env.windir;
	if (systemRoot === void 0 || systemRoot === "") return void 0;
	return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
/** Run the interpreter with a whitelisted environment; nothing user-set rides along. */
function childEnv(env) {
	const allowed = [
		"SystemRoot",
		"SystemDrive",
		"windir",
		"TEMP",
		"TMP"
	];
	const result = {};
	for (const name of allowed) {
		const value = env[name];
		if (typeof value === "string" && value !== "") result[name] = value;
	}
	return result;
}
/**
* Unwrap the AES key an app's `Local State` keeps under `os_crypt`.
*
* @throws QoderKeyError with a reason, never with key or blob material.
*/
async function unwrapQoderOscryptKey(localStatePath, options = {}) {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	if (platform !== "win32") throw new QoderKeyError("unsupported-platform", "Qoder OSCrypt unwrap needs Windows DPAPI");
	const stateText = await readFile(localStatePath, "utf8");
	let encoded;
	try {
		const parsed = JSON.parse(stateText);
		const osCrypt = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed["os_crypt"] : void 0;
		encoded = typeof osCrypt === "object" && osCrypt !== null && !Array.isArray(osCrypt) ? osCrypt["encrypted_key"] : void 0;
	} catch {
		throw new QoderKeyError("invalid", "Qoder Local State is not JSON");
	}
	if (typeof encoded !== "string" || encoded === "") throw new QoderKeyError("invalid", "Qoder Local State has no os_crypt.encrypted_key");
	const blob = Buffer.from(encoded, "base64");
	try {
		if (blob.subarray(0, 5).toString("latin1") !== DPAPI_PREFIX) throw new QoderKeyError("invalid", "Qoder encrypted_key is not a DPAPI blob");
		const payload = blob.subarray(5);
		if (payload.length === 0) throw new QoderKeyError("invalid", "Qoder encrypted_key is empty");
		const exe = powershellPath(env);
		if (exe === void 0) throw new QoderKeyError("unavailable", "SystemRoot is not set, cannot locate PowerShell");
		const stdout = await new Promise((resolve, reject) => {
			const child = spawn(exe, [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				DPAPI_SCRIPT
			], {
				env: childEnv(env),
				windowsHide: true,
				stdio: [
					"pipe",
					"pipe",
					"pipe"
				]
			});
			let out = "";
			let err = "";
			const timer = setTimeout(() => {
				child.kill();
			}, options.timeoutMs ?? 3e4);
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk) => {
				out += chunk;
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk) => {
				err += chunk;
			});
			child.on("error", (error) => {
				clearTimeout(timer);
				reject(new QoderKeyError("unavailable", String(error.message).slice(0, 200)));
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (code === 0) resolve(out);
				else reject(new QoderKeyError("unavailable", `PowerShell exited ${code}: ${err.trim().slice(0, 160)}`));
			});
			child.stdin.end(payload.toString("base64"));
		});
		const key = Buffer.from(stdout.trim(), "base64");
		if (key.length !== 32) throw new QoderKeyError("invalid", "DPAPI unwrap did not yield a 32-byte key");
		return key;
	} finally {
		blob.fill(0);
	}
}
/**
* Normalise the session JSON inside `auth.v1.dat`.
*
* @returns the credential fields, or `undefined` when the session carries no
* token or no user id — either way the caller reports `invalid` rather than
* routing a half-known account.
*/
function parseQoderAuthSession(plaintext) {
	let session;
	try {
		session = JSON.parse(plaintext);
	} catch {
		return;
	}
	if (typeof session !== "object" || session === null) return void 0;
	const record = session;
	const token = typeof record["token"] === "string" ? record["token"] : "";
	if (token === "") return void 0;
	const rawUser = record["user"];
	const user = typeof rawUser === "object" && rawUser !== null && !Array.isArray(rawUser) ? rawUser : {};
	const userID = typeof user["id"] === "string" ? user["id"] : "";
	if (userID === "") return void 0;
	const parsedExpiry = (value) => {
		const parsed = Date.parse(String(value));
		return Number.isFinite(parsed) ? parsed : 0;
	};
	return {
		userID,
		name: typeof user["name"] === "string" ? user["name"] : "",
		email: typeof user["email"] === "string" ? user["email"] : "",
		token,
		refreshToken: typeof record["refreshToken"] === "string" ? record["refreshToken"] : "",
		expiresAtMs: parsedExpiry(record["expiresAt"]),
		refreshTokenExpiresAtMs: parsedExpiry(record["refreshTokenExpiresAt"])
	};
}
async function machineIdOf(appDir) {
	for (const name of MACHINE_ID_NAMES) try {
		const text = (await readFile(join(appDir, name), "utf8")).trim();
		if (text !== "") return text;
	} catch {}
}
/** First readable `auth.v1.dat` among the spellings, with its bytes kept. */
async function firstAuthBlob(paths) {
	for (const path of paths) try {
		return await readFile(path);
	} catch {}
}
/** Read one app directory's credential, or the reason there is none. */
async function readQoderCredential(candidates, options = {}) {
	const byKind = (kind) => candidates.filter((candidate) => candidate.kind === kind).map((candidate) => candidate.path);
	const appDir = candidates[0]?.appDir ?? "";
	const base = { region: candidates[0]?.region ?? "cn" };
	const authBlob = await firstAuthBlob(byKind("auth-v1"));
	if (authBlob === void 0) return { failure: {
		...base,
		reason: "no-auth"
	} };
	let key;
	try {
		const localState = byKind("local-state")[0];
		if (localState === void 0) throw new QoderKeyError("invalid", "no Local State candidate");
		key = await unwrapQoderOscryptKey(localState, options);
	} catch (error) {
		const reason = error instanceof QoderKeyError && error.reason === "unsupported-platform" ? "unsupported-platform" : "no-key";
		return { failure: {
			...base,
			reason,
			...error instanceof Error ? { message: error.message } : {}
		} };
	}
	try {
		const plain = decryptQoderOscrypt(authBlob, key);
		if (plain === void 0) return { failure: {
			...base,
			reason: "undecryptable"
		} };
		const session = parseQoderAuthSession(plain);
		if (session === void 0) return { failure: {
			...base,
			reason: "invalid"
		} };
		const machineID = await machineIdOf(appDir);
		return { credential: {
			...base,
			...session,
			...machineID === void 0 ? {} : { machineID }
		} };
	} finally {
		key.fill(0);
	}
}
/**
* Every Qoder sign-in on this machine. One app directory that is missing or
* unreadable never hides the others; failures carry reasons, never tokens.
*/
async function discoverQoderCredentials(candidates = qoderStorageCandidates()) {
	const byAppDir = /* @__PURE__ */ new Map();
	for (const candidate of candidates) {
		const list = byAppDir.get(candidate.appDir);
		if (list === void 0) byAppDir.set(candidate.appDir, [candidate]);
		else list.push(candidate);
	}
	const credentials = [];
	const failures = [];
	for (const group of byAppDir.values()) {
		const result = await readQoderCredential(group);
		if (result.credential !== void 0) {
			if (!credentials.some((existing) => existing.region === result.credential.region && existing.userID === result.credential.userID)) credentials.push(result.credential);
		} else if (result.failure !== void 0 && result.failure.reason !== "no-auth") failures.push(result.failure);
	}
	return {
		credentials,
		failures
	};
}
//#endregion
//#region src/qoder-upstream.ts
/**
* Qoder gateway request codec.
*
* Offline half of the Qoder path: everything needed to turn a credential into
* the exact bytes and headers one gateway request must carry. No DPAPI,
* PowerShell or SQLite work happens here — the credential is handed in by
* the caller.
*/
/** Gateway base per region. */
const QODER_GATEWAYS = {
	cn: "https://gateway.qoder.com.cn/",
	global: "https://api3.qoder.sh/"
};
/** Public key the gateway expects the per-request AES key to be wrapped with. */
const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
/** COSY protocol revision the gateway is currently serving. */
const COSY_VERSION = "1.1.38";
/** Data-policy value a non-consenting client sends. */
const DATA_POLICY = "disagree";
/** Permuted base64 alphabet used when `Encode=1` is in effect. */
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
/** Standard base64 alphabet, positionally mapped onto the custom one. */
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/**
* Positional translation table from standard to custom alphabet, exactly 256
* entries so a lookup can never read out of bounds. `=` becomes `$`, which is
* why the encoded body is not valid base64 and must not be decoded as such.
*/
const ENCODE_TABLE = (() => {
	const table = /* @__PURE__ */ new Uint8Array(256);
	for (let i = 0; i < table.length; i++) table[i] = i;
	for (let i = 0; i < 64; i++) table[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
	table["=".charCodeAt(0)] = "$".charCodeAt(0);
	return table;
})();
/** The translation for one byte; identity for a byte the table does not name. */
function encodeByteAt(byte) {
	return ENCODE_TABLE[byte] ?? byte;
}
/**
* Encode a request body the way `Encode=1` requires: base64 the bytes,
* translate each character through the permuted alphabet, then rotate the
* string so the last third comes first and the first third goes last.
*/
function encodeBody(plaintext) {
	const std = (Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext)).toString("base64");
	const n = std.length;
	const third = Math.floor(n / 3);
	const out = Buffer.allocUnsafe(n);
	let dst = 0;
	for (let i = n - third; i < n; i++) out[dst++] = encodeByteAt(std.charCodeAt(i));
	for (let i = third; i < n - third; i++) out[dst++] = encodeByteAt(std.charCodeAt(i));
	for (let i = 0; i < third; i++) out[dst++] = encodeByteAt(std.charCodeAt(i));
	return out;
}
/**
* The path the signature covers: the request path with a leading `/algo`
* stripped, because the gateway routes that prefix away before verifying.
*/
function signaturePath(url) {
	let path = new URL(url).pathname;
	if (path.startsWith("/algo")) path = path.slice(5);
	return path;
}
/**
* Machine OS string, spelled the way the gateway expects. Measured safe on
* both regions (the gateway does not gate on it), so it names the real host
* instead of announcing every machine as `x86_64_linux`.
*/
function qoderMachineOs(platform = process.platform, arch = process.arch) {
	if (platform === "win32") return arch === "arm64" ? "aarch64_windows" : "x86_64_windows";
	if (platform === "darwin") return arch === "arm64" ? "aarch64_darwin" : "x86_64_darwin";
	return arch === "arm64" ? "aarch64_linux" : "x86_64_linux";
}
/** AES-128-CBC encrypt with the key doubling as the IV, base64-encoded. */
function aesEncryptCBCBase64(plaintext, keyString) {
	const key = Buffer.from(keyString);
	const cipher = createCipheriv("aes-128-cbc", key, key);
	return cipher.update(plaintext, "utf8", "base64") + cipher.final("base64");
}
/**
* Build the full authenticated header set for one gateway request.
*
* @param body - the exact bytes that will be sent (already encoded).
* @param url - the absolute request URL.
* @param credential - `{ userID, token, name, email, machineID }`.
*/
function buildCosyAuthHeaders(body, url, credential, options = {}) {
	const uuid = options.uuid ?? randomUUID;
	const aesKey = options.aesKey ?? uuid().replace(/-/g, "").slice(0, 16);
	const infoB64 = aesEncryptCBCBase64(JSON.stringify({
		uid: credential.userID,
		security_oauth_token: credential.token,
		name: credential.name ?? "",
		aid: "",
		email: credential.email ?? ""
	}), aesKey);
	const cosyKey = publicEncrypt({
		key: QODER_RSA_PUBLIC_KEY,
		padding: constants.RSA_PKCS1_PADDING
	}, Buffer.from(aesKey)).toString("base64");
	const timestamp = Math.floor((options.nowSeconds ?? (() => Date.now() / 1e3))()).toString();
	const payloadB64 = Buffer.from(JSON.stringify({
		version: "v1",
		requestId: uuid(),
		info: infoB64,
		cosyVersion: COSY_VERSION,
		ideVersion: ""
	})).toString("base64");
	const path = signaturePath(url);
	const bodyBytes = body;
	const sig = createHash("md5").update(payloadB64).update("\n").update(cosyKey).update("\n").update(timestamp).update("\n").update(bodyBytes).update("\n").update(path).digest("hex");
	const machineID = credential.machineID ?? "";
	return {
		"Authorization": `Bearer COSY.${payloadB64}.${sig}`,
		"Cosy-Key": cosyKey,
		"Cosy-User": credential.userID,
		"Cosy-Date": timestamp,
		"Cosy-Version": COSY_VERSION,
		"Cosy-Machineid": machineID,
		"Cosy-Machinetoken": machineID,
		"Cosy-Machinetype": "5",
		"Cosy-Machineos": qoderMachineOs(),
		"Cosy-Clienttype": "5",
		"Cosy-Clientip": "127.0.0.1",
		"Cosy-Bodyhash": createHash("md5").update(bodyBytes).digest("hex"),
		"Cosy-Bodylength": String(bodyBytes.length),
		"Cosy-Sigpath": path,
		"Cosy-Data-Policy": DATA_POLICY,
		"Cosy-Organization-Id": "",
		"Cosy-Organization-Tags": "",
		"Login-Version": "v2",
		"X-Request-Id": uuid()
	};
}
//#endregion
//#region src/qoder-client.ts
/**
* Qoder minimal upstream client.
*
* Fetches the callable roster and opens one chat stream. No disk reads here;
* tokens stay in the caller's memory.
*
* Shapes follow `dsh-connect-qoder` (MIT): the `algo/api/v2/model/list`
* envelope groups its models by product surface, and only the `chat` group is
* callable. Chat requests normalise `developer` to `system`, because a system
* message the gateway does not recognise is answered with a permanent
* `403 {"code":"10605"}` on every retry.
*
* Everything the client needs from the outside is injected (credential,
* `fetchImpl`), so the whole path can be exercised offline.
*
* @module dsh-wtq-pool/qoder-client
*/
/** Qoder's thinking ladder, low to high: the upstream's own order. */
const QODER_EFFORT_ORDER = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/**
* The levels a catalog row can list: the ladder without "none", which is not a
* level but the off value. Keeping it out of the table is what stops it from
* ever being published as a level or picked as a model's default.
*/
const QODER_TABLE_LEVELS = QODER_EFFORT_ORDER.filter((level) => level !== "none");
/** Model directory path; `Encode=1` names the permuted-base64 wire form. */
const QODER_MODELS_PATH = "/algo/api/v2/model/list?Encode=1";
/** Streaming chat path; `FetchKeys` selects the OpenAI-shaped result field. */
const QODER_CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
/** Join a gateway base and an API path without doubling slashes. */
function qoderEndpoint(baseUrl, path) {
	return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
/** OpenAPI base per region: the quota surface, not the COSY gateway. */
const QODER_OPENAPI = {
	cn: "https://openapi.qoder.com.cn",
	global: "https://openapi.qoder.sh"
};
/** Quota usage path (narrow shape); the presentation route is tried first. */
const QODER_USAGE_PATH = "/api/v2/quota/usage";
/** Presentation usage path (carries dedicated packages); preferred. */
const QODER_USAGE_PRESENTATION_PATH = "/sash/api/v2/me/usage";
/** Campaign list path; the same payload answers promo rows and the daily check-in round. */
const QODER_CAMPAIGNS_PATH = "/sash/api/v1/me/campaigns";
/**
* Headers the Qoder IDE itself sends to the OpenAPI host. `Cosy-ClientType: 10`
* identifies the desktop app. The umid machine-identity block (international
* daily round only) is deliberately absent: usage needs no block, CN or global.
*/
function qoderOpenApiHeaders(credential) {
	return {
		Accept: "application/json",
		Authorization: `Bearer ${credential.token}`,
		"Cosy-ClientType": "10",
		"User-Agent": "Qoder"
	};
}
function qoderNumber(value) {
	const n = typeof value === "string" && value.trim() !== "" ? Number(value) : typeof value === "number" ? value : NaN;
	return Number.isFinite(n) ? n : void 0;
}
/** What is left of one pool. The upstream may omit it, so `used` backs it up. */
function qoderRemainingOf(record, total) {
	const used = Math.max(0, qoderNumber(record["used"]) ?? 0);
	return Math.max(0, qoderNumber(record["remaining"]) ?? total - used);
}
function qoderQuotaBucket(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
	const record = value;
	const total = qoderNumber(record["total"]);
	if (total === void 0 || total < 0) return void 0;
	return {
		total,
		remaining: qoderRemainingOf(record, total)
	};
}
function qoderDedicatedPackage(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
	const record = value;
	const id = typeof record["id"] === "string" ? record["id"].trim() : "";
	const total = qoderNumber(record["total"]);
	if (id === "" || total === void 0 || total <= 0) return void 0;
	const expiresAtMs = qoderEpochMs(record["expiresAt"] ?? record["expires_at"]);
	return {
		id,
		name: typeof record["name"] === "string" ? record["name"] : "",
		total,
		remaining: qoderRemainingOf(record, total),
		...expiresAtMs === void 0 ? {} : { expiresAtMs }
	};
}
/** Anything below this epoch-millisecond value must be seconds (1e12 ms ≈ 2001). */
const QODER_EPOCH_SECONDS_BOUNDARY_MS = 0xe8d4a51000;
/**
* A date past this is not a date: the API spells "no expiry at all" as the
* largest timestamp it can write, which read as `9999-12-31` on the card.
* Nothing a user can hold outlives the year 2200, so the ceiling is a
* generous one and only sentinels fall past it.
*/
const QODER_EPOCH_CEILING_MS = 72581184e5;
function qoderRawEpochMs(value) {
	if (value === null || value === void 0) return void 0;
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value <= 0) return void 0;
		return value < QODER_EPOCH_SECONDS_BOUNDARY_MS ? Math.floor(value * 1e3) : Math.floor(value);
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
/**
* Coerce one upstream timestamp (seconds, ms, RFC 3339) into epoch
* milliseconds, dropping the far-future value that means "never expires".
*/
function qoderEpochMs(value) {
	const ms = qoderRawEpochMs(value);
	return ms !== void 0 && ms <= QODER_EPOCH_CEILING_MS ? ms : void 0;
}
/** MIME-free label for the one campaign type that actually pays out. */
const QODER_CLAIM_BENEFIT_ACTION = "CLAIM_BENEFIT";
/** Status of a round this account has already collected. */
const QODER_CLAIMED_STATUS = "CLAIMED";
/**
* Ceiling on one chat stream, for a caller that did not pass its own signal.
*
* The same bound the Trae gateway applies: a stream can legitimately run for
* minutes, but a black-holed host must not leave the response - and the
* upstream connection behind it - pending for the rest of the process.
*/
const CHAT_STREAM_TIMEOUT_MS = 12e4;
/**
* Bound on one read against the COSY gateway or the OpenAPI surface (directory,
* usage, campaigns, a claim), for a caller that did not pass its own signal.
* Every one of them has to be bounded: the check-in path issues them one account
* after another, and a black-holed host would otherwise leave the socket and the
* fetch pending for the rest of the process.
*/
const DIRECTORY_TIMEOUT_MS = 3e4;
function qoderBenefitOf(campaign) {
	const benefit = campaign?.benefit;
	if (benefit === null || typeof benefit !== "object") return void 0;
	const record = benefit;
	const amount = Number(record.amount);
	if (!Number.isFinite(amount) || amount <= 0) return void 0;
	const relative = record.validity?.mode === "RELATIVE_DAYS";
	const validityDays = Number(record.validity?.days);
	return {
		amount,
		kind: typeof record.kind === "string" ? record.kind : "CREDITS",
		...relative && Number.isFinite(validityDays) && validityDays > 0 ? { validDays: validityDays } : {}
	};
}
function qoderWindowOpenAt(campaign, nowMs) {
	const record = campaign;
	const startAt = qoderEpochMs(record?.startAt ?? record?.beginAt);
	const endAt = qoderEpochMs(record?.endAt);
	if (startAt !== void 0 && nowMs < startAt) return false;
	if (endAt !== void 0 && nowMs > endAt) return false;
	return true;
}
function qoderClaimableCampaignOf(payload, nowMs) {
	const list = payload?.campaigns;
	if (!Array.isArray(list)) return void 0;
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const campaign = entry;
		if (campaign["actionType"] !== QODER_CLAIM_BENEFIT_ACTION) continue;
		if (!qoderWindowOpenAt(campaign, nowMs)) continue;
		return campaign;
	}
}
/**
* Id of today's round when it can be claimed right now, else undefined. Kept
* out of the card-facing state on purpose: callers read the list and claim in
* the same breath, so the id is never held long enough to go stale.
*/
function qoderClaimableCampaignIdOf(payload, nowMs = Date.now()) {
	const campaign = qoderClaimableCampaignOf(payload, nowMs);
	if (campaign === void 0 || campaign["claimStatus"] === QODER_CLAIMED_STATUS) return void 0;
	const id = campaign["campaignId"];
	return typeof id === "string" && id.length > 0 ? id : void 0;
}
/**
* How long a claimed reward stays usable, in days, when the upstream states a
* rule instead of a date.
*
* The credits a daily check-in pays out land in the add-on pool, and the usage
* routes carry no date for that pool — the only expiry the API states for it
* is this rule ("valid 30 days after claiming"). The shortest rule wins: an
* account holding rounds of different lengths expires soonest, and that is
* the number worth showing on the pool.
*/
function qoderRewardValidityDaysOf(payload) {
	const list = payload?.campaigns;
	if (!Array.isArray(list)) return void 0;
	let days;
	for (const entry of list) {
		const validDays = qoderBenefitOf(entry)?.validDays;
		if (validDays === void 0) continue;
		if (days === void 0 || validDays < days) days = validDays;
	}
	return days;
}
/**
* When the credits the newest claimed check-in round paid out run out, in ms.
*
* The usage routes report that pool only as a sum, and the campaign list is the
* one place that dates it: a round states a one-day claim window and a validity
* in days, and the credits can only have been claimed inside that window — so
* the window's opening plus the validity is the date, exact to within the day
* a claim can land in. Only a round already claimed counts: one still open has
* paid out nothing. Newest wins, because its credits are the last to go.
*/
function qoderRewardExpiryMs(payload) {
	const list = payload?.campaigns;
	if (!Array.isArray(list)) return void 0;
	let openedAt;
	let validDays;
	for (const entry of list) {
		const record = entry;
		if (record === null || typeof record !== "object") continue;
		if (record["actionType"] !== QODER_CLAIM_BENEFIT_ACTION) continue;
		if (record["claimStatus"] !== QODER_CLAIMED_STATUS) continue;
		const days = qoderBenefitOf(record)?.validDays;
		if (days === void 0) continue;
		const startedAt = qoderEpochMs(record["startAt"]) ?? qoderEpochMs(record["beginAt"]);
		if (startedAt === void 0) continue;
		if (openedAt === void 0 || startedAt > openedAt) {
			openedAt = startedAt;
			validDays = days;
		}
	}
	return openedAt === void 0 || validDays === void 0 ? void 0 : openedAt + validDays * 864e5;
}
/**
* The card-facing check-in state. No campaign id is published: the claim route
* re-reads the list, so a stale id could never be clicked from this state.
* Unknown `claimStatus` reads as claimable; an upstream `active:false` without
* a `CLAIM_BENEFIT` round (e.g. international without umid) reads as inactive.
*/
function qoderCheckinStateFrom(payload, nowMs = Date.now()) {
	const campaign = qoderClaimableCampaignOf(payload, nowMs);
	if (campaign === void 0) {
		const opensAt = qoderNextOpenAt(payload, nowMs);
		return {
			active: false,
			todayCheckedIn: false,
			...opensAt === void 0 ? {} : { opensAt }
		};
	}
	const benefit = qoderBenefitOf(campaign);
	const endsAt = qoderEpochMs(campaign["endAt"]);
	return {
		active: true,
		todayCheckedIn: campaign["claimStatus"] === QODER_CLAIMED_STATUS,
		...benefit === void 0 ? {} : {
			amount: benefit.amount,
			unit: benefit.kind === "CREDITS" ? "credits" : benefit.kind.toLowerCase(),
			...benefit.validDays === void 0 ? {} : { validDays: benefit.validDays }
		},
		...endsAt === void 0 ? {} : { endsAt }
	};
}
/**
* When the next round opens, for an account whose current round is not
* claimable right now (already collected, or its window has not started).
*
* Qoder re-issues the daily round at 10:00 Beijing and the window then runs to
* 09:59 the next day, so before 10:00 this is the honest answer to "when can I
* claim" — and the moment the automatic pass comes back for.
*/
function qoderNextOpenAt(payload, nowMs) {
	const list = payload?.campaigns;
	if (!Array.isArray(list)) return void 0;
	let soonest;
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const campaign = entry;
		if (campaign["actionType"] !== QODER_CLAIM_BENEFIT_ACTION) continue;
		if (campaign["claimStatus"] === QODER_CLAIMED_STATUS) continue;
		const startAt = qoderEpochMs(campaign["startAt"] ?? campaign["beginAt"]);
		if (startAt === void 0 || nowMs >= startAt) continue;
		if (soonest === void 0 || startAt < soonest) soonest = startAt;
	}
	return soonest;
}
/**
* Claim path for one campaign id. The caller reads the list immediately
* before claiming: the daily round is re-issued with a new id each day, so an
* id remembered from an earlier read is a stale one.
*/
function qoderClaimCampaignPath(campaignId) {
	return `${QODER_CAMPAIGNS_PATH}/${encodeURIComponent(campaignId)}/claim`;
}
/**
* Read back what a claim answered. A repeat answers `replayed: true` and
* grants nothing rather than failing, so both fresh and replayed are success.
* `amount` is present only when this call actually paid out.
*/
function qoderNormalizeClaimResult(payload, campaign) {
	const payloadRecord = payload;
	const body = payloadRecord?.data !== null && typeof payloadRecord?.data === "object" ? payloadRecord.data : payload;
	const status = typeof body?.status === "string" ? body.status : "";
	const replayed = body?.replayed === true;
	const granted = status === QODER_CLAIMED_STATUS || replayed || body?.success === true;
	const amountValue = Number(body?.benefit?.amount ?? (typeof campaign !== "undefined" ? qoderBenefitOf(campaign)?.amount : void 0));
	const expiresAt = qoderEpochMs(body?.expiresAt);
	return {
		claimed: granted,
		replayed,
		...!replayed && Number.isFinite(amountValue) && amountValue > 0 ? { amount: amountValue } : {},
		...expiresAt === void 0 ? {} : { expiresAt }
	};
}
/** Map an HTTP status onto the failure class the future gateway answers with. */
function classifyQoderUpstreamError(status) {
	if (status === 401 || status === 403) return "authentication";
	if (status === 402) return "hard_credit";
	if (status === 429) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	return "client";
}
/** Flatten a content value into plain text; image blocks contribute nothing. */
function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) if (block?.type === "text") text += typeof block.text === "string" ? block.text : "";
	return text;
}
/**
* OpenAI messages → the endpoint's message vocabulary.
*
* An assistant turn that only called tools carries no content; the endpoint
* rejects a null content field, so an empty string is sent. A tool result
* without its calling id, or an assistant tool call without one, throws with
* the reason — the gateway would refuse it anyway, and an early throw names
* the missing link instead of a bare upstream 400.
*/
function toQoderMessages(messages) {
	if (!Array.isArray(messages)) return [];
	const out = [];
	for (const raw of messages) {
		if (raw === null || typeof raw !== "object") continue;
		if (raw["role"] === "system" || raw["role"] === "developer") {
			out.push({
				role: "system",
				content: textOf(raw["content"])
			});
			continue;
		}
		if (raw["role"] === "user") {
			const content = raw["content"];
			out.push({
				role: "user",
				content: Array.isArray(content) ? content : textOf(content)
			});
			continue;
		}
		if (raw["role"] === "assistant") {
			const toolCalls = [];
			if (Array.isArray(raw["tool_calls"])) for (const call of raw["tool_calls"]) {
				if (call === null || typeof call !== "object") continue;
				const id = call["id"];
				if (typeof id !== "string" || id.length === 0) throw new Error("toQoderMessages: assistant tool_call is missing an id; the tool loop cannot match the result back to it");
				const fn = call["function"];
				const name = typeof fn === "object" && fn !== null ? fn["name"] : call["name"];
				if (typeof name !== "string" || name.length === 0) throw new Error(`toQoderMessages: assistant tool_call "${id}" has no function name; the gateway cannot dispatch it`);
				const args = typeof fn === "object" && fn !== null ? fn["arguments"] : call["arguments"];
				toolCalls.push({
					id,
					type: "function",
					function: {
						name,
						arguments: typeof args === "string" ? args : JSON.stringify(args ?? {})
					}
				});
			}
			const entry = {
				role: "assistant",
				content: textOf(raw["content"])
			};
			if (toolCalls.length > 0) entry["tool_calls"] = toolCalls;
			out.push(entry);
			continue;
		}
		if (raw["role"] === "tool" || raw["role"] === "toolResult") {
			const toolCallId = raw["tool_call_id"] ?? raw["toolCallId"];
			if (typeof toolCallId !== "string" || toolCallId.length === 0) throw new Error("toQoderMessages: tool result message is missing tool_call_id; it cannot be linked to the calling assistant turn");
			out.push({
				role: "tool",
				tool_call_id: toolCallId,
				content: textOf(raw["content"])
			});
		}
	}
	return out;
}
/**
* Tool definitions → the endpoint's function schema. The OpenAI shape passes
* through; a bare `{ name, description, parameters }` descriptor is wrapped.
*/
function toQoderTools(tools) {
	if (!Array.isArray(tools)) return [];
	return tools.map((tool, index) => {
		if (tool !== null && typeof tool === "object") {
			const fn = tool["function"];
			if (fn !== null && typeof fn === "object") {
				const name = fn["name"];
				if (typeof name !== "string" || name.length === 0) throw new Error(`toQoderTools: tool at index ${index} has no function name; the gateway cannot register it`);
				return {
					type: "function",
					function: {
						name,
						description: fn["description"] ?? "",
						parameters: fn["parameters"] ?? {
							type: "object",
							properties: {}
						}
					}
				};
			}
			const name = tool["name"];
			if (typeof name === "string" && name.length > 0) return {
				type: "function",
				function: {
					name,
					description: tool["description"] ?? "",
					parameters: tool["parameters"] ?? {
						type: "object",
						properties: {}
					}
				}
			};
		}
		throw new Error(`toQoderTools: tool at index ${index} has no name; the gateway cannot register it`);
	});
}
/**
* OpenAI request body → the flat `agent_chat_generation` literal.
*
* Only the endpoint's own fields are sent: optional Pi/OpenAI fields
* (temperature, top_p, tool_choice, …) would fail validation. `max_tokens`
* is forwarded only when the caller actually specifies a positive integer —
* reasoning and the answer share this budget upstream, so no default is
* invented here. `is_reasoning` is sent only when the caller states it: a
* fabricated `false` answers `provider_error` 1210 ("该模型始终思考，
* 不支持关闭思考") on models that always think.
*/
function buildQoderChatBody(source, model, options = {}) {
	const input = JSON.parse(source);
	const recordID = randomUUID();
	const messages = toQoderMessages(input["messages"]);
	const lastText = textOf([...messages].reverse().find((message) => message["role"] === "user")?.["content"]);
	const parameters = {};
	const maxTokens = input["max_tokens"] ?? input["max_completion_tokens"];
	if (typeof maxTokens === "number" && Number.isSafeInteger(maxTokens) && maxTokens > 0) parameters["max_tokens"] = maxTokens;
	if (options.enableThinking === true) {
		parameters["enable_thinking"] = true;
		if (typeof options.reasoningEffort === "string" && options.reasoningEffort.length > 0) parameters["reasoning_effort"] = options.reasoningEffort;
	} else if (options.enableThinking === false) parameters["enable_thinking"] = false;
	return JSON.stringify({
		request_id: randomUUID(),
		request_set_id: recordID,
		chat_record_id: recordID,
		session_id: options.sessionId ?? `xdpool-${randomUUID()}`,
		stream: true,
		chat_task: "FREE_INPUT",
		is_reply: true,
		is_retry: false,
		source: 1,
		version: "3",
		session_type: "qodercli",
		agent_id: "agent_common",
		task_id: "common",
		code_language: "",
		chat_prompt: "",
		aliyun_user_type: "",
		system: "",
		messages,
		tools: toQoderTools(input["tools"]),
		parameters,
		chat_context: {
			chatPrompt: "",
			imageUrls: null,
			extra: {
				context: [],
				modelConfig: {
					key: model,
					...options.enableThinking === void 0 ? {} : { is_reasoning: options.enableThinking }
				},
				originalContent: lastText
			},
			features: [],
			text: lastText
		},
		model_config: {
			key: model,
			source: "system",
			...options.enableThinking === void 0 ? {} : { is_reasoning: options.enableThinking }
		},
		business: {
			product: "cli",
			version: "1.0.0",
			type: "agent",
			stage: "start",
			id: randomUUID(),
			name: lastText.slice(0, 30),
			begin_at: Date.now()
		}
	});
}
/**
* The `chat` group of a directory envelope, or a named error when the shape
* moved. Naming the groups that DID arrive keeps the next upstream rename
* instantly readable instead of a bare "no chat group".
*/
function readQoderCatalogShape(data) {
	if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error(`Qoder model list shape changed: top level is ${Array.isArray(data) ? "an array" : typeof data}, not a group envelope`);
	const envelope = data;
	if (!("chat" in envelope)) throw new Error(`Qoder model list shape changed: no \`chat\` group; groups present: ${Object.keys(envelope).slice(0, 12).join(", ") || "(none)"}`);
	const chat = envelope["chat"];
	if (!Array.isArray(chat)) throw new Error(`Qoder model list shape changed: \`chat\` is ${chat === null ? "null" : typeof chat}, not an array`);
	return chat;
}
/**
* The window a Qoder model runs at, from `context_config`.
*
* The catalog offers several sizes per model (`1M`, `200K`, `400K`) and marks
* the one in force with `is_default`. A row that names no default keeps its
* largest, which is the reading that cannot promise less than the model has.
*/
function qoderContextWindowOf(record) {
	const config = record["context_config"];
	if (config === null || typeof config !== "object" || Array.isArray(config)) return void 0;
	const tokenCountOf = (entry) => {
		if (entry === null || typeof entry !== "object") return void 0;
		const value = entry["token_count"];
		return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
	};
	const entries = Object.values(config);
	const chosen = tokenCountOf(entries.find((entry) => entry !== null && typeof entry === "object" && entry["is_default"] === true));
	if (chosen !== void 0) return chosen;
	const sizes = entries.map(tokenCountOf).filter((value) => value !== void 0);
	return sizes.length === 0 ? void 0 : Math.max(...sizes);
}
/** One directory row → one callable model, or undefined when unusable. */
function qoderModelOf(entry) {
	if (entry === null || typeof entry !== "object") return void 0;
	const record = entry;
	if (typeof record["key"] !== "string" || record["key"].length === 0) return void 0;
	if (record["enable"] === false) return void 0;
	if (typeof record["display_name"] !== "string" || record["display_name"].length === 0) return void 0;
	const config = record["thinking_config"];
	const efforts = config?.enabled?.efforts;
	const isShape = efforts !== null && typeof efforts === "object" && !Array.isArray(efforts);
	const effortLevels = isShape ? QODER_TABLE_LEVELS.filter((level) => Object.prototype.hasOwnProperty.call(efforts, level)) : [];
	const defaultEffort = isShape ? QODER_TABLE_LEVELS.find((level) => {
		const row = efforts[level];
		return row !== null && typeof row === "object" && row["is_default"] === true;
	}) : void 0;
	const maxInputTokens = typeof record["max_input_tokens"] === "number" && Number.isFinite(record["max_input_tokens"]) && record["max_input_tokens"] > 0 ? record["max_input_tokens"] : void 0;
	const contextWindow = qoderContextWindowOf(record) ?? maxInputTokens;
	return {
		id: record["key"],
		name: record["display_name"],
		...maxInputTokens === void 0 ? {} : { maxInputTokens },
		...contextWindow === void 0 ? {} : { contextWindow },
		supportsImages: record["is_vl"] === true,
		...effortLevels.length === 0 ? {} : { effortLevels },
		...defaultEffort === void 0 ? {} : { defaultEffort },
		...effortLevels.length > 0 && config?.disabled === void 0 ? { alwaysThinking: true } : {}
	};
}
/**
* Qoder upstream client: chat, usage, campaigns and the model directory.
* `fetchImpl` is injectable for offline checks.
*/
var QoderUpstreamClient = class {
	options;
	fetchImpl;
	constructor(options) {
		this.options = options;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}
	baseUrl() {
		return QODER_GATEWAYS[this.options.region];
	}
	/**
	* Read the callable roster for this region. A row the parser cannot use is
	* skipped rather than failing the whole directory; a shape that moved
	* throws a named error.
	*/
	async fetchModels(signal) {
		const credential = await this.options.credential();
		const url = qoderEndpoint(this.baseUrl(), QODER_MODELS_PATH);
		const headers = buildCosyAuthHeaders(Buffer.alloc(0), url, credential);
		const response = await this.fetchImpl(url, {
			method: "GET",
			headers: {
				Accept: "application/json",
				...headers
			},
			redirect: "error",
			signal: signal ?? AbortSignal.timeout(DIRECTORY_TIMEOUT_MS)
		});
		if (!response.ok) throw new Error(`Qoder model list failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
		const chat = readQoderCatalogShape(await response.json());
		const models = [];
		for (const raw of chat) {
			const model = qoderModelOf(raw);
			if (model !== void 0) models.push(model);
		}
		return models;
	}
	openApiBase() {
		return QODER_OPENAPI[this.options.region];
	}
	/**
	* Read the account's usage, shaped the way the IDE panel presents it.
	*
	* Two routes carry different halves: the presentation route includes the
	* per-model dedicated packages, `quota/usage` is the older narrower shape.
	* Either alone renders something useful, so the first failing falls back to
	* the second rather than failing the whole read. Both failing throws — the
	* caller reports "usage unavailable" instead of an empty panel.
	*/
	async fetchUsage(signal) {
		const headers = qoderOpenApiHeaders(await this.options.credential());
		const read = async (path) => {
			const response = await this.fetchImpl(qoderEndpoint(this.openApiBase(), path), {
				method: "GET",
				headers,
				redirect: "error",
				signal: signal ?? AbortSignal.timeout(DIRECTORY_TIMEOUT_MS)
			});
			if (!response.ok) throw new Error(`Qoder usage failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
			return await response.json();
		};
		let payload;
		let source = "presentation";
		try {
			payload = await read(QODER_USAGE_PRESENTATION_PATH);
		} catch (error) {
			if (signal?.aborted) throw error;
			source = "quota";
			payload = await read(QODER_USAGE_PATH);
		}
		const envelope = payload === null || typeof payload !== "object" ? {} : payload;
		const usage = envelope["qoderUsage"] ?? envelope["data"] ?? payload;
		if (usage === null || typeof usage !== "object") throw new Error("Qoder usage answered no usable document");
		const record = usage;
		const userQuota = qoderQuotaBucket(record["user_quota"] ?? record["userQuota"]);
		const addOnQuota = qoderQuotaBucket(record["add_on_quota"] ?? record["addOnQuota"]);
		const rawExpiry = record["expiresAt"] ?? record["expires_at"];
		const expiresAtMs = qoderEpochMs(rawExpiry);
		const neverExpires = expiresAtMs === void 0 && rawExpiry !== void 0 && rawExpiry !== null && rawExpiry !== "";
		const rawPackages = record["dedicated_resource_packages"] ?? record["dedicatedResourcePackages"];
		const now = Date.now();
		const dedicatedPackages = Array.isArray(rawPackages) ? rawPackages.map(qoderDedicatedPackage).filter((entry) => entry !== void 0).filter((entry) => entry.expiresAtMs === void 0 || entry.expiresAtMs > now) : [];
		if (userQuota === void 0 && addOnQuota === void 0 && dedicatedPackages.length === 0) throw new Error("Qoder usage contained no usable quota");
		return {
			...userQuota === void 0 ? {} : { userQuota },
			...addOnQuota === void 0 ? {} : { addOnQuota },
			dedicatedPackages,
			...expiresAtMs === void 0 ? {} : { expiresAtMs },
			...neverExpires ? { neverExpires: true } : {},
			source
		};
	}
	/**
	* Read the raw campaigns payload once. One round trip answers both the
	* promotional rows and the daily check-in round; the pure selectors above
	* split it without a second request.
	*/
	async fetchCampaigns(signal) {
		const credential = await this.options.credential();
		const response = await this.fetchImpl(qoderEndpoint(this.openApiBase(), QODER_CAMPAIGNS_PATH), {
			method: "GET",
			headers: qoderOpenApiHeaders(credential),
			redirect: "error",
			signal: signal ?? AbortSignal.timeout(DIRECTORY_TIMEOUT_MS)
		});
		if (!response.ok) throw new Error(`Qoder campaigns failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
		return await response.json();
	}
	/**
	* Claim one campaign's benefit, returning the raw answer. A repeat answers
	* `replayed: true` rather than failing; `qoderNormalizeClaimResult` narrows it.
	*/
	async claimCampaign(campaignId, signal) {
		if (typeof campaignId !== "string" || campaignId.length === 0) throw new Error("Qoder check-in failed: no campaign id to claim");
		const credential = await this.options.credential();
		const response = await this.fetchImpl(qoderEndpoint(this.openApiBase(), qoderClaimCampaignPath(campaignId)), {
			method: "POST",
			headers: {
				...qoderOpenApiHeaders(credential),
				"Content-Type": "application/json"
			},
			body: "{}",
			redirect: "error",
			signal: signal ?? AbortSignal.timeout(DIRECTORY_TIMEOUT_MS)
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`Qoder check-in failed: HTTP ${response.status} ${text.slice(0, 200)}`);
		try {
			return JSON.parse(text);
		} catch {
			const contentType = response.headers.get("content-type") ?? "no content-type";
			throw new Error(`Qoder check-in: response is not valid JSON (${contentType}) — ${text.slice(0, 300)}`);
		}
	}
	/**
	* Open one chat stream for a model. The caller owns the SSE translation;
	* a refusal answers as a classified error with the body truncated.
	*/
	async chatStream(openAiBody, model, options = {}) {
		let plain;
		try {
			plain = buildQoderChatBody(openAiBody, model, options);
		} catch {
			return {
				ok: false,
				status: 400,
				kind: "client",
				message: "invalid JSON request"
			};
		}
		const credential = await this.options.credential();
		const url = qoderEndpoint(this.baseUrl(), QODER_CHAT_PATH);
		const bodyBytes = encodeBody(plain);
		const headers = buildCosyAuthHeaders(bodyBytes, url, credential);
		let response;
		try {
			response = await this.fetchImpl(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...headers,
					...options.extraHeaders
				},
				body: bodyBytes,
				redirect: "error",
				signal: options.signal === void 0 ? AbortSignal.timeout(CHAT_STREAM_TIMEOUT_MS) : AbortSignal.any([options.signal, AbortSignal.timeout(CHAT_STREAM_TIMEOUT_MS)])
			});
		} catch (error) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `transport error: ${String(error)}`
			};
		}
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			return {
				ok: false,
				status: response.status,
				kind: classifyQoderUpstreamError(response.status),
				message: text.slice(0, 300) || `Qoder returned HTTP ${response.status}`
			};
		}
		return {
			ok: true,
			response
		};
	}
};
//#endregion
//#region src/qoder-sse.ts
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function tryJsonObject(text) {
	try {
		const parsed = JSON.parse(text);
		return isPlainObject(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
/**
* The code and message a failure frame really carries, however deeply they are
* wrapped. The walk follows `details`/`error`, or a `message` string that is
* itself a JSON document, up to 8 levels — bounded so a self-referential
* payload cannot spin. When it bottoms out on an object (the queue descriptor),
* that object is far more useful than the string that carried it.
*/
function unwrapFailure(frame) {
	let code = "";
	let detail = "";
	let node = frame;
	let descended = false;
	for (let depth = 0; depth < 8; depth++) {
		if (!isPlainObject(node)) break;
		const levelCode = node["errorCode"] ?? node["code"];
		if (typeof levelCode === "string" && levelCode.length > 0) code = levelCode;
		else if (typeof levelCode === "number" && Number.isFinite(levelCode)) code = String(levelCode);
		const message = node["message"] ?? node["errorMessage"];
		if (typeof message === "string" && message.length > 0) detail = message;
		const next = (isPlainObject(node["details"]) ? node["details"] : isPlainObject(node["error"]) ? node["error"] : void 0) ?? (typeof message === "string" ? tryJsonObject(message) : void 0);
		if (next === void 0) break;
		node = next;
		descended = true;
	}
	if (descended && detail === "" && isPlainObject(node)) detail = JSON.stringify(node);
	return {
		code,
		detail
	};
}
/**
* The gateway's retry hint, when the frame carries one.
*
* A carried `0` is the decoder's "no hint" placeholder, not a real wait, so it
* falls through to the nested value the same way `queueSeconds` does. Treating it
* as a real answer returned 0 and threw away the actual wait the queue frame
* carried in its message text.
*/
function retryAfterSecondsOf(frame) {
	if (!isPlainObject(frame)) return 0;
	const direct = frame["retryAfterSeconds"];
	if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) return direct;
	const { detail } = unwrapFailure(frame);
	if (detail === "") return 0;
	const nested = tryJsonObject(detail)?.["retryAfterSeconds"];
	return typeof nested === "number" && Number.isFinite(nested) && nested > 0 ? nested : 0;
}
/**
* The inner chunk of one data payload: the envelope's `body` when it is a JSON
* string, the object when it is inline, and the envelope itself when it carries
* neither. Returns undefined when no layer parses.
*/
function unwrapQoderFrame(payload) {
	const envelope = tryJsonObject(payload);
	if (envelope === void 0) return void 0;
	const body = envelope["body"];
	if (typeof body === "string") return tryJsonObject(body);
	if (isPlainObject(body)) return body;
	return envelope;
}
/**
* Classify one data payload. A token-accounting frame carries `choices: []` (or
* omits it) with a top-level `usage`; it must be forwarded as a chunk, not read
* as a failure. Anything with neither chunks nor a name — a bare `{ success:
* true }` keepalive, or a payload whose shape moved — is reported as unknown
* rather than guessed at.
*/
function decodeQoderFrame(payload) {
	const chunk = unwrapQoderFrame(payload);
	if (chunk === void 0) return {
		type: "unknown",
		reason: "unparseable",
		data: payload
	};
	if (chunk["choices"] !== void 0 || chunk["usage"] !== void 0 && chunk["usage"] !== null) return {
		type: "chunk",
		chunk
	};
	const { code, detail } = unwrapFailure(chunk);
	if (code === "" && detail === "") return {
		type: "unknown",
		reason: "unnamed",
		data: chunk
	};
	return {
		type: "failure",
		code,
		detail,
		retryAfterSeconds: retryAfterSecondsOf(chunk)
	};
}
/** One unterminated line may not grow without bound; chat deltas are small. */
const MAX_LINE_CHARS = 8388608;
/**
* Incremental reader for the Qoder wire form: one JSON payload per `data:`
* line. Qoder sends no `event:`/`id:`/`retry` fields, so this stays a plain
* line reader instead of duplicating a full SSE event parser.
*/
var QoderFrameDecoder = class {
	buffer = "";
	done = false;
	/** Whether the wire has supplied its terminal marker, independent of TCP EOF. */
	get ended() {
		return this.done;
	}
	/** Payloads seen so far; `[DONE]` ends the stream and yields nothing. */
	push(chunk) {
		if (this.done) return [];
		this.buffer += chunk;
		const payloads = [];
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf("\n");
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (payload.length === 0) continue;
			if (payload === "[DONE]") {
				this.done = true;
				return payloads;
			}
			payloads.push(payload);
		}
		if (this.buffer.length > MAX_LINE_CHARS) {
			this.buffer = "";
			throw new Error("sse line exceeded 8388608 characters without a newline");
		}
		return payloads;
	}
	/** Flush a final payload the upstream left without a trailing newline. */
	finish() {
		if (this.done) return [];
		this.done = true;
		const line = this.buffer.trim();
		this.buffer = "";
		if (!line.startsWith("data:")) return [];
		const payload = line.slice(5).trim();
		return payload.length === 0 || payload === "[DONE]" ? [] : [payload];
	}
};
//#endregion
//#region src/qoder-shim.ts
/**
* Qoder ↔ OpenAI relay translation.
*
* The layer that makes a Qoder model answer an OpenAI client: it translates
* the request envelope, then translates the answer back. `src/shim.ts` —
* which is bound to the WorkBuddy pool, upstream client and catalog — is
* untouched by this.
*/
/** Retryable queue wait the gateway answers with 429 + Retry-After. */
var QoderQueueRejection = class extends Error {
	retryAfterSeconds;
	constructor(retryAfterSeconds, message) {
		super(message);
		this.retryAfterSeconds = retryAfterSeconds;
		this.name = "QoderQueueRejection";
	}
};
/** Daily allowance spent: no retry within this session helps. */
var QoderDailyLimitRejection = class extends Error {
	retryAfterSeconds;
	constructor(retryAfterSeconds, message) {
		super(message);
		this.retryAfterSeconds = retryAfterSeconds;
		this.name = "QoderDailyLimitRejection";
	}
};
/** The sign-in is gone; the user must sign in to the Qoder app again. */
var QoderSignInExpiredError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "QoderSignInExpiredError";
	}
};
/** Queue descriptor field names; any two co-occurring mark a queue. */
const QUEUE_MARKERS = [
	"\"queueType\"",
	"\"retryAfterSeconds\"",
	"\"isQueued\"",
	"\"serviceAvailable\""
];
function queueMarkerCount(text) {
	let count = 0;
	for (const marker of QUEUE_MARKERS) if (text.includes(marker)) count += 1;
	return count;
}
/**
* Best-effort `retryAfterSeconds` from a queue payload, seconds.
*
* A carried `0` is "no hint" (the decoder's placeholder), not a real wait —
* only a positive value is used directly, otherwise the text is dug through.
*/
function queueSeconds(frame) {
	if (Number.isFinite(frame.retryAfterSeconds) && frame.retryAfterSeconds > 0) return frame.retryAfterSeconds;
	let text = frame.detail;
	for (let depth = 0; depth < 4; depth++) {
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			return 0;
		}
		if (typeof parsed === "string") {
			text = parsed;
			continue;
		}
		if (parsed === null || typeof parsed !== "object") return 0;
		const record = parsed;
		const seconds = Number(record["retryAfterSeconds"]);
		if (Number.isFinite(seconds) && seconds > 0) return seconds;
		if (typeof record["message"] !== "string" || record["message"] === text) return 0;
		text = record["message"];
	}
	return 0;
}
/**
* Map one in-stream failure onto the gateway's answer.
*
* Exact code matches decide first, so a sign-in failure is never shadowed by
* a stray field name; the marker fallback fires only when at least two queue
* markers co-occur, so an auth error that happens to carry a
* `retryAfterSeconds` field is not misread as a queue. The daily-limit check
* runs BEFORE the queue check: a spent allowance arrives WITH queue markers
* and a multi-hour Retry-After, and classifying it as a queue would turn it
* into a long sleep instead of a failover.
*/
function classifyQoderFailure(failure) {
	const code = failure.code.trim();
	const text = `${code} ${failure.message}`;
	if (code === "110" || /daily.*(limit|quota)|quota.*daily|allowance.*spent/i.test(text)) {
		const retryAfter = queueSeconds({
			type: "failure",
			code,
			detail: failure.message,
			retryAfterSeconds: failure.retryAfterSeconds ?? 0
		});
		return {
			status: 429,
			kind: "hard_credit",
			error: new QoderDailyLimitRejection(Number.isFinite(retryAfter) ? retryAfter : 0, failure.message)
		};
	}
	if (code === "10605") return {
		status: 429,
		kind: "soft_rate",
		error: new QoderQueueRejection(queueSeconds({
			type: "failure",
			code,
			detail: failure.message,
			retryAfterSeconds: failure.retryAfterSeconds ?? 0
		}), failure.message)
	};
	if (/Login expired|TOKEN_EXPIRE|token is not active/i.test(text) || code === "105") return {
		status: 401,
		kind: "authentication",
		error: new QoderSignInExpiredError(failure.message)
	};
	if (code === "1210") return {
		status: 400,
		kind: "client",
		error: new Error(failure.message)
	};
	if (queueMarkerCount(failure.message) >= 2) return {
		status: 429,
		kind: "soft_rate",
		error: new QoderQueueRejection(queueSeconds({
			type: "failure",
			code,
			detail: failure.message,
			retryAfterSeconds: failure.retryAfterSeconds ?? 0
		}), failure.message)
	};
	if (code === "429") return {
		status: 429,
		kind: "soft_rate",
		error: new QoderQueueRejection(0, failure.message)
	};
	if (code === "402") return {
		status: 402,
		kind: "hard_credit",
		error: new Error(failure.message)
	};
	return {
		status: 502,
		kind: "client",
		error: new Error(failure.message)
	};
}
/**
* OpenAI request body → the Qoder chat call.
*
* The model id and the caller's thinking intent are the only things this adds
* over the plain envelope: `max_tokens` / `tools` / `messages` pass through
* the client builder untouched, and `is_reasoning` is only stated when the
* caller states it (a fabricated `false` is refused with 1210 on models that
* always think).
*/
function qoderRequestBody(openAiBody, model, entry, options = {}) {
	const requested = readReasoningEffort(openAiBody);
	const off = requested === "off" || requested === "none";
	const wire = requested === void 0 || off ? void 0 : qoderWireEffort(requested, entry);
	return {
		body: openAiBody,
		model,
		options: {
			...options,
			...requested === void 0 ? {} : {
				enableThinking: !off,
				...wire === void 0 ? {} : { reasoningEffort: wire }
			}
		}
	};
}
/**
* The level Qoder accepts for this model, or undefined when none may be sent.
*
* A listed level passes through; an unlisted one moves to the nearest listed
* level, ties going to the model's own default. A model whose catalog row
* carries no level table (only on/off) takes no level at all.
*/
function qoderWireEffort(requested, entry) {
	const levels = entry?.effortLevels ?? [];
	if (levels.length === 0) return void 0;
	if (levels.includes(requested)) return requested;
	const rank = (level) => QODER_EFFORT_ORDER.indexOf(level);
	const want = rank(requested);
	if (want < 0) return entry?.defaultEffort ?? levels[0];
	const fallback = entry?.defaultEffort === void 0 ? want : rank(entry.defaultEffort);
	const distance = (level) => Math.abs(rank(level) - fallback);
	return [...levels].sort((a, b) => {
		const near = Math.abs(rank(a) - want) - Math.abs(rank(b) - want);
		return near !== 0 ? near : distance(a) - distance(b);
	})[0];
}
/**
* The thinking level a client asked for, in the host's spelling.
*
* The host drops the field entirely for "off" (see `requestThinkingLevel`), so
* a present field always means thinking is wanted; "none" is Qoder's own
* spelling of the same off value. Anything unrecognized is passed through
* rather than guessed at.
*/
function readReasoningEffort(openAiBody) {
	let parsed;
	try {
		parsed = JSON.parse(openAiBody);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const effort = parsed["reasoning_effort"];
	return typeof effort === "string" && effort.trim() !== "" ? effort.trim() : void 0;
}
/**
* Translate a Qoder byte stream into an OpenAI chat-completion SSE stream.
*
* Terminal behaviour mirrors the Trae bridge: exactly one finish chunk goes
* out (a clean EOF with no done marker still gets one, because a client waits
* for a non-null `finish_reason` before it stops), and exactly one
* `data: [DONE]` closes it. A failure that arrives after output started ends
* the stream as an error; one that arrives before any output is left for the
* caller (`openQoderResponse`) to turn into a real HTTP status.
*/
function bridgeQoderStream(source, model, options = {}) {
	const id = options.id ?? `chatcmpl-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
	const created = options.created ?? Math.floor(Date.now() / 1e3);
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const frames = new QoderFrameDecoder();
	let sawToolCalls = false;
	let emittedFinishReason = false;
	let usage;
	const reader = source.getReader();
	let cancelled = false;
	const chunk = (delta, finishReason = null) => encoder.encode(`data: ${JSON.stringify({
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: delta === null ? [] : [{
			index: 0,
			delta,
			finish_reason: finishReason
		}],
		...usage === void 0 ? {} : { usage }
	})}\n\n`);
	let started = false;
	const roleChunk = (controller) => {
		if (started) return;
		started = true;
		controller.enqueue(chunk({
			role: "assistant",
			content: ""
		}));
	};
	const consume = (payload, controller) => {
		const decoded = decodeQoderFrame(payload);
		if (decoded.type === "unknown") return;
		if (decoded.type === "failure") {
			const { error } = classifyQoderFailure({
				code: decoded.code,
				message: decoded.detail,
				retryAfterSeconds: decoded.retryAfterSeconds
			});
			throw error;
		}
		const inner = decoded.chunk;
		const choices = inner["choices"];
		if (Array.isArray(choices)) for (const raw of choices) {
			if (raw === null || typeof raw !== "object") continue;
			const choice = raw;
			const delta = choice["delta"];
			if (delta !== null && typeof delta === "object") {
				const out = { ...delta };
				const toolCalls = delta["tool_calls"];
				if (Array.isArray(toolCalls) && toolCalls.length > 0) sawToolCalls = true;
				if (Object.keys(out).length > 0) {
					roleChunk(controller);
					controller.enqueue(chunk(out));
				}
			}
			const finish = choice["finish_reason"];
			if (typeof finish === "string" && finish !== "" && finish !== "null") {
				if (!emittedFinishReason) {
					emittedFinishReason = true;
					controller.enqueue(chunk({}, sawToolCalls ? "tool_calls" : finish));
				}
			}
		}
		if (inner["usage"] !== void 0 && inner["usage"] !== null && typeof inner["usage"] === "object") {
			usage = inner["usage"];
			controller.enqueue(chunk(null));
		}
	};
	return new ReadableStream({
		async start(controller) {
			try {
				while (!cancelled) {
					const next = await reader.read();
					if (cancelled) return;
					if (next.done) break;
					for (const payload of frames.push(decoder.decode(next.value, { stream: true }))) consume(payload, controller);
					if (frames.ended) break;
				}
				if (cancelled) return;
				for (const payload of frames.finish()) consume(payload, controller);
				if (!emittedFinishReason) {
					emittedFinishReason = true;
					controller.enqueue(chunk({}, sawToolCalls ? "tool_calls" : "stop"));
				}
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			} catch (error) {
				if (cancelled) controller.error(error);
				else {
					if (!(error instanceof Error && error.name === "AbortError")) options.onFailure?.(error);
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({
						id,
						object: "chat.completion.chunk",
						created,
						model,
						choices: [],
						error: {
							message: redactSecrets(error instanceof Error ? error.message : String(error)),
							type: "upstream_error"
						}
					})}\n\n`));
					if (!emittedFinishReason) {
						emittedFinishReason = true;
						controller.enqueue(chunk({}, sawToolCalls ? "tool_calls" : "stop"));
					}
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				}
			} finally {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
		},
		cancel(reason) {
			cancelled = true;
			return reader.cancel(reason);
		}
	});
}
/** How far {@link openQoderResponse} reads before giving up on finding a failure. */
const PEEK_MAX_CHUNKS = 64;
const PEEK_MAX_BYTES = 262144;
/** Replay the bytes the peek consumed, then drain the rest of the upstream. */
function replaySource(buffered, reader, ended) {
	let index = 0;
	return new ReadableStream({
		async pull(controller) {
			const bytes = buffered[index];
			if (bytes !== void 0) {
				index += 1;
				controller.enqueue(bytes);
				return;
			}
			if (ended) {
				controller.close();
				return;
			}
			const next = await reader.read();
			if (next.done) {
				controller.close();
				return;
			}
			controller.enqueue(next.value);
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => {});
		}
	});
}
/**
* Turn one gateway response into something an OpenAI client can consume.
*
* A non-2xx answer becomes a JSON error, and so does a 2xx with no body at all.
* A 2xx answer is peeked briefly: a failure that arrives before any output is
* turned into a real HTTP error rather than a 200 stream that ends empty, and
* everything peeked is replayed so no output is lost. A body that ends without
* ever producing output is forwarded as-is, so the client reads an empty turn.
*/
async function openQoderResponse(response, model, options = {}) {
	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).slice(0, 1024);
		return Response.json({ error: {
			message: detail === "" ? `Qoder returned HTTP ${response.status}` : detail,
			type: "upstream_error",
			code: response.status
		} }, { status: response.status });
	}
	const source = response.body;
	if (source === null) return Response.json({ error: {
		message: `Qoder response ${response.status} carried no body`,
		type: "upstream_error",
		code: 502
	} }, { status: 502 });
	const reader = source.getReader();
	const decoder = new TextDecoder();
	const frames = new QoderFrameDecoder();
	const buffered = [];
	let bufferedBytes = 0;
	let sawOutput = false;
	let failure;
	let ended = false;
	const inspect = (payloads) => {
		for (const payload of payloads) {
			const decoded = decodeQoderFrame(payload);
			if (decoded.type === "chunk") {
				const choices = decoded.chunk["choices"];
				if (Array.isArray(choices) && choices.length > 0) sawOutput = true;
				else if (decoded.chunk["usage"] !== void 0) sawOutput = true;
			} else if (decoded.type === "failure") failure ??= {
				code: decoded.code,
				message: decoded.detail,
				retryAfterSeconds: decoded.retryAfterSeconds
			};
			if (sawOutput || failure !== void 0) break;
		}
	};
	try {
		while (buffered.length < PEEK_MAX_CHUNKS && bufferedBytes < PEEK_MAX_BYTES) {
			const next = await reader.read();
			if (next.done) {
				ended = true;
				inspect(frames.finish());
				break;
			}
			buffered.push(next.value);
			bufferedBytes += next.value.byteLength;
			inspect(frames.push(decoder.decode(next.value, { stream: true })));
			if (sawOutput || failure !== void 0 || frames.ended) break;
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	}
	if (failure !== void 0 && !sawOutput) {
		await reader.cancel().catch(() => {});
		const { status, error } = classifyQoderFailure(failure);
		const retryAfter = error instanceof QoderQueueRejection || error instanceof QoderDailyLimitRejection ? error.retryAfterSeconds : void 0;
		return Response.json({ error: {
			message: error.message === "" ? `Qoder refused the request (${failure.code})` : error.message.slice(0, 1024),
			type: "upstream_error",
			code: status,
			...retryAfter === void 0 || !(retryAfter > 0) ? {} : { retryAfterSeconds: retryAfter }
		} }, {
			status,
			...retryAfter === void 0 || !(retryAfter > 0) ? {} : { headers: { "Retry-After": String(Math.ceil(retryAfter)) } }
		});
	}
	const replayed = replaySource(buffered, reader, ended);
	return new Response(bridgeQoderStream(replayed, model, options), {
		status: 200,
		headers: { "Content-Type": "text/event-stream" }
	});
}
//#endregion
//#region src/qoder-gateway.ts
/**
* Qoder loopback gateway.
*
* Stands the Qoder path up on a real 127.0.0.1 endpoint with the same routes
* and the same guards as the Trae gateway.
*
* Everything the gateway needs from the outside is injected (credentials,
* `fetchImpl`), so the whole path can be exercised offline.
*
* @module dsh-wtq-pool/qoder-gateway
*/
const MODELS_TTL_MS = 6e5;
function createQoderGateway(options) {
	const logger = options.logger;
	let cachedModels = [];
	let catalogAt = 0;
	let catalogInFlight;
	async function firstCredential(purpose) {
		const usable = (await options.credentials(purpose)).find((credential) => credential.token !== "");
		if (usable === void 0) throw new Error("no Qoder sign-in found on this machine");
		return usable;
	}
	function clientFor(credential) {
		return new QoderUpstreamClient({
			region: options.region,
			credential: async () => credential,
			...options.fetchImpl === void 0 ? {} : { fetchImpl: options.fetchImpl }
		});
	}
	/** Read the directory, at most once per TTL even under concurrent requests. */
	async function models() {
		if (Date.now() - catalogAt < MODELS_TTL_MS && cachedModels.length > 0) return cachedModels;
		if (catalogInFlight !== void 0) return catalogInFlight;
		catalogInFlight = (async () => {
			try {
				const read = await clientFor(await firstCredential()).fetchModels();
				cachedModels = read;
				catalogAt = Date.now();
				return read;
			} finally {
				catalogInFlight = void 0;
			}
		})();
		return catalogInFlight;
	}
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		const watcher = new AbortController();
		res.on("close", () => watcher.abort());
		const raw = (await readRequestBody(req)).toString("utf8");
		let model = "";
		try {
			model = JSON.parse(raw)["model"] ?? "";
		} catch {
			model = "";
		}
		if (typeof model !== "string" || model.trim() === "") {
			writeOpenAIError(res, 400, "invalid_request_error", "model is required");
			return;
		}
		model = model.trim();
		let reason = "Qoder model directory is not available yet";
		let roster = await models().catch((error) => {
			reason = "Qoder model directory could not be read: " + String(error instanceof Error ? error.message : error);
			return cachedModels;
		});
		if (watcher.signal.aborted) return;
		if (roster.length === 0) roster = cachedModels;
		if (roster.length === 0) {
			writeOpenAIError(res, 503, "upstream_unavailable", reason);
			return;
		}
		if (!roster.some((entry) => entry.id === model)) {
			writeOpenAIError(res, 404, "not_found", `model not in the Qoder directory: ${model}`);
			return;
		}
		let credential;
		try {
			credential = await firstCredential("chat");
		} catch (error) {
			writeOpenAIError(res, 503, "upstream_unavailable", String(error instanceof Error ? error.message : error));
			return;
		}
		if (watcher.signal.aborted) return;
		const directory = roster.find((entry) => entry.id === model);
		const call = qoderRequestBody(raw, model, directory);
		const result = await clientFor(credential).chatStream(call.body, call.model, {
			...call.options,
			extraHeaders: {
				"X-Model-Key": model,
				"X-Model-Source": "system"
			},
			signal: watcher.signal
		});
		if (!result.ok) {
			if (result.status === 0) {
				writeOpenAIError(res, 502, "upstream_error", result.message);
				return;
			}
			writeOpenAIError(res, result.status, "upstream_error", result.message);
			return;
		}
		const relayed = await openQoderResponse(result.response, model, { onFailure: (error) => {
			logger?.warn?.("dsh-wtq-pool: qoder relay stream failed mid-flight", error);
		} });
		if (relayed.status !== 200) {
			const detail = await relayed.text().catch(() => "");
			const status = relayed.status;
			const retryAfter = relayed.headers.get("retry-after");
			if (retryAfter !== null) res.setHeader("Retry-After", retryAfter);
			writeOpenAIError(res, status, "upstream_error", detail === "" ? "Qoder refused the request" : detail);
			return;
		}
		if (relayed.body === null) {
			writeOpenAIError(res, 502, "upstream_error", "Qoder returned no stream");
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		const body = Readable.fromWeb(relayed.body);
		body.on("error", (error) => {
			if (!(watcher.signal.aborted || error instanceof Error && error.name === "AbortError")) logger?.warn?.("dsh-wtq-pool: qoder relay stream failed mid-flight", error);
			if (res.writable) res.end();
		});
		body.pipe(res);
	}
	async function handle(req, res) {
		if (!guardsPass(req, res)) return;
		const url = req.url ?? "/";
		if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
			writeJson$1(res, 200, {
				ok: true,
				source: "qoder",
				credentials: (await options.credentials().catch(() => [])).length,
				models: cachedModels.length
			});
			return;
		}
		if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
			let served;
			try {
				served = await models();
			} catch (error) {
				served = cachedModels;
				if (served.length === 0) {
					writeOpenAIError(res, 503, "upstream_unavailable", String(error instanceof Error ? error.message : error));
					return;
				}
				logger?.warn?.("dsh-wtq-pool: qoder directory refresh failed; serving the cached roster");
			}
			const ids = options.listedIds?.();
			writeJson$1(res, 200, {
				object: "list",
				data: (ids === void 0 ? served : listedModels(served, ids)).map((model) => ({
					id: model.id,
					object: "model",
					created: 0,
					owned_by: "qoder"
				}))
			});
			return;
		}
		if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
			await chatCompletions(req, res);
			return;
		}
		writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
	}
	const server = createServer((req, res) => {
		answerRequest(res, () => handle(req, res), logger);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(options.port ?? 0, "127.0.0.1");
	server.on("error", (error) => {
		logger?.warn?.("dsh-wtq-pool: qoder gateway server error", error);
	});
	const port = () => {
		const address = server.address();
		return address === null || typeof address === "string" ? 0 : address.port;
	};
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("qoder gateway has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	return {
		ready,
		baseUrl,
		port,
		models: () => cachedModels,
		close: async () => {
			server.closeAllConnections?.();
			await new Promise((resolve) => server.close(() => resolve()));
		}
	};
}
//#endregion
//#region src/host.ts
/**
* dsh-wtq-pool - the plugin's engine.
*
* Merges every WorkBuddy, Trae and Qoder desktop sign-in on this machine into
* one model pool that fails over on its own:
*
*   1. discover every sign-in on this machine (read-only),
*   2. serve each vendor edition from its own loopback OpenAI-compatible
*      endpoint,
*   3. publish those endpoints as six providers,
*   4. rotate to the next account whenever the upstream answers 429.
*
* This file is the engine, not the entry: `index.ts` owns the Cordis
* activation and the provider registrations, and `pi-compat.ts` is the bridge
* between the two. Everything below is written against that bridge.
*
* Upstream traffic uses the platform `fetch` rather than a host network bridge:
* a bridged response is buffered into text, and a provider contract needs the
* upstream SSE body relayed as it arrives. Nothing leaves this machine except
* to the three vendors' own endpoints.
*/
/** Read from the package, so this can never drift behind the version it reports. */
const PLUGIN_VERSION = version;
/** The one background service this plugin registers. */
const SERVICE_ID = "provider-host";
const COMMAND_OPEN = "xdpool.open";
const COMMAND_RESCAN = "xdpool.rescan";
const COMMAND_RESET = "xdpool.resetCooldowns";
const COMMAND_DOCTOR = "xdpool.doctor";
const COMMAND_CHECKIN = "xdpool.checkin";
/** The two gateways, matching the provider ids this plugin registers. */
const REGIONS = ["cn", "global"];
const PROVIDER_ID_BY_REGION = {
	cn: "xdpool-cn",
	global: "xdpool-global"
};
const PROVIDER_NAME_BY_REGION = {
	cn: "WTQ Pool (CN)",
	global: "WTQ Pool (Global)"
};
/** The settings key each source's switch is stored under. */
const SOURCE_SETTING_KEYS = {
	workbuddy: "sourceWorkbuddy",
	trae: "sourceTrae",
	qoder: "sourceQoder"
};
/** Whether one source is switched on in settings. Unknown sources stay off, so a typo can never enable a gateway. */
function sourceEnabled(source) {
	const key = SOURCE_SETTING_KEYS[source];
	return key !== void 0 && settings.enabled !== false && settings[key] !== false;
}
/**
* Regions switched off on their own, as `source:region` keys.
*
* The source switch covers a whole vendor; this covers one edition of it, so a
* region whose sign-in is expired or unwanted can be parked without silencing
* the other one. A parked region gets no gateway, no scan and no provider row.
*/
function disabledRegionKeys() {
	const value = settings.disabledRegions;
	return Array.isArray(value) ? value.filter((key) => typeof key === "string" && key !== "") : [];
}
/** Whether one source region may run: its source is on and the region is not parked. */
function regionEnabled(source, region) {
	return sourceEnabled(source) && !disabledRegionKeys().includes(sourceRegionKey(source, region));
}
/** Regions whose source is switched on and which are not parked. */
function activeRegions() {
	return REGIONS.filter((region) => regionEnabled("workbuddy", region));
}
/** Preferred loopback port, one per gateway. */
const REGION_PORTS = {
	cn: 42831,
	global: 42841
};
/**
* Trae's gateways, kept beside the WorkBuddy pair rather than inside it.
*
* Trae's regions are `cn` / `ai` - a different pair from WorkBuddy's
* `cn` / `global` - and its credentials never enter the WorkBuddy account
* pool, so they get their own map, ports and provider ids. The two existing
* WorkBuddy rows above are untouched: nothing migrates and nothing is renamed.
*/
const TRAE_REGIONS = ["cn", "ai"];
const TRAE_PROVIDER_ID_BY_REGION = {
	cn: "xdpool-trae-cn",
	ai: "xdpool-trae-ai"
};
const TRAE_PROVIDER_NAME_BY_REGION = {
	cn: "WTQ Pool Trae (CN)",
	ai: "WTQ Pool Trae (Global)"
};
/** Trae's pair, in its own slots of the same block. */
const TRAE_PORTS = {
	cn: 42851,
	ai: 42861
};
const traeGateways = /* @__PURE__ */ new Map();
/** Regions whose source is switched on and which are not parked. */
function activeTraeRegions() {
	return TRAE_REGIONS.filter((region) => regionEnabled("trae", region));
}
/**
* Qoder's gateways, kept beside the WorkBuddy pair rather than inside it.
*
* Qoder's regions are `cn` / `global` - the same pair as WorkBuddy's - but
* its credentials never enter the WorkBuddy account pool, so they get their
* own map, ports and provider ids all the same. Nothing above is touched.
*/
const QODER_REGIONS = ["cn", "global"];
const QODER_PROVIDER_ID_BY_REGION = {
	cn: "xdpool-qoder-cn",
	global: "xdpool-qoder-global"
};
const QODER_PROVIDER_NAME_BY_REGION = {
	cn: "WTQ Pool Qoder (CN)",
	global: "WTQ Pool Qoder (Global)"
};
/** Qoder's pair, in the last two slots. */
const QODER_PORTS = {
	cn: 42871,
	global: 42881
};
/** region -> { region, gateway, baseUrl, portFallback, lastError }. */
const qoderGateways = /* @__PURE__ */ new Map();
/** Regions whose source is switched on and which are not parked. */
function activeQoderRegions() {
	return QODER_REGIONS.filter((region) => regionEnabled("qoder", region));
}
/**
* How hard one run tries to reclaim its preferred port.
*
* A busy preferred port is almost always the previous instance still exiting,
* which is a wait of milliseconds rather than a permanent condition. Giving up
* instantly made a run fall back to a spare port and publish it, which
* stranded the host on an address nothing listens on.
*/
const PORT_RESERVE_ATTEMPTS = 6;
const PORT_RESERVE_INTERVAL_MS = 250;
/** Levels the host's thinking picker accepts, in the order it shows them. */
const HOST_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Publication bounds this plugin holds its provider declarations to. */
const MAX_MODELS = 64;
const MAX_TOKEN_BUDGET = 4294967295;
const CONSERVATIVE_CONTEXT_WINDOW = 128e3;
const DEFAULT_MAX_TOKENS = 32e3;
const CATALOG_TTL_MS = 18e5;
/** Used until a shim binds, so a descriptor never carries an empty base URL. */
const PLACEHOLDER_BASE_URL = "http://127.0.0.1:1/v1";
/**
* How long one account's billing answers (credits, check-in) are reused.
*
* The panel renders from these cached answers and they refresh behind the first
* paint, so opening it never waits on a billing call per account.
*/
const PROBE_TTL_MS = 6e4;
/**
* Bound on one model-catalog request, so a stalled host cannot stall a load.
*
* Ten seconds is well past a healthy roster read, and it also has to fit the
* budget the host gives `onLoad`: the two regions are read at once, so this
* timeout is the ceiling on init rather than twice it.
*/
const MODELS_TIMEOUT_MS = 1e4;
/**
* The share of the load path a roster read may take.
*
* Nothing in DSH caps how long this plugin's own load may take, so these bounds
* are the plugin's: the first declaration publishes on time and a slow roster
* read lands behind it. A read that outruns its share is left to finish behind
* the answer, and the refresh that follows the service start fills the roster in.
*/
const LOAD_ROSTER_BUDGET_MS = 6e3;
const SERVICE_ROSTER_BUDGET_MS = 3e3;
/**
* The share of the same two paths the steps in front of the roster read may
* take: the gateway reconcilers, the account scan, and the runtime starts.
*
* Those steps are disk and port work that can stall on a pathological machine,
* and the point of publishing early is lost if they are what the load waits
* on. A step that outruns its budget keeps running behind the answer; the
* refresh after the service start reconciles whatever it missed.
*/
const LOAD_BOOTSTRAP_BUDGET_MS = 5e3;
const SERVICE_BOOTSTRAP_BUDGET_MS = 1500;
/**
* One whole refresh pass, and how long a forced one waits for the pass it found
* already running.
*
* The panel bridge imposes no call-length cap, so this budget is the plugin's
* own. Every stage inside a pass is sized against this one deadline, and the
* port reservations in front of it are capped by their own attempt count - a
* few seconds at worst when another process holds the preferred ports.
*/
const REFRESH_PASS_BUDGET_MS = 18e3;
const REFRESH_HANDOVER_MS = 2e3;
let settings = {};
/**
* Bumped by every local mutation of `settings`.
*
* A refresh pass reads the document from the host and then awaits for seconds;
* a save landing in that window is newer than the document the read returns.
* Comparing this counter across the read is what stops the pass from reverting
* a switch the user just flipped.
*/
let settingsRevision = 0;
let dataPath = "";
/** One runtime per gateway: its shim and catalog. */
const runtimes = /* @__PURE__ */ new Map();
/**
* Gateway closes `reconcileRuntimes` started but could not wait for.
*
* That function runs synchronously inside settings application, yet a source
* toggled off and straight back on starts a new gateway while the old one's
* close is still releasing the port. `startRuntimes` drains this list first, so
* the new bind lands on a port the old shim has actually let go of instead of
* falling back to a temporary one nothing was told about.
*/
const pendingRuntimeStops = [];
/** Provider ids the host has confirmed it is serving, this process's lifetime. */
let publishedIds = /* @__PURE__ */ new Set();
/**
* Every provider row this process has published, keyed by provider id.
*
* The host registers providers at runtime, so nothing on disk remembers them:
* the declaration this plugin published IS the record. Keeping it here is also
* what lets the doctor report a refused registration instead of guessing.
*/
let declarationIndex = /* @__PURE__ */ new Map();
/** Shared upstream client and account pool, built in onLoad. */
const core = {
	client: null,
	pool: null
};
/** Handle for the one deferred refresh, so a burst of opens coalesces. */
let refreshTimer = null;
/** The background refresh in flight, so two passes never overlap. */
let refreshInflight = null;
/**
* Counts activations, so a pass from a retired one can tell that it is stale.
*
* A refresh suspends at network awaits, and unload cannot wait for it. Without
* this the pass resumes after teardown and re-creates what teardown just closed:
* it binds a fresh gateway on the port and fills maps
* that were cleared - all ownerless, because unload has already run. Every pass
* therefore carries the generation it started in and stops at its own await
* points once that number moves.
*/
let loadGeneration = 0;
let serviceStopped = false;
/**
* True while `generation` is still the live activation.
*
* Every long pass checks this after an await before it touches shared state, so
* a pass that outlived its activation gives up instead of re-opening gateways
* and timers the teardown has already closed.
*/
function stillLoaded(generation) {
	return !serviceStopped && generation === loadGeneration;
}
/** The host settings listener, kept so onUnload can detach it. */
let settingsChangedHandler = null;
/** The daily check-in timer, and what it has already collected. */
let autoCheckinTimer = null;
/**
* True while a check-in pass is running, whichever entry point started it.
*
* One flag for all three — the scheduled tick, the host command and the panel's
* "run now" — because two passes writing `autoCheckinLast` would leave the log
* describing whichever finished last rather than what the user asked for.
*/
let checkinPassRunning = false;
/** Slots this process has collected, as `YYYY-MM-DDTHH` in the campaign's zone. */
const autoCheckinSlots = /* @__PURE__ */ new Set();
/** The last automatic pass, for the panel's status line. */
let autoCheckinLast = null;
/**
* When a deferred pass is owed, in ms; 0 = nothing pending.
*
* Qoder's daily round only exists from 10:00 Beijing, so an automatic pass at
* 09:00 cannot collect it. Rather than adding a second timer, this remembers
* the opening time and the same timer comes back for it then.
*/
let qoderRetryAt = 0;
/**
* Cat-travel pacing: one pass per account, same throttle as the upstream's own
* scheduler. A single `travelOne` already fans out to several RPCs, so a tight
* loop would look like a burst to the upstream.
*/
const TRAVEL_ACCOUNT_DELAY_MS = 800;
/** Pause between two Qoder accounts' check-ins, so a batch does not read as a burst. */
const QODER_ACCOUNT_DELAY_MS = 1e3;
/** Trae's check-in pace: 5 s between accounts, ±2 s jitter (the spacing its endpoint is proven with). */
const TRAE_ACCOUNT_DELAY_MS = 5e3;
const TRAE_ACCOUNT_JITTER_MS = 2e3;
/** Wait after the adopt preflight report before calling buddy/first. */
const TRAVEL_ADOPT_GAP_MS = 1050;
/** Between the check-in burst and the growth burst on the same accounts. */
const GROWTH_AFTER_CHECKIN_MS = 1500;
/** Between one domestic account and the next inside the growth pass. */
const GROWTH_ACCOUNT_DELAY_MS = 400;
/** Account ids that hit the adopt conversation threshold today (CST day). */
const travelAdoptTried = /* @__PURE__ */ new Map();
/**
* An error's text with token-shaped content already redacted.
*
* Every caller gets this form — log lines, the panel and the doctor report all
* read the same string — so a credential that reaches an error message cannot
* end up somewhere it should not, whichever call site forgot to ask for the
* panel's stricter copy.
*/
function messageOf(error) {
	return redactSecrets(error && error.message ? String(error.message) : String(error));
}
function log(level, message) {
	try {
		console.log("[xdpool] " + level + ": " + message);
	} catch {}
}
/**
* One gateway logger line from what a gateway passed it.
*
* The gateways call `warn(message, error)`, and an adapter that took only the
* first argument threw away the only explanation a closed socket or a failed
* upstream read ever had. Detail goes through the same redaction every other
* error text gets, so nothing unredacted reaches the log through it.
*/
function gatewayLogLine(prefix, args) {
	return prefix + args.map(messageOf).join(" ");
}
function regionOfKey(value) {
	return value === "global" ? "global" : "cn";
}
/**
* Read the settings document.
*
* `undefined` means the read failed, which is not the same answer as an empty
* document and must not be treated as one - see {@link adoptHostSettings}.
*/
async function loadSettings() {
	try {
		return await pi.plugin.getSettings() || {};
	} catch {
		return;
	}
}
/**
* Replace this process's settings with a fresh read, unless that read failed or
* a local write landed while it was in flight. Returns whether it replaced them.
*
* Two failures are ruled out here. A failed read is not an empty document:
* returning `{}` let one transient host RPC error wipe this process's copy of
* `disabledAccountIds`, `removedAccounts`, `creditReserves`, `modelSelection`
* and the parked regions, and because the panel's save helpers spread that copy
* before writing one key, the next save made the loss permanent. A read that
* raced a save is also older than that save by definition, so taking it reverted
* the switch the user had just flipped.
*/
async function adoptHostSettings() {
	const revision = settingsRevision;
	const next = await loadSettings();
	if (next === void 0) {
		log("warn", "could not read settings; keeping the last known document");
		return false;
	}
	if (settingsRevision !== revision) return false;
	settings = next;
	return true;
}
/**
* Persist a partial settings patch.
*
* Returns false instead of throwing so a request path can never be broken by a
* rejected write, but the caller still learns that nothing was stored.
*/
async function saveSettings(patch) {
	try {
		await pi.plugin.setSettings(patch);
		settings = {
			...settings,
			...patch
		};
		settingsRevision += 1;
		return true;
	} catch (error) {
		log("warn", "could not save settings: " + messageOf(error));
		return false;
	}
}
/**
* Apply a settings payload the host pushed at this process.
*
* The host validates and stores first, then announces the merged document, so a
* selection edited in the host's own settings UI reaches the running plugin
* here instead of only after a reload. The selection is re-applied and the
* declaration republished straight away, because a narrower model list has to
* reach the picker or the user still sees the models they just disabled.
*/
async function onHostSettingsChanged(next) {
	if (serviceStopped) return;
	if (next === null || typeof next !== "object" || Array.isArray(next)) return false;
	settings = {
		...settings,
		...next
	};
	settingsRevision += 1;
	applySettingsToCore();
	traeAccountRows = traeAccountRows.filter((row) => regionEnabled("trae", row.region));
	qoderAccountRows = qoderAccountRows.filter((row) => regionEnabled("qoder", row.region));
	await reconcileTraeGateways();
	await reconcileQoderGateways();
	syncDeclaration();
	probeCache.clear();
	scheduleRefresh("settings");
	return true;
}
/** Subscribe to the host's settings event, tolerating a host without it. */
function subscribeToHostSettings() {
	settingsChangedHandler = (next) => {
		onHostSettingsChanged(next).then((applied) => {
			if (applied) log("info", "settings changed in the host UI; selection re-applied");
		}).catch((error) => log("warn", "applying host settings failed: " + messageOf(error)));
	};
	try {
		if (pi.events && typeof pi.events.on === "function") {
			pi.events.on("plugin:settingsChanged", settingsChangedHandler);
			return true;
		}
	} catch (error) {
		log("warn", "could not subscribe to settings changes: " + messageOf(error));
	}
	settingsChangedHandler = null;
	return false;
}
function cooldownMs() {
	const value = Number(settings.cooldownSeconds);
	if (!Number.isFinite(value) || value <= 0) return 6e4;
	return Math.max(1e3, Math.min(864e5, Math.round(value * 1e3)));
}
/** `priority` drains one account. An old `balanced` value reads as priority. */
const WORKBUDDY_DISTRIBUTIONS = [
	"round-robin",
	"expiry",
	"sticky"
];
function distributionSetting() {
	const value = settings.distribution;
	return WORKBUDDY_DISTRIBUTIONS.includes(value) ? value : "priority";
}
/**
* The zone the daily check-in hours are read in.
*
* The reward windows are defined in Beijing time, so an hour has to mean the
* same instant on every machine: reading the host's local hour would make "9
* o'clock" slip by a day on a laptop set to another zone.
*/
const CHECKIN_TIME_ZONE = "Asia/Shanghai";
/** Collected at 09:00 local campaign time unless the user says otherwise. */
const DEFAULT_CHECKIN_HOURS = [9];
/** How often the timer looks for a due slot. A minute is far below one hour. */
const CHECKIN_POLL_MS = 6e4;
/** Calendar day and hour of `date` in the check-in zone, as zero-padded strings. */
function zonedDayHour(date) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: CHECKIN_TIME_ZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hourCycle: "h23"
	}).formatToParts(date);
	const pick = (type) => {
		const found = parts.find((part) => part.type === type);
		return found === void 0 ? "00" : found.value;
	};
	return {
		day: pick("year") + "-" + pick("month") + "-" + pick("day"),
		hour: Number(pick("hour"))
	};
}
/**
* Whole hours only, in order. Anything unreadable is dropped rather than
* guessed at, and an empty list falls back to the default hour: a switch that
* is on but never fires would be worse than one that picks a sane time.
*/
function normaliseCheckinHours(raw) {
	const hours = [...new Set(raw.map((value) => Math.floor(Number(value))))].filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23).sort((a, b) => a - b);
	return hours.length === 0 ? [...DEFAULT_CHECKIN_HOURS] : hours;
}
/** Hours in force now: what the user configured, or the default. */
function checkinHours() {
	const raw = settings.autoCheckin?.hours;
	return normaliseCheckinHours(Array.isArray(raw) ? raw : []);
}
function autoCheckinEnabled() {
	return settings.autoCheckin?.enabled === true;
}
/**
* The slot to collect right now, or undefined when nothing is due.
*
* A slot is `YYYY-MM-DDTHH` in the check-in zone, and an hour is due once its
* time has passed — catch-up, deliberately: a machine that slept through 09:00
* still collects when it wakes instead of waiting for tomorrow. The earliest
* unconsumed hour wins, so two configured hours still give two passes a day.
*/
function checkinSlotId(day, hour) {
	return day + "T" + String(hour).padStart(2, "0");
}
function dueCheckinSlot(now, hours, fired) {
	const { day, hour } = zonedDayHour(now);
	for (const candidate of [...hours].sort((a, b) => a - b)) {
		if (candidate > hour) continue;
		const slot = checkinSlotId(day, candidate);
		if (!fired.has(slot)) return slot;
	}
}
function preferredAccountId(region) {
	const value = settings.preferredAccountIds?.[region];
	return typeof value === "string" && value !== "" ? value : void 0;
}
/** Storage key for one source region's picked account. */
function sourceRegionKey(source, region) {
	return source + ":" + region;
}
/** The account the user picked for one source region; "" means automatic. */
function preferredSourceAccount(source, region) {
	const value = settings.preferredSourceAccounts?.[sourceRegionKey(source, region)];
	return typeof value === "string" ? value : "";
}
/** The picked account per active region of one source, for the panel's picker. */
function sourcePreferredMap(source) {
	const regions = source === "trae" ? activeTraeRegions() : activeQoderRegions();
	const map = {};
	for (const region of regions) map[region] = preferredSourceAccount(source, region);
	return map;
}
/**
* The Trae/Qoder accounts this run found, for one source.
*
* Both the composer chip and the panel picker name an account by this label, and
* both have to store it. Reading them from here is what lets a choice be checked
* against the sign-ins that actually exist instead of being written blind.
*/
function sourceAccountLabels(source, region) {
	return (source === "trae" ? traeAccountRows : qoderAccountRows).filter((row) => row.region === region && row.expired !== true).map((row) => row.label);
}
/**
* Whether a named account may be stored as the preferred one.
*
* An empty label clears the preference, which is always allowed. Any other label
* has to name an account this run found and that has not expired: storing a name
* nothing can match leaves the picker silently falling back to its own default,
* so the click looks like it worked and the same account keeps serving.
*/
function sourceAccountMayBePreferred(source, region, label) {
	if (label === "") return true;
	return sourceAccountLabels(source, region).includes(label);
}
/** Usage modes one source can follow. `expiry` spends the soonest one-off pack first. */
const SOURCE_DISTRIBUTIONS = ["round-robin", "expiry"];
/** How one source spreads requests when no account is picked for the region. */
function sourceDistribution(source) {
	const value = settings.sourceDistributions?.[source];
	return SOURCE_DISTRIBUTIONS.includes(value) ? value : "priority";
}
/** Soonest remaining one-off pack. Monthly and never-expiring pools do not count. */
function nearestPackExpiry(packages) {
	let best;
	const now = Date.now();
	for (const pack of packages || []) {
		if (pack.monthly === true || pack.neverExpires === true) continue;
		const when = typeof pack.expiresAtMs === "number" ? pack.expiresAtMs : typeof pack.roundExpiresAtMs === "number" ? pack.roundExpiresAtMs : void 0;
		if (typeof when !== "number" || when <= now) continue;
		if (typeof pack.remain === "number" && pack.remain <= 0) continue;
		if (best === void 0 || when < best) best = when;
	}
	return best;
}
const sourceCreditExpiry = /* @__PURE__ */ new Map();
function noteSourceExpiry(source, label, packages) {
	const at = nearestPackExpiry(packages);
	const key = source + "\n" + label;
	if (at === void 0) sourceCreditExpiry.delete(key);
	else sourceCreditExpiry.set(key, at);
}
/** Unknown expiry sorts last, so it never beats a real deadline. */
function packUrgency(source, label, now) {
	const at = sourceCreditExpiry.get(source + "\n" + label);
	return typeof at === "number" && at > now ? at : Infinity;
}
/** Where each source region's rotation stands, advanced once per request. */
const sourceRotation = /* @__PURE__ */ new Map();
/**
* A sign-in with no expiry is still usable. Only a timestamp that has passed is dead.
*/
function sourceCredentialExpired(credential, now) {
	return typeof credential.expiresAtMs === "number" && credential.expiresAtMs > 0 && credential.expiresAtMs <= now;
}
/**
* One source region's credentials, in the order its gateway should try them:
* the picked account first, then tokens that still work before expired ones.
*
* The gateways take the first usable entry and re-read this list per request,
* so this order is the whole of "which account serves this region" — and
* putting a live token ahead of a dead one is what keeps a stale sign-in from
* being the one that answers.
*
* A picked account is what the user asked to spend, so it leads in every mode;
* only "automatic" leaves the choice to the usage mode. Round-robin then walks
* the list one account per request instead of draining the first one.
*/
function orderSourceCredentials(source, region, credentials, labelOf, rotate) {
	const now = Date.now();
	const stored = preferredSourceAccount(source, region);
	const preferred = stored !== "" && credentials.some((credential) => labelOf(credential) === stored) ? stored : "";
	const rank = (credential) => {
		const wanted = preferred !== "" && labelOf(credential) === preferred ? 0 : 1;
		const expired = sourceCredentialExpired(credential, now) ? 1 : 0;
		return wanted * 2 + expired;
	};
	const ordered = credentials.slice().sort((left, right) => rank(left) - rank(right));
	if (preferred === "" && sourceDistribution(source) === "expiry") {
		const live = ordered.filter((credential) => !sourceCredentialExpired(credential, now));
		const rest = ordered.filter((credential) => sourceCredentialExpired(credential, now));
		live.sort((left, right) => packUrgency(source, labelOf(left), now) - packUrgency(source, labelOf(right), now));
		return live.concat(rest);
	}
	const live = ordered.filter((credential) => !sourceCredentialExpired(credential, now));
	if (rotate !== true || preferred !== "" || live.length < 2 || sourceDistribution(source) !== "round-robin") return ordered;
	const key = sourceRegionKey(source, region);
	const step = (sourceRotation.get(key) ?? 0) % live.length;
	sourceRotation.set(key, step + 1);
	const rest = ordered.filter((credential) => sourceCredentialExpired(credential, now));
	return live.slice(step).concat(live.slice(0, step), rest);
}
/** Account ids switched off on the panel; the pool never picks them. */
function disabledAccountIds() {
	const value = settings.disabledAccountIds;
	if (!Array.isArray(value)) return [];
	return value.filter((id) => typeof id === "string" && id !== "");
}
/** Per-account credit floor from the panel, keyed by account id. */
function creditReserves() {
	const value = settings.creditReserves;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const clean = {};
	for (const [id, raw] of Object.entries(value)) {
		const floor = Number(raw);
		if (id !== "" && Number.isFinite(floor) && floor > 0) clean[id] = Math.floor(floor);
	}
	return clean;
}
/**
* Accounts removed from the pool for good, with label and gateway kept so the
* panel can still offer a restore after the account stops being scanned.
*/
function removedAccounts() {
	const value = settings.removedAccounts;
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => entry !== null && typeof entry === "object" && typeof entry.id === "string" && entry.id !== "" && REGIONS.includes(entry.region));
}
/**
* The saved model selection for one gateway.
*
* The original kept a single selection for the whole pool; the port keys it per
* gateway so the two picker groups can be filtered independently. Absent means
* "everything enabled" - an unconfigured install must never show an empty list.
*/
function selectionFor(region) {
	return gatewaySelectionFor(regionOfKey(region));
}
/** The stored selection for one raw gateway key, absent means "everything on". */
function gatewaySelectionFor(key) {
	return normalizeSelection((settings.modelSelection && typeof settings.modelSelection === "object" ? settings.modelSelection : {})[key]);
}
/**
* The ids one gateway's stored selection keeps; null means publish everything.
* A selection naming no live model is treated as unset, mirroring
* savedSelectionMatches, so a renamed catalog never empties the group.
*/
function gatewayEnabledIds(key, catalogIds) {
	const enabled = gatewaySelectionFor(key).enabledModelIds;
	if (!Array.isArray(enabled) || enabled.length === 0) return null;
	const known = new Set(catalogIds);
	const kept = enabled.filter((id) => known.has(id));
	return kept.length > 0 ? new Set(kept) : null;
}
/** Stored per-model overrides for one gateway key ("trae:cn", ...), by model id. */
function gatewayOverrides(key) {
	const overrides = gatewaySelectionFor(key).overrides;
	return overrides !== null && typeof overrides === "object" ? overrides : {};
}
/**
* One Trae/Qoder model as the panel edits it: the value in force, the value the
* gateway reported, and whether the user changed it. The provider declaration
* and the status document both read this, so what the editor shows is what gets
* published.
*/
function sourceModelView(key, model, native) {
	const id = String(model.id || "").trim();
	const override = gatewayOverrides(key)[id] ?? {};
	const nativeName = typeof model.name === "string" && model.name !== "" ? model.name : id;
	const alias = typeof override.alias === "string" && override.alias.trim() !== "" ? override.alias.trim() : void 0;
	return {
		id,
		name: alias ?? nativeName,
		...alias === void 0 ? {} : { alias },
		nativeName,
		contextWindow: Number.isFinite(override.contextWindow) ? override.contextWindow : native.contextWindow,
		maxOutputTokens: Number.isFinite(override.maxOutputTokens) ? override.maxOutputTokens : native.maxTokens,
		nativeContextWindow: native.contextWindow,
		nativeMaxOutputTokens: native.maxTokens,
		supportsImages: typeof override.supportsImages === "boolean" ? override.supportsImages : native.supportsImages,
		nativeSupportsImages: native.supportsImages,
		...native.multiplier === void 0 ? {} : { multiplier: native.multiplier },
		advanced: Object.keys(override).length > 0
	};
}
/** One gateway's models in that shape; `nativeOf` reports what the gateway itself said. */
function sourceRosterFor(key, models, nativeOf) {
	const source = key.split(":")[0];
	return models.filter((model) => String(model.id || "").trim() !== "").map((model) => sourceModelView(key, model, nativeOf(model))).filter((view) => isSelectableSourceModel(source, view));
}
/**
* Trae's internal slots, by the names the IDE gives them.
*
* They are the IDE's own, stable across versions, and are what distinguishes a
* helper slot from a model — a helper sometimes carries a borrowed display name,
* so the name alone cannot answer it.
*/
const TRAE_INTERNAL_MODEL_IDS = /* @__PURE__ */ new Set([
	"summary",
	"fast_apply",
	"title_generation",
	"input_optimization",
	"laziness_detection"
]);
/** The same slots, by shape: the placeholders Trae binds at runtime, the helpers it drives, the entries it routes on its own. */
const TRAE_INTERNAL_MODEL_ID_RE = /^(custom_model|search_agent)_|_(subagent|agent)(_|$)|-(for-)?auto$/;
/**
* Whether one gateway model is something to offer in the picker.
*
* Trae's directory is the IDE's slot table rather than a model catalogue: beside
* the models it lists the slots the IDE fills in for itself — the
* `custom_model_*` placeholders it binds to a provider at runtime, the
* `search_agent_*` and `*_subagent` helpers it drives, the `-auto` entries it
* routes on its own, and housekeeping endpoints like `summary`. Offering those
* fills the picker with rows that answer nothing.
*
* A model with no name to show is dropped on either source: Trae lists `sagitta`
* and `aquila` as `—`, which is the whole of what the picker could say about them.
*
* Qoder's ids are exempt from the shape test. They are its real names — `qmodel`,
* `gfmodel`, `kmodel_latest` — and an underscore test written for Trae would
* delete every one of them.
*/
function isSelectableSourceModel(source, view) {
	const name = typeof view.name === "string" ? view.name.trim() : "";
	if (name === "" || !/[\p{L}\p{N}]/u.test(name)) return false;
	if (source !== "trae") return true;
	const id = view.id;
	return !TRAE_INTERNAL_MODEL_IDS.has(id) && !TRAE_INTERNAL_MODEL_ID_RE.test(id);
}
function normalizeSelection(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out = {};
	if (Array.isArray(value.enabledModelIds)) out.enabledModelIds = value.enabledModelIds;
	const overrides = Object.create(null);
	if (value.overrides && typeof value.overrides === "object" && !Array.isArray(value.overrides)) {
		for (const [id, entry] of Object.entries(value.overrides)) if (typeof id === "string" && id !== "" && entry && typeof entry === "object" && !Array.isArray(entry)) overrides[id] = { ...entry };
	}
	if (Object.keys(overrides).length > 0) out.overrides = overrides;
	return out;
}
/**
* The selection actually applied to one gateway's catalog.
*
* A stored selection can name models the live roster no longer carries (the
* upstream renames and retires models). Applying that verbatim would filter
* every model out: the picker group would vanish, the panel would show nothing
* enabled, and no save could be made to look like it took effect. When none of
* the saved ids exist any more, the selection is treated as unset so the group
* stays usable, and `selectionStale` tells the panel to say why.
*
* Takes the catalog explicitly rather than looking it up in `runtimes`: it is
* called while a runtime is still being constructed, before it is registered.
*/
function savedSelectionMatches(region, catalog) {
	const enabled = selectionFor(region).enabledModelIds;
	if (!Array.isArray(enabled) || enabled.length === 0 || !catalog) return true;
	const known = new Set(catalog.current().map((model) => model.id));
	return enabled.some((id) => known.has(id));
}
function effectiveSelectionFor(region, catalog) {
	return savedSelectionMatches(region, catalog) ? selectionFor(region) : {};
}
/** True when a gateway's stored selection no longer matches its live roster. */
function selectionStale(region, catalog) {
	return !savedSelectionMatches(region, catalog);
}
/**
* Apply the user's selection to one gateway's catalog, after checking it
* against the roster that gateway actually has.
*
* Called when settings change, when a runtime is built, and after the roster is
* (re)read, because a selection is only meaningful relative to the current
* catalog: a re-read can retire every id a saved selection names.
*/
function applyEffectiveSelection(region, runtime) {
	const target = runtime ?? runtimes.get(regionOfKey(region));
	if (!target) return;
	target.catalog.applySelection(effectiveSelectionFor(region, target.catalog));
	if (selectionStale(region, target.catalog)) target.lastWarning = "the saved model selection no longer matches the live model list; showing every model";
}
/** The port one gateway prefers, and the only address it ever publishes. */
function preferredPort(region) {
	const port = REGION_PORTS[region];
	return typeof port === "number" ? port : 0;
}
/**
* A pause, for the retry loops below.
*
* The timer is unref'd: a pause nobody is waiting for any more - the plugin is
* unloading, or the whole pass it belongs to has already been abandoned - must
* not be the reason the process stays alive.
*/
function delay(ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		if (typeof timer.unref === "function") timer.unref();
	});
}
/**
* Wait for `work`, but no longer than `budgetMs`.
*
* Resolves to the value when the work finishes in time and `undefined` when the
* budget runs out. The work is never cancelled - a plugin pass must finish what
* it started - so the caller's job is to answer on time and let the late result
* land in whatever cache the panel reads next.
*/
async function settleWithin(work, budgetMs) {
	let timer = null;
	const budget = new Promise((resolve) => {
		timer = setTimeout(() => resolve(void 0), budgetMs);
		if (typeof timer.unref === "function") timer.unref();
	});
	try {
		return await Promise.race([work, budget]);
	} finally {
		clearTimeout(timer);
	}
}
/**
* Try to bind one specific port once.
*
* Resolves the port on success and 0 on failure, so the caller can decide
* whether to wait and try again instead of moving on immediately.
*/
function tryPort(port) {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.unref();
		server.once("error", () => {
			try {
				server.close();
			} catch {}
			resolve(0);
		});
		server.listen(port, "127.0.0.1", () => {
			const bound = server.address().port;
			server.close(() => resolve(bound));
		});
	});
}
/**
* Ask the OS for the gateway's one preferred port.
*
* A port busy for a quarter of a second is the previous instance shutting
* down. Giving up on the first refusal made a run bind an ephemeral port while
* the declaration kept naming this one, leaving the host on an address nothing
* listens on.
*
* Resolves 0 when the port stays taken. The shim then uses an ephemeral port
* for this session, and the declaration still names the preferred port.
*/
function reservePort(port) {
	if (typeof port !== "number" || port <= 0) return Promise.resolve(0);
	return (async () => {
		for (let attempt = 0; attempt < PORT_RESERVE_ATTEMPTS; attempt += 1) {
			const bound = await tryPort(port);
			if (bound !== 0) return bound;
			if (attempt < 5) await delay(PORT_RESERVE_INTERVAL_MS);
		}
		return 0;
	})();
}
/** Thinking levels the picker may offer for one model, in host order. */
function thinkingLevelsFor(model) {
	const declared = Array.isArray(model.supportedEfforts) ? model.supportedEfforts.filter((level) => HOST_THINKING_LEVELS.includes(level)) : [];
	if (declared.length === 0) return ["off"];
	const wanted = model.canDisableThinking === true ? ["off", ...declared] : declared;
	return HOST_THINKING_LEVELS.filter((level) => wanted.includes(level));
}
/**
* Whether a level list is worth publishing.
*
* One real level is still a choice and keeps the model a reasoning one; a lone
* "off" only says the model cannot think, which the host already reads from an
* absent level list.
*/
function offersThinking(levels) {
	return levels.some((level) => level !== "off");
}
/** Model label as the picker shows it: name plus the upstream cost suffix. */
function modelDisplayName(model) {
	const label = model.name || model.id;
	if (typeof model.multiplier !== "number" || !Number.isFinite(model.multiplier)) return label;
	return label + " · x" + model.multiplier.toFixed(2);
}
/**
* The label the picker shows.
*
* An alias the user typed is used verbatim: it is a name, not a catalog row, so
* appending a cost suffix to it would edit the user's own text back. Without an
* alias the catalog name keeps its suffix, which is the existing behaviour.
*/
function modelLabel(model) {
	const alias = typeof model.alias === "string" ? model.alias.trim() : "";
	return alias === "" ? modelDisplayName(model) : alias;
}
function positiveInteger(value, fallback) {
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) return fallback;
	return Math.round(number);
}
/** The models one gateway publishes, after the user's selection is applied. */
function declarationModels(region) {
	const catalog = runtimes.get(region)?.catalog;
	if (!catalog) return [];
	const models = [];
	const seen = /* @__PURE__ */ new Set();
	for (const model of catalog.visible()) {
		const id = String(model.id || "").trim();
		if (id === "" || id.length > 256 || seen.has(id)) continue;
		seen.add(id);
		const thinkingLevels = thinkingLevelsFor(model);
		const entry = {
			id,
			name: modelLabel(model),
			contextWindow: positiveInteger(model.contextWindow, CONSERVATIVE_CONTEXT_WINDOW),
			maxTokens: positiveInteger(model.maxOutputTokens, DEFAULT_MAX_TOKENS),
			supportsImages: model.supportsImages === true,
			...offersThinking(thinkingLevels) ? { thinkingLevels } : {}
		};
		if (typeof model.defaultThinkingLevel === "string" && thinkingLevels.includes(model.defaultThinkingLevel)) entry.defaultThinkingLevel = model.defaultThinkingLevel;
		models.push(entry);
		if (models.length >= MAX_MODELS) break;
	}
	return models;
}
/** Runtime registration must name the bound gateway, including a fallback port. */
function descriptorFor(region) {
	const runtime = runtimes.get(region);
	const preferred = preferredPort(region);
	const baseUrl = runtime?.baseUrl || (preferred > 0 ? "http://127.0.0.1:" + preferred + "/v1" : PLACEHOLDER_BASE_URL);
	return {
		id: PROVIDER_ID_BY_REGION[region],
		name: PROVIDER_NAME_BY_REGION[region],
		baseUrl,
		apiStyle: "chat_completions",
		authKind: "none",
		models: declarationModels(region)
	};
}
/**
* Publish the provider rows through the running host.
*
* Because registration is a runtime call, this is also where the process's own
* record of its declaration is kept. The result keeps the shape its callers
* expect, so `syncDeclaration` and the panel footer are unaffected.
*/
function writeDeclaration(descriptors) {
	const result = pi.declareProviders(descriptors);
	declarationIndex = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
	publishedIds = result.ok === true ? new Set(descriptors.map((descriptor) => descriptor.id)) : /* @__PURE__ */ new Set();
	return result;
}
/**
* Result of the last declaration write, for the panel footer.
*
* Starts as not-ok because nothing has been written yet: `ok: true` here read as
* "the last write succeeded" before any write had been attempted, so a cold load
* whose first pass failed showed the footer as up to date. The reason travels
* with it, because a disabled plugin never writes at all and the panel and
* doctor print the message verbatim - without it the report said "undefined".
*/
const runtimeState = { write: {
	ok: false,
	changed: false,
	error: "the declaration has not been published yet"
} };
/**
* Cache for the auxiliary per-account probes (credits, check-in).
*
* Keyed by account id. A panel open reads this cache and schedules the upstream
* calls behind it, instead of blocking the first paint on 2 calls per account.
*/
const probeCache = /* @__PURE__ */ new Map();
/**
* Publish every gateway that is actually usable.
*
* A provider row with an empty model list is not registered at all: an adapter
* route with nothing behind it serves nothing, and registering it would put a
* dead group in the picker. A gateway that is signed out, unreachable or still
* starting is therefore left out; the next registration drops the row, which is
* also how a signed-out edition disappears from the picker.
*/
function syncDeclaration() {
	const publishable = activeRegions().filter((region) => {
		const runtime = runtimes.get(region);
		return runtime && runtime.signedIn && declarationModels(region).length > 0;
	});
	const publishableTrae = activeTraeRegions().filter((region) => traeDeclarationModels(region).length > 0);
	const publishableQoder = activeQoderRegions().filter((region) => qoderDeclarationModels(region).length > 0);
	if (!(activeRegions().length > 0 || activeTraeRegions().length > 0 || activeQoderRegions().length > 0)) {
		const result = writeDeclaration([]);
		runtimeState.write = result.ok ? {
			...result,
			skipped: "every source is switched off; the declaration is cleared"
		} : result;
		return runtimeState.write;
	}
	const activeIds = /* @__PURE__ */ new Set([
		...activeRegions().map((region) => PROVIDER_ID_BY_REGION[region]),
		...activeTraeRegions().map((region) => TRAE_PROVIDER_ID_BY_REGION[region]),
		...activeQoderRegions().map((region) => QODER_PROVIDER_ID_BY_REGION[region])
	]);
	const current = [
		...publishable.map(descriptorFor),
		...publishableTrae.map(descriptorForTrae),
		...publishableQoder.map(descriptorForQoder)
	];
	const currentIds = new Set(current.map((provider) => provider.id));
	const retained = declaredProviders().filter((provider) => activeIds.has(provider.id) && !currentIds.has(provider.id));
	const result = writeDeclaration([...current, ...retained]);
	runtimeState.write = result;
	return result;
}
/**
* Ask one Trae/Qoder gateway for its directory once, and record what it said.
*
* The message is overwritten either way round: a directory that failed while
* load was still opening the other gateways and answers a minute later must
* not keep reporting the first failure for the rest of the process. That is
* what WorkBuddy's `connect` also does, by clearing before every attempt.
*/
async function warmSourceDirectory(entry, signal) {
	if (signal && signal.aborted) return false;
	const bounds = [AbortSignal.timeout(DIRECTORY_WARM_TIMEOUT_MS)];
	if (signal) bounds.push(signal);
	try {
		const warm = await fetch(entry.baseUrl + "/v1/models", { signal: bounds.length === 1 ? bounds[0] : AbortSignal.any(bounds) });
		entry.lastError = warm.ok ? "" : "directory answered HTTP " + warm.status;
	} catch (error) {
		if (signal && signal.aborted) return false;
		entry.lastError = entry.gateway.models().length > 0 ? "" : "directory unavailable: " + safeMessage(error);
		if (entry.lastError !== "") log("warn", "[" + entry.source + ":" + entry.region + "] " + entry.lastError);
	}
	return entry.lastError === "";
}
/**
* How long one directory read may take before a refresh pass gives up on it.
*
* The Trae directory walks several upstream endpoints behind the gateway's
* `/v1/models`, and a gateway whose read has not been bounded leaves every
* user-invoked refresh waiting on it. This is the ceiling on that wait, not on
* the read itself: a gateway that stops here keeps fetching and every later
* refresh sees the roster it lands with.
*/
const DIRECTORY_WARM_TIMEOUT_MS = 8e3;
/** Startup warm-up attempts and the gap between them, for a cold machine. */
const DIRECTORY_WARM_ATTEMPTS = 3;
const DIRECTORY_WARM_BACKOFF_MS = 1500;
/**
* Aborted on unload, and re-created on the next load.
*
* The startup warm-up runs detached — it must not hold up the host's answer —
* so nothing else owns its lifetime. Left alone it outlives the plugin: up to
* three 8 s attempts plus backoff kept fetching a gateway that had already been
* closed, and wrote `lastError` onto an entry no map held any more, which is how
* the next load's log picked up warnings about a run that had just ended.
*/
let warmAbort = new AbortController();
/** Stop every warm-up still in flight. Called from `onUnload`. */
function abortWarmups() {
	warmAbort.abort();
}
/**
* Warm one gateway's directory, retrying while a startup burst can be blamed.
*
* The first attempt runs while load is still reading every other source's
* storage and opening its sockets, so one failure is not taken as the answer.
* Whatever survives the retries stays on the entry until a later refresh
* clears it.
*/
async function warmSourceDirectoryAtStartup(entry, signal) {
	for (let attempt = 1; attempt <= DIRECTORY_WARM_ATTEMPTS; attempt += 1) {
		if (signal && signal.aborted) return false;
		if (await warmSourceDirectory(entry, signal)) return true;
		if (attempt >= DIRECTORY_WARM_ATTEMPTS) break;
		if (!signal) {
			await delay(DIRECTORY_WARM_BACKOFF_MS * attempt);
			continue;
		}
		await new Promise((resolve) => {
			const onAbort = () => resolve();
			signal.addEventListener("abort", onAbort, { once: true });
			delay(DIRECTORY_WARM_BACKOFF_MS * attempt).then(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			});
		});
	}
	return false;
}
/**
* Create one gateway's runtime: its own catalog and its own loopback endpoint.
*
* Each gateway is scoped to its own account slice of the pool, so a CN request
* can never be served by a global account and vice versa - the two gateways are
* not interchangeable - and a failing gateway cannot take the other one down.
*
* Credentials and identity come from the machine's own Trae installs, read
* per request rather than cached here, so switching the source off really
* does stop the scanning. The directory is warmed through the gateway's own
* `/v1/models` route right after start: until it answers there is no model
* list, and a gateway with no models is simply not published.
*/
async function createTraeRuntime(region) {
	const preferred = TRAE_PORTS[region];
	const bound = await reservePort(preferred);
	const desktopCandidates = traeStorageCandidates().filter((entry) => entry.source === "desktop");
	const gateway = createTraeGateway({
		credentials: async (purpose) => orderSourceCredentials("trae", region, (await discoverTraeCredentials()).credentials.filter((credential) => traeRegionOfCredential(credential) === region), traeRowLabel, purpose === "chat"),
		identity: (credential) => resolveTraeIdentity(desktopCandidates, credential.edition),
		listedIds: () => traeDeclarationModels(region).map((model) => model.id),
		port: bound,
		logger: {
			info: (...args) => log("info", gatewayLogLine("[trae:" + region + "] ", args)),
			warn: (...args) => log("warn", gatewayLogLine("[trae:" + region + "] ", args)),
			error: (...args) => log("error", gatewayLogLine("[trae:" + region + "] ", args))
		}
	});
	await gateway.ready;
	const entry = {
		region,
		gateway,
		baseUrl: gateway.baseUrl(),
		portFallback: bound !== preferred,
		lastError: "",
		source: "trae"
	};
	warmSourceDirectoryAtStartup(entry, warmAbort.signal).catch((error) => log("warn", "[trae:" + region + "] directory warm-up failed: " + messageOf(error)));
	return entry;
}
/** Start and stop Trae gateways so the map matches the source switch exactly. */
async function reconcileTraeGateways() {
	const generation = loadGeneration;
	if (!stillLoaded(generation)) return;
	const active = activeTraeRegions();
	for (const [region, entry] of Array.from(traeGateways)) {
		if (active.includes(region)) continue;
		traeGateways.delete(region);
		try {
			await entry.gateway.close();
		} catch (error) {
			log("warn", "[trae:" + region + "] gateway did not close cleanly: " + messageOf(error));
		}
	}
	for (const region of active) {
		if (traeGateways.has(region)) continue;
		try {
			const entry = await createTraeRuntime(region);
			if (!stillLoaded(generation) || !activeTraeRegions().includes(region) || traeGateways.has(region)) await entry.gateway.close();
			else traeGateways.set(region, entry);
		} catch (error) {
			log("warn", "[trae:" + region + "] gateway could not start: " + messageOf(error));
		}
	}
}
/** What a Trae gateway itself reported for one model. */
function traeNativeOf(model) {
	return {
		contextWindow: positiveInteger(model.contextWindow, CONSERVATIVE_CONTEXT_WINDOW),
		maxTokens: positiveInteger(model.maxTokens, DEFAULT_MAX_TOKENS),
		supportsImages: model.supportsImages === true,
		...Number.isFinite(model.creditMultiplier) ? { multiplier: model.creditMultiplier } : {}
	};
}
function traeDeclarationModels(region) {
	const gateway = traeGateways.get(region)?.gateway;
	if (!gateway) return [];
	const models = [];
	const seen = /* @__PURE__ */ new Set();
	const roster = gateway.models().map((model) => String(model.id || "").trim());
	const enabled = gatewayEnabledIds("trae:" + region, roster);
	for (const model of gateway.models()) {
		const id = String(model.id || "").trim();
		if (id === "" || id.length > 256 || seen.has(id)) continue;
		if (enabled !== null && !enabled.has(id)) continue;
		seen.add(id);
		const view = sourceModelView("trae:" + region, model, traeNativeOf(model));
		if (!isSelectableSourceModel("trae", view)) continue;
		const advertised = (model.reasoning ? model.reasoning.supported : []).filter((level) => HOST_THINKING_LEVELS.includes(level));
		models.push({
			id: view.id,
			name: modelLabel(view),
			contextWindow: view.contextWindow,
			maxTokens: view.maxOutputTokens,
			supportsImages: view.supportsImages,
			thinkingLevels: offersThinking(advertised) ? advertised : ["off"]
		});
		if (models.length >= MAX_MODELS) break;
	}
	return models;
}
/** One Trae provider declaration, same shape as {@link descriptorFor}. */
function descriptorForTrae(region) {
	const preferred = TRAE_PORTS[region];
	return {
		id: TRAE_PROVIDER_ID_BY_REGION[region],
		name: TRAE_PROVIDER_NAME_BY_REGION[region],
		baseUrl: traeGateways.get(region)?.baseUrl ? traeGateways.get(region).baseUrl + "/v1" : "http://127.0.0.1:" + preferred + "/v1",
		apiStyle: "chat_completions",
		authKind: "none",
		models: traeDeclarationModels(region)
	};
}
/** One discovered Qoder sign-in, shaped as the client and gateway consume it. */
function qoderClientCredential(credential) {
	return {
		userID: credential.userID,
		token: credential.token,
		...credential.name === "" ? {} : { name: credential.name },
		...credential.email === "" ? {} : { email: credential.email },
		...credential.machineID === void 0 ? {} : { machineID: credential.machineID }
	};
}
/**
* Start one Qoder gateway on its own fixed port.
*
* Credentials come from the machine's own Qoder installs, read per request
* rather than cached here, so switching the source off really does stop the
* scanning. The directory is warmed through the gateway's own `/v1/models`
* route right after start: until it answers there is no model list, and a
* gateway with no models is simply not published.
*/
async function createQoderRuntime(region) {
	const preferred = QODER_PORTS[region];
	const bound = await reservePort(preferred);
	const gateway = createQoderGateway({
		region,
		credentials: async (purpose) => {
			return orderSourceCredentials("qoder", region, (await discoverQoderCredentials()).credentials.filter((credential) => credential.region === region), qoderRowLabel, purpose === "chat").map(qoderClientCredential);
		},
		listedIds: () => qoderDeclarationModels(region).map((model) => model.id),
		port: bound,
		logger: {
			info: (...args) => log("info", gatewayLogLine("[qoder:" + region + "] ", args)),
			warn: (...args) => log("warn", gatewayLogLine("[qoder:" + region + "] ", args)),
			error: (...args) => log("error", gatewayLogLine("[qoder:" + region + "] ", args))
		}
	});
	await gateway.ready;
	const entry = {
		region,
		gateway,
		baseUrl: gateway.baseUrl(),
		portFallback: bound !== preferred,
		lastError: "",
		source: "qoder"
	};
	warmSourceDirectoryAtStartup(entry, warmAbort.signal).catch((error) => log("warn", "[qoder:" + region + "] directory warm-up failed: " + messageOf(error)));
	return entry;
}
/** Start and stop Qoder gateways so the map matches the source switch exactly. */
async function reconcileQoderGateways() {
	const generation = loadGeneration;
	if (!stillLoaded(generation)) return;
	const active = activeQoderRegions();
	for (const [region, entry] of Array.from(qoderGateways)) {
		if (active.includes(region)) continue;
		qoderGateways.delete(region);
		try {
			await entry.gateway.close();
		} catch (error) {
			log("warn", "[qoder:" + region + "] gateway did not close cleanly: " + messageOf(error));
		}
	}
	for (const region of active) {
		if (qoderGateways.has(region)) continue;
		try {
			const entry = await createQoderRuntime(region);
			if (!stillLoaded(generation) || !activeQoderRegions().includes(region) || qoderGateways.has(region)) await entry.gateway.close();
			else qoderGateways.set(region, entry);
		} catch (error) {
			log("warn", "[qoder:" + region + "] gateway could not start: " + messageOf(error));
		}
	}
}
function qoderNativeOf(model) {
	return {
		contextWindow: positiveInteger(model.contextWindow ?? model.maxInputTokens, CONSERVATIVE_CONTEXT_WINDOW),
		maxTokens: DEFAULT_MAX_TOKENS,
		supportsImages: model.supportsImages === true
	};
}
/**
* Thinking levels one Qoder model may offer, in host order.
*
* Qoder's ladder spells "off" as "none", which the host does not use, so the
* table is filtered to the host's own names first. A row whose catalog entry
* carries no level table only takes thinking on or off: nothing is declared
* for it, because inventing a level would promise a control the upstream
* ignores.
*/
function qoderThinkingLevelsFor(model) {
	const declared = Array.isArray(model.effortLevels) ? model.effortLevels.filter((level) => HOST_THINKING_LEVELS.includes(level)) : [];
	if (declared.length === 0) return [];
	const wanted = model.alwaysThinking === true ? declared : ["off", ...declared];
	return HOST_THINKING_LEVELS.filter((level) => wanted.includes(level));
}
/** The models one Qoder gateway publishes, after its directory has been read. */
function qoderDeclarationModels(region) {
	const gateway = qoderGateways.get(region)?.gateway;
	if (!gateway) return [];
	const models = [];
	const seen = /* @__PURE__ */ new Set();
	const roster = gateway.models().map((model) => String(model.id || "").trim());
	const enabled = gatewayEnabledIds("qoder:" + region, roster);
	for (const model of gateway.models()) {
		const id = String(model.id || "").trim();
		if (id === "" || id.length > 256 || seen.has(id)) continue;
		if (enabled !== null && !enabled.has(id)) continue;
		seen.add(id);
		const view = sourceModelView("qoder:" + region, model, qoderNativeOf(model));
		if (!isSelectableSourceModel("qoder", view)) continue;
		const levels = qoderThinkingLevelsFor(model);
		models.push({
			id: view.id,
			name: view.name,
			contextWindow: view.contextWindow,
			maxTokens: view.maxOutputTokens,
			supportsImages: view.supportsImages,
			...offersThinking(levels) ? { thinkingLevels: levels } : {}
		});
		if (models.length >= MAX_MODELS) break;
	}
	return models;
}
/** One Qoder provider declaration, same shape as {@link descriptorFor}. */
function descriptorForQoder(region) {
	const preferred = QODER_PORTS[region];
	return {
		id: QODER_PROVIDER_ID_BY_REGION[region],
		name: QODER_PROVIDER_NAME_BY_REGION[region],
		baseUrl: qoderGateways.get(region)?.baseUrl ? qoderGateways.get(region).baseUrl + "/v1" : "http://127.0.0.1:" + preferred + "/v1",
		apiStyle: "chat_completions",
		authKind: "none",
		models: qoderDeclarationModels(region)
	};
}
async function createRuntime(region) {
	const runtime = {
		region,
		baseUrl: PLACEHOLDER_BASE_URL,
		catalog: new WorkBuddyCatalog(),
		signedIn: false,
		lastError: "",
		lastWarning: "",
		portFallback: false,
		connecting: null,
		/** A stopped gateway cannot commit a catalog fetch that finishes later. */
		retired: false,
		catalogFetchedAtMs: 0
	};
	applyEffectiveSelection(region, runtime);
	const preferred = preferredPort(region);
	const bound = await reservePort(preferred);
	runtime.portFallback = bound === 0;
	if (runtime.portFallback) log("warn", "[" + region + "] preferred port " + preferred + " is held by another process; serving this session on an ephemeral port");
	runtime.shim = createWorkBuddyShim({
		pool: core.pool,
		client: core.client,
		catalog: runtime.catalog,
		listedIds: () => declarationModels(region).map((model) => model.id),
		region,
		port: bound,
		logger: {
			info: (...args) => log("info", gatewayLogLine("[" + region + "] ", args)),
			warn: (...args) => log("warn", gatewayLogLine("[" + region + "] ", args)),
			error: (...args) => log("error", gatewayLogLine("[" + region + "] ", args))
		}
	});
	await runtime.shim.ready;
	runtime.baseUrl = runtime.shim.baseUrl() + "/v1";
	return runtime;
}
/**
* Start every active WorkBuddy gateway that is not running yet.
*
* One gateway's failure is logged and left out, on the same terms as the Trae
* and Qoder reconciles: the shim's `listen` can lose the port race that
* `reservePort` opened between reserving and binding, and that must not take the
* whole plugin down - the other region still has a roster to publish, and a
* plugin that fails to load publishes nothing at all. Read end to end the two
* regions cost one bound rather than two, which is why the reads run together.
*/
async function startRuntimes() {
	const generation = loadGeneration;
	if (!stillLoaded(generation)) return;
	if (pendingRuntimeStops.length > 0) await Promise.all(pendingRuntimeStops.splice(0));
	await Promise.all(activeRegions().map(async (region) => {
		if (runtimes.has(region)) return;
		try {
			const runtime = await createRuntime(region);
			if (!stillLoaded(generation) || !activeRegions().includes(region) || runtimes.has(region)) await stopRuntime(runtime);
			else runtimes.set(region, runtime);
		} catch (error) {
			log("warn", "[workbuddy:" + region + "] gateway could not start: " + messageOf(error));
		}
	}));
}
async function stopRuntime(runtime) {
	runtime.retired = true;
	runtime.signedIn = false;
	if (runtime.shim) await runtime.shim.close().catch((error) => {
		log("warn", "[workbuddy:" + runtime.region + "] gateway did not close cleanly: " + messageOf(error));
	});
}
/**
* Bring one gateway online: seed its catalog from that gateway's own account.
*
* The catalog is per gateway because the two do not advertise the same roster;
* seeding both from one account showed a CN list on the international
* provider. A gateway with no account keeps its static fallback, which is what
* keeps its model list non-empty (and therefore publishable) before any
* upstream call succeeds.
*/
async function connect(runtime, force) {
	if (runtime.retired) return false;
	runtime.lastError = "";
	runtime.lastWarning = "";
	const account = core.pool.list(runtime.region)[0];
	if (account === void 0) {
		runtime.signedIn = false;
		runtime.lastError = "no " + runtime.region + " WorkBuddy sign-in found";
		runtime.catalogFetchedAtMs = Date.now();
		return false;
	}
	runtime.signedIn = true;
	if (force === true || !catalogFresh(runtime)) try {
		const models = await core.client.fetchModels(account.credential, AbortSignal.timeout(MODELS_TIMEOUT_MS));
		if (runtime.retired) return false;
		runtime.catalog.updateFromUpstream(models);
		runtime.catalogFetchedAtMs = Date.now();
	} catch (error) {
		runtime.lastWarning = "model list failed: " + safeMessage(error);
		runtime.catalogFetchedAtMs = Date.now();
	}
	applyEffectiveSelection(runtime.region, runtime);
	if (runtime.retired) return false;
	return true;
}
/** True while one gateway's model roster is still inside its refresh window. */
function catalogFresh(runtime) {
	if (runtime.catalogFetchedAtMs === 0) return false;
	return Date.now() - runtime.catalogFetchedAtMs < CATALOG_TTL_MS;
}
/**
* Whether the panel should come back for a refreshed document.
*
* True while a pass is running (its result has not been rendered yet) and while
* anything it would fill in is missing or stale: a stale model roster, or
* billing probes that are cold or past their TTL. Scheduling is de-duplicated
* separately in `scheduleRefresh`, so reporting an in-flight pass here is safe
* and is what keeps the poll alive until the numbers actually land.
*/
function refreshNeeded() {
	if (serviceStopped) return false;
	if (refreshInflight !== null) return true;
	for (const runtime of runtimes.values()) {
		if (runtime.connecting) return true;
		if (!catalogFresh(runtime)) return true;
	}
	return probesStale();
}
/** True while any pool account's cached billing answers are missing or old. */
function probesStale() {
	const now = Date.now();
	for (const account of core.pool.list()) {
		if (account.cooldownUntilMs > now || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
		const cached = probeCache.get(account.id);
		if (cached === void 0 || now - cached.atMs >= PROBE_TTL_MS) return true;
	}
	return false;
}
/**
* Run a refresh behind the current turn, at most one at a time.
*
* Deferring it to the next tick is what keeps a panel open cheap: the caller
* answers from cache first and the detection lands behind the rendered page.
* This is the *background* flavour, so it respects each gateway's refresh
* window instead of forcing a roster fetch that load already did.
*/
function scheduleRefresh(reason) {
	if (serviceStopped) return;
	if (refreshTimer !== null || refreshInflight !== null) return;
	refreshTimer = setTimeout(() => {
		refreshTimer = null;
		refreshAll(reason, false).catch((error) => log("warn", "background refresh failed: " + messageOf(error)));
	}, 0);
	if (typeof refreshTimer.unref === "function") refreshTimer.unref();
}
async function refreshRuntime(runtime, reason, force) {
	if (runtime.connecting) return runtime.connecting;
	runtime.connecting = (async () => {
		try {
			return {
				ok: await connect(runtime, force === true),
				reason
			};
		} finally {
			runtime.connecting = null;
		}
	})();
	return runtime.connecting;
}
/**
* What a pass answers once its activation is gone.
*
* The document is deliberately not built: this plugin is no longer loaded, so
* nobody is reading the answer, and reading the shared state it was built from
* is exactly what must not happen during a teardown.
*/
function stalePass() {
	return { stale: true };
}
/**
* Re-read settings, re-apply them, re-seed every gateway's catalog, then
* republish. `force` decides whether each gateway's roster is refetched even
* inside its refresh window: `true` for a user-invoked pass, `false` for the
* background one that follows a panel open.
*
* Concurrent passes are collapsed: the background pass would otherwise
* duplicate the work of the pass a Refresh click just started.
*/
async function refreshAll(reason, force) {
	if (serviceStopped) return await statusDocument({ allowNetwork: false });
	const wantForce = force === true;
	if (refreshInflight !== null) {
		const current = refreshInflight;
		if (!wantForce || current.force) return await current.promise;
		await settleWithin(current.promise.catch(() => {}), REFRESH_HANDOVER_MS);
	}
	const generation = loadGeneration;
	const run = async () => {
		const deadline = Date.now() + REFRESH_PASS_BUDGET_MS;
		const left = () => Math.max(0, deadline - Date.now());
		await adoptHostSettings();
		if (!stillLoaded(generation)) return stalePass();
		applySettingsToCore();
		if (poolNeedsScan) {
			poolNeedsScan = false;
			await settleWithin(core.pool.scan(), left());
			if (!stillLoaded(generation)) return stalePass();
		}
		for (const region of activeRegions()) {
			if (runtimes.has(region)) continue;
			const starting = createRuntime(region);
			let runtime;
			try {
				runtime = await settleWithin(starting, left());
			} catch (error) {
				log("warn", "[" + region + "] gateway could not start: " + messageOf(error));
				continue;
			}
			if (runtime === void 0) {
				starting.then((late) => stopRuntime(late)).catch(() => {});
				continue;
			}
			if (!stillLoaded(generation)) {
				stopRuntime(runtime);
				return stalePass();
			}
			if (!stillLoaded(generation) || !activeRegions().includes(region) || runtimes.has(region)) {
				await stopRuntime(runtime);
				continue;
			}
			runtimes.set(region, runtime);
		}
		await settleWithin(reconcileTraeGateways(), left());
		if (!stillLoaded(generation)) return stalePass();
		await settleWithin(reconcileQoderGateways(), left());
		if (!stillLoaded(generation)) return stalePass();
		await settleWithin(refreshSourceAccounts(), left());
		if (!stillLoaded(generation)) return stalePass();
		await settleWithin(Promise.all([...Array.from(traeGateways.values()), ...Array.from(qoderGateways.values())].filter((entry) => entry.lastError !== "" || entry.gateway.models().length === 0).map((entry) => warmSourceDirectory(entry))), left());
		if (!stillLoaded(generation)) return stalePass();
		await settleWithin(Promise.all(Array.from(runtimes.values()).map((runtime) => refreshRuntime(runtime, reason, wantForce))), left());
		if (!stillLoaded(generation)) return stalePass();
		syncDeclaration();
		return await statusDocument({
			allowNetwork: true,
			budgetMs: left()
		});
	};
	const entry = {
		force: wantForce,
		promise: null
	};
	entry.promise = run();
	refreshInflight = entry;
	try {
		return await entry.promise;
	} finally {
		if (refreshInflight === entry) refreshInflight = null;
	}
}
/**
* The sign-ins found on this machine for the sources that are not pool
* accounts, reduced to what the panel shows: a label, the region, and whether
* the token is still fresh. No token material leaves this function.
*/
let traeAccountRows = [];
let qoderAccountRows = [];
/**
* The name one Trae account is listed and claimed under.
*
* A Trae-generated `username` can read as a stranger (`zhi c cheng`), so the
* email is what the panel shows next to it; the label itself stays the app's
* own name so it matches what the desktop app displays.
*/
function traeRowLabel(credential) {
	return credential.accountName ?? credential.email ?? credential.userId;
}
/**
* The app one Trae sign-in came from.
*
* One account keeps a copy in every Trae app it was signed into (and one in the
* CLI), and the scanner folds those copies into a single account. Naming the
* copy that won is what makes that fold readable: without it the account just
* looks like it lost a row.
*/
function traeAppLabelOf(credential) {
	if (credential.source === "cli") return "Trae CLI";
	return traeWindowsAppNames(credential.edition)[0];
}
/** The name one Qoder account is listed and claimed under. */
function qoderRowLabel(credential) {
	return credential.name === "" ? credential.userID : credential.name;
}
/**
* How long the Trae and Qoder sign-in lists may take in total.
*
* Each account's probe is already bounded, but a machine with several sign-ins
* to a source would add those bounds end to end, and the host allows a panel
* call 30 s. Past this budget a row keeps the figures it already has. The
* figure is deliberately a slice of a refresh pass rather than most of it: the
* pass still has a roster read and a document to answer with.
*/
const SOURCE_ACCOUNTS_BUDGET_MS = 8e3;
/**
* How long one Trae or Qoder account's probe may take.
*
* Trae's probes read at once, so this bounds that whole list; Qoder paces its
* reads, so the deadline above is what bounds that list instead.
*/
const SOURCE_PROBE_TIMEOUT_MS = 8e3;
/**
* Read one Trae account's check-in state and quota for its card. Quota is the
* verified pay endpoint (`web_user_ent_usage`, same surface dsh-connect-trae
* ships); the check-in row is CN-only. A failed probe keeps the previous
* row's figures — a flaky network is not "no quota".
*/
async function traeRowProbe(credential, previous) {
	if (sourceCredentialExpired(credential, Date.now())) return previous;
	try {
		const desktopCandidates = traeStorageCandidates().filter((entry) => entry.source === "desktop");
		const client = new TraeSoloUpstreamClient({
			credential: async () => credential,
			identity: () => resolveTraeIdentity(desktopCandidates, credential.edition)
		});
		if (traeRegionOfCredential(credential) !== "cn") {
			const pay = await client.fetchPayStatus(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS));
			return {
				checkin: void 0,
				usage: pay.plan === "" ? void 0 : { plan: {
					name: pay.plan,
					inTrial: pay.inTrial
				} }
			};
		}
		const [status, usage] = await Promise.all([client.fetchCheckinStatus(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS)), client.fetchUsageSummary(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS))]);
		return {
			checkin: {
				active: status.enable === true,
				todayCheckedIn: status.checkedIn === true,
				deviceCheckedIn: status.didCheckedIn === true,
				credits: status.credits,
				extraCredits: status.extraCredits,
				amount: status.credits,
				unit: "credits"
			},
			usage: { credits: traeSourceCredits(usage) }
		};
	} catch {
		return previous;
	}
}
/**
* One Trae usage answer folded into the credit shape the panel renders, so a
* source account and a pool account are drawn by the same code. Each pack
* keeps its own expiry because that is the only place it exists: the daily
* check-in reward lands as a pack of its own, so "when do the check-in credits
* run out" is answered per row rather than per account.
*/
function traeSourceCredits(usage) {
	const packages = usage.packs.map((pack) => ({
		packageName: pack.name,
		remain: pack.remaining,
		size: pack.total,
		...pack.expiresAtMs === void 0 ? {} : { expiresAtMs: pack.expiresAtMs }
	}));
	const nearestExpiryMs = nearestPackExpiry(packages);
	return {
		total: usage.remainingAmount,
		packages,
		...nearestExpiryMs === void 0 ? {} : { nearestExpiryMs }
	};
}
/** Read one Qoder account's quota and today's campaign, reduced for the card. */
async function qoderRowProbe(credential, previous) {
	if (sourceCredentialExpired(credential, Date.now())) return previous;
	try {
		const client = new QoderUpstreamClient({
			region: credential.region,
			credential: async () => qoderClientCredential(credential)
		});
		const [usage, campaigns] = await Promise.all([client.fetchUsage(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS)), client.fetchCampaigns(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS)).catch(() => void 0)]);
		const state = qoderCheckinStateFrom(campaigns);
		const validDays = qoderRewardValidityDaysOf(campaigns);
		const rewardExpiresAtMs = qoderRewardExpiryMs(campaigns);
		const planExpiry = usage.expiresAtMs !== void 0 ? { expiresAtMs: usage.expiresAtMs } : usage.neverExpires === true ? { neverExpires: true } : {};
		const rewardExpiry = rewardExpiresAtMs !== void 0 ? { roundExpiresAtMs: rewardExpiresAtMs } : validDays === void 0 ? {} : { validDays };
		const packages = [
			...usage.userQuota === void 0 ? [] : [{
				nameKey: "credits.planQuota",
				remain: usage.userQuota.remaining,
				size: usage.userQuota.total,
				...planExpiry
			}],
			...usage.addOnQuota === void 0 ? [] : [{
				nameKey: "credits.addOnQuota",
				remain: usage.addOnQuota.remaining,
				size: usage.addOnQuota.total,
				...rewardExpiry
			}],
			...usage.dedicatedPackages.slice(0, 3).map((pack) => ({
				packageName: pack.name,
				remain: pack.remaining,
				size: pack.total,
				...pack.expiresAtMs === void 0 ? {} : { expiresAtMs: pack.expiresAtMs }
			}))
		];
		const credits = packages.length === 0 ? void 0 : {
			total: packages.reduce((sum, pack) => sum + pack.remain, 0),
			packages,
			...nearestPackExpiry(packages) === void 0 ? {} : { nearestExpiryMs: nearestPackExpiry(packages) }
		};
		return {
			...credits === void 0 ? {} : { usage: { credits } },
			checkin: {
				...state,
				...state.opensAt === void 0 ? {} : { opensAtHour: zonedDayHour(new Date(state.opensAt)).hour }
			}
		};
	} catch {
		return previous;
	}
}
async function refreshSourceAccounts() {
	const now = Date.now();
	try {
		const regions = activeTraeRegions();
		if (regions.length > 0) {
			const found = await discoverTraeCredentials();
			traeAccountRows = (await Promise.all(found.credentials.filter((credential) => regions.includes(traeRegionOfCredential(credential))).map(async (credential) => {
				const label = traeRowLabel(credential);
				const region = traeRegionOfCredential(credential);
				const probe = await traeRowProbe(credential, traeAccountRows.find((row) => row.label === label && row.region === region));
				noteSourceExpiry("trae", label, probe?.usage?.credits?.packages);
				return {
					label,
					region,
					app: traeAppLabelOf(credential),
					...credential.email === void 0 || credential.email === label ? {} : { email: credential.email },
					expiresAt: credential.expiresAtMs,
					expired: sourceCredentialExpired(credential, now),
					...probe?.checkin ? { checkin: probe.checkin } : {},
					...probe?.usage ? { usage: probe.usage } : {}
				};
			}))).filter((row) => regionEnabled("trae", row.region));
		} else traeAccountRows = [];
	} catch (error) {
		log("warn", "listing Trae sign-ins failed: " + messageOf(error));
	}
	try {
		const regions = activeQoderRegions();
		if (regions.length > 0) {
			const found = await discoverQoderCredentials();
			const rows = [];
			const deadline = Date.now() + SOURCE_ACCOUNTS_BUDGET_MS;
			let first = true;
			for (const credential of found.credentials) {
				if (!regions.includes(credential.region)) continue;
				if (!first) await delay(QODER_ACCOUNT_DELAY_MS);
				first = false;
				const label = qoderRowLabel(credential);
				const previous = qoderAccountRows.find((row) => row.label === label && row.region === credential.region);
				const probe = Date.now() < deadline ? await qoderRowProbe(credential, previous) : previous;
				noteSourceExpiry("qoder", label, probe?.usage?.credits?.packages);
				rows.push({
					label,
					region: credential.region,
					expiresAt: credential.expiresAtMs,
					expired: sourceCredentialExpired(credential, now),
					...probe?.checkin ? { checkin: probe.checkin } : {},
					...probe?.usage ? { usage: probe.usage } : {}
				});
			}
			qoderAccountRows = rows.filter((row) => regionEnabled("qoder", row.region));
		} else qoderAccountRows = [];
	} catch (error) {
		log("warn", "listing Qoder sign-ins failed: " + messageOf(error));
	}
}
/** Push the settings that affect discovery, cooldown and the picker. */
function applySettingsToCore() {
	const authFile = typeof settings.authFile === "string" ? settings.authFile.trim() : "";
	core.pool.applyConfig({
		authDirs: authFile === "" ? candidateAuthDirs() : [path.dirname(authFile)],
		cooldownMs: cooldownMs(),
		distribution: distributionSetting(),
		disabledAccountIds: disabledAccountIds(),
		creditReserves: creditReserves()
	});
	core.pool.applyRemoved(removedAccounts().map((entry) => entry.id));
	for (const region of REGIONS) {
		core.pool.prefer(preferredAccountId(region), region);
		applyEffectiveSelection(region);
	}
	reconcileRuntimes();
	applyAutoCheckin();
}
/**
* Retire runtimes whose source is switched off.
*
* Called on every settings application, so toggling the source needs no reload:
* the gateway stops, its accounts leave the pool, and its probes are dropped.
*/
function reconcileRuntimes() {
	const active = new Set(activeRegions());
	for (const [region, runtime] of runtimes) if (!active.has(region)) {
		pendingRuntimeStops.push(stopRuntime(runtime));
		runtimes.delete(region);
	}
	if (active.size === 0 && core.pool) {
		core.pool.clear();
		probeCache.clear();
		poolNeedsScan = true;
	}
}
/**
* True while the pool is empty because its last active region was switched off.
*
* A local directory read one pass later is what turns the pool back on; the flag
* keeps that read to the passes that actually follow a switch-off, rather than
* re-reading the disk on every pass for a machine with no sign-in at all.
*/
let poolNeedsScan = false;
/** The message as the panel and the report show it: redacted and bounded. */
function safeMessage(error) {
	return messageOf(error).slice(0, 500);
}
/**
* The errno code of a failure, and nothing else. An fs error quotes the
* absolute path it hit, which is the install path when the write target is
* this plugin's own state file; the code is the part a report can act on.
*/
function errorCodeOf(error) {
	const code = error && typeof error === "object" ? error.code : void 0;
	return typeof code === "string" && code !== "" ? code : "unknown";
}
/**
* Margin for the whole per-account probe batch inside one panel call.
*
* The panel bridge imposes no call-length cap, so this is the plugin's own
* bound, and a refresh pass spends part of it on the roster: the probes get
* the rest rather than all of it.
*/
const PROBE_BATCH_BUDGET_MS = 2e4;
/** Fold one probe's answer into the row it was read for. */
function applyProbe(row, probe) {
	if (probe.pending === true) {
		row.probePending = true;
		return;
	}
	if (probe.credits !== void 0) row.credits = probe.credits;
	if (probe.creditsError !== void 0) row.creditsError = probe.creditsError;
	if (probe.checkin !== void 0) row.checkin = probe.checkin;
	if (probe.checkinError !== void 0) row.checkinError = probe.checkinError;
}
/**
* One account's credits and check-in, served from cache while it is fresh.
*
* `allowNetwork: false` never waits on the upstream: a cold entry reports
* `pending` so the panel can say it is still reading, and the caller refreshes
* behind the first paint.
*/
async function accountProbe(account, allowNetwork) {
	const cached = probeCache.get(account.id);
	if (allowNetwork !== true) return cached === void 0 ? { pending: true } : cached.value;
	if (cached !== void 0 && Date.now() - cached.atMs < PROBE_TTL_MS) return cached.value;
	const value = {};
	try {
		const credits = await core.client.fetchCredits(account.credential);
		value.credits = {
			...credits.total === void 0 ? {} : { total: credits.total },
			packages: (credits.packages || []).map((pack) => ({
				packageName: pack.packageName,
				...pack.remain === void 0 ? {} : { remain: pack.remain },
				...pack.size === void 0 ? {} : { size: pack.size },
				...pack.monthly === void 0 ? {} : { monthly: pack.monthly },
				...pack.refreshAtMs === void 0 ? {} : { refreshAtMs: pack.refreshAtMs },
				...pack.expiresAtMs === void 0 ? {} : { expiresAtMs: pack.expiresAtMs }
			})),
			...credits.expiringSoon === void 0 ? {} : { expiringSoon: credits.expiringSoon },
			...credits.nearestExpiryMs === void 0 ? {} : { nearestExpiryMs: credits.nearestExpiryMs }
		};
	} catch (error) {
		value.creditsError = safeMessage(error);
	}
	if (value.credits !== void 0 && typeof value.credits.total === "number") core.pool.setCreditBalance(account.id, value.credits.total, value.credits.nearestExpiryMs);
	try {
		const checkin = await core.client.fetchCheckinStatus(account.credential);
		value.checkin = {
			active: checkin.active,
			todayCheckedIn: checkin.todayCheckedIn,
			streakDays: checkin.streakDays,
			dailyCredit: checkin.dailyCredit,
			todayCredit: checkin.todayCredit,
			isStreakDay: checkin.isStreakDay,
			nextStreakDay: checkin.nextStreakDay,
			streakBonusCredit: checkin.streakBonusCredit
		};
	} catch (error) {
		value.checkinError = safeMessage(error);
	}
	probeCache.set(account.id, {
		atMs: Date.now(),
		value
	});
	return value;
}
/**
* Per-gateway roster warnings, for gateways that have one right now.
*
* Empty spread when nothing is wrong, so a healthy panel carries no
* `warnings` key at all rather than an empty object to check.
*/
function catalogWarnings() {
	const warnings = {};
	for (const region of activeRegions()) {
		const runtime = runtimes.get(region);
		const message = runtime?.lastError || runtime?.lastWarning;
		if (typeof message === "string" && message !== "") warnings[region] = message;
	}
	return Object.keys(warnings).length === 0 ? {} : { warnings };
}
async function statusDocument(options) {
	const allowNetwork = options?.allowNetwork === true;
	const probeBudget = typeof options?.budgetMs === "number" ? Math.min(PROBE_BATCH_BUDGET_MS, Math.max(0, options.budgetMs)) : PROBE_BATCH_BUDGET_MS;
	const now = Date.now();
	const campaignClock = zonedDayHour(new Date(now));
	const accounts = [];
	const models = [];
	const selectionByRegion = {};
	const preferredAccountIds = {};
	/** region -> the account `pool.acquire` would pick next, for the "next up" row. */
	const runtimeNextUpId = /* @__PURE__ */ new Map();
	/** Gateways whose stored selection names models the roster no longer has. */
	const staleSelectionRegions = [];
	/** Row -> the credits/check-in read that row is still waiting on. */
	const pendingProbes = [];
	for (const region of activeRegions()) {
		preferredAccountIds[region] = preferredAccountId(region) || "";
		selectionByRegion[region] = effectiveSelectionFor(region, runtimes.get(region)?.catalog);
		if (selectionStale(region, runtimes.get(region)?.catalog)) staleSelectionRegions.push(region);
		const available = core.pool.available(now, void 0, region);
		const preferred = available.find((account) => account.id === preferredAccountIds[region]);
		const namesNext = distributionSetting() === "priority" || distributionSetting() === "expiry";
		const nextUp = preferred ?? (namesNext ? core.pool.preview(available) : void 0);
		runtimeNextUpId.set(region, nextUp === void 0 ? void 0 : nextUp.id);
		for (const account of core.pool.list(region)) {
			const cooling = account.cooldownUntilMs > now;
			const modelCooldowns = Object.entries(account.modelCooldowns).filter(([, until]) => until > now).sort((a, b) => a[1] - b[1]).map(([modelId, until]) => ({
				modelId,
				until: new Date(until).toISOString()
			}));
			const row = {
				id: account.id,
				label: account.label,
				...account.credential.nickname === void 0 ? {} : { nickname: account.credential.nickname },
				region,
				domain: account.credential.domain,
				...account.credential.expiresAtMs === 0 ? {} : { expiresAt: new Date(account.credential.expiresAtMs).toISOString() },
				cooling,
				...cooling ? { cooldownUntil: new Date(account.cooldownUntilMs).toISOString() } : {},
				...modelCooldowns.length === 0 ? {} : { modelCooldowns },
				rateLimitHits: account.rateLimitHits,
				active: runtimeNextUpId.get(region) === account.id,
				preferred: preferredAccountIds[region] === account.id,
				disabled: core.pool.isDisabled(account.id),
				...creditReserves()[account.id] === void 0 ? {} : { creditReserve: creditReserves()[account.id] }
			};
			if (!cooling) pendingProbes.push(accountProbe(account, allowNetwork).then((probe) => {
				applyProbe(row, probe);
			}));
			accounts.push(row);
		}
		const catalog = runtimes.get(region)?.catalog;
		if (catalog) {
			const selection = effectiveSelectionFor(region, catalog);
			const enabled = selection.enabledModelIds;
			const overrides = selection.overrides || {};
			for (const model of catalog.current()) {
				const override = overrides[model.id];
				const effective = applyOverride(model, override);
				const levels = thinkingLevelsFor(effective);
				const promo = promoStatusFor(model, campaignClock, region);
				models.push({
					id: model.id,
					name: model.name,
					...effective.alias === void 0 ? {} : { alias: effective.alias },
					region,
					...model.multiplier === void 0 ? {} : { multiplier: model.multiplier },
					...promo === void 0 ? {} : { promo },
					supportsImages: effective.supportsImages,
					contextWindow: effective.contextWindow,
					maxOutputTokens: effective.maxOutputTokens,
					nativeContextWindow: model.contextWindow,
					nativeMaxOutputTokens: model.maxOutputTokens,
					nativeSupportsImages: model.supportsImages,
					nativeThinkingLevels: model.supportedEfforts === void 0 || model.supportedEfforts.length === 0 ? [] : [...model.supportedEfforts],
					thinkingLevels: levels,
					...effective.defaultThinkingLevel === void 0 ? {} : { defaultThinkingLevel: effective.defaultThinkingLevel },
					advanced: hasOverride(override),
					enabled: enabled === void 0 || enabled.includes(model.id)
				});
			}
		}
	}
	if (pendingProbes.length > 0) await settleWithin(Promise.all(pendingProbes).catch(() => {}), probeBudget);
	return {
		regions: activeRegions(),
		sources: {
			workbuddy: sourceEnabled("workbuddy"),
			trae: sourceEnabled("trae"),
			qoder: sourceEnabled("qoder")
		},
		disabledRegions: disabledRegionKeys(),
		trae: {
			regions: activeTraeRegions(),
			distribution: sourceDistribution("trae"),
			accounts: traeAccountRows,
			preferred: sourcePreferredMap("trae"),
			gateways: Array.from(traeGateways.values()).map((entry) => ({
				region: entry.region,
				port: entry.gateway.port(),
				models: traeDeclarationModels(entry.region).length,
				portFallback: entry.portFallback,
				lastError: entry.lastError,
				roster: sourceRosterFor("trae:" + entry.region, entry.gateway.models(), traeNativeOf),
				selection: gatewaySelectionFor("trae:" + entry.region)
			}))
		},
		qoder: {
			regions: activeQoderRegions(),
			distribution: sourceDistribution("qoder"),
			accounts: qoderAccountRows,
			preferred: sourcePreferredMap("qoder"),
			gateways: Array.from(qoderGateways.values()).map((entry) => ({
				region: entry.region,
				port: entry.gateway.port(),
				models: qoderDeclarationModels(entry.region).length,
				portFallback: entry.portFallback,
				lastError: entry.lastError,
				roster: sourceRosterFor("qoder:" + entry.region, entry.gateway.models(), qoderNativeOf),
				selection: gatewaySelectionFor("qoder:" + entry.region)
			}))
		},
		enabled: settings.enabled !== false,
		pluginVersion: pluginVersion(),
		unpublishedDeclarations: unpublishedDeclarations(),
		modelCap: MAX_MODELS,
		distribution: distributionSetting(),
		showComposerPoints: settings.showComposerPoints === true,
		autoCheckin: {
			enabled: autoCheckinEnabled(),
			hours: checkinHours(),
			...autoCheckinLast === null ? {} : { last: autoCheckinLast }
		},
		preferredAccountIds,
		removedAccounts: removedAccounts().map((entry) => ({
			id: entry.id,
			label: typeof entry.label === "string" && entry.label !== "" ? entry.label : entry.id,
			region: entry.region
		})),
		declaration: runtimeState.write,
		addressDrift: addressDrift(),
		shims: {
			cn: shimInfo("cn"),
			global: shimInfo("global")
		},
		...catalogWarnings(),
		accounts,
		models,
		selectionByRegion,
		staleSelectionRegions
	};
}
function pluginVersion() {
	return PLUGIN_VERSION;
}
/** The loopback origin of one gateway, or a not-running marker. */
function shimInfo(region) {
	const runtime = runtimes.get(region);
	try {
		if (!runtime || !runtime.shim) return { running: false };
		if (runtime.shim.port() === 0) return { running: false };
		return {
			running: true,
			baseUrl: runtime.shim.baseUrl() + "/v1"
		};
	} catch {
		return { running: false };
	}
}
/** Every provider row this process has published, in declaration order. */
function declaredProviders() {
	return Array.from(declarationIndex.values());
}
function declaredProvider(region) {
	return declaredProviders().find((provider) => provider.id === PROVIDER_ID_BY_REGION[region]);
}
/** The published base URL of one Trae/Qoder gateway, by that source's id map. */
function declaredSourceBaseUrl(entry, idByRegion) {
	const baseUrl = declaredProviders().find((row) => row.id === idByRegion[entry.region])?.baseUrl;
	return typeof baseUrl === "string" ? baseUrl : void 0;
}
/**
* Provider ids this run declares but the host is not serving.
*
* Registration is a runtime call, so the only question is whether the LAST
* attempt succeeded: a registration the host refused leaves its ids out, and
* naming them is what turns a silently empty model list into the one action
* that clears it.
*/
function unpublishedDeclarations() {
	return declaredProviders().filter((provider) => !publishedIds.has(provider.id)).map((provider) => provider.id);
}
function declaredBaseUrl(region) {
	const baseUrl = declaredProvider(region)?.baseUrl;
	return typeof baseUrl === "string" ? baseUrl : void 0;
}
/**
* Two published addresses, compared as origins.
*
* The declaration always publishes the `/v1` form, but what a gateway hands
* back does not: the WorkBuddy shim's baseUrl() carries `/v1` while the Trae
* and Qoder gateways' is the bare origin kept for their own `/v1/models`
* warm-up calls. Comparing those shapes verbatim reports drift for a session
* that bound the right port on every row. Only the suffix differs, so only the
* suffix is ignored here.
*/
function samePublishedAddress(a, b) {
	if (typeof a !== "string" || typeof b !== "string") return false;
	const origin = (value) => value.replace(/\/+$/, "").replace(/\/v1$/, "");
	return origin(a) === origin(b);
}
/**
* True when the address that was published is not the address this run bound.
*
* A run that fell back to an ephemeral port counts as drift even though the
* declaration still names the preferred port, because until the plugin is
* reloaded nothing answers on the published address.
*
* Trae and Qoder are read the same way as WorkBuddy: they reserve a preferred
* port on the same terms, so they drift the same way.
*/
function addressDrift() {
	for (const region of activeRegions()) {
		if (runtimes.get(region)?.portFallback === true) return true;
		const published = declaredBaseUrl(region);
		const bound = shimInfo(region).baseUrl;
		if (published === void 0 || bound === void 0) continue;
		if (published !== bound) return true;
	}
	for (const entry of Array.from(traeGateways.values())) {
		if (entry.portFallback === true) return true;
		const published = declaredSourceBaseUrl(entry, TRAE_PROVIDER_ID_BY_REGION);
		if (published !== void 0 && !samePublishedAddress(published, entry.baseUrl)) return true;
	}
	for (const entry of Array.from(qoderGateways.values())) {
		if (entry.portFallback === true) return true;
		const published = declaredSourceBaseUrl(entry, QODER_PROVIDER_ID_BY_REGION);
		if (published !== void 0 && !samePublishedAddress(published, entry.baseUrl)) return true;
	}
	return false;
}
/** Trae discovery for the doctor: count only, never token material. */
async function traeDoctorDetail() {
	if (!sourceEnabled("trae")) return "switched off in plugin settings (deliberate; not a failure)";
	try {
		const found = await discoverTraeCredentials();
		if (found.credentials.length === 0) return "on; no Trae sign-in found (sign in to Trae CN / TRAE SOLO CN, then run the check again)";
		const byRegion = {};
		for (const credential of found.credentials) {
			const region = traeRegionOfCredential(credential);
			byRegion[region] = (byRegion[region] || 0) + 1;
		}
		const parts = Object.entries(byRegion).map(([region, count]) => `${region} x${count}`).join(", ");
		const failures = found.failures.length > 0 ? `; ${found.failures.length} unreadable file(s)` : "";
		const served = activeTraeRegions().map((region) => `${region}: ${traeDeclarationModels(region).length} model(s)`).join(", ");
		return `on; ${found.credentials.length} account(s) (${parts})${failures}; serving ${served}`;
	} catch (error) {
		return `on; discovery failed (${errorCodeOf(error)})`;
	}
}
/** Qoder credentials for the doctor: count only, never token material. */
async function qoderDoctorDetail() {
	if (!sourceEnabled("qoder")) return "switched off in plugin settings (deliberate; not a failure)";
	try {
		const found = await discoverQoderCredentials();
		if (found.credentials.length === 0) return `on; no Qoder sign-in found (sign in to Qoder, then run the check again)${found.failures.length > 0 ? `; ${found.failures.length} unreadable app dir(s)` : ""}`;
		const byRegion = {};
		for (const credential of found.credentials) byRegion[credential.region] = (byRegion[credential.region] || 0) + 1;
		const parts = Object.entries(byRegion).map(([region, count]) => `${region} x${count}`).join(", ");
		const failures = found.failures.length > 0 ? `; ${found.failures.length} unreadable app dir(s)` : "";
		const served = activeQoderRegions().map((region) => `${region}: ${qoderDeclarationModels(region).length} model(s)`).join(", ");
		return `on; ${found.credentials.length} account(s) (${parts})${failures}; serving ${served}`;
	} catch (error) {
		return `on; discovery failed (${errorCodeOf(error)})`;
	}
}
/** A readable report of everything that has to hold for a chat to reach upstream. */
async function doctor() {
	const deadline = Date.now() + PANEL_STEP_BUDGET_MS;
	const left = () => Math.max(0, deadline - Date.now());
	const status = await settleWithin(statusDocument({
		allowNetwork: true,
		budgetMs: left()
	}), left()) ?? await statusDocument({ allowNetwork: false });
	const findings = [];
	const push = (id, ok, detail) => findings.push({
		id,
		ok,
		detail
	});
	push("plugin-enabled", status.enabled, status.enabled ? "enabled" : "disabled in plugin settings");
	push("source-workbuddy", true, status.sources.workbuddy === true ? "on" : "switched off in plugin settings (deliberate; not a failure)");
	push("source-trae", true, await settleWithin(traeDoctorDetail(), left()) ?? "on; still reading this source's sign-ins");
	push("source-qoder", true, await settleWithin(qoderDoctorDetail(), left()) ?? "on; still reading this source's sign-ins");
	push("accounts", status.sources.workbuddy !== true || status.accounts.length > 0, status.sources.workbuddy !== true ? "WorkBuddy source is switched off; nothing is scanned or served" : status.accounts.length === 0 ? "no WorkBuddy sign-in found; sign in to the desktop app, then detect accounts again" : status.accounts.length + " account(s): " + status.accounts.map((account) => account.label).join(", "));
	const healthy = status.accounts.filter((account) => !account.cooling).length;
	push("rotation", status.sources.workbuddy !== true || healthy > 0, status.sources.workbuddy !== true ? "switched off; nothing to rotate" : healthy + " of " + status.accounts.length + " account(s) can serve a request now");
	const unpublished = status.unpublishedDeclarations || [];
	push("host-registered-providers", unpublished.length === 0, unpublished.length === 0 ? "the host is serving every provider this plugin declares" : unpublished.length + " provider(s) failed to register with the host (" + unpublished.join(", ") + ") - the next change to the pool retries them");
	for (const region of activeRegions()) {
		const runtime = runtimes.get(region);
		const label = PROVIDER_NAME_BY_REGION[region];
		const info = shimInfo(region);
		const declared = declaredProvider(region) !== void 0 && publishedIds.has(PROVIDER_ID_BY_REGION[region]);
		push(label + ": endpoint", info.running, info.running ? "listening on " + info.baseUrl : "not listening");
		const regionModels = status.models.filter((model) => model.region === region);
		push(label + ": models", regionModels.length > 0, regionModels.length + " model(s) in the catalog");
		push(label + ": declared", declared, declared ? "registered with the running host" : runtime?.lastError || runtime?.lastWarning || "this gateway is not published yet");
	}
	for (const region of activeRegions()) {
		const runtime = runtimes.get(region);
		const published = declaredBaseUrl(region);
		const bound = runtime?.baseUrl;
		if (published === void 0 || bound === void 0) continue;
		const fallback = runtime?.portFallback === true;
		if (published === bound && !fallback) {
			push(PROVIDER_NAME_BY_REGION[region] + ": published address", true, "matches the endpoint this gateway bound (" + bound + ")");
			continue;
		}
		const detail = fallback ? "port " + preferredPort(region) + " is held by another process, so this session serves " + bound + " - free that port (usually a leftover plugin process), then reload the plugin" : "the published address is " + published + " but this gateway is on " + bound + " - reload the plugin so the host picks the new address up";
		push(PROVIDER_NAME_BY_REGION[region] + ": published address", false, detail);
	}
	for (const [gateways, idByRegion, nameByRegion, ports] of [[
		traeGateways,
		TRAE_PROVIDER_ID_BY_REGION,
		TRAE_PROVIDER_NAME_BY_REGION,
		TRAE_PORTS
	], [
		qoderGateways,
		QODER_PROVIDER_ID_BY_REGION,
		QODER_PROVIDER_NAME_BY_REGION,
		QODER_PORTS
	]]) for (const entry of Array.from(gateways.values())) {
		const published = declaredSourceBaseUrl(entry, idByRegion);
		const bound = entry.baseUrl;
		const label = nameByRegion[entry.region];
		if (published === void 0 || bound === void 0) continue;
		const fallback = entry.portFallback === true;
		if (samePublishedAddress(published, bound) && !fallback) {
			push(label + ": published address", true, "matches the endpoint this gateway bound (" + bound + ")");
			continue;
		}
		const detail = fallback ? "port " + ports[entry.region] + " is held by another process, so this session serves " + bound + " - free that port (usually a leftover plugin process), then reload the plugin" : "the published address is " + published + " but this gateway is on " + bound + " - reload the plugin so the host picks the new address up";
		push(label + ": published address", false, detail);
	}
	push("declaration-written", runtimeState.write.ok === true, runtimeState.write.ok !== true ? safeMessage(runtimeState.write.error) : runtimeState.write.changed ? "the model list was just updated; the host discovers it from this gateway's /v1/models" : String(runtimeState.write.skipped || "up to date"));
	const ok = findings.every((finding) => finding.ok);
	const report = [
		"WTQ Pool doctor",
		(/* @__PURE__ */ new Date()).toISOString(),
		"overall: " + (ok ? "PASS" : "FAIL"),
		"",
		...findings.map((finding) => (finding.ok ? "PASS  " : "FAIL  ") + finding.id + " - " + finding.detail),
		""
	].join("\n");
	if (dataPath !== "") try {
		fs$1.writeFileSync(path.join(dataPath, "doctor.txt"), report, "utf8");
	} catch {}
	return {
		ok,
		findings,
		report,
		status
	};
}
function panelError(message, code) {
	const error = new Error(message);
	error.code = code;
	return error;
}
/**
* Validate an untrusted selection payload.
*
* Returns undefined for anything malformed so nothing partial is written. An
* empty array is meaningful (`enabledModelIds: []` disables every model, which
* the panel refuses to save) so it is preserved rather than treated as absent.
*/
function parseSelection(body) {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return void 0;
	const out = {};
	const enabled = body.enabledModelIds;
	if (enabled !== void 0) {
		if (!Array.isArray(enabled)) return void 0;
		const ids = [];
		for (const entry of enabled) {
			if (typeof entry !== "string" || entry === "") return void 0;
			ids.push(entry);
		}
		out.enabledModelIds = ids;
	}
	const overrides = body.overrides;
	if (overrides !== void 0) {
		if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) return void 0;
		const map = Object.create(null);
		for (const [id, raw] of Object.entries(overrides)) {
			if (typeof id !== "string" || id === "") return void 0;
			const parsed = parseOverride(raw);
			if (parsed === void 0) return void 0;
			if (Object.keys(parsed).length > 0) map[id] = parsed;
		}
		out.overrides = map;
	}
	return out;
}
/**
* Validate one model's override.
*
* Every field is optional, and a value that is present must be usable: the host
* rejects a zero window, and a thinking level outside the host's ladder would be
* dropped there anyway. Rejecting here means the panel reports a failure instead
* of a save that quietly did nothing.
*/
function parseOverride(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
	const out = {};
	if (raw.alias !== void 0) {
		if (typeof raw.alias !== "string") return void 0;
		const alias = raw.alias.trim();
		if (alias.length > 120) return void 0;
		out.alias = alias;
	}
	for (const key of ["contextWindow", "maxOutputTokens"]) {
		const value = raw[key];
		if (value === void 0) continue;
		if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_TOKEN_BUDGET) return void 0;
		out[key] = value;
	}
	if (raw.supportsImages !== void 0) {
		if (typeof raw.supportsImages !== "boolean") return void 0;
		out.supportsImages = raw.supportsImages;
	}
	if (raw.thinkingLevels !== void 0) {
		if (!Array.isArray(raw.thinkingLevels)) return void 0;
		const levels = [];
		for (const level of raw.thinkingLevels) {
			if (typeof level !== "string" || !HOST_THINKING_LEVELS.includes(level)) return void 0;
			if (!levels.includes(level)) levels.push(level);
		}
		if (levels.length > 0) out.thinkingLevels = levels;
	}
	if (raw.defaultThinkingLevel !== void 0) {
		if (typeof raw.defaultThinkingLevel !== "string") return void 0;
		if (!HOST_THINKING_LEVELS.includes(raw.defaultThinkingLevel)) return void 0;
		out.defaultThinkingLevel = raw.defaultThinkingLevel;
	}
	return out;
}
async function onPanelInvoke(channel, payload) {
	switch (channel) {
		/**
		* Opening the panel.
		*
		* The old implementation ran the whole detection pass inline - a model
		* roster fetch per gateway plus two billing calls per account - before it
		* could answer, so the panel stayed blank for seconds every time it opened.
		* Now the cached document is returned immediately and the detection runs
		* behind it; `refreshing` tells the panel to ask again shortly. `wait: true`
		* (the Refresh button) still resolves on a fully refreshed document.
		*/
		case "xd.state": {
			if (payload?.wait === true) return {
				...await refreshAll("panel", true),
				refreshing: false
			};
			const document = await statusDocument({ allowNetwork: false });
			const refreshing = refreshNeeded();
			if (refreshing) scheduleRefresh("panel");
			return {
				...document,
				refreshing
			};
		}
		/**
		* "Detect accounts again": a deliberate, user-invoked re-read, so every
		* gateway's roster is refetched even inside its refresh window.
		*/
		case "xd.rescan": {
			const deadline = Date.now() + RESCAN_BUDGET_MS;
			const left = () => Math.max(0, deadline - Date.now());
			if (activeRegions().length > 0) await settleWithin(core.pool.scan(), left());
			await settleWithin(startRuntimes(), left());
			await settleWithin(refreshSourceAccounts(), left());
			await settleWithin(Promise.all(Array.from(runtimes.values()).map((runtime) => refreshRuntime(runtime, "rescan", true))), left());
			syncDeclaration();
			return await statusDocument({
				allowNetwork: true,
				budgetMs: left()
			});
		}
		case "xd.resetCooldowns":
			core.pool.resetCooldowns();
			return await statusDocument({ allowNetwork: false });
		case "xd.checkin": {
			const accountId = typeof payload?.accountId === "string" ? payload.accountId : "";
			if (accountId === "") throw panelError("accountId is required", "INVALID");
			const account = core.pool.list().find((item) => item.id === accountId);
			if (account === void 0) throw panelError("unknown account", "NOT_FOUND");
			if (!regionEnabled("workbuddy", regionOf(account.credential.domain))) throw panelError("this source region is disabled", "INACTIVE");
			const work = async () => {
				const before = await core.client.fetchCheckinStatus(account.credential);
				if (before.todayCheckedIn) {
					probeCache.delete(accountId);
					return {
						state: await statusDocument({
							allowNetwork: true,
							budgetMs: DOCUMENT_BUDGET_MS
						}),
						result: {
							credit: 0,
							streakDays: before.streakDays,
							isStreakDay: before.isStreakDay
						}
					};
				}
				if (!before.active) throw panelError("check-in is not available for this account", "INACTIVE");
				const claim = await core.client.claimDailyCheckin(account.credential);
				probeCache.delete(accountId);
				return {
					state: await statusDocument({
						allowNetwork: true,
						budgetMs: DOCUMENT_BUDGET_MS
					}),
					result: claim
				};
			};
			const answered = await settleWithin(work(), PANEL_STEP_BUDGET_MS);
			if (answered === void 0) throw panelError("the check-in did not finish in time; try again", "TIMEOUT");
			return answered;
		}
		/**
		* Save the model selection for one gateway.
		*
		* The write result is checked rather than assumed: reporting success while
		* nothing was stored is exactly how "saving does nothing" presents itself.
		* The selection is applied to the catalog and republished before answering,
		* so the panel reflects what will be in force from now on.
		*/
		case "xd.saveModels": {
			const requested = typeof payload?.gateway === "string" ? payload.gateway : typeof payload?.region === "string" ? payload.region : "";
			if (!/^(cn|global|trae:cn|trae:ai|qoder:cn|qoder:global)$/.test(requested)) throw panelError("unknown gateway", "INVALID");
			const selection = parseSelection(payload?.selection);
			if (selection === void 0) throw panelError("invalid selection payload", "INVALID");
			const all = { ...settings.modelSelection || {} };
			all[requested] = selection;
			if (await saveSettings({ modelSelection: all }) !== true) throw panelError("the selection could not be written to the plugin settings file", "SAVE_FAILED");
			if (requested === "cn" || requested === "global") applyEffectiveSelection(requested);
			syncDeclaration();
			return await statusDocument({ allowNetwork: false });
		}
		case "xd.preferAccount": {
			const region = payload?.region;
			const accountId = payload?.accountId;
			if (!REGIONS.includes(region) || typeof accountId !== "string") throw panelError("region and accountId are required", "INVALID");
			if (accountId !== "" && !core.pool.list(region).some((account) => account.id === accountId)) throw panelError("account does not belong to this region", "NOT_FOUND");
			const preferredAccountIds = {};
			for (const key of REGIONS) {
				const current = preferredAccountId(key);
				if (current !== void 0) preferredAccountIds[key] = current;
			}
			if (accountId === "") delete preferredAccountIds[region];
			else preferredAccountIds[region] = accountId;
			if (await saveSettings({ preferredAccountIds }) !== true) throw panelError("the account choice could not be saved", "SAVE_FAILED");
			core.pool.prefer(accountId || void 0, region);
			return await statusDocument({ allowNetwork: false });
		}
		/**
		* One channel for the two per-account decisions: "not right now" (switched
		* off, still listed, one click from coming back) and "not mine any more"
		* (removed, and a rescan will not bring it back).
		*/
		case "xd.setAccountState": {
			const region = payload?.region;
			const accountId = payload?.accountId;
			const state = payload?.state;
			if (!REGIONS.includes(region) || typeof accountId !== "string" || accountId === "" || ![
				"enabled",
				"disabled",
				"removed",
				"restored"
			].includes(state)) throw panelError("region, accountId and a known state are required", "INVALID");
			const account = core.pool.list(region).find((item) => item.id === accountId);
			const stored = removedAccounts().find((entry) => entry.id === accountId);
			if (state !== "restored" && account === void 0 && stored === void 0) throw panelError("account does not belong to this gateway", "NOT_FOUND");
			const disabled = disabledAccountIds().filter((id) => id !== accountId);
			if (state === "disabled") disabled.push(accountId);
			const removed = removedAccounts().filter((entry) => entry.id !== accountId);
			if (state === "removed") removed.push({
				id: accountId,
				label: account === void 0 ? stored.label : account.label,
				region
			});
			if (await saveSettings({
				disabledAccountIds: disabled,
				removedAccounts: removed
			}) !== true) throw panelError("the account setting could not be saved", "SAVE_FAILED");
			core.pool.applyConfig({ disabledAccountIds: disabled });
			core.pool.applyRemoved(removed.map((entry) => entry.id));
			if (accountId !== "" && preferredAccountId(region) === accountId && state !== "enabled" && state !== "restored") {
				const nextPreferred = {};
				for (const key of REGIONS) {
					const current = preferredAccountId(key);
					if (current !== void 0 && !(key === region && current === accountId)) nextPreferred[key] = current;
				}
				await saveSettings({ preferredAccountIds: nextPreferred });
				core.pool.prefer(void 0, region);
			}
			return await statusDocument({ allowNetwork: false });
		}
		/** The credits to keep back on one account: 0 clears the floor. */
		case "xd.setCreditReserve": {
			const region = payload?.region;
			const accountId = payload?.accountId;
			const reserve = Number(payload?.reserve);
			if (!REGIONS.includes(region) || typeof accountId !== "string" || accountId === "") throw panelError("region and accountId are required", "INVALID");
			if (!Number.isFinite(reserve) || reserve < 0) throw panelError("reserve must be a number of credits, 0 or more", "INVALID");
			if (!core.pool.list(region).some((account) => account.id === accountId)) throw panelError("account does not belong to this gateway", "NOT_FOUND");
			const next = { ...creditReserves() };
			if (reserve === 0) delete next[accountId];
			else next[accountId] = Math.floor(reserve);
			if (await saveSettings({ creditReserves: next }) !== true) throw panelError("the reserve could not be saved", "SAVE_FAILED");
			core.pool.applyConfig({ creditReserves: next });
			return await statusDocument({ allowNetwork: false });
		}
		/** One click for every account's daily reward, as the command palette does.
		*  With `source`, only that source's pool runs — each source has its own
		*  check-in pool in the panel, so one button must not sweep the others. */
		case "xd.checkinAll": {
			const source = typeof payload?.source === "string" ? payload.source : "";
			const want = (name) => source === "" || source === name;
			if (checkinPassRunning) return {
				state: await statusDocument({
					allowNetwork: true,
					budgetMs: DOCUMENT_BUDGET_MS
				}),
				running: true
			};
			const passGeneration = loadGeneration;
			checkinPassRunning = true;
			const failed = { failed: true };
			const counts = await settleWithin((async () => {
				try {
					const [pool, travel, qoder, trae] = await Promise.all([
						want("workbuddy") ? claimAllCheckins() : Promise.resolve({
							claimed: 0,
							skipped: 0,
							failed: 0
						}),
						want("workbuddy") ? travelAllAccounts() : Promise.resolve(void 0),
						want("qoder") ? qoderCheckinAll() : Promise.resolve(void 0),
						want("trae") ? traeCheckinAll() : Promise.resolve(void 0)
					]);
					return {
						...pool,
						travel,
						qoder,
						trae
					};
				} finally {
					if (stillLoaded(passGeneration)) checkinPassRunning = false;
				}
			})().catch((error) => {
				log("warn", "check-in pass failed: " + messageOf(error));
				return failed;
			}), CHECKIN_BUDGET_MS);
			if (counts === void 0) return {
				state: await statusDocument({
					allowNetwork: true,
					budgetMs: DOCUMENT_BUDGET_MS
				}),
				running: true
			};
			if (counts === failed) throw panelError("the check-in pass failed; the reason is in the plugin log", "UPSTREAM");
			return {
				state: await statusDocument({
					allowNetwork: true,
					budgetMs: DOCUMENT_BUDGET_MS
				}),
				...counts
			};
		}
		/**
		* Claim ONE Trae or Qoder account's daily reward.
		*
		* The label and region are the pair the panel's row was built from, so a
		* stale row cannot claim a different account; the claim itself re-reads
		* status first, which is what keeps a double click from collecting twice.
		*/
		case "xd.sourceCheckin": {
			const source = typeof payload?.source === "string" ? payload.source : "";
			const label = typeof payload?.label === "string" ? payload.label : "";
			const region = typeof payload?.region === "string" ? payload.region : "";
			if (source !== "trae" && source !== "qoder") throw panelError("source must be trae or qoder", "INVALID");
			if (label === "" || region === "") throw panelError("label and region are required", "INVALID");
			if (!regionEnabled(source, region)) throw panelError("this source region is disabled", "INACTIVE");
			const answered = await settleWithin((async () => {
				const outcome = source === "trae" ? await traeClaimOne(label, region) : await qoderClaimOne(label, region);
				return {
					state: await statusDocument({
						allowNetwork: true,
						budgetMs: DOCUMENT_BUDGET_MS
					}),
					result: outcome
				};
			})(), PANEL_STEP_BUDGET_MS);
			if (answered === void 0) throw panelError("the check-in did not finish in time; try again", "TIMEOUT");
			return answered;
		}
		/**
		* Pick which of a source's accounts serves its region.
		*
		* The label is the same one the panel's row was built from, and the
		* gateways re-read their credentials on every request, so this takes effect
		* from the next request on without restarting anything.
		*/
		case "xd.preferSourceAccount": {
			const source = typeof payload?.source === "string" ? payload.source : "";
			const region = typeof payload?.region === "string" ? payload.region : "";
			const label = typeof payload?.label === "string" ? payload.label : "";
			if (source !== "trae" && source !== "qoder") throw panelError("source must be trae or qoder", "INVALID");
			if (!(source === "trae" ? TRAE_REGIONS : QODER_REGIONS).includes(region)) throw panelError("unknown region for this source", "INVALID");
			if (!sourceAccountMayBePreferred(source, region, label)) throw panelError("that account is not available for this source", "INVALID");
			const next = { ...settings.preferredSourceAccounts ?? {} };
			if (label === "") delete next[sourceRegionKey(source, region)];
			else next[sourceRegionKey(source, region)] = label;
			if (await saveSettings({ preferredSourceAccounts: next }) !== true) throw panelError("the account choice could not be saved", "SAVE_FAILED");
			return await statusDocument({ allowNetwork: false });
		}
		case "xd.distribution": {
			const requested = payload?.distribution;
			const next = WORKBUDDY_DISTRIBUTIONS.includes(requested) ? requested : "priority";
			if (await saveSettings({ distribution: next }) !== true) throw panelError("the usage mode could not be written to the plugin settings file", "SAVE_FAILED");
			core.pool.applyConfig({ distribution: next });
			return await statusDocument({ allowNetwork: false });
		}
		/**
		* The usage mode of one Trae/Qoder source. WorkBuddy's own mode is handled
		* above by the pool; a source gateway has no pool, it reads an ordered
		* credential list per request, so the mode is only a setting here.
		*/
		case "xd.sourceDistribution": {
			const source = typeof payload?.source === "string" ? payload.source : "";
			if (source !== "trae" && source !== "qoder") throw panelError("source must be trae or qoder", "INVALID");
			const requested = payload?.distribution;
			const next = SOURCE_DISTRIBUTIONS.includes(requested) ? requested : "priority";
			if (await saveSettings({ sourceDistributions: {
				...settings.sourceDistributions ?? {},
				[source]: next
			} }) !== true) throw panelError("the usage mode could not be written to the plugin settings file", "SAVE_FAILED");
			return await statusDocument({ allowNetwork: false });
		}
		/** Switch the daily automatic check-in on or off, and set its hours. */
		case "xd.setAutoCheckin": {
			const hours = normaliseCheckinHours(Array.isArray(payload?.hours) ? payload.hours : []);
			if (await saveSettings({ autoCheckin: {
				enabled: payload?.enabled === true,
				hours
			} }) !== true) throw panelError("the automatic check-in setting could not be written to the plugin settings file", "SAVE_FAILED");
			applyAutoCheckin();
			return await statusDocument({ allowNetwork: false });
		}
		/**
		* Run the daily pass now, by hand.
		*
		* The scheduled pass is silent by nature: it fires at an hour nobody is
		* watching, so a user who set 11:00 had nothing to look at and no way to
		* check the setting had taken. This runs exactly what the scheduler runs and
		* records it in the same place, so the panel's "last run" line answers for
		* both — and a user can see the result of a manual run immediately.
		*
		* Bounded like every other network pass here: Trae alone spaces its accounts
		* five seconds apart, so ten of them is a minute, and the host cuts a panel
		* call off well before that. So the pass starts now, the call answers with
		* whatever the budget allows, and a pass still running lands in the same
		* `autoCheckinLast` when it finishes — the panel picks it up on its next
		* refresh instead of the result being lost to a truncated call.
		*/
		case "xd.runCheckinNow":
			await settleWithin(runCheckinPass({ manual: true }), REFRESH_PASS_BUDGET_MS);
			return await statusDocument({ allowNetwork: false });
		case "xd.setComposerPoints":
			if (await saveSettings({ showComposerPoints: payload?.enabled === true }) !== true) throw panelError("the composer credits setting could not be written to the plugin settings file", "SAVE_FAILED");
			return await statusDocument({ allowNetwork: false });
		/**
		* Park or unpark one edition of one source (国内版 / 国际版).
		*
		* Same shape as the source switch above: a parked region keeps no gateway,
		* no scan and no provider row, and unparking waits for a real refresh so
		* the panel comes back with that region's accounts and models.
		*/
		case "xd.setRegionEnabled": {
			const source = typeof payload?.source === "string" ? payload.source : "";
			const region = typeof payload?.region === "string" ? payload.region : "";
			const known = source === "trae" ? TRAE_REGIONS : source === "qoder" ? QODER_REGIONS : source === "workbuddy" ? REGIONS : void 0;
			if (known === void 0 || !known.includes(region)) throw panelError("unknown source region", "INVALID");
			const key = sourceRegionKey(source, region);
			const parked = disabledRegionKeys().filter((entry) => entry !== key);
			if (payload?.enabled !== true) parked.push(key);
			if (await saveSettings({ disabledRegions: parked }) !== true) throw panelError("the region switch could not be written to the plugin settings file", "SAVE_FAILED");
			await onHostSettingsChanged({});
			if (payload?.enabled === true) await refreshAll("region-on", true);
			else syncDeclaration();
			return await statusDocument({ allowNetwork: false });
		}
		/**
		* Switch one source on or off from the panel.
		*
		* Same settings key the host's own settings dialog writes, so the switch
		* state is shared: whichever surface changes it, the next document says the
		* same thing. Turning a source on waits for a real refresh so the panel
		* comes back with its gateways and accounts, not an empty strip.
		*/
		case "xd.setSource": {
			const key = typeof payload?.source === "string" ? SOURCE_SETTING_KEYS[payload.source] : void 0;
			if (key === void 0) throw panelError("unknown source", "UNSUPPORTED");
			if (await saveSettings({ [key]: payload?.enabled === true }) !== true) throw panelError("the source switch could not be written to the plugin settings file", "SAVE_FAILED");
			await onHostSettingsChanged({});
			if (payload?.enabled === true) await refreshAll("source-on", true);
			else syncDeclaration();
			return await statusDocument({ allowNetwork: false });
		}
		case "xd.doctor": return await doctor();
		/**
		* The composer readout.
		*
		* `composerPoints` answers from cache only; a poll may schedule the
		* background refresh that fills a stale cache, but never waits on one.
		* `composerPrefer` is the click behind it and is allowed to write.
		*/
		case "xd.composerPoints": return composerPoints(payload);
		case "xd.composerPrefer": return await composerPrefer(payload);
		/**
		* Re-read the credits behind the composer popup, then answer with them.
		*
		* The popup lists one route's accounts, so the refresh covers exactly those:
		* a WorkBuddy region drops its probe cache and reads it back, a Trae or Qoder
		* region re-probes each of its rows. The polled readout stays cache-only;
		* this channel is the one the click is allowed to wait on, and it waits only
		* as long as the readout's own call deadline leaves room for the answer.
		*/
		case "xd.composerRefresh": {
			const hit = matchComposerModel(payload);
			if (hit === void 0) return composerPoints(payload);
			const deadline = Date.now() + COMPOSER_REFRESH_BUDGET_MS;
			if (hit.source === "workbuddy") {
				for (const account of core.pool.list(hit.region)) probeCache.delete(account.id);
				await settleWithin(statusDocument({
					allowNetwork: true,
					budgetMs: COMPOSER_REFRESH_BUDGET_MS
				}), COMPOSER_REFRESH_BUDGET_MS);
			} else {
				const rows = hit.source === "trae" ? traeAccountRows : qoderAccountRows;
				const found = hit.source === "trae" ? await discoverTraeCredentials() : await discoverQoderCredentials();
				for (const row of rows) {
					if (row.region !== hit.region) continue;
					if (Date.now() >= deadline) break;
					const credential = found.credentials.find((item) => {
						const itemLabel = hit.source === "trae" ? traeRowLabel(item) : qoderRowLabel(item);
						const itemRegion = hit.source === "trae" ? traeRegionOfCredential(item) : item.region;
						return itemLabel === row.label && itemRegion === row.region;
					});
					if (credential === void 0) continue;
					const probe = hit.source === "trae" ? await traeRowProbe(credential, row) : await qoderRowProbe(credential, row);
					if (probe?.usage) row.usage = probe.usage;
					if (probe?.checkin) row.checkin = probe.checkin;
				}
			}
			return composerPoints(payload);
		}
		default: throw panelError("unsupported panel channel: " + String(channel), "UNSUPPORTED");
	}
}
async function registerCommands() {
	const register = async (id, title, keywords, run) => {
		try {
			await pi.commands.register({
				id,
				title,
				category: "Productivity",
				keywords,
				run
			});
		} catch (error) {
			log("warn", "could not register command " + id + ": " + messageOf(error));
		}
	};
	await register(COMMAND_OPEN, "WTQ Pool: Open Panel", [
		"workbuddy",
		"pool",
		"池",
		"模型"
	], async () => {
		await pi.ui.openPanel();
	});
	await register(COMMAND_RESCAN, "WTQ Pool: Detect Accounts Again", [
		"workbuddy",
		"rescan",
		"重新检测"
	], async () => {
		const state = await onPanelInvoke("xd.rescan", {});
		await pi.ui.showToast("WTQ Pool - " + state.accounts.length + " account(s) in the pool", "info");
	});
	await register(COMMAND_RESET, "WTQ Pool: Clear All Cooldowns", [
		"workbuddy",
		"cooldown",
		"清除冷却"
	], async () => {
		core.pool.resetCooldowns();
		await pi.ui.showToast("WTQ Pool - all cooldowns cleared", "info");
	});
	await register(COMMAND_DOCTOR, "WTQ Pool: Run Connection Check", [
		"workbuddy",
		"doctor",
		"诊断"
	], async () => {
		const result = await doctor();
		await pi.ui.showToast(result.ok ? "WTQ Pool check passed" : "WTQ Pool check found problems - see the panel", result.ok ? "info" : "warn");
	});
	await register(COMMAND_CHECKIN, "WTQ Pool: Daily Check-in (All Accounts)", [
		"workbuddy",
		"trae",
		"qoder",
		"checkin",
		"签到"
	], async () => {
		const finished = runCheckinPass().then((result) => checkinSummaryText(result));
		const summary = await settleWithin(finished, CHECKIN_BUDGET_MS);
		if (summary !== void 0) {
			await pi.ui.showToast(summary, "info");
			return;
		}
		await pi.ui.showToast("dsh-wtq-pool - check-in running in the background", "info");
		finished.then((late) => pi.ui.showToast(late, "info")).catch((error) => log("warn", "background check-in failed: " + messageOf(error)));
	});
}
/**
* Run one check-in pass and record it in `autoCheckinLast`.
*
* All three entry points — the scheduled tick, the host command and the panel's
* "run now" — come through here, so the re-entry guard lives in one place. In
* the panel channel alone it would miss the tick and the host command, which can
* start a second pass alongside a manual one: no double claiming, because every
* step reads `todayCheckedIn` before it writes, but the log would then describe
* whichever pass finished last rather than what the user asked for.
*
* `manual` marks a pass the user started, so the panel's status line can say so.
*/
async function runCheckinPass(options) {
	const manual = options?.manual === true;
	const generation = loadGeneration;
	if (checkinPassRunning) return { running: true };
	checkinPassRunning = true;
	const zoned = zonedDayHour(/* @__PURE__ */ new Date());
	const slot = typeof options?.slot === "string" && options.slot !== "" ? options.slot : dueCheckinSlot(/* @__PURE__ */ new Date(), checkinHours(), autoCheckinSlots) ?? checkinSlotId(zoned.day, zoned.hour);
	const started = {
		slot,
		claimed: 0,
		pending: true,
		at: (/* @__PURE__ */ new Date()).toISOString(),
		...manual ? { manual: true } : {}
	};
	autoCheckinLast = started;
	autoCheckinSlots.add(slot);
	scheduleRefresh(manual ? "manual-checkin" : "auto-checkin");
	try {
		const [pool, travel, qoder, trae] = await Promise.all([
			claimAllCheckins(),
			travelAllAccounts(),
			qoderCheckinAll(),
			traeCheckinAll()
		]);
		if (!stillLoaded(generation)) return started;
		qoderRetryAt = typeof qoder.opensAt === "number" && qoder.opensAt > Date.now() ? qoder.opensAt : 0;
		Object.assign(started, {
			claimed: pool.claimed,
			skipped: pool.skipped,
			failed: pool.failed,
			travel,
			qoder,
			trae
		});
		await delay(GROWTH_AFTER_CHECKIN_MS);
		if (!stillLoaded(generation)) return started;
		started.growth = await claimAllGrowth();
		log((manual ? "manual" : "automatic") + " check-in collected " + pool.claimed + " account(s) for " + slot);
	} catch (error) {
		started.error = safeMessage(error);
		log("warn", (manual ? "manual" : "automatic") + " check-in failed for " + slot + ": " + started.error);
	} finally {
		if (stillLoaded(generation)) checkinPassRunning = false;
		delete started.pending;
	}
	if (stillLoaded(generation)) {
		autoCheckinLast = started;
		scheduleRefresh(manual ? "manual-checkin" : "auto-checkin");
	}
	return started;
}
/**
* How long a check-in pass may run before it answers what it has and leaves the
* rest to the background. Inside the host's command budget, with room for the
* document that answers with it.
*/
const CHECKIN_BUDGET_MS = 15e3;
/**
* The other wide panel passes: a deliberate re-scan, one check-in step, and the
* connection check. Each is capped as a whole rather than by adding up the
* bounds of the calls inside it, and each answers from what has arrived.
*/
const RESCAN_BUDGET_MS = 2e4;
const PANEL_STEP_BUDGET_MS = 2e4;
/**
* What a pass may spend on the document it answers with. The figures are read
* from the caches the pass has just filled, so this buys the numbers, not the
* reads: `allowNetwork: true` still probes inside this share.
*/
const DOCUMENT_BUDGET_MS = 4e3;
/**
* What the composer popup's refresh may spend before it answers.
*
* The readout's own call deadline is 20 s (`INVOKE_TIMEOUT_MS`), and the route
* still has to serialize the answer inside it, so this pass stops short of the
* full figure. Past it the popup keeps the figures it already has and its poll
* picks up whatever the abandoned probe wrote, which is what keeps a slow
* credentials read from turning the click into a client-side timeout.
*/
const COMPOSER_REFRESH_BUDGET_MS = 15e3;
/** The one line a check-in pass reports, whichever way it finished. */
function checkinSummaryText(result) {
	if (result == null || result.running === true) return "WTQ Pool - a check-in pass is already running";
	const growth = result.growth;
	const growthText = growth === void 0 ? "" : ", streak " + (Number(growth.streak) || 0) + " tier(s), tasks " + (Number(growth.tasks) || 0) + " (+" + (Number(growth.credit) || 0) + " credits)";
	return "WTQ Pool - checked in " + result.claimed + " account(s), travel " + JSON.stringify(result.travel) + growthText + ", Qoder " + JSON.stringify(result.qoder) + ", Trae " + JSON.stringify(result.trae);
}
/**
* Redeem every unlocked streak tier of one account.
*
* A locked tier is the normal state until enough days accumulate, and a claimed
* one needs no action, so neither is a failure. Returns how many tiers were
* redeemed and what they paid, so the panel can say so.
*/
async function redeemAccountStreak(account) {
	const status = await core.client.growthStreakFull(account.credential);
	let claimed = 0;
	let credit = 0;
	let energy = 0;
	for (const tier of status.tiers) {
		if (tier.status !== "unlocked") continue;
		try {
			await core.client.redeemStreakTier(account.credential, tier.tier);
			claimed += 1;
			credit += tier.credit;
			energy += tier.energy;
			log("info", "streak " + account.label + ": redeemed " + tier.tier + " (+" + tier.credit + "c +" + tier.energy + "e)");
		} catch (error) {
			log("warn", "streak " + account.label + ": redeem " + tier.tier + " failed: " + messageOf(error));
		}
	}
	return {
		claimed,
		credit,
		energy
	};
}
/**
* Collect every claimable task reward of one account.
*
* Enrolment comes first: a task that was never accepted cannot be claimed, and
* accepting an already-accepted task succeeds, so replaying the pass is safe.
* The list is read again afterwards, because accepting can change what is
* claimable. A repeat claim answers `already_claimed` and pays nothing.
*/
async function claimAccountTasks(account) {
	const credential = account.credential;
	const open = (await core.client.listTasks(credential)).filter((task) => task.acceptStatus === "not_accepted" && !task.locked).map((task) => task.taskCode);
	if (open.length > 0) await core.client.acceptTasks(credential, open);
	const tasks = await core.client.listTasks(credential);
	let claimed = 0;
	let credit = 0;
	let energy = 0;
	let failed = 0;
	for (const task of tasks) {
		if (!task.claimable || task.locked) continue;
		try {
			const reward = await core.client.claimTaskReward(credential, task.taskCode);
			if (reward.credit > 0 || reward.energy > 0) {
				claimed += 1;
				credit += reward.credit;
				energy += reward.energy;
				log("info", "task " + account.label + ": " + task.title + " +" + reward.credit + "c +" + reward.energy + "e");
			}
		} catch (error) {
			failed += 1;
			log("warn", "task " + account.label + ": " + task.taskCode + " failed: " + messageOf(error));
		}
	}
	if (claimed === 0 && failed > 0) throw panelError("the task rewards could not be claimed", "UPSTREAM");
	return {
		claimed,
		credit,
		energy
	};
}
/**
* Collect the streak bonus and the task rewards of every domestic account.
*
* Both are idempotent, so a pass that finds nothing to collect costs the reads
* and no mutation, and running it on the daily schedule cannot double-pay. One
* account failing never stops the rest. International accounts have no growth
* centre, so they are skipped without a call.
*/
async function claimAllGrowth() {
	const counts = {
		streak: 0,
		tasks: 0,
		credit: 0,
		failed: 0
	};
	let first = true;
	for (const account of core.pool.list()) {
		if (core.pool.isDisabled(account.id) || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
		if (regionOf(account.credential.domain) !== "cn") continue;
		if (!first) await delay(GROWTH_ACCOUNT_DELAY_MS);
		first = false;
		let collected = false;
		try {
			const streak = await redeemAccountStreak(account);
			counts.streak += streak.claimed;
			counts.credit += streak.credit;
			if (streak.claimed > 0) collected = true;
		} catch (error) {
			counts.failed += 1;
			log("warn", "streak failed for " + account.label + ": " + messageOf(error));
		}
		try {
			const tasks = await claimAccountTasks(account);
			counts.tasks += tasks.claimed;
			counts.credit += tasks.credit;
			if (tasks.claimed > 0) collected = true;
		} catch (error) {
			counts.failed += 1;
			log("warn", "tasks failed for " + account.label + ": " + messageOf(error));
		}
		if (collected) probeCache.delete(account.id);
	}
	return counts;
}
function isAlreadyCheckin(error) {
	const message = messageOf(error);
	return message.includes("已签到") || message.toLowerCase().includes("already");
}
async function claimAllCheckins() {
	const counts = {
		claimed: 0,
		skipped: 0,
		failed: 0
	};
	for (const account of core.pool.list()) {
		if (core.pool.isDisabled(account.id) || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
		try {
			const before = await core.client.fetchCheckinStatus(account.credential);
			if (!before.active) continue;
			if (before.todayCheckedIn) {
				counts.skipped += 1;
				continue;
			}
			await core.client.claimDailyCheckin(account.credential);
			probeCache.delete(account.id);
			counts.claimed += 1;
		} catch (error) {
			if (isAlreadyCheckin(error)) {
				counts.skipped += 1;
				continue;
			}
			counts.failed += 1;
			log("warn", "check-in failed for " + account.label + ": " + messageOf(error));
		}
	}
	return counts;
}
/**
* Today's campaign day (CST), for the adopt-threshold memory. Reuses the
* check-in zone reader: the upstream resets its daily quota at 00:00 CST.
*/
function travelDay() {
	return zonedDayHour(/* @__PURE__ */ new Date()).day;
}
/**
* Adopt the first buddy: report (unlocks the task) -> agree -> first.
*
* The report failure does not block the chain — the upstream answers 200 yet
* silently drops a bad report, so buddy/first stays the real gate. A
* threshold refusal is recorded for the day and retried tomorrow instead of
* hammering the upstream.
*/
async function travelAdopt(account) {
	const day = travelDay();
	if (travelAdoptTried.get(account.id) === day) return "skipped";
	const conversationId = "wb2api-adopt-" + Date.now();
	try {
		await core.client.reportChatActivity(account.credential, conversationId);
	} catch (error) {
		log("warn", "travel " + account.label + ": adopt preflight report: " + messageOf(error));
	}
	await delay(TRAVEL_ADOPT_GAP_MS);
	try {
		await core.client.agreeBuddy(account.credential);
	} catch (error) {
		log("warn", "travel " + account.label + ": agreement: " + messageOf(error));
		return "failed";
	}
	try {
		await core.client.adoptBuddy(account.credential);
	} catch (error) {
		if (isBuddyThresholdIncomplete(messageOf(error))) {
			travelAdoptTried.set(account.id, day);
			log("info", "travel " + account.label + ": adopt skipped (conversation threshold not reached, retry tomorrow)");
			return "skipped";
		}
		log("warn", "travel " + account.label + ": adopt: " + messageOf(error));
		return "failed";
	}
	log("info", "travel " + account.label + ": adopt ok (+300 credits)");
	return "adopted";
}
/**
* One account, one trip: at most one mutating call, no polling, no waiting.
*
* Returns what happened so the caller can count it; every failure path logs
* and returns instead of throwing, so one bad account never stops the rest.
*/
async function travelOne(account) {
	let buddy = null;
	try {
		buddy = await core.client.fetchBuddyInfo(account.credential);
	} catch (error) {
		log("warn", "travel " + account.label + ": buddy-info: " + messageOf(error));
		return "failed";
	}
	if (buddy === null) return await travelAdopt(account);
	let status = null;
	try {
		status = await core.client.fetchTravelStatus(account.credential);
	} catch (error) {
		log("warn", "travel " + account.label + ": status: " + messageOf(error));
		return "failed";
	}
	if (status.state === "arrived") {
		if (status.recordId === 0) {
			log("info", "travel " + account.label + ": claim skipped (arrived but no record_id)");
			return "skipped";
		}
		try {
			const reward = await core.client.claimTravelReward(account.credential, status.recordId);
			log("info", "travel " + account.label + ": claim ok record=" + status.recordId + " reward=" + reward);
			return "claimed";
		} catch (error) {
			log("warn", "travel " + account.label + ": claim record=" + status.recordId + ": " + messageOf(error));
			return "failed";
		}
	}
	if (status.state === "idle") {
		if (status.dailyLimitReached) {
			log("info", "travel " + account.label + ": skip (daily limit reached)");
			return "skipped";
		}
		try {
			await core.client.departTravel(account.credential, 4);
			log("info", "travel " + account.label + ": depart ok location=4");
			return "departed";
		} catch (error) {
			log("warn", "travel " + account.label + ": depart: " + messageOf(error));
			return "failed";
		}
	}
	if (status.state === "traveling") {
		log("info", "travel " + account.label + ": skip (traveling record=" + status.recordId + ")");
		return "skipped";
	}
	log("info", "travel " + account.label + ": skip (unknown state " + JSON.stringify(status.state) + ")");
	return "skipped";
}
/**
* Walk every eligible account once. Disabled / removed accounts stay out
* (removal is already filtered by `list()`); international accounts have no
* CN task system upstream, so they are skipped without a single call.
*/
async function travelAllAccounts() {
	const counts = {
		departed: 0,
		claimed: 0,
		adopted: 0
	};
	let first = true;
	for (const account of core.pool.list()) {
		if (core.pool.isDisabled(account.id) || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
		if (regionOf(account.credential.domain) !== "cn") continue;
		if (!account.credential.refreshToken) continue;
		if (!first) await delay(TRAVEL_ACCOUNT_DELAY_MS);
		first = false;
		try {
			const outcome = await travelOne(account);
			if (outcome === "departed" || outcome === "claimed" || outcome === "adopted") {
				counts[outcome === "departed" ? "departed" : outcome === "claimed" ? "claimed" : "adopted"] += 1;
				probeCache.delete(account.id);
			}
		} catch (error) {
			log("warn", "travel failed for " + account.label + ": " + messageOf(error));
		}
	}
	return counts;
}
/**
* Claim today's Qoder round for every signed-in Qoder account whose region is
* switched on. Each account is read first: one that already collected, or that
* has no claimable round (international without the app's machine identity),
* costs one GET and no mutation. One account failing never stops the rest.
*/
async function qoderCheckinAll() {
	const counts = {
		claimed: 0,
		skipped: 0,
		failed: 0
	};
	const regions = activeQoderRegions();
	if (regions.length === 0) return counts;
	const found = await discoverQoderCredentials();
	let first = true;
	for (const credential of found.credentials) {
		if (!regions.includes(credential.region)) continue;
		if (!first) await delay(QODER_ACCOUNT_DELAY_MS);
		first = false;
		const result = await qoderClaimFor(credential);
		counts[result.outcome] += 1;
		if (result.opensAt !== void 0 && (counts.opensAt === void 0 || result.opensAt < counts.opensAt)) counts.opensAt = result.opensAt;
	}
	return counts;
}
/**
* One Qoder account's daily round: `{outcome, reason?}`.
*
* The campaigns read comes first, so an account with nothing claimable (or one
* that already collected) costs a single GET and no mutation.
*/
async function qoderClaimFor(credential) {
	const client = new QoderUpstreamClient({
		region: credential.region,
		credential: async () => qoderClientCredential(credential)
	});
	try {
		const campaigns = await client.fetchCampaigns();
		const id = qoderClaimableCampaignIdOf(campaigns);
		if (id === void 0) {
			const state = qoderCheckinStateFrom(campaigns);
			return {
				outcome: "skipped",
				...state.opensAt === void 0 ? {} : { opensAt: state.opensAt }
			};
		}
		const result = qoderNormalizeClaimResult(await client.claimCampaign(id));
		return { outcome: result.claimed && !result.replayed ? "claimed" : "skipped" };
	} catch (error) {
		const reason = safeMessage(error);
		log("warn", "[qoder:" + credential.region + "] check-in failed for " + qoderRowLabel(credential) + ": " + reason);
		return {
			outcome: "failed",
			reason
		};
	}
}
/**
* Claim today's Trae credits for every signed-in CN Trae account. Each account
* is read first: one already checked in costs a single status call and no
* mutation. International accounts have no check-in and are never contacted.
* An expired token is skipped (the desktop app refreshes it while it runs).
* Accounts are spaced 5 s ± 2 s apart, the pace the endpoint is proven with.
*/
async function traeCheckinAll() {
	const counts = {
		claimed: 0,
		skipped: 0,
		failed: 0
	};
	if (!activeTraeRegions().includes("cn")) return counts;
	const desktopCandidates = traeStorageCandidates().filter((entry) => entry.source === "desktop");
	const cnCredentials = (await discoverTraeCredentials()).credentials.filter((credential) => traeRegionOfCredential(credential) === "cn");
	let index = 0;
	for (; index < cnCredentials.length; index += 1) {
		if (index > 0) await delay(Math.max(1e3, TRAE_ACCOUNT_DELAY_MS + Math.round((Math.random() * 2 - 1) * TRAE_ACCOUNT_JITTER_MS)));
		const result = await traeClaimFor(cnCredentials[index], desktopCandidates);
		counts[result.outcome] += 1;
		if (result.deviceCheckedIn === true) {
			counts.skipped += cnCredentials.length - index - 1;
			break;
		}
	}
	return counts;
}
/**
* One Trae account's daily credits: `{outcome, reason?}`.
*
* The status read comes first, so an account that already checked in costs one
* GET and no mutation. An expired token never reaches the network (the desktop
* app refreshes it while it runs); international accounts have no check-in and
* are filtered out by the caller.
*/
async function traeClaimFor(credential, desktopCandidates) {
	const label = traeRowLabel(credential);
	if (sourceCredentialExpired(credential, Date.now())) {
		const reason = "token expired (open Trae to refresh it)";
		log("warn", "[trae:cn] check-in skipped for " + label + ": token expired (open Trae to refresh it)");
		return {
			outcome: "skipped",
			reason
		};
	}
	const client = new TraeSoloUpstreamClient({
		credential: async () => credential,
		identity: () => resolveTraeIdentity(desktopCandidates, credential.edition)
	});
	try {
		const status = await client.fetchCheckinStatus();
		if (status.code === 0 && status.enable !== true) return { outcome: "skipped" };
		if (status.code === 0 && status.checkedIn) return { outcome: "skipped" };
		if (status.code === 0 && status.didCheckedIn) return {
			outcome: "skipped",
			deviceCheckedIn: true
		};
		const claim = status.code === 0 ? await client.claimCheckin() : status;
		if (claim.code === 0) return { outcome: "claimed" };
		if (claim.code === 9095) {
			log("info", "[trae:cn] check-in already used by this device for " + label + ": " + (claim.message ?? ""));
			return {
				outcome: "skipped",
				deviceCheckedIn: true
			};
		}
		const reason = "code " + claim.code + (claim.message === void 0 ? "" : " " + safeMessage(claim.message));
		log("warn", "[trae:cn] check-in refused for " + label + ": " + reason);
		return {
			outcome: "failed",
			reason
		};
	} catch (error) {
		const reason = safeMessage(error);
		log("warn", "[trae:cn] check-in failed for " + label + ": " + reason);
		return {
			outcome: "failed",
			reason
		};
	}
}
/** The one Trae account a panel row names, or a refusal that says why. */
async function traeClaimOne(label, region) {
	if (region !== "cn") throw panelError("Trae check-in is CN-only", "INVALID");
	const credential = (await discoverTraeCredentials()).credentials.find((entry) => traeRowLabel(entry) === label && traeRegionOfCredential(entry) === region);
	if (credential === void 0) throw panelError("unknown Trae account: " + label, "NOT_FOUND");
	const result = await traeClaimFor(credential, traeStorageCandidates().filter((entry) => entry.source === "desktop"));
	if (result.outcome === "failed") throw panelError(result.reason ?? "Trae refused the check-in", "UPSTREAM");
	return result;
}
/** The one Qoder account a panel row names, or a refusal that says why. */
async function qoderClaimOne(label, region) {
	const credential = (await discoverQoderCredentials()).credentials.find((entry) => qoderRowLabel(entry) === label && entry.region === region);
	if (credential === void 0) throw panelError("unknown Qoder account: " + label, "NOT_FOUND");
	const result = await qoderClaimFor(credential);
	if (result.outcome === "failed") throw panelError(result.reason ?? "Qoder refused the claim", "UPSTREAM");
	return result;
}
/**
* One look at the schedule: collect the daily reward when a slot is due.
*
* The slot is recorded BEFORE the claim, so a failed pass is not retried all
* day — the upstream is down or the account is rate-limited, and hammering it
* would only add noise. Tomorrow's slot is a fresh chance either way.
*/
async function autoCheckinTick(now) {
	if (!autoCheckinEnabled()) return void 0;
	const when = now === void 0 ? /* @__PURE__ */ new Date() : now;
	if (qoderRetryAt !== 0 && when.getTime() >= qoderRetryAt && activeQoderRegions().length > 0) {
		if (checkinPassRunning) {
			log("info", "deferred Qoder check-in deferred: a pass is already running");
			return autoCheckinLast;
		}
		const retryGeneration = loadGeneration;
		checkinPassRunning = true;
		try {
			qoderRetryAt = 0;
			const retry = await qoderCheckinAll();
			qoderRetryAt = typeof retry.opensAt === "number" && retry.opensAt > Date.now() ? retry.opensAt : 0;
			autoCheckinLast = {
				...autoCheckinLast,
				qoder: retry,
				at: (/* @__PURE__ */ new Date()).toISOString()
			};
			log("info", "deferred Qoder check-in: " + JSON.stringify(retry));
		} finally {
			if (stillLoaded(retryGeneration)) checkinPassRunning = false;
		}
		scheduleRefresh("auto-checkin");
		return autoCheckinLast;
	}
	if (activeRegions().length === 0 && activeQoderRegions().length === 0 && activeTraeRegions().length === 0) return void 0;
	const slot = dueCheckinSlot(when, checkinHours(), autoCheckinSlots);
	if (slot === void 0) return void 0;
	if (checkinPassRunning) {
		log("info", "scheduled check-in deferred: a pass is already running");
		return autoCheckinLast;
	}
	return await runCheckinPass({ slot });
}
function startAutoCheckin() {
	if (autoCheckinTimer !== null) return;
	autoCheckinTimer = setInterval(() => {
		autoCheckinTick().catch((error) => log("warn", "scheduled check-in failed: " + messageOf(error)));
	}, CHECKIN_POLL_MS);
	if (typeof autoCheckinTimer.unref === "function") autoCheckinTimer.unref();
}
function stopAutoCheckin() {
	if (autoCheckinTimer === null) return;
	clearInterval(autoCheckinTimer);
	autoCheckinTimer = null;
}
/** Follow the switch: one timer exists exactly while automatic check-in is on. */
function applyAutoCheckin() {
	if (autoCheckinEnabled()) startAutoCheckin();
	else stopAutoCheckin();
}
/**
* Bring the declaration up to date BEFORE the host can act on it.
*
* Registration is a runtime call and the host serves whatever the last
* registration said, so publishing at the earliest point the plugin runs means
* the routes exist before anything can route to them, and the panel says so
* when the declaration could not be registered.
*
* Note this is the only place the roster is fetched during load: opening the
* panel no longer triggers detection of its own.
*/
async function publishDeclarationEarly() {
	await adoptHostSettings();
	if (settings.enabled === false) return;
	applySettingsToCore();
	reconcileRuntimes();
	const bootstrapDeadline = Date.now() + LOAD_BOOTSTRAP_BUDGET_MS;
	const bootstrapLeft = () => Math.max(0, bootstrapDeadline - Date.now());
	await settleWithin(reconcileTraeGateways(), bootstrapLeft());
	await settleWithin(reconcileQoderGateways(), bootstrapLeft());
	if (activeRegions().length > 0) await settleWithin(core.pool.scan(), bootstrapLeft());
	await settleWithin(startRuntimes(), bootstrapLeft());
	await settleWithin(Promise.all(Array.from(runtimes.values()).map(async (runtime) => {
		try {
			await connect(runtime, true);
		} catch (error) {
			runtime.lastError = safeMessage(error);
			log("warn", runtime.region + " failed to start during load: " + runtime.lastError);
		}
	})), LOAD_ROSTER_BUDGET_MS);
	const written = syncDeclaration();
	if (written.ok !== true) log("warn", "declaration not written: " + String(written.error));
	else if (written.changed === true) log("info", "declaration updated at load time; " + written.providerCount + " provider(s)");
}
async function onServiceStart() {
	serviceStopped = false;
	if (warmAbort.signal.aborted) warmAbort = new AbortController();
	await adoptHostSettings();
	if (settings.enabled === false) {
		log("info", "plugin disabled in settings; the provider host stays down");
		return;
	}
	applySettingsToCore();
	reconcileRuntimes();
	const bootstrapDeadline = Date.now() + SERVICE_BOOTSTRAP_BUDGET_MS;
	const bootstrapLeft = () => Math.max(0, bootstrapDeadline - Date.now());
	await settleWithin(reconcileTraeGateways(), bootstrapLeft());
	await settleWithin(reconcileQoderGateways(), bootstrapLeft());
	await settleWithin(startRuntimes(), bootstrapLeft());
	await settleWithin(Promise.all(Array.from(runtimes.values()).map(async (runtime) => {
		try {
			await connect(runtime, !catalogFresh(runtime));
		} catch (error) {
			runtime.lastError = safeMessage(error);
			log("warn", runtime.region + " failed to start: " + runtime.lastError);
		}
	})), SERVICE_ROSTER_BUDGET_MS);
	syncDeclaration();
	scheduleRefresh("service-start");
}
async function onServiceStop() {
	serviceStopped = true;
	loadGeneration += 1;
	if (refreshTimer !== null) {
		clearTimeout(refreshTimer);
		refreshTimer = null;
	}
	stopAutoCheckin();
	abortWarmups();
	const closing = Array.from(runtimes.values()).map(stopRuntime);
	runtimes.clear();
	for (const entry of [...traeGateways.values(), ...qoderGateways.values()]) closing.push(entry.gateway.close().catch((error) => {
		log("warn", "[" + entry.source + ":" + entry.region + "] gateway did not close cleanly: " + messageOf(error));
	}));
	traeGateways.clear();
	qoderGateways.clear();
	await Promise.all(closing);
}
async function onLoad() {
	serviceStopped = false;
	loadGeneration += 1;
	warmAbort = new AbortController();
	checkinPassRunning = false;
	autoCheckinSlots.clear();
	autoCheckinLast = null;
	qoderRetryAt = 0;
	core.client = new WorkBuddyUpstreamClient();
	core.pool = new WorkBuddyAccountPool({
		client: core.client,
		cooldownMs: cooldownMs(),
		distribution: distributionSetting(),
		logger: {
			info: (...args) => log("info", gatewayLogLine("", args)),
			warn: (...args) => log("warn", gatewayLogLine("", args)),
			error: (...args) => log("error", gatewayLogLine("", args))
		}
	});
	await adoptHostSettings();
	declarationIndex = /* @__PURE__ */ new Map();
	publishedIds = /* @__PURE__ */ new Set();
	try {
		dataPath = await pi.plugin.getDataPath();
	} catch (error) {
		dataPath = "";
		log("warn", "no plugin data path: " + messageOf(error));
	}
	await registerCommands();
	pi.services.register({
		id: SERVICE_ID,
		start: onServiceStart,
		stop: onServiceStop
	});
	subscribeToHostSettings();
	await publishDeclarationEarly();
}
async function onUnload() {
	loadGeneration += 1;
	if (refreshTimer !== null) {
		clearTimeout(refreshTimer);
		refreshTimer = null;
	}
	stopAutoCheckin();
	abortWarmups();
	await onServiceStop();
	probeCache.clear();
	try {
		if (pi.events && typeof pi.events.off === "function" && settingsChangedHandler !== null) pi.events.off("plugin:settingsChanged", settingsChangedHandler);
	} catch (error) {
		log("warn", "could not unsubscribe from settings changes: " + messageOf(error));
	}
	settingsChangedHandler = null;
	try {
		await pi.commands.unregister(COMMAND_OPEN);
		await pi.commands.unregister(COMMAND_RESCAN);
		await pi.commands.unregister(COMMAND_RESET);
		await pi.commands.unregister(COMMAND_DOCTOR);
		await pi.commands.unregister(COMMAND_CHECKIN);
	} catch (error) {
		log("warn", "unregistering commands failed: " + messageOf(error));
	}
}
function composerPointsEnabled() {
	return settings.showComposerPoints === true;
}
/**
* The source and region one selected provider route belongs to.
*
* The composer readout is handed the session's selection straight from the
* host's `modelSelection` projection, which carries the provider route id and
* the model id and nothing else - no display name. So the route id is what
* identifies the source: it is the id this plugin registered the provider under,
* and the two cannot drift apart the way a printed label can. A route that is
* not one of ours resolves to nothing and the readout stays hidden.
*/
function composerRoute(provider) {
	const wanted = typeof provider === "string" ? provider.trim() : "";
	if (wanted === "") return void 0;
	for (const region of activeRegions()) if (PROVIDER_ID_BY_REGION[region] === wanted) return {
		source: "workbuddy",
		region
	};
	for (const region of activeTraeRegions()) if (TRAE_PROVIDER_ID_BY_REGION[region] === wanted) return {
		source: "trae",
		region
	};
	for (const region of activeQoderRegions()) if (QODER_PROVIDER_ID_BY_REGION[region] === wanted) return {
		source: "qoder",
		region
	};
}
/**
* The row one selected model belongs to.
*
* The model id has to be one this plugin actually publishes for that route: the
* picker keeps offering a model the user has disabled until its discovery cache
* expires, and reporting an account balance against a model this pool does not
* serve would be a number with nothing behind it.
*/
function matchComposerModel(args) {
	const route = composerRoute(args?.provider);
	if (route === void 0) return void 0;
	const wanted = typeof args?.model === "string" ? args.model.trim() : "";
	if (wanted === "") return void 0;
	if ((route.source === "workbuddy" ? declarationModels(route.region) : route.source === "trae" ? traeDeclarationModels(route.region) : qoderDeclarationModels(route.region)).find((model) => String(model.id || "").trim() === wanted) === void 0) return void 0;
	return {
		source: route.source,
		region: route.region,
		id: wanted
	};
}
function workbuddyComposerAccounts(region, modelId) {
	const now = Date.now();
	const list = core.pool.list(region);
	const available = core.pool.available(now, modelId, region);
	const preferredId = preferredAccountId(region);
	const preferred = available.find((account) => account.id === preferredId);
	const namesNext = distributionSetting() === "priority" || distributionSetting() === "expiry";
	const next = preferred ?? (namesNext ? core.pool.preview(available) : void 0);
	return list.map((account) => {
		const cached = probeCache.get(account.id)?.value?.credits;
		return {
			id: account.id,
			label: account.label,
			active: next !== void 0 && next.id === account.id,
			...typeof cached?.total === "number" ? { total: cached.total } : {},
			...Array.isArray(cached?.packages) && cached.packages.length > 0 ? { packages: cached.packages } : {}
		};
	});
}
function sourceComposerAccounts(source, region) {
	const rows = (source === "trae" ? traeAccountRows : qoderAccountRows).filter((row) => row.region === region);
	const live = rows.filter((row) => row.expired !== true);
	const preferred = preferredSourceAccount(source, region);
	let active = preferred === "" ? void 0 : live.find((row) => row.label === preferred);
	if (active === void 0) {
		const mode = sourceDistribution(source);
		if (mode === "expiry") {
			const now = Date.now();
			active = live.slice().sort((left, right) => packUrgency(source, left.label, now) - packUrgency(source, right.label, now))[0];
		} else if (mode !== "round-robin") active = live[0];
	}
	return rows.map((row) => {
		const credits = row.usage?.credits;
		return {
			id: row.label,
			label: row.label,
			active: active !== void 0 && active.label === row.label,
			...typeof credits?.total === "number" ? { total: credits.total } : {},
			...Array.isArray(credits?.packages) && credits.packages.length > 0 ? { packages: credits.packages } : {},
			...row.usage?.plan?.name ? { plan: row.usage.plan.name } : {}
		};
	});
}
/**
* Cached credits for the model the composer is showing.
*
* The answer itself is cache-only, so a poll is cheap. One exception: a stale
* WorkBuddy probe schedules the background refresh that fills the cache, so
* the first poll after a load may be what starts the read the later polls
* answer from.
*
* `ours` separates the two reasons there is nothing to show: the selected route
* is not this plugin's (nothing will ever arrive, so there is nothing to wait
* for) from the route being ours while a runtime has not declared its roster
* yet - the balance is still coming. The readout cannot tell them apart from
* `show` alone, so it is told here rather than left to infer it.
*/
function composerPoints(args) {
	if (!composerPointsEnabled()) return {
		show: false,
		ours: false
	};
	const hit = matchComposerModel(args);
	if (hit === void 0) return {
		show: false,
		ours: composerRoute(args?.provider) !== void 0
	};
	if (hit.source === "workbuddy" && probesStale()) scheduleRefresh("composer");
	const accounts = hit.source === "workbuddy" ? workbuddyComposerAccounts(hit.region, hit.id) : sourceComposerAccounts(hit.source, hit.region);
	const active = accounts.find((account) => account.active === true);
	return {
		show: true,
		ours: true,
		source: hit.source,
		region: hit.region,
		label: active?.label || "",
		total: typeof active?.total === "number" ? active.total : null,
		accounts
	};
}
async function composerPrefer(args) {
	const source = args?.source;
	const region = args?.region;
	const hit = matchComposerModel(args);
	if (hit === void 0 || hit.source !== source || hit.region !== region) return { show: false };
	if (source === "workbuddy") {
		const accountId = typeof args?.accountId === "string" ? args.accountId : "";
		if (!REGIONS.includes(region)) return { show: false };
		if (accountId !== "" && !core.pool.list(region).some((account) => account.id === accountId)) return { show: false };
		const preferredAccountIds = {};
		for (const key of REGIONS) {
			const current = preferredAccountId(key);
			if (current !== void 0) preferredAccountIds[key] = current;
		}
		if (accountId === "") delete preferredAccountIds[region];
		else preferredAccountIds[region] = accountId;
		if (await saveSettings({ preferredAccountIds }) !== true) throw panelError("the account choice could not be saved", "SAVE_FAILED");
		core.pool.prefer(accountId || void 0, region);
		const servable = accountId === "" || core.pool.available(Date.now(), hit.id, region).some((account) => account.id === accountId);
		return {
			...composerPoints(args),
			saved: true,
			...servable ? {} : { unavailable: true }
		};
	}
	if (source !== "trae" && source !== "qoder") return { show: false };
	if (!(source === "trae" ? TRAE_REGIONS : QODER_REGIONS).includes(region)) return { show: false };
	const accountLabel = typeof args?.accountLabel === "string" ? args.accountLabel : "";
	if (!sourceAccountMayBePreferred(source, region, accountLabel)) return { show: false };
	const next = { ...settings.preferredSourceAccounts ?? {} };
	if (accountLabel === "") delete next[sourceRegionKey(source, region)];
	else next[sourceRegionKey(source, region)] = accountLabel;
	if (await saveSettings({ preferredSourceAccounts: next }) !== true) throw panelError("the account choice could not be saved", "SAVE_FAILED");
	return {
		...composerPoints(args),
		saved: true
	};
}
//#endregion
//#region src/index.ts
/**
* dsh-wtq-pool — the DeepSeek Harness entry.
*
* This file owns everything host-specific: the Cordis activation, the settings
* schema, the six provider registrations and the routes that carry the panel.
* The pool itself lives in `host.ts`, and `pi-compat.ts` bridges it to the
* services below.
*
* @module dsh-wtq-pool
*/
/** The Cordis row id; also the settings namespace this plugin is served under. */
const name = ROW_ID;
/**
* `settings` is declared so the host renders this plugin's own section instead
* of reading `undefined` while it builds the provider list; `llm` is the seam
* the six providers register into.
*/
const inject = ["llm", "settings"];
/** Settings namespace, used when the running loader entry id cannot be read. */
const FALLBACK_SETTINGS_NS = ROW_ID;
/** This package's own root, derived from the compiled entry's location. */
const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Idle ceiling while one upstream stream read is outstanding. */
const STREAM_IDLE_TIMEOUT_MS = 3e5;
/** Image-request budgets at the dsh-llm-pi-ai defaults. */
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/** Levels the picker accepts, in the order it shows them. */
const THINKING_LEVELS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/**
* Inert pi-ai auth plane.
*
* The loopback endpoints authenticate nothing: their guard is the 127.0.0.1
* bind plus the Host/Origin check, and their own `bearerAccepted` only requires
* the Authorization header to have a bearer *shape*. A pi-ai credential
* lifecycle here would therefore invent a secret nothing verifies.
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-wtq-pool: this route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** The sentinel every loopback gateway accepts. */
const LOOPBACK_BEARER = "dsh-wtq-pool-loopback";
/**
* Wrap one schema in `volatile()` when the installed schemastery has it.
*
* `volatile()` landed in schemastery 3.18.3. Hand-writing `meta.volatile` on an
* older copy would bypass the host's own `validateVolatileSchema`, so an older
* builder degrades to the plain schema instead.
*/
function asVolatile(schema) {
	const candidate = schema;
	return typeof candidate.volatile === "function" ? candidate.volatile() : schema;
}
const Config = z.object({
	enabled: asVolatile(z.boolean().default(true).description("Serve this pool at all")),
	sourceWorkbuddy: asVolatile(z.boolean().default(true).description("Merge the WorkBuddy desktop sign-ins")),
	sourceTrae: asVolatile(z.boolean().default(true).description("Merge the Trae desktop sign-ins")),
	sourceQoder: asVolatile(z.boolean().default(true).description("Merge the Qoder desktop sign-ins")),
	authFile: asVolatile(z.string().description("WorkBuddy desktop auth file (defaults to the app own location)")),
	autoCheckin: asVolatile(z.object({
		enabled: z.boolean().default(false),
		hours: z.array(z.number()).default([])
	}).description("Daily check-in across every discovered sign-in")),
	cooldownSeconds: asVolatile(z.number().default(60).description("Rate-limit cooldown per account, in seconds")),
	creditReserves: asVolatile(z.dict(z.number()).default({}).description("Per-account credit floor, keyed by account id")),
	disabledAccountIds: asVolatile(z.array(z.string()).default([]).description("Account ids the pool must never pick")),
	disabledRegions: asVolatile(z.array(z.string()).default([]).description("Regions parked on their own, as source:region")),
	distribution: asVolatile(z.union([
		"priority",
		"round-robin",
		"expiry",
		"sticky"
	]).default("priority").description("How the WorkBuddy pool spreads requests")),
	modelSelection: asVolatile(z.any().description("Per-gateway model selection")),
	preferredAccountIds: asVolatile(z.any().description("Picked WorkBuddy account per region")),
	preferredSourceAccounts: asVolatile(z.any().description("Picked Trae/Qoder account per region")),
	removedAccounts: asVolatile(z.any().description("Accounts removed from the pool for good")),
	showComposerPoints: asVolatile(z.boolean().default(false).description("Show the active account credits beside the composer")),
	sourceDistributions: asVolatile(z.any().description("How each Trae/Qoder region spreads requests"))
});
/** Peel one volatile reference, if the running line wrapped it. */
function unwrapVolatile(value) {
	if (value !== null && typeof value === "object" && typeof value.get === "function") return value.get();
	return value;
}
/**
* Peel volatile references all the way down.
*
* The settings document is validated and cloned whole, so a surviving `{get}`
* wrapper fails validation with `expected string but got [object Object]` and
* the section then never renders.
*/
function unwrapVolatileDeep(value) {
	const peeled = unwrapVolatile(value);
	if (Array.isArray(peeled)) return peeled.map((entry) => unwrapVolatileDeep(entry));
	if (peeled !== null && typeof peeled === "object") {
		const out = {};
		for (const [key, entry] of Object.entries(peeled)) out[key] = unwrapVolatileDeep(entry);
		return out;
	}
	return peeled;
}
/** The namespace the host actually serves this plugin's settings under. */
function settingsNamespaceOf(ctx) {
	try {
		const id = ctx.fiber?.entry?.options?.id;
		if (typeof id === "string" && id !== "") return id;
		const canonical = ctx.fiber?.entry?.id;
		if (typeof canonical === "string" && canonical !== "") return canonical;
	} catch {}
	return FALLBACK_SETTINGS_NS;
}
/** The harness data root: an explicit override, then `$DSH_HOME`, then `~/.dsh`. */
function dshHome() {
	const override = String(process.env["DSH_HOME"] ?? "").trim();
	return override === "" ? path.join(os.homedir(), ".dsh") : override;
}
/** One pi-ai model descriptor pointing at a loopback gateway. */
function toPiModel(row, baseUrl, providerId) {
	const declared = row.thinkingLevels ?? [];
	const advertised = declared.filter((level) => THINKING_LEVELS.includes(level));
	const map = advertised.length === 0 ? void 0 : (() => {
		const out = {};
		for (const level of THINKING_LEVELS) out[level] = advertised.includes(level) ? level : null;
		if (!declared.includes("off")) out["off"] = null;
		return out;
	})();
	return {
		id: row.id,
		name: typeof row.name === "string" && row.name.trim() !== "" ? row.name.trim() : row.id,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: row.supportsImages === true ? ["text", "image"] : ["text"],
		cost: NO_COST,
		contextWindow: typeof row.contextWindow === "number" ? row.contextWindow : 128e3,
		maxTokens: typeof row.maxTokens === "number" ? row.maxTokens : 32e3,
		reasoning: map !== void 0,
		...map === void 0 ? {} : { thinkingLevelMap: map },
		compat: { supportsReasoningEffort: map !== void 0 }
	};
}
/**
* Whether the resolved pi-ai carries the prompt inside the transcript.
*
* The host folds `Context.systemPrompt` and `Context.tools` into a leading
* `role:"system"` message before a provider sees a request, and only a
* generation that exports `normalizeContext` reads that message back. Which
* generation this plugin gets is not its own call: the harness resolves
* `@earendil-works/pi-ai` through the profile's hoisted linker, so a profile
* that hoists an older generation hands this provider a transcript its own copy
* of pi-ai never learned to read.
*/
const PI_AI_FOLDS_TRANSCRIPT = typeof piAi.normalizeContext === "function";
/** The complete prompt of a leading system message: its text, then its sections. */
function promptText(message) {
	const parts = [piAi.contentText(message.content)];
	for (const value of Object.values(message.sections ?? {})) if (typeof value === "string") parts.push(value);
	return parts.filter((part) => part.length > 0).join("\n\n");
}
/**
* Re-shape one request context into the form the delegate's own generation reads.
*
* A generation without `normalizeContext` has no `role:"system"` handling in
* either its request converter or its context estimator, so the transcript the
* host folds either throws there (with string content) or drops the prompt and
* every tool without a word (with block content). Unfolding restores the
* `{systemPrompt, tools, messages}` form that generation was written against,
* which is exactly what the fold undoes. On a generation that does fold, the
* host's transcript is already the expected shape and passes through untouched.
*/
function contextForDelegate(context) {
	if (PI_AI_FOLDS_TRANSCRIPT) return context;
	const messages = context.messages;
	if (!Array.isArray(messages)) return context;
	const leading = messages[0];
	if (leading?.role !== "system") return context;
	const prompt = promptText(leading);
	const tools = Array.isArray(leading.toolsAdded) ? leading.toolsAdded : void 0;
	return {
		...prompt.length > 0 ? { systemPrompt: prompt } : {},
		...tools === void 0 ? {} : { tools },
		messages: messages.slice(1)
	};
}
/** Wrap one API implementation so every request arrives in the shape it reads. */
function withDelegateShape(api) {
	return {
		...api,
		stream: (model, context, options) => api.stream(model, contextForDelegate(context), options),
		streamSimple: (model, context, options) => api.streamSimple(model, contextForDelegate(context), options)
	};
}
/**
* Build one pi-ai provider per declared row, all served by ONE adapter.
*
* `registerAdapter` maps a *set* of providers onto one adapter, so registering
* each row in its own call would leave only the last one owned. One adapter
* holding one profile per row is what keeps all six alive at once.
*/
function buildAdapter(descriptors, ctx) {
	const profiles = /* @__PURE__ */ new Map();
	const providerIds = [];
	for (const row of descriptors) {
		providerIds.push(row.id);
		const models = row.models.map((model) => toPiModel(model, row.baseUrl, row.id));
		const provider = {
			...createProvider({
				id: row.id,
				name: row.name,
				auth: { apiKey: {
					name: "dsh-wtq-pool loopback endpoint",
					async resolve({ credential }) {
						const apiKey = credential?.key;
						return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
							auth: { apiKey },
							source: row.name
						};
					}
				} },
				models,
				api: withDelegateShape(openAICompletionsApi())
			}),
			getModels: () => models
		};
		profiles.set(row.id, {
			provider: row.id,
			displayName: row.name,
			streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
			retryPolicy: resolveRetryPolicy(void 0, `dsh-wtq-pool.${row.id}.retryPolicy`),
			configuredMaxTokens: /* @__PURE__ */ new Map(),
			modelErrors: /* @__PURE__ */ new Map(),
			...REQUEST_IMAGE_BUDGETS,
			piProvider: provider
		});
	}
	const attachments = ctx.get("attachments");
	const adapter = new PiAiAdapter({
		profiles: () => profiles,
		auth: INERT_AUTH,
		resolveApiKey: async () => LOOPBACK_BEARER,
		resolveAttachments: () => attachments,
		resolveImageAccess: (store, ref) => resolveImageAttachmentAccess(store, (hostPath) => {
			return ctx.get("fs")?.processPathFromHostPath?.(hostPath);
		}, ref)
	});
	const defaults = new Map(descriptors.map((row) => [row.id, new Map(row.models.filter((model) => model.defaultThinkingLevel !== void 0 && model.thinkingLevels?.includes(model.defaultThinkingLevel)).map((model) => [model.id, model.defaultThinkingLevel]))]));
	const withOptionsDefault = (options) => {
		const effort = options.reasoningEffort ?? defaults.get(options.provider)?.get(options.model);
		return effort === void 0 ? options : {
			...options,
			reasoningEffort: effort
		};
	};
	const withModelDefault = (model) => {
		const effort = defaults.get(model.provider)?.get(model.id);
		return effort === void 0 || model.reasoning === void 0 ? model : {
			...model,
			reasoning: {
				...model.reasoning,
				defaultEffort: effort
			}
		};
	};
	const resolveModel = adapter.resolveModel.bind(adapter);
	const prepareCall = adapter.prepareCall.bind(adapter);
	const stream = adapter.stream.bind(adapter);
	adapter.resolveModel = async (...args) => withModelDefault(await resolveModel(...args));
	adapter.prepareCall = async (...args) => {
		const call = await prepareCall(...args);
		return {
			model: withModelDefault(call.model),
			stream: (options) => call.stream(withOptionsDefault(options))
		};
	};
	adapter.stream = (options) => stream(withOptionsDefault(options));
	return {
		adapter,
		profiles,
		providerIds
	};
}
/** A stable rendering of what a registration would serve, to skip no-op writes. */
function registrationFingerprint(descriptors) {
	return JSON.stringify(descriptors.map((row) => ({
		id: row.id,
		name: row.name,
		baseUrl: row.baseUrl,
		models: row.models.map((model) => [
			model.id,
			model.name,
			model.contextWindow,
			model.maxTokens,
			model.supportsImages === true,
			model.thinkingLevels ?? [],
			model.defaultThinkingLevel
		])
	})));
}
/**
* Activate the plugin.
*
* Order matters: the core's `onLoad` builds the pool and the account client,
* its registered background service brings the gateways up, and the declaration
* pass that follows is what hands the six rows to {@link LlmSeam}.
*/
function apply(ctx, config = {}) {
	const current = () => unwrapVolatileDeep(config);
	const settingsNamespace = settingsNamespaceOf(ctx);
	const notes = [];
	const commands = /* @__PURE__ */ new Map();
	const unsubscribes = [];
	let lastRows = [];
	let fingerprint = "";
	let disposeRegistration;
	let stopped = false;
	const settingsService = ctx.settings;
	/**
	* How many of this plugin's own settings writes are in flight.
	*
	* DSH answers a plugin's volatile write by emitting `loader/volatile-update`
	* back at the writer's own fiber, and the loader delivers it synchronously
	* inside `mutate`. So a save this plugin made arrives here looking exactly
	* like an edit from the host's settings UI, and treating it as one cleared the
	* whole credit cache: every account switch blanked the readout to `—` until a
	* warm-up poll refilled it. PI's host never echoes a plugin's own write, which
	* is why only this build showed it. The writer is the one place that can tell
	* the two apart, so the echo is dropped here instead of guessed at downstream.
	*/
	let writesInFlight = 0;
	/** Replace patched top-level fields without merging their dictionaries. */
	const writeSettings = async (patch) => {
		const mutate = settingsService?.mutate;
		if (mutate === void 0) throw new Error("this host exposes no settings mutate()");
		writesInFlight += 1;
		try {
			await mutate.call(settingsService, settingsNamespace, Object.entries(patch).map(([key, value]) => ({
				op: "set",
				path: [key],
				value
			})));
		} finally {
			writesInFlight -= 1;
		}
	};
	installPi({
		getSettings: () => current(),
		setSettings: writeSettings,
		getDataPath: async () => {
			const dir = path.join(dshHome(), "dsh-wtq-pool");
			await fs.mkdir(dir, { recursive: true });
			return dir;
		},
		onSettingsChanged: (handler) => {
			const listener = () => {
				if (writesInFlight > 0) return;
				handler(current());
			};
			const dispose = ctx.on("loader/volatile-update", listener);
			if (typeof dispose === "function") unsubscribes.push(dispose);
			else unsubscribes.push(() => ctx.off?.("loader/volatile-update", listener));
		},
		offSettingsChanged: () => {
			for (const dispose of unsubscribes.splice(0)) dispose();
		},
		notify: (text) => {
			notes.push(text);
			ctx.logger.info?.(`dsh-wtq-pool: ${text}`);
		},
		openPanel: () => {
			notes.push("面板在 插件页 → WTQ Pool 卡片");
		},
		registerCommand: async (spec) => {
			const service = ctx.get("commands");
			if (service === void 0) return;
			const commandName = spec.id.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
			notes.length = 0;
			const dispose = service.register({
				name: commandName,
				description: spec.title,
				handler: async () => {
					notes.length = 0;
					try {
						await spec.run();
						return {
							kind: "success",
							text: notes.join("\n") || spec.title
						};
					} catch (error) {
						return {
							kind: "error",
							text: error instanceof Error ? error.message : String(error)
						};
					}
				}
			});
			if (typeof dispose === "function") commands.set(spec.id, dispose);
		},
		unregisterCommand: async (id) => {
			commands.get(id)?.();
			commands.delete(id);
		},
		/**
		* Publish the provider rows.
		*
		* The core rebuilds its declaration on every account scan, model write and
		* settings change, so this is called often; the fingerprint check turns an
		* unchanged set into a no-op instead of a re-registration storm.
		*/
		declareProviders: (descriptors) => {
			if (stopped) return {
				ok: false,
				changed: false,
				error: "the plugin is unloading"
			};
			try {
				const next = registrationFingerprint(descriptors);
				if (next === fingerprint) return {
					ok: true,
					changed: false
				};
				disposeRegistration?.();
				disposeRegistration = void 0;
				lastRows = [];
				if (descriptors.length === 0) {
					fingerprint = next;
					ctx.emit("llm/adapters-updated");
					return {
						ok: true,
						changed: true,
						providerCount: 0
					};
				}
				const built = buildAdapter(descriptors, ctx);
				const releaseAdapter = ctx.llm.registerAdapter(built.providerIds, built.adapter);
				let releaseRows;
				disposeRegistration = () => {
					releaseAdapter?.();
					releaseRows?.();
				};
				releaseRows = ctx.llm.registerConfigurableProviders(descriptors.map((row) => ({
					provider: row.id,
					displayName: row.name,
					settingsNs: settingsNamespace,
					settingsPath: [],
					declared: false
				})));
				lastRows = descriptors;
				fingerprint = next;
				ctx.emit("llm/adapters-updated");
				return {
					ok: true,
					changed: true,
					providerCount: descriptors.length
				};
			} catch (error) {
				disposeRegistration?.();
				disposeRegistration = void 0;
				lastRows = [];
				fingerprint = "";
				const message = error instanceof Error ? error.message : String(error);
				ctx.logger.error("dsh-wtq-pool: provider registration failed", error);
				return {
					ok: false,
					changed: false,
					error: message
				};
			}
		}
	});
	try {
		if (typeof settingsService?.configure === "function") ctx.effect(() => settingsService.configure?.({ auto: true }, ctx.fiber) ?? (() => {}));
	} catch (error) {
		ctx.logger.warn?.("dsh-wtq-pool: settings section unavailable", error);
	}
	ctx.effect(() => ctx.llm.registerModelDiscovery(settingsNamespace, async (request) => {
		const wanted = request?.provider;
		const rows = [];
		for (const row of lastRows) {
			if (wanted !== void 0 && row.id !== wanted) continue;
			for (const model of row.models) rows.push({
				id: model.id,
				name: typeof model.name === "string" ? model.name : model.id,
				...typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {},
				...typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {},
				inputModalities: model.supportsImages === true ? ["text", "image"] : ["text"]
			});
		}
		return rows;
	}), "dsh-wtq-pool: model discovery");
	ctx.inject(["webServer"], (webCtx) => {
		registerPanelRoutes(webCtx, {
			pluginRoot: PLUGIN_ROOT,
			invoke: (channel, payload) => onPanelInvoke(channel, payload),
			effect: (callback) => webCtx.effect(callback, "dsh-wtq-pool: panel routes"),
			logger: ctx.logger
		});
	});
	ctx.effect(() => async () => {
		stopped = true;
		lastRows = [];
		await stopRegisteredService();
		for (const dispose of commands.values()) dispose();
		commands.clear();
		for (const dispose of unsubscribes.splice(0)) dispose();
		disposeRegistration?.();
		disposeRegistration = void 0;
		await onUnload();
	});
	onLoad().then(() => {
		if (!stopped) return startRegisteredService();
	}).catch((error) => {
		if (stopped) return;
		ctx.logger.error("dsh-wtq-pool: activation failed", error);
	});
}
//#endregion
export { Config, apply, inject, name, onLoad, onPanelInvoke, onUnload };
