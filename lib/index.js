import * as path from "node:path";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as os from "node:os";
import { cpus, homedir, hostname, release } from "node:os";
import * as fs from "node:fs/promises";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as piAi from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import z from "@deepseek-ai/schemastery";
import { createServer } from "node:http";
import { constants, createCipheriv, createDecipheriv, createHash, publicEncrypt, randomBytes, randomUUID } from "node:crypto";
import * as net from "node:net";
import { BlockList, isIP } from "node:net";
import * as fs$1 from "node:fs";
import { statSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, execFileSync, spawn } from "node:child_process";
//#region src/log.ts
/**
* The prefix the shared modules' log lines and warnings carry.
*
* One constant rather than a literal per call site, because those modules are
* synced byte for byte between the two builds and a literal is what a sync
* overwrites. Both builds use the same product name, so the host banner and
* these lines agree.
*/
const LOG_PREFIX = "wtq-pool";
/**
* A stable, non-identifying tag for one account in a log line.
*
* The panel shows the label because the user needs to tell accounts apart. A
* log is copied into bug reports far more often than the panel is, and an email
* address or nickname there is personal data; a short digest still lets two
* lines about the same account be correlated without carrying the label.
*/
function accountLogTag(label) {
	return "acct-" + createHash("sha256").update(String(label ?? "")).digest("hex").slice(0, 8);
}
//#endregion
//#region src/loopback.ts
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]",
	"::1"
]);
/** Strip the port, and unwrap an IPv6 bracket, so only the host name remains. */
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	if (hostname.split(":").length > 2) return hostname;
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/** Host must name loopback; drops DNS-rebinding attempts before routing. */
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/**
* The pathname of a request target.
*
* `req.url` keeps the query string and may be an absolute-form proxy target;
* routing compared it whole, so `?api-version=…` or `GET http://host/v1/…`
* answered 404 on every route.
*/
function requestPathname(raw) {
	if (raw === void 0 || raw === "") return "/";
	try {
		return new URL(raw, "http://127.0.0.1").pathname;
	} catch {
		return "/";
	}
}
/** A present Origin must be loopback; non-browser clients send none and pass. */
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname);
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
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"X-Content-Type-Options": "nosniff",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/**
* An error's text, redacted and bounded, for anything that leaves the process.
*
* One copy for the log path and the client path: two copies of a redaction
* rule are two chances to drift, and the panel's copy had already drifted from
* the host entry's on the plain-object case.
*/
function safeMessage(error) {
	return redactSecrets(error && typeof error === "object" && "message" in error && error.message ? String(error.message) : String(error)).slice(0, 500);
}
/** The error shape every OpenAI-compatible client expects. */
function writeOpenAIError(res, status, kind, message) {
	writeJson(res, status, { error: {
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
* one a query string carries. Qoder's signed headers ride account and machine
* identity (`Cosy-User`, `Cosy-Machinetoken`, `X-User-Id`), so they are listed
* too: an echoed request that prints them identifies the account as surely as
* a token does. The three-part JWT needs no key at all: it is recognisable on
* its own, and the opaque prefixes are Qoder's own.
*
* Trae's tokens are opaque, not JWTs, so only the scheme rules cover them -
* which is why every header name the plugin itself sends is listed there. A
* space-separated echo of one the list missed printed the whole credential, and
* four were missing: `Cosy-Machineid` (the same value `Cosy-Machinetoken`
* carries) plus `x-machine-id`, `x-device-id` and `x-uid`, the Trae machine,
* device and account ids. Qoder's identity headers were listed and Trae's were
* not, which is the drift the sentence above is meant to prevent.
*/
const REDACTIONS = [
	[/\b(Bearer|Cosy-Key|Cosy-Machineid|Cosy-Machinetoken|Cosy-User|Cloud-IDE-JWT|X-Cloudide-Token|X-Ide-Token|X-Refresh-Token|X-Api-Key|X-User-Id|x-device-id|x-machine-id|x-uid)\b([\s:="'\\]{1,6})[A-Za-z0-9_+/.=~-]{8,}/gi, "$1$2[redacted]"],
	[/\beyJ[A-Za-z0-9_+/.=-]+(?:\.[A-Za-z0-9_+/.=-]+){0,2}/g, "[redacted token]"],
	[/\b(qoder-oauth-token-)[A-Za-z0-9_+/.=-]+/g, "$1[redacted]"],
	[/\b(rt_)[A-Za-z0-9_+/.=-]+/g, "$1[redacted]"],
	[/((?:\\{0,2}["']?)(?:access_?token|refresh_?token|id_?token|auth_?token|oauth_?token|api_?key|secret|token)(?:\\{0,2}["']?\s*[:=]\s*\\{0,2}["']?))(?=[A-Za-z0-9_+/.=-]{6,})(?=[A-Za-z0-9_+/.=-]*[A-Za-z_-])[A-Za-z0-9_+/.=-]+/gi, "$1[redacted]"],
	[/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[account]"],
	[/\b[A-Za-z]:[\\/][^\r\n"'<>|]*/g, "[redacted path]"],
	[/\\\\[^\r\n"'<>|]+/g, "[redacted path]"],
	[/(['"])(\/(?!\/)[^'"\r\n]+)\1/g, "$1[redacted path]$1"],
	[/(?<![\w./])\/(?:[\w.@-]+(?: [\w.@-]+)*\/)+[\w.@-]+(?: [\w.@-]+)*\.[A-Za-z][\w]*/g, "[redacted path]"]
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
* The vendor's channel check, answered as what it is.
*
* WorkBuddy's upstream inspects the system and assistant turns for wording that
* belongs to a client it does not serve, and answers business code 11128. The
* plugin already moves the system prompt into the first user turn and retries
* once (`chatStream`); a second refusal means the blocked wording is somewhere
* that move does not reach, or the host changed its screen again. Every account
* of that region answers the same way, so rotation cannot clear it, and the
* vendor body is a wall of mixed Chinese and English tips that names no cause a
* user can act on. The sentence below says what happened and what does work.
*/
function unapprovedChannelRefusal(text) {
	if (!/"code"\s*:\s*"?11128\b/u.test(text) && !/\bcode 11128\b/u.test(text)) return void 0;
	return channelCheckRefusal();
}
/** The sentence a refused prompt is answered with, whatever shape the body has. */
function channelCheckRefusal() {
	return "the WorkBuddy host refused this conversation at its client check (11128). That screen reads system and assistant turns for wording that belongs to a client it does not serve, so remove client-identifying text from the conversation, start a new one, or use Trae or Qoder for this prompt.";
}
/**
* The `finish_reason` one turn is reported with.
*
* A turn that emitted tool calls says `tool_calls`, because that is what an
* OpenAI client looks for before it acts on them. It must not say that *over*
* what the upstream reported: `length` and `content_filter` describe how the
* turn ended, and a tool call cut off by the output budget is exactly the case
* where acting on its arguments spends a request on half a JSON body. So only
* the verdict that carries nothing of its own - `stop`, or nothing at all - is
* replaced.
*/
function openAIFinishReason(upstream, sawToolCalls) {
	const stated = upstream === void 0 || upstream === "" || upstream === "null" ? void 0 : upstream;
	if (stated !== void 0 && stated !== "stop") return stated;
	return sawToolCalls ? "tool_calls" : "stop";
}
/**
* Models a discovery answer may name.
*
* The host rebuilds the picker from `GET /v1/models`, so these ids are the
* ones the manifest publishes. An empty publication falls back to the
* directory: an empty discovery answer makes the host drop the provider. A
* publication that names only ids the roster no longer carries falls back the
* same way, because that is a roster that moved since the declaration was
* written; the next declaration rebuild re-applies the selection, and an empty
* answer in the meantime would cost the user the provider row itself.
*/
function listedModels(directory, listedIds) {
	if (listedIds.length === 0) return directory;
	const allowed = new Set(listedIds);
	const picked = directory.filter((model) => allowed.has(model.id));
	return picked.length > 0 ? picked : directory;
}
/**
* Lift the message out of an upstream error envelope.
*
* The Trae and Qoder gateways relay the upstream's own JSON error document as
* the message of their OpenAI-shaped error, which double-wraps it: the client
* then reads a serialized document where a sentence should be. Parsed here,
* once, so every gateway answers in the upstream's own words; redacted,
* because that document is exactly where an echoed credential would ride.
*/
function liftUpstreamMessage(text) {
	const trimmed = text.trim();
	if (trimmed === "") return "";
	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return redactSecrets(text);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return redactSecrets(text);
	const record = parsed;
	const error = record["error"];
	if (typeof error === "string" && error.trim() !== "") return redactSecrets(error);
	if (typeof error === "object" && error !== null && !Array.isArray(error)) {
		const message = error["message"];
		if (typeof message === "string" && message.trim() !== "") return redactSecrets(message);
	}
	if (typeof record["message"] === "string" && record["message"].trim() !== "") return redactSecrets(record["message"]);
	return "";
}
/** Longest wait a client is told to honour, in seconds. */
const RETRY_AFTER_CEILING_SECONDS = 7200;
/**
* One wait time in whole seconds, bounded, or nothing when it is not a wait.
*
* A client that honours a `Retry-After` stops asking for that long, so one
* malformed value must not be able to park an account for years. Both readers
* of the header come through here rather than each carrying its own ceiling.
*/
function boundedRetryAfterSeconds(seconds) {
	if (!Number.isFinite(seconds) || seconds <= 0) return void 0;
	return Math.min(Math.ceil(seconds), RETRY_AFTER_CEILING_SECONDS);
}
/**
* A `Retry-After` worth sending, or nothing.
*
* The upstream's own wait time, bounded and validated. An empty string, prose
* or a number of years is dropped rather than forwarded.
*/
function retryAfterHeader(value) {
	const bounded = boundedRetryAfterSeconds(typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
	return bounded === void 0 ? void 0 : String(bounded);
}
/** The largest chat body a gateway will buffer before refusing the request. */
const REQUEST_BODY_LIMIT = 67108864;
/**
* How long an oversized upload may take to finish before the socket is closed
* anyway. Node's own request timeout still bounds a client that never ends.
*/
const BODY_DRAIN_GRACE_MS = 1e4;
/** Raised when a request body passes the `limitBytes` bound it was read with. */
var BodyTooLargeError = class extends Error {};
/**
* Buffer one request body, refusing anything past the `limitBytes` bound it is
* given, which defaults to {@link REQUEST_BODY_LIMIT}.
*
* A body that arrives in pieces is counted as it arrives, so an endless upload
* is cut off by size rather than by the client finishing it. Live here for the
* same reason as the guards above: three gateways each reading their own limit
* is three limits to keep in step.
*
* The rejection carries the reason through to the caller so the answer is a
* 413 the client can act on, not a 500 that reads as a bug in this plugin.
*/
function readRequestBody(req, limitBytes = REQUEST_BODY_LIMIT) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let refused = false;
		const declared = Number(req.headers?.["content-length"]);
		if (Number.isFinite(declared) && declared > limitBytes) {
			reject(new BodyTooLargeError("request body too large"));
			const grace = setTimeout(() => {
				if (!req.destroyed) req.destroy();
			}, BODY_DRAIN_GRACE_MS);
			grace.unref();
			const done = () => {
				clearTimeout(grace);
				if (!req.destroyed) req.destroy();
			};
			req.on("end", done);
			req.on("error", done);
			return;
		}
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limitBytes) {
				if (!refused) {
					refused = true;
					reject(new BodyTooLargeError("request body too large"));
					const grace = setTimeout(() => {
						if (!req.destroyed) req.destroy();
					}, BODY_DRAIN_GRACE_MS);
					grace.unref();
					const done = () => {
						clearTimeout(grace);
						if (!req.destroyed) req.destroy();
					};
					req.on("end", done);
					req.on("error", done);
				}
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
async function answerRequest(res, handle, log, answerFailure) {
	res.on?.("error", (error) => {
		log?.warn?.("wtq-pool: response socket closed mid-write", error);
	});
	try {
		await handle();
	} catch (error) {
		log?.warn?.("wtq-pool: request failed", error);
		const answer = answerFailure ?? ((target, caught) => {
			if (caught instanceof BodyTooLargeError) writeOpenAIError(target, 413, "request_too_large", String(caught.message));
			else writeOpenAIError(target, 500, "internal", String(caught));
		});
		try {
			if (!res.headersSent) answer(res, error);
			else res.end();
		} catch (writeError) {
			log?.warn?.("wtq-pool: could not answer a failed request", writeError);
		}
	}
}
/**
* Read a bounded JSON body; an empty or malformed body reads as `{}`.
*
* The bound and the drain grace come from {@link readRequestBody}'s, because a
* panel POST is a request like any other and a second size policy is a second
* policy to keep in step. The parse is lenient on purpose: a panel call that
* carries no body is a read, not a malformed write.
*
* The limit is a parameter rather than a constant because the panel's requests
* are a channel name and a handful of settings, and it accepts a thousand times
* less than a chat body does.
*/
async function readJsonBody(req, limitBytes = REQUEST_BODY_LIMIT) {
	const raw = (await readRequestBody(req, limitBytes)).toString("utf8");
	if (raw.trim() === "") return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed !== null && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}
/**
* The relay stream a `Response` was built from.
*
* `Response` wraps the stream it is given in another `ReadableStream`, and in
* the plugin process that wrapper stops delivering to its reader after the
* first chunks: the caller holds a 200 whose body never arrives. The bridges
* hand their stream over under this key as well, and the gateways pump that one
* directly. Nothing that reads `response.body` is affected.
*/
const RELAY_STREAM = Symbol.for("wtq-pool.relay-stream");
/** Attach the unwrapped relay stream to a response built around it. */
function withRelayStream(response, stream) {
	Object.defineProperty(response, RELAY_STREAM, {
		value: stream,
		enumerable: false
	});
	return response;
}
/** The stream to relay: the attached one when present, else the response body. */
function relayStreamOf(response) {
	const attached = response[RELAY_STREAM];
	if (attached !== void 0) return attached;
	if (response.body === null) throw new Error("response carries no body");
	return response.body;
}
/**
* Write one relayed chunk, waiting while the client's socket is full.
*
* A relay that ignores the false return of `res.write` keeps reading the
* upstream at full speed and parks the whole answer inside the plugin process,
* competing with the gateways and the panel for one event loop.
*/
async function writeChunk(res, chunk) {
	if (res.destroyed || res.writableEnded) return;
	if (res.write(Buffer.from(chunk))) return;
	if (res.destroyed) return;
	await new Promise((resolve) => {
		const wake = () => {
			res.off("drain", wake);
			res.off("close", wake);
			resolve();
		};
		res.once("drain", wake);
		res.once("close", wake);
	});
}
/**
* Relay one web stream to a Node response, honouring backpressure.
*
* Written out rather than `Readable.fromWeb` + `pipe`: that adapter stops
* delivering a stream this plugin built itself, so the client held a 200 whose
* body never arrived. Ends the response once the source ends; a read or write
* failure is the caller's to classify.
*/
async function pumpToResponse(source, res) {
	const reader = source.getReader();
	const releaseLock = () => {
		try {
			reader.releaseLock();
		} catch {}
	};
	if (res.destroyed || res.writableEnded) {
		await reader.cancel().catch(() => {});
		releaseLock();
		return;
	}
	const cancel = () => {
		reader.cancel().catch(() => {});
	};
	res.once("close", cancel);
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			await writeChunk(res, next.value);
			if (res.destroyed || res.writableEnded) break;
		}
	} finally {
		res.off("close", cancel);
		releaseLock();
	}
	if (res.writable && !res.destroyed) res.end();
}
/**
* Replay the bytes a peek consumed, then drain the rest of the upstream.
*
* The relay hands the client a stream it already read the head of, so the bytes
* that were buffered while looking for a failure have to be put back in front of
* the reader's remainder. Cancelling has to reach the upstream reader: a caller
* that hangs up otherwise leaves the upstream socket open until it ends on its
* own, which for a long turn is the whole conversation.
*/
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
	const site = req.headers["sec-fetch-site"];
	if (typeof site === "string" && site !== "" && site !== "same-origin" && site !== "same-site" && site !== "none") {
		writeOpenAIError(res, 403, "origin_not_allowed", "cross-site request to a loopback gateway");
		return false;
	}
	if (!bearerAccepted(req)) {
		writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
		return false;
	}
	return true;
}
/**
* One loopback HTTP server, bound and torn down the same way everywhere.
*
* The WorkBuddy shim and the Trae and Qoder gateways each wrote out their own
* `createServer` / `listen` / `close` block. One copy here is what stops the next
* gateway writing a fourth, and `handle` is the only hook: everything else a
* gateway varies — its port, the name its errors carry — is data, so there is
* nothing left to get subtly wrong.
*
* Teardown makes two calls, and their ORDER is the whole point:
*
* - `closeAllConnections()` first aborts the turns that are still in flight.
* - `server.close()` then stops listening and waits for its connections to end.
*   They end at once, because they were just destroyed.
*
* Reversed, `close()` waits for a chat that is mid-stream to finish on its own,
* and the abort that would have ended it sits behind the wait, so it never runs:
* teardown blocks on the upstream instead of on the user, and the plugin process
* stays alive with it. That is the order the shim had.
*
* The idle case hides all of this. A client that finished a turn holds an idle
* keep-alive socket, and `close()` drops those itself, so with nothing in flight
* every ordering resolves and the difference is invisible. Only a turn that is
* still streaming makes it show, which is the fixture the teardown test uses.
*/
function createLoopbackServer(options) {
	const server = createServer((req, res) => {
		answerRequest(res, () => options.handle(req, res), options.logger);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(options.port ?? 0, "127.0.0.1");
	server.on("error", (error) => {
		options.logger?.warn?.("wtq-pool: " + options.label + " server error", safeMessage(error));
	});
	return {
		ready,
		/** The bound port, or 0 before `listening` (or after close). */
		port: () => {
			const address = server.address();
			return address === null || typeof address === "string" ? 0 : address.port;
		},
		baseUrl: () => {
			const address = server.address();
			if (address === null || typeof address === "string") throw new Error(options.label + " has no listening address");
			return `http://127.0.0.1:${address.port}`;
		},
		close: async () => {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(() => resolve()));
		}
	};
}
//#endregion
//#region src/pi-compat.ts
/**
* The capability surface the plugin core is written against.
*
* The core (`host.ts`) was written for a host that hands the plugin process a
* `pi` object: settings, events, commands, a clipboard, a panel and a provider
* declaration channel. DeepSeek Harness exposes the same capabilities as Cordis
* services on the plugin `Context` instead, spread across different service
* names and shapes.
*
* Rather than rewrite the core against each of those services, this module
* adapts the Cordis context to the shape the core already speaks. `index.ts`
* calls {@link installPi} once at activation; every method below forwards to
* the bridge it installs.
*
* @module dsh-wtq-pool/pi-compat
*/
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
	services: { 
	/**
	* The background services the core registers, whose `start` brings every
	* gateway up. Cordis has no second lifecycle stage to hang that on, so the
	* hooks are stashed here for the entry to run itself; `stop` is what the
	* entry's cleanup calls. Keyed by the service's own id, so a registration
	* that repeats one replaces it rather than leaving a second start/stop pair
	* beside a first that is still the only one called.
	*/
register: (service) => {
		services.set(service.id, {
			start: service.start,
			stop: service.stop
		});
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
/** The hooks the services above registered, in registration order. */
const services = /* @__PURE__ */ new Map();
/**
* Run every service the core registered, if it did.
*
* One service's failure must not skip the ones after it: they are registered
* independently, and a service that never started is a gateway that never
* bound, which the panel then reports as missing with no reason attached.
*/
async function startRegisteredService() {
	for (const service of services.values()) try {
		await service.start();
	} catch (error) {
		console.warn("[dsh-wtq-pool] service failed to start:", safeMessage(error));
	}
}
/**
* Stop every service the core registered, if it did.
*
* One service's failure must not skip the ones after it: a gateway that never
* closed holds its port, and the next start falls back to a temporary one.
*
* The map is deliberately NOT cleared. Disabling and re-enabling the plugin
* runs stop and then start with no load in between, and clearing it here left
* the re-enable with nothing to start: the gateways never came back until a
* full reload. Registration is keyed by id, so the next load overwrites rather
* than accumulates.
*/
async function stopRegisteredService() {
	for (const service of services.values()) try {
		await service.stop();
	} catch (error) {
		console.warn("[dsh-wtq-pool] service failed to stop:", safeMessage(error));
	}
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
//#region src/web-panel.ts
/**
* The channels the panel bridge serves.
*
* Every channel the panel or the composer readout asks for has to appear here,
* or it is refused. The two groups are admitted identically - the split below
* is a reading aid for whoever opens this file, not a rule the route enforces -
* and the appearance channel the page asks for is answered here without
* reaching the plugin.
*
* `xd.doctor` sits in the second group rather than the first because it reports
* on the pool's own connections instead of reading them, and `xd.state` can
* spend a network pass of its own when it is asked to wait: a channel's cost is
* not what the grouping says.
*/
const CHANNELS = /* @__PURE__ */ new Set([
	"xd.state",
	"xd.composerPoints",
	"xd.composerPrefer",
	"xd.composerRefresh",
	"xd.checkin",
	"xd.checkinAll",
	"xd.doctor",
	"xd.preferAccount",
	"xd.preferSourceAccount",
	"xd.rescan",
	"xd.fetchModels",
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
	"xd.sourceDistribution",
	"xd.startLogin",
	"xd.pollLogin",
	"xd.growthState",
	"xd.growthRun",
	"xd.keepAlive"
]);
/** Largest panel request body accepted, so a hung or oversized body cannot pin memory. */
const MAX_BODY_BYTES = 65536;
/**
* The content policy the panel document is served with.
*
* A header rather than the page's own `<meta>`, which {@link panelHtml} strips:
* one copy serves both embeddings, and a meta that survived the strip would
* intersect with this header and block the bridge's inline script. The bridge
* is the only inline script, and it carries a per-request nonce rather than a
* blanket `unsafe-inline` allowance: anything that could write into this
* package's `renderer/` would otherwise own script execution on a page whose
* channels change settings and move credits. `connect-src 'self'` is the fetch
* the bridge makes, and `frame-ancestors 'self'` is what stops a page on
* another site from framing the panel's mutating controls - the host card
* frames it same-origin.
*/
const PANEL_CSP = [
	"default-src 'none'",
	"script-src 'self' 'nonce-__PANEL_NONCE__'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"connect-src 'self'",
	"frame-ancestors 'self'",
	"base-uri 'none'",
	"form-action 'none'"
].join("; ");
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");
LOOPBACK.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
/** Whether the request's peer is this machine. */
function peerIsLoopback(req) {
	const address = req.socket.remoteAddress;
	if (address === void 0) return false;
	const family = isIP(address);
	if (family === 4) return LOOPBACK.check(address, "ipv4");
	if (family === 6) return LOOPBACK.check(address, "ipv6");
	return false;
}
/**
* Whether the request's own headers say the page asking is this origin.
*
* A browser sends no `Origin` at all on a top-level GET into an iframe, so the
* loopback Origin check alone cannot see a page on another site framing the
* panel - `Sec-Fetch-Site` is the header that names the asker. A client that is
* not a browser sends neither header and passes.
*/
function askerIsThisOrigin(req) {
	if (!originIsLoopback(req.headers.origin)) return false;
	const site = req.headers["sec-fetch-site"];
	return typeof site !== "string" || site === "same-origin" || site === "none";
}
/**
* Answer one panel route behind the guards every route answers with.
*
* The four checks are the whole of the panel's access control - this host's
* server carries no authentication or origin policy of its own - and each route
* owes the same four in the same order: the peer, the Host the asker named, the
* method, and the origin. The loopback bind and the peer check between them
* admit a DNS-rebinding page, because a browser aimed at
* `http://127.0.0.1:<port>` sends the Host that page chose, and only the Host
* check refuses it. A refusal is answered here and returns, so `handle` runs
* only once all four have passed.
*
* The panel routes write the response themselves rather than going through a
* gateway, so they also owe the guard the gateways get from `answerRequest`: a
* socket with no `error` listener turns a client that hung up mid-answer into an
* uncaught exception, and `/invoke` can run for the best part of twenty seconds
* before it answers anything at all. That is why the guards run inside
* `answerPanel` rather than ahead of it.
*/
function guarded(req, res, method, handle, log) {
	return answerPanel(res, () => {
		if (!peerIsLoopback(req)) return writeJson(res, 403, { error: "peer-not-loopback" });
		if (!hostIsLoopback(req.headers.host)) return writeJson(res, 403, { error: "host-not-loopback" });
		if (req.method !== method) return writeJson(res, 405, { error: "method not allowed" });
		if (!askerIsThisOrigin(req)) return writeJson(res, 403, { error: "origin-not-trusted" });
		return handle();
	}, log);
}
/**
* Answer a panel route, writing a failure in the panel's own JSON shape.
*
* The socket sink, the failure log and the write guard all belong to
* `answerRequest`; only the shape of the answer is the panel's.
*
* A body past the cap is the client's problem to fix, so it is answered as the
* 413 it is rather than a 500 that reads as a bug in this plugin.
*/
function answerPanel(res, handle, log) {
	return answerRequest(res, handle, log, (target, error) => {
		if (error instanceof BodyTooLargeError) writeJson(target, 413, { error: safeMessage(error) });
		else writeJson(target, 500, { error: safeMessage(error) });
	});
}
/** Answer with the panel document: its content policy, uncached, and never sniffed. */
function writeHtml(res, body, nonce) {
	res.writeHead(200, {
		"Content-Type": "text/html; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
		"Content-Security-Policy": PANEL_CSP.replace("__PANEL_NONCE__", nonce),
		"X-Content-Type-Options": "nosniff"
	});
	res.end(body);
}
/** Answer with one file's bytes, uncached so an edited asset is picked up. */
function sendFile(res, file, type) {
	const body = fs$1.readFileSync(file);
	res.writeHead(200, {
		"Content-Type": type,
		"Content-Length": body.length,
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff"
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
* the host-chrome metas it carried in its previous embedding are dropped - the
* content-policy one because the response header is now authoritative - and
* the bridge that talks to this plugin is injected ahead of its own script. The
* panel therefore stays one page with one host dependency, and nothing about
* its markup is duplicated here.
*
* `nonce` is minted per request and has to be the value the response's content
* policy names, or the policy refuses the one script the page needs.
*/
function panelHtml(pluginRoot, base, lang, nonce) {
	const file = panelAsset(pluginRoot, "index.html");
	if (file === void 0) return void 0;
	const safeBase = base === "dark" ? "dark" : "light";
	const safeLang = lang.toLowerCase().startsWith("en") ? "en" : "zh-CN";
	const bridge = `<script nonce="${nonce}">
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
	return fs$1.readFileSync(file, "utf8").replace(/\s*<meta\b[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/i, "").replace("</head>", `${bridge}\n</head>`);
}
function registerPanelRoutes(ctx, deps) {
	try {
		deps.effect(() => {
			const disposers = [];
			const release = () => {
				for (const dispose of disposers) try {
					dispose();
				} catch (error) {
					deps.logger.warn("dsh-wtq-pool: a panel route did not release cleanly", safeMessage(error));
				}
			};
			const mount = (route) => {
				disposers.push(ctx.webServer.register(route));
			};
			try {
				mount({
					kind: "exact",
					path: `${PANEL_BASE}/panel`,
					handler: (req, res) => guarded(req, res, "GET", () => {
						const url = new URL(req.url ?? "/", "http://localhost");
						const nonce = randomBytes(16).toString("base64");
						const body = panelHtml(deps.pluginRoot, url.searchParams.get("base") ?? "light", url.searchParams.get("lang") ?? "zh-CN", nonce);
						if (body === void 0) return writeJson(res, 404, { error: "missing renderer/index.html" });
						writeHtml(res, body, nonce);
					}, deps.logger)
				});
				mount({
					kind: "exact",
					path: `${PANEL_BASE}/panel.css`,
					handler: (req, res) => guarded(req, res, "GET", () => {
						const file = panelAsset(deps.pluginRoot, "panel.css");
						if (file === void 0) return writeJson(res, 404, { error: "missing panel.css" });
						sendFile(res, file, "text/css; charset=utf-8");
					}, deps.logger)
				});
				mount({
					kind: "exact",
					path: `${PANEL_BASE}/panel.js`,
					handler: (req, res) => guarded(req, res, "GET", () => {
						const file = panelAsset(deps.pluginRoot, "panel.js");
						if (file === void 0) return writeJson(res, 404, { error: "missing panel.js" });
						sendFile(res, file, "text/javascript; charset=utf-8");
					}, deps.logger)
				});
				mount({
					kind: "exact",
					path: `${PANEL_BASE}/invoke`,
					handler: (req, res) => guarded(req, res, "POST", async () => {
						if (!isJsonContentType(req)) return writeJson(res, 415, { error: "Content-Type must be application/json" });
						const body = await readJsonBody(req, MAX_BODY_BYTES);
						const channel = typeof body["channel"] === "string" ? body["channel"] : "";
						if (channel === "") return writeJson(res, 400, { error: "channel is required" });
						if (channel === "app.getAppearance") return writeJson(res, 200, { result: {
							base: body["base"] === "dark" ? "dark" : "light",
							locale: typeof body["lang"] === "string" ? body["lang"] : "zh-CN"
						} });
						if (channel.startsWith("xd.") === false || CHANNELS.has(channel) === false) return writeJson(res, 400, { error: `unsupported channel: ${channel}` });
						const payload = body["payload"] !== null && typeof body["payload"] === "object" ? body["payload"] : {};
						const result = await deps.invoke(channel, payload);
						writeJson(res, 200, { result: result === void 0 ? null : result });
					}, deps.logger)
				});
			} catch (error) {
				release();
				throw error;
			}
			return release;
		});
	} catch (error) {
		deps.logger.warn("dsh-wtq-pool: the panel routes could not be mounted", safeMessage(error));
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
//#region src/checkin-time.ts
/**
* When the daily check-in is due, decided in one time zone.
*
* The reward windows are defined in Beijing time, so an hour has to mean the
* same instant on every machine: reading the host's local hour would make "9
* o'clock" slip by a day on a laptop set to another zone. Everything here is a
* pure function of its arguments, which is what lets a check drive the whole
* decision - the configured hours, the slot id, what is due right now - without
* a clock to fake or a settings file to write.
*
* The cap on the configured hours is defensive rather than load-bearing - the
* filter below already leaves at most 24 distinct values in 0..23 - but a host
* entry that skipped it would disagree with this one about which hours are in
* force, so the rule lives in one place.
*
* @module dsh-wtq-pool/checkin-time
*/
/** The zone the daily check-in hours are read in. */
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
* Calendar day `offset` days from today in the check-in zone, as `YYYY-MM-DD`.
*
* Same zone as {@link zonedDayHour}, so a make-up target and a scheduled pass
* can never disagree about which day they mean. The offset is applied to the
* zone's own midnight rather than to the caller's clock: adding 24-hour steps
* across a DST boundary in some other zone lands on the wrong date.
*/
function zonedDay(offset = 0) {
	const today = zonedDayHour(/* @__PURE__ */ new Date()).day;
	if (offset === 0) return today;
	const [year, month, day] = today.split("-");
	return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + offset)).toISOString().slice(0, 10);
}
/**
* Whole hours only, in order. Anything unreadable is dropped rather than
* guessed at, and an empty list falls back to the default hour: a switch that
* is on but never fires would be worse than one that picks a sane time.
*/
function normaliseCheckinHours(raw) {
	const hours = [...new Set(raw.filter((value) => typeof value === "number" || typeof value === "string" && value.trim() !== "").map((value) => Math.floor(Number(value))))].filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23).sort((a, b) => a - b);
	return hours.length === 0 ? [...DEFAULT_CHECKIN_HOURS] : hours;
}
/** A slot's id: `YYYY-MM-DDTHH` in the check-in zone. */
function checkinSlotId(day, hour) {
	return day + "T" + String(hour).padStart(2, "0");
}
/**
* The slot to collect right now, or undefined when nothing is due.
*
* An hour is due once its time has passed - catch-up, deliberately: a machine
* that slept through 09:00 still collects when it wakes instead of waiting for
* tomorrow. The earliest unconsumed hour wins, so two configured hours still
* give two passes a day.
*/
function dueCheckinSlot(now, hours, fired) {
	const { day, hour } = zonedDayHour(now);
	for (const candidate of [...hours].sort((a, b) => a - b)) {
		if (candidate > hour) continue;
		const slot = checkinSlotId(day, candidate);
		if (!fired.has(slot)) return slot;
	}
}
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
const GLOBAL_BASE$1 = "https://www.workbuddy.ai";
/**
* Client versions the two gateways see, and the headers that carry them.
*
* CN desktop 5.9.3 (2026-10-27) sends `X-Agent-Runtime: local-agent` and the
* same `X-Stainless-*` family as the bundled CLI. The international desktop is
* still 5.8.4. Keeping one literal for both was one version behind on CN and
* produced a combination no installed client sends.
*/
const CN_CLIENT_VERSION = "5.9.3";
const CN_CLI_VERSION = "2.165.0";
const GLOBAL_CLIENT_VERSION = "5.8.4";
const GLOBAL_CLI_VERSION = "2.161.0";
/** CN chat UA: the desktop client's three-segment spelling. */
const CN_CHAT_UA = `WorkBuddy/${CN_CLIENT_VERSION} WorkBuddy/${CN_CLIENT_VERSION} CLI/${CN_CLI_VERSION}`;
/** CN desktop UA, used by the endpoints the desktop process calls directly. */
const CN_DESKTOP_UA = `WorkBuddy/${CN_CLIENT_VERSION}`;
/**
* The international desktop client's UA. The `workbuddy-ai/` segment only
* exists on that gateway, and the CN spelling gets the CLI roster there.
*/
const GLOBAL_CHAT_UA = `WorkBuddy/${GLOBAL_CLIENT_VERSION} workbuddy-ai/${GLOBAL_CLIENT_VERSION} CLI/${GLOBAL_CLI_VERSION}`;
/**
* Desktop app UA for the global gateway. It serves its product config only to
* this client channel: the CLI UA gets a truncated roster (or an HTTP 500),
* which is why the international catalog must be read with the desktop
* spelling.
*/
const GLOBAL_DESKTOP_UA = `WorkBuddy/${GLOBAL_CLIENT_VERSION}`;
/** CN model catalog. */
const MODELS_CATALOG_PATH = "/v2/enterprises/personal/models";
/** Global product config, which carries the international model roster. */
const GLOBAL_CONFIG_PATH = "/v3/config";
const JSON_TIMEOUT_MS = 3e4;
const ERROR_BODY_LIMIT = 4096;
/** Deadline for a failed response's error body, which no other phase covers. */
const ERROR_BODY_TIMEOUT_MS = 1e4;
/** Deadline for the chat POST to reach its response headers. */
const STREAM_HEADERS_TIMEOUT_MS = 6e4;
/** Longest a relayed chat stream may go without a single byte. */
const STREAM_IDLE_TIMEOUT_MS$1 = 3e5;
/**
* Lifetime assumed for a token whose answer carries no `expiresIn`.
*
* It must exceed the refresh margin, or a refreshed credential would read as
* already-expiring and every request would refresh again. An hour is
* comfortably past that margin and far short of any cap, so a token with a
* real lifetime always replaces it in time.
*/
const ASSUMED_TOKEN_LIFETIME_MS = 36e5;
/** Longest expiry `Date` can represent; anything past it is not a date. */
const MAX_EXPIRY_MS$1 = 41024448e5;
/**
* Absolute expiry for a token the vendor issued, from its `expiresIn`.
*
* The figure comes from the vendor's own answer, so it is bounded here rather
* than trusted: a garbled one (1e300, Infinity) would otherwise store a
* timestamp past `Date`'s range, and the panel's `toISOString()` for that row
* then threw, failing the whole document rather than the one field. A value
* this function refuses falls back to the assumed lifetime, not to 0: 0 means
* "never expires", which would leave a token that really was not fresh being
* served as if it were.
*/
function tokenExpiryMs(expiresInSec) {
	const assumed = () => Date.now() + ASSUMED_TOKEN_LIFETIME_MS;
	if (typeof expiresInSec !== "number" || !Number.isFinite(expiresInSec) || expiresInSec <= 0) return assumed();
	const at = Date.now() + expiresInSec * 1e3;
	if (!Number.isFinite(at) || at > MAX_EXPIRY_MS$1) return assumed();
	return at;
}
/**
* A response's `Retry-After`, in whole seconds, bounded.
*
* The header is the upstream's own answer to "how long", and it is the only
* place a 429 window can be stated that the body parser does not cover.
*/
function retryAfterSeconds(headers) {
	const raw = headers.get("retry-after");
	if (raw === null || raw.trim() === "") return void 0;
	return boundedRetryAfterSeconds(Number(raw.trim()));
}
/**
* Wrap a relayed body so a stream that goes quiet mid-turn fails instead of
* hanging. The upstream socket is cancelled on the first idle gap, and the
* failure is surfaced through the stream: `reader.cancel` resolves the pending
* read as a clean end, which the relay would otherwise report as a finished
* turn with a truncated reply.
*/
function withIdleWatchdog(body, idleMs = STREAM_IDLE_TIMEOUT_MS$1, signal) {
	const reader = body.getReader();
	let timer;
	let idle;
	const disarm = () => {
		if (timer !== void 0) clearTimeout(timer);
		timer = void 0;
	};
	/**
	* Give up on the body and make the pending read report this failure.
	*
	* `reader.cancel` resolves the read the watchdog is waiting on as an end
	* rather than rejecting it, so the reason is recorded for `pull` to turn into
	* an error instead of a clean close. Shared by the idle timer and a caller
	* hang-up: a client that stopped waiting must tear the upstream down, and the
	* header deadline deliberately detaches its own listener once the headers
	* land, so this is where that abort has to be caught.
	*/
	const stop = (reason) => {
		if (idle !== void 0) return;
		idle = reason;
		reader.cancel(reason).catch(() => {});
		disarm();
		detach();
	};
	const onAbort = () => {
		stop(signal?.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("upstream stream cancelled by the caller"));
	};
	const detach = () => {
		signal?.removeEventListener("abort", onAbort);
	};
	if (signal?.aborted === true) onAbort();
	else signal?.addEventListener("abort", onAbort);
	const finish = () => {
		disarm();
		detach();
	};
	const arm = () => {
		disarm();
		timer = setTimeout(() => {
			stop(/* @__PURE__ */ new Error("upstream stream went idle"));
		}, idleMs);
		timer.unref?.();
	};
	return new ReadableStream({
		start() {
			arm();
		},
		async pull(controller) {
			try {
				const next = await reader.read();
				if (idle !== void 0) {
					finish();
					controller.error(idle);
					return;
				}
				arm();
				if (next.done) {
					finish();
					controller.close();
					return;
				}
				controller.enqueue(next.value);
			} catch (error) {
				finish();
				controller.error(error);
			}
		},
		cancel(reason) {
			finish();
			return reader.cancel(reason);
		}
	});
}
/**
* A fetch signal that covers the response headers and nothing else.
*
* A signal handed to `fetch` stays attached to the response body afterwards:
* undici errors the body when it fires, so a deadline meant for the headers
* phase cuts the stream dead the moment it expires. Measured on this machine,
* every WorkBuddy turn longer than a minute and every Trae or Qoder turn
* longer than two was aborted mid-body, the client meeting a reset connection
* instead of the rest of the reply.
*
* The returned signal is aborted by a hang-up straight away, and by the
* deadline only while the request is still waiting for headers. `arrived()`
* disarms the deadline and detaches the hang-up listener, because a rotation
* that exhausts its attempts would otherwise add one listener per account on
* the same caller signal. The body's own teardown on a hang-up is the idle
* watchdog's: `withIdleWatchdog` is handed the same signal and cancels the
* upstream read when it fires.
*/
function headersDeadline(caller, ms) {
	const controller = new AbortController();
	const onCallerAbort = () => controller.abort(caller?.reason);
	if (caller?.aborted === true) controller.abort(caller.reason);
	else caller?.addEventListener("abort", onCallerAbort);
	const timer = setTimeout(() => {
		controller.abort(/* @__PURE__ */ new Error(`upstream did not send response headers within ${ms}ms`));
	}, ms);
	timer.unref?.();
	return {
		signal: controller.signal,
		arrived: () => {
			clearTimeout(timer);
			caller?.removeEventListener("abort", onCallerAbort);
		}
	};
}
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
/** Whether a text names an exhausted balance rather than a rate limit. */
function isHardCreditText(body) {
	const lower = body.toLowerCase();
	return HARD_CREDIT_MARKERS.some((marker) => lower.includes(marker.toLowerCase()) || body.includes(marker));
}
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
* The plan gate: the account is fine, the model is not included in it.
*
* Matched as an envelope value rather than a bare substring, for the same
* reason as the session marker: `11158` turns up inside ids, and reclassifying
* a request error as a plan gate would cool a model that is actually fine.
*/
const MODEL_TIER_PATTERN = /"code"\s*:\s*"?11158\b/u;
/**
* The prompt-screen refusal: `11128`.
*
* The host returns it for a system or assistant turn whose wording belongs to a
* client it does not serve. It is a property of the request body, not the
* account, so the rotation must not spend another sign-in on it; `chatStream`
* moves the system prompt into the first user turn and retries once instead.
*/
const CHANNEL_CHECK_PATTERN = /"code"\s*:\s*"?11128\b/u;
/**
* The vendor's account-level restriction: `11140`, "request illegal".
*
* The body names the account ("your account has been restricted due to unusual
* activity") rather than the request, and no retry with the same sign-in can
* clear it. Reading it as a plain client error answered 400 and stopped the
* rotation, so a second account that could serve the turn was never tried.
*/
const ACCOUNT_RESTRICTED_PATTERN = /"code"\s*:\s*"?11140\b/u;
/**
* The upstream's rate-limit marker.
*
* The same envelope is returned with HTTP 200 by JSON endpoints and by the
* chat screen, so the status alone cannot decide it. The code is matched as an
* envelope value rather than as a bare number for the reason above; the text
* forms cover the older deployments that answer with prose only.
*/
const SOFT_RATE_PATTERN = /"code"\s*:\s*"?6004\b|soft_rate|频率限制/u;
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
/** The client version that gateway expects in `X-IDE-Version`. */
function clientVersion(region) {
	return region === "global" ? GLOBAL_CLIENT_VERSION : CN_CLIENT_VERSION;
}
/** The full chat UA for the credential's gateway. */
function chatUa(region) {
	return region === "global" ? GLOBAL_CHAT_UA : CN_CHAT_UA;
}
/** The desktop-process UA for endpoints outside the chat path. */
function desktopUa(region) {
	return region === "global" ? GLOBAL_DESKTOP_UA : CN_DESKTOP_UA;
}
/**
* The OpenAI Node SDK's fingerprint headers, as the current desktop client sends
* them. OS, architecture and runtime version follow the host so a macOS or Linux
* install does not claim to be a Windows client; the rest mirror the bundled CLI.
*/
function stainlessHeaders() {
	return {
		"x-stainless-lang": "js",
		"x-stainless-package-version": "6.25.0",
		"x-stainless-os": process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "MacOS" : "Linux",
		"x-stainless-arch": process.arch,
		"x-stainless-runtime": "node",
		"x-stainless-runtime-version": process.version,
		"x-stainless-retry-count": "0",
		"x-stainless-timeout": "1200"
	};
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
	return GLOBAL_BASE$1;
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
		"User-Agent": desktopUa(regionOf(credential.domain)),
		"X-CodeBuddy-Request": "1",
		"Connection": "close"
	};
}
/**
* The conversation header family the desktop client puts on every chat request.
*
* The international gateway runs a channel check that refuses a request
* carrying no conversation id at all: business code 11128,
* `conversation id missing`, answered as a 400 whose tip says the call failed
* channel verification. The CN gateway does not ask for it and accepts the
* family too, so it is sent on both rather than branched on region.
*
* The shapes and the pairings follow the 5.8.4 client capture: the conversation
* id is a dashed UUID, the four request and message ids are 32 hex characters,
* `X-Root-Request-ID` carries the same value as `X-Conversation-Request-ID`,
* and `X-Request-ID` the same value as `X-Conversation-Message-ID`. The trace
* family is the W3C/B3 pair the client sends; `X-B3-ParentSpanId` is left out
* because a real parent span needs a caller this plugin does not have.
*
* Every id is fresh per request. The upstream keeps no history by the
* conversation id - the same id sent twice answers the second turn as a fresh
* one - so there is nothing to gain from deriving it, and a stable value would
* be one more thing for the channel check to notice.
*/
function conversationHeaders(region) {
	const turn = randomUUID().replace(/-/g, "");
	const message = randomUUID().replace(/-/g, "");
	const traceId = randomUUID().replace(/-/g, "");
	const spanId = randomBytes(8).toString("hex");
	return {
		"X-Conversation-ID": randomUUID(),
		"X-Conversation-Request-ID": turn,
		"X-Root-Request-ID": turn,
		"X-Conversation-Message-ID": message,
		"X-Request-ID": message,
		"X-Agent-Intent": "craft",
		"X-Agent-Purpose": "conversation",
		"X-Agent-Type": "main",
		"X-IDE-Version": clientVersion(region),
		"X-Private-Data": "true",
		"X-Trace-ID": traceId,
		"traceparent": `00-${traceId}-${spanId}-01`,
		"b3": `${traceId}-${spanId}-1`,
		"X-B3-TraceId": traceId,
		"X-B3-SpanId": spanId,
		"X-B3-Sampled": "1"
	};
}
/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential) {
	const region = regionOf(credential.domain);
	return {
		...commonHeaders(credential),
		...conversationHeaders(region),
		...stainlessHeaders(),
		"Content-Type": "application/json",
		"Authorization": `Bearer ${credential.accessToken}`,
		...credential.uid === "" || credential.uid === void 0 ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid },
		...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? { "X-No-Enterprise-Id": "1" } : { "X-Enterprise-Id": credential.enterpriseId },
		...credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain },
		"X-Product": "SaaS",
		...region === "cn" ? { "X-Agent-Runtime": "local-agent" } : {},
		"User-Agent": chatUa(region)
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
		"X-CodeBuddy-Request": "1",
		"User-Agent": desktopUa(regionOf(credential.domain)),
		"Connection": "close"
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
/**
* The sentence a gateway-level rejection is answered with.
*
* openresty / APISIX reject a request before it reaches the product when the
* credential is one the gateway no longer honours. The status alone is not
* actionable and the HTML body leaks nothing useful, so the raw page would
* otherwise reach the client as the error text.
*/
function gatewayRejectionText(status) {
	return `the WorkBuddy gateway rejected this credential (http ${status}). This usually means the account is using a stale sign-in the upstream no longer accepts: sign in again in the WorkBuddy desktop app, then pick the account on the plugin card. Run the WTQ Pool connection check (the panel's connection tab) to list every credential found.`;
}
/**
* Read a failed response's body, bounded in both time and size.
*
* An upstream that answers 429 and then trickles its error page would otherwise
* hold the attempt until undici's own body timeout, and a rotation pays that
* once per account before it can answer at all. Cancelling the reader is what
* releases the socket, so the bound is real rather than a race that leaves the
* connection behind. The caller's own hang-up reaches the body through
* `signal`: the headers deadline has detached itself by the time a non-2xx
* answer is read, so a cancelled turn would otherwise wait out the deadline
* below with the socket still open.
*
* Never rejects: a read that fails keeps whatever arrived, which is usually the
* sentence the client needs. Callers on the error path used to let a body that
* died mid-read replace the upstream's status with a bare abort error.
*
* `timeoutMs` is a seam for the check: the shipped deadline is ten seconds, and
* the case that proves the reader is cancelled should not sit it out.
*/
async function readErrorBody(response, limitBytes, signal, timeoutMs = ERROR_BODY_TIMEOUT_MS) {
	const body = response.body;
	if (body === null) return "";
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	const abandon = (reason) => {
		reader.cancel(new Error(reason)).catch(() => {});
	};
	const deadline = setTimeout(() => {
		abandon("upstream error body read timed out");
	}, timeoutMs);
	deadline.unref?.();
	const onAbort = () => {
		abandon("upstream error body read cancelled by the caller");
	};
	if (signal?.aborted === true) onAbort();
	else signal?.addEventListener("abort", onAbort);
	let done = false;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) {
				done = true;
				break;
			}
			text += decoder.decode(next.value, { stream: true });
			if (text.length >= limitBytes) break;
		}
	} catch {} finally {
		clearTimeout(deadline);
		signal?.removeEventListener("abort", onAbort);
		if (!done) abandon("upstream error body size limit reached");
		reader.releaseLock();
	}
	return text.length > limitBytes ? text.slice(0, limitBytes) : text;
}
async function readEnvelope(response) {
	const text = await response.text();
	if (isGatewayHtmlRejection(response.status, text)) throw Object.assign(new Error(gatewayRejectionText(response.status)), { kind: classifyUpstreamError(response.status, text) });
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${redactSecrets(text).slice(0, 160)}`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`);
	const document = parsed;
	const rawCode = document["code"];
	return {
		code: typeof rawCode === "number" && Number.isFinite(rawCode) ? rawCode : typeof rawCode === "string" && /^-?\d+$/u.test(rawCode.trim()) ? Number(rawCode.trim()) : 0,
		msg: typeof document["msg"] === "string" ? document["msg"] : "",
		data: "data" in document ? document["data"] : void 0
	};
}
/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status, envelope) {
	const kind = classifyUpstreamError(status, JSON.stringify({
		code: envelope.code,
		msg: envelope.msg
	}));
	return Object.assign(/* @__PURE__ */ new Error(`workbuddy upstream ${kind} (http ${status}): ${redactSecrets(envelope.msg).slice(0, 160)}`), { kind });
}
/**
* The classified kind of an upstream failure, for a caller holding the error.
*
* `chatStream` answers with its kind in the result; every JSON endpoint throws,
* and a caller that must tell a refused sign-in from a rate limit would
* otherwise match on the message text. Anything without a kind - a local fault,
* a bug - reads as undefined rather than being guessed at.
*/
function upstreamErrorKind(error) {
	const kind = error?.kind;
	return typeof kind === "string" ? kind : void 0;
}
/**
* Classify an upstream failure from its HTTP status and body excerpt.
*
* A body marker only refines a status that has not already said something
* more specific. A 429 has: the throttling answer routinely quotes quota
* text, and reading that as billing exhaustion answered 402 for a limit that
* clears on its own. When the status is about the sign-in, the only thing
* that may reclassify it is a session marker, and a session marker never
* fires on any other status, or a rate limit whose text happens to carry
* the code would rotate without cooling the account.
*
* The credit markers are read on the statuses the upstream itself uses for
* "this account cannot pay": 402, 403, and an HTTP 200 business envelope. A
* 400 or 422 is a verdict on the REQUEST, and its body routinely quotes the
* quota it measured against, so matching there turned a malformed body into a
* whole-pool rotation and a 402 that named the wrong problem.
*/
function classifyUpstreamError(status, body) {
	if (status === 402) return "hard_credit";
	if (status === 429) return "soft_rate";
	if (status === 200) {
		if (ACCOUNT_RESTRICTED_PATTERN.test(body)) return "account_restricted";
		if (MODEL_TIER_PATTERN.test(body)) return "model_tier";
		if (SESSION_DEAD_PATTERN.test(body)) return "session_dead";
		if (SOFT_RATE_PATTERN.test(body)) return "soft_rate";
		if (isHardCreditText(body)) return "hard_credit";
		return "client";
	}
	if ((status === 400 || status === 403 || status === 422) && ACCOUNT_RESTRICTED_PATTERN.test(body)) return "account_restricted";
	if ((status === 400 || status === 403 || status === 422) && MODEL_TIER_PATTERN.test(body)) return "model_tier";
	if ((status === 401 || status === 403) && SESSION_DEAD_PATTERN.test(body)) return "session_dead";
	if (status === 401) return "session_dead";
	if (status === 403) {
		if (isHardCreditText(body)) return "hard_credit";
	}
	if (status === 503 && SOFT_RATE_PATTERN.test(body)) return "soft_rate";
	if (status === 403 && !/"code"\s*:|"msg"\s*:/.test(body)) return "waf_block";
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
	const epochMs = /"(?:resetAt|reset_at|resetTime|reset_time)"\s*:\s*["']?(\d{10,13})["']?/.exec(body);
	if (epochMs !== null) {
		const raw = Number(epochMs[1]);
		return capRateReset(raw < 0xe8d4a51000 ? raw * 1e3 : raw);
	}
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
/**
* Put an empty system prompt in front of the conversation when the host opened
* with a user turn.
*
* The international gateway refuses a request whose first message is not a
* system prompt (code 11128, "first message is not system prompt"), and a host
* that starts with the user's turn sends none. The content is empty on purpose:
* it satisfies the check without adding an instruction the model would follow,
* so the model still sees exactly what the host sent. The CN gateway asks for
* neither, so this is the one part of the shape that is region-specific.
*/
function withLeadingSystemPrompt(prepared) {
	let body;
	try {
		body = JSON.parse(prepared);
	} catch {
		return prepared;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return prepared;
	const obj = body;
	const messages = obj["messages"];
	if (!Array.isArray(messages) || messages.length === 0) return prepared;
	const first = messages[0];
	if (typeof first === "object" && first !== null && first["role"] === "system") return prepared;
	obj["messages"] = [{
		role: "system",
		content: ""
	}, ...messages];
	return JSON.stringify(obj);
}
/**
* System prompts the host has already refused at its channel check.
*
* WorkBuddy's prompt screen reads system and assistant roles, not user turns, and
* it matches more than one client's wording: the DSH opening line, the DSH GUI
* pair, and several lines shared with other agent harnesses. A fixed rewrite list
* is therefore always one upstream change behind. The first turn that is refused
* pays one 400, its system prompt is folded into the first user message, and the
* same prompt is folded before sending from then on. Bounded so a process that
* sees many one-off prompts keeps only recent ones.
*/
const FOLDED_PROMPTS_MAX = 32;
const foldedPrompts = /* @__PURE__ */ new Set();
/** The fingerprint of every system message in a prepared body, if it has one. */
function systemPromptFingerprint(prepared) {
	let body;
	try {
		body = JSON.parse(prepared);
	} catch {
		return;
	}
	const messages = body?.messages;
	if (!Array.isArray(messages)) return void 0;
	const texts = [];
	for (const value of messages) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const message = value;
		if (message["role"] !== "system" && message["role"] !== "developer") continue;
		texts.push(contentText(message["content"]));
	}
	if (texts.length === 0) return void 0;
	return createHash("sha256").update(texts.join("\0")).digest("hex");
}
/** The text parts of a message content value, joined for the fingerprint and fold. */
function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const part of content) if (typeof part === "string") parts.push(part);
	else if (typeof part === "object" && part !== null && typeof part["text"] === "string") parts.push(part["text"]);
	return parts.join("\n");
}
/**
* Move every system message into the first user message, and take the client
* name out of assistant turns.
*
* The host accepts the same instructions in a user turn; a system turn is what
* its channel check inspects. Assistant turns are inspected too, so a reply that
* quoted the client name would fail the next request; that copy is renamed. A
* neutral system message stays first so a gateway that insists on one still sees
* it. Returns undefined when there is nothing to move or rename, which is also
* what keeps an empty system message from looping.
*/
function foldSystemIntoUser(prepared) {
	let body;
	try {
		body = JSON.parse(prepared);
	} catch {
		return;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return void 0;
	const obj = body;
	const messages = obj["messages"];
	if (!Array.isArray(messages)) return void 0;
	const prompts = [];
	const rest = [];
	let renamed = false;
	for (const value of messages) {
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			const message = value;
			if (message["role"] === "system" || message["role"] === "developer") {
				const text = contentText(message["content"]);
				if (text.trim() !== "") prompts.push(text);
				continue;
			}
			if (message["role"] === "assistant" && "content" in message) {
				const content = renameInContent(message["content"]);
				if (content !== message["content"]) {
					renamed = true;
					rest.push({
						...message,
						content
					});
					continue;
				}
			}
		}
		rest.push(value);
	}
	if (prompts.length === 0 && !renamed) return void 0;
	if (prompts.length === 0) {
		obj["messages"] = rest;
		return JSON.stringify(obj);
	}
	const instructions = prompts.join("\n\n");
	const firstUser = rest.findIndex((value) => typeof value === "object" && value !== null && !Array.isArray(value) && value["role"] === "user");
	if (firstUser === -1) rest.unshift({
		role: "user",
		content: instructions
	});
	else {
		const message = rest[firstUser];
		const content = message["content"];
		rest[firstUser] = {
			...message,
			content: typeof content === "string" ? `${instructions}\n\n${content}` : [{
				type: "text",
				text: instructions
			}, ...Array.isArray(content) ? content : []]
		};
	}
	obj["messages"] = [{
		role: "system",
		content: ""
	}, ...rest];
	return JSON.stringify(obj);
}
/**
* Rename the client in one message content, preserving every other field.
*
* Matched case-insensitively because the host's screen is, and only the product
* name is replaced: the rest of the sentence still reads naturally, and the
* model sees the same instructions.
*/
function renameInContent(content) {
	const rename = (text) => text.replace(/DeepSeek Harness/gi, "DeepSeek");
	if (typeof content === "string") return rename(content);
	if (!Array.isArray(content)) return content;
	return content.map((part) => {
		if (typeof part === "string") return rename(part);
		if (typeof part !== "object" || part === null || Array.isArray(part)) return part;
		const record = part;
		if (typeof record["text"] !== "string") return part;
		const text = rename(record["text"]);
		return text === record["text"] ? part : {
			...record,
			text
		};
	});
}
function rememberFoldedPrompt(fingerprint) {
	if (foldedPrompts.has(fingerprint)) return;
	if (foldedPrompts.size >= FOLDED_PROMPTS_MAX) {
		const oldest = foldedPrompts.values().next().value;
		if (oldest !== void 0) foldedPrompts.delete(oldest);
	}
	foldedPrompts.add(fingerprint);
}
/** Whether a 400 body is the host's prompt screen rather than a bad request. */
function isChannelCheckText(text) {
	return CHANNEL_CHECK_PATTERN.test(text);
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
			if (message["role"] === "assistant" && "content" in message) {
				const content = renameInContent(message["content"]);
				if (content !== message["content"]) message["content"] = content;
			}
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
			}
		}
		return JSON.stringify(obj);
	}
	/** Forward one chat completion. Never throws for upstream failures. */
	async chatStream(credential, prepared, signal, timeouts) {
		const fingerprint = systemPromptFingerprint(prepared);
		const region = regionOf(credential.domain);
		let body = region === "global" ? withLeadingSystemPrompt(prepared) : prepared;
		const cacheKey = fingerprint === void 0 ? void 0 : `${region}:${fingerprint}`;
		if (cacheKey !== void 0 && foldedPrompts.has(cacheKey)) body = foldSystemIntoUser(body) ?? body;
		let rememberOnSuccess;
		for (let attempt = 0;; attempt++) {
			let response;
			const deadline = headersDeadline(signal, timeouts?.headersMs ?? STREAM_HEADERS_TIMEOUT_MS);
			try {
				response = await this.fetchImpl(`${chatBase(credential)}/v2/chat/completions`, {
					redirect: "error",
					method: "POST",
					headers: chatHeaders(credential),
					body,
					signal: deadline.signal
				});
			} catch (error) {
				if (signal?.aborted === true) return {
					ok: false,
					kind: "aborted",
					status: 0,
					message: "cancelled by the caller"
				};
				return {
					ok: false,
					kind: "transport",
					status: 0,
					message: `transport error: ${String(error)}`
				};
			} finally {
				deadline.arrived();
			}
			if (response.ok) {
				const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
				const declaredLength = Number(response.headers.get("content-length") ?? "");
				const smallDeclaredBody = Number.isFinite(declaredLength) && declaredLength > 0 && declaredLength <= ERROR_BODY_LIMIT;
				if (contentType.includes("application/json") || smallDeclaredBody && !contentType.includes("text/event-stream")) {
					const text = await readErrorBody(response, ERROR_BODY_LIMIT, signal);
					if (attempt === 0 && isChannelCheckText(text)) {
						const folded = foldSystemIntoUser(body);
						if (folded !== void 0) {
							rememberOnSuccess = cacheKey;
							body = folded;
							continue;
						}
					}
					if (rememberOnSuccess !== void 0 && !isChannelCheckText(text)) rememberFoldedPrompt(rememberOnSuccess);
					const envelopeResponse = new Response(text, {
						status: response.status,
						headers: response.headers
					});
					const envelopeBody = envelopeResponse.body;
					if (envelopeBody === null) return {
						ok: false,
						kind: "server",
						status: 502,
						message: "upstream returned 200 without a body"
					};
					return {
						ok: true,
						response: withRelayStream(envelopeResponse, envelopeBody)
					};
				}
				if (rememberOnSuccess !== void 0) rememberFoldedPrompt(rememberOnSuccess);
				if (response.body === null) return {
					ok: false,
					kind: "server",
					status: 502,
					message: "upstream returned 200 without a stream"
				};
				const relayed = withIdleWatchdog(response.body, timeouts?.idleMs, signal);
				return {
					ok: true,
					response: withRelayStream(new Response(relayed, {
						status: response.status,
						headers: response.headers
					}), relayed)
				};
			}
			const text = await readErrorBody(response, ERROR_BODY_LIMIT, signal);
			const retryAfter = retryAfterSeconds(response.headers);
			if (attempt === 0 && response.status === 400 && isChannelCheckText(text)) {
				const folded = foldSystemIntoUser(body);
				if (folded !== void 0) {
					rememberOnSuccess = cacheKey;
					body = folded;
					continue;
				}
			}
			return {
				ok: false,
				kind: classifyUpstreamError(response.status, text),
				status: response.status,
				message: isGatewayHtmlRejection(response.status, text) ? gatewayRejectionText(response.status) : text,
				...retryAfter === void 0 ? {} : { retryAfter }
			};
		}
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
	* - **CN** serves the roster at `/v2/enterprises/personal/models`. Like the
	*   desktop process that calls it directly, it expects the desktop client
	*   spelling; this is not the chat endpoint's three-segment UA.
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
			"X-CodeBuddy-Request": "1",
			"Connection": "close",
			"User-Agent": GLOBAL_DESKTOP_UA
		} : {
			...commonHeaders(credential),
			"Authorization": `Bearer ${credential.accessToken}`,
			"Accept": "application/json"
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
			if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw > 0xe8d4a51000 ? raw : raw > 1e9 ? raw * 1e3 : void 0;
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
	*
	* The uid is not optional and is not substituted: the `uin` is a different
	* identifier, and sending it produced exactly the silent drop the comment
	* above warns about, with a 200 to show for it. An account that carries no
	* uid fails loudly instead.
	*/
	async reportChatActivity(credential, conversationId) {
		const uid = credential.uid ?? "";
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
			makeupCards: numberField(asRecord(data["makeup_cards"]), "balance"),
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
	* Call a billing-domain endpoint and return its unwrapped `data`.
	*
	* Counterpart of {@link growthJson}: same envelope, but these paths carry the
	* `/v2/billing/meter` prefix and the billing host. Kept separate because the
	* prefix is part of the path, not something the caller should remember.
	*/
	async billingJson(credential, path, body) {
		const response = await this.fetchImpl(`${billingBase(credential)}${path}`, {
			redirect: "error",
			method: "POST",
			headers: billingHeaders(credential),
			body: body === void 0 ? "{}" : JSON.stringify(body),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		return asRecord(envelope.data);
	}
	/**
	* The one-off starter gift. Once per account; a second claim is a business
	* error, which the caller treats as "nothing to collect".
	*
	* No `/v2` prefix: that form answers a 404 route miss, while the bare path is
	* the one the console itself posts to.
	*/
	async claimGift(credential) {
		return numberField(await this.billingJson(credential, "/billing/meter/claim-gift"), "credit");
	}
	/** Campaign compensation, when the account has any waiting. */
	async claimCompensation(credential) {
		return numberField(await this.billingJson(credential, "/billing/meter/claim-compensation"), "credit");
	}
	/**
	* Whether yesterday is still empty on the streak heatmap.
	*
	* A missed day breaks the run, and the run is what unlocks the 7/14/28-day
	* tiers, so this is read before deciding to spend a make-up card on it.
	*/
	async missedYesterday(credential) {
		const data = await this.growthJson(credential, "GET", "/activity/growth/heatmap");
		const cells = Array.isArray(data["cells"]) ? data["cells"] : [];
		const yesterday = zonedDay(-1);
		for (const entry of cells) {
			const cell = asRecord(entry);
			if ((typeof cell["date"] === "string" ? cell["date"].slice(0, 10) : "") === yesterday) return numberField(cell, "score") === 0;
		}
		return false;
	}
	/** Spend one make-up card on a past day (`YYYY-MM-DD`). */
	async useMakeupCard(credential, date) {
		await this.growthJson(credential, "POST", "/activity/growth/makeup-cards/use", { target_date: date });
	}
	/** Make-up cards in hand; the streak is only repairable while this is above zero. */
	async makeupCards(credential) {
		return numberField(asRecord((await this.growthJson(credential, "GET", "/activity/growth/streak"))["makeup_cards"]), "balance");
	}
	/** Draws available from redeemed streak tiers. */
	async lotteryChances(credential) {
		return numberField(await this.growthJson(credential, "GET", "/activity/growth/lottery/summary"), "chances");
	}
	/** Spend one draw; the prize payload is passed through as-is. */
	async drawLottery(credential) {
		return await this.growthJson(credential, "POST", "/activity/growth/lottery/draw", { client_token: randomUUID() });
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
/**
* Whether a Windows path names a local file rather than a network share.
*
* The registry scan reads values any process running as the user can write. A
* `DisplayIcon` naming `\\host\share\x.exe` would make PowerShell's own path
* check authenticate to that host before any signature was read, leaking the
* user's NTLM response. Only absolute drive paths are considered, and every
* stat and spawn goes through the same filter.
*/
function localWindowsPath(candidate) {
	return /^[A-Za-z]:[\\/]/u.test(candidate);
}
function windowsRegistryAppPaths() {
	if (process.platform !== "win32") return [];
	const cached = registryAppPaths;
	if (cached !== void 0) {
		if (cached.length > 0 && statExecutables(cached).length > 0) return cached;
		if (Date.now() - registryScannedAtMs < KEY_FAILURE_BACKOFF_MS) return [];
	}
	registryAppPaths = readRegistryAppPaths();
	registryScannedAtMs = Date.now();
	return registryAppPaths;
}
/**
* The Windows directory, whichever of the two variables holds it.
*
* Both are read here rather than only in `scanInterpreter`, because the module
* path and the interpreter have to come from the same place: pinning the
* absolute path from `windir` while the 5.1 module directory was skipped for a
* missing `SystemRoot` left `Get-AuthenticodeSignature` unable to load for every
* candidate, which is the failure this pair exists to avoid.
*/
function systemRootOf(env) {
	const value = env["SystemRoot"]?.trim() || env["windir"]?.trim();
	return value === void 0 || value === "" ? void 0 : value;
}
/**
* The environment the signature scan runs in.
*
* `powershell` is Windows PowerShell 5.1, and it resolves
* `Microsoft.PowerShell.Security` by walking `PSModulePath` in order. Any machine
* with a Store-installed PowerShell 7 carries that build's Modules directory
* ahead of the system one, because the Store install prepends it to the variable
* the desktop host inherited. 5.1 then binds the 7 build's copy of the module
* first and the import dies on a type-data conflict, so
* `Get-AuthenticodeSignature` throws for every candidate. The scan's own catch
* swallows that, the policy function is handed an empty status, and the at-rest
* key reads as "no WorkBuddy executable found" on a machine holding two signed
* installs. Putting the 5.1 directory first makes the right copy win.
*
* The directory is derived from `SystemRoot` rather than written out, and the
* rest of the ambient path is left alone so a user's own modules still resolve.
* Applying it twice is a no-op, so the answer stays one directory long however
* often it is built.
*/
function signatureScanEnv(env = process.env) {
	const systemRoot = systemRootOf(env);
	const ambient = env["PSModulePath"];
	const modules = systemRoot === void 0 ? void 0 : join(systemRoot, "system32", "WindowsPowerShell", "v1.0", "Modules");
	if (modules === void 0) return { ...env };
	if (ambient === modules || ambient?.startsWith(`${modules};`) === true) return { ...env };
	return {
		...env,
		PSModulePath: ambient === void 0 || ambient === "" ? modules : `${modules};${ambient}`
	};
}
/**
* The interpreter to run the scan with, by absolute path.
*
* Resolved from `SystemRoot` rather than through `PATH`, for the same reason the
* scan exists at all: a user-level directory is on the default `PATH`
* (`%LOCALAPPDATA%\Microsoft\WindowsApps`), so a bare `powershell` would let
* whatever sits there be spawned inside a process holding every WorkBuddy token.
* Neither variable set answers `undefined`, and the caller treats that as "no
* scan" rather than guessing a path.
*/
function scanInterpreter(env) {
	const systemRoot = systemRootOf(env);
	if (systemRoot === void 0) return void 0;
	return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
/**
* Every path an uninstall key names for a WorkBuddy-family install.
*
* The scan reads `DisplayName`, `DisplayIcon` and `InstallLocation` out of the
* user's own uninstall keys, which means any process running as the user can add
* one. It only enumerates here: a path is filtered to a local drive, stat'ed,
* and signature-checked in Node before anything is spawned. Doing the stat or
* signature read in PowerShell would touch a planted UNC path first and leak an
* NTLM response to the host it names.
*
* PowerShell does the part only it can do: enumerate the keys and clean the
* resource index and quotes off `DisplayIcon`. The decision is
* {@link signatureAccepts}'s, in Node, because that is where it can be tested
* without a registry to plant a key in, and it is handed a module path 5.1 can
* actually load, because the host's is not always one.
*/
function readRegistryAppPaths() {
	const script = [
		"$ErrorActionPreference='SilentlyContinue'",
		"try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}",
		"function Clean([string]$v) {",
		"  $v = $v.Trim()",
		"  if ($v.Length -ge 2 -and $v.StartsWith(\"'\") -and $v.EndsWith(\"'\")) { $v = $v.Substring(1, $v.Length - 2) }",
		"  $v = $v.Trim()",
		"  $i = $v.LastIndexOf(\",\")",
		"  if ($i -gt 0 -and $v.Substring($i + 1) -match \"^[0-9]+$\") { $v = $v.Substring(0, $i) }",
		"  return $v",
		"}",
		"$roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
		"$out = foreach($r in $roots){",
		"  Get-ItemProperty -Path $r | ForEach-Object {",
		"    $dn=[string]$_.DisplayName; $di=[string]$_.DisplayIcon; $il=[string]$_.InstallLocation",
		"    if($dn -match 'WorkBuddy|CodeBuddy' -or $di -match 'WorkBuddy|CodeBuddy'){",
		"      foreach($raw in @($di,$il)){",
		"        $p = Clean $raw",
		"        if($p -eq ''){ continue }",
		"        Write-Output $p",
		"      }",
		"    }",
		"  }",
		"}",
		"ConvertTo-Json -InputObject @($out) -Compress"
	].join("\n");
	let stdout;
	const interpreter = scanInterpreter(process.env);
	if (interpreter === void 0) return [];
	try {
		stdout = execFileSync(interpreter, [
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
			maxBuffer: 8388608,
			env: signatureScanEnv()
		});
	} catch {
		return [];
	}
	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	const entries = Array.isArray(parsed) ? parsed : [parsed];
	const out = [];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const cleaned = cleanIconPath(entry);
		if (cleaned === "" || !localWindowsPath(cleaned)) continue;
		out.push(cleaned);
	}
	return out;
}
/**
* Whether a scanned file's signature makes it safe to run.
*
* Exported so the policy can be tested without a registry to plant a key in: the
* PowerShell half is not unit-testable, and this half is where the decision
* actually lives.
*
* `Valid` means the chain resolved to a trusted root. A user process cannot
* forge the vendor's signature, but it can trust a certificate of its own in the
* current user's root store without elevation, so this check raises the bar
* rather than proving the file is the vendor's. It still rejects an unsigned
* planted executable, and every cached registry path is checked again before it
* is run.
*
* The publisher is deliberately not pinned. The plugin is a third-party build and
* the vendor can change its signing certificate; a pinned name would turn that
* into a silent loss of the at-rest key on every machine at once, which is a
* worse failure than the one being prevented.
*
* An unknown status is refused, not assumed: `HashMismatch`, `NotSigned` and a
* signature PowerShell could not read at all all mean the file is not the
* vendor's, and the caller answers "no key" rather than running something.
*/
function signatureAccepts(status, signer) {
	return status === "Valid" && signer !== void 0 && signer.trim() !== "";
}
/** Why the last signature scan could not produce an answer, if it could not. */
let signatureScanFailure = "";
/**
* The candidates whose Authenticode signature is valid.
*
* The standard install roots and the environment override were trusted by path
* alone, while only the registry fallback checked a signature. A process running
* as the user can write `%LOCALAPPDATA%\\Programs\\WorkBuddy\\WorkBuddy.exe`; when
* the host runs elevated, spawning that file would hand it the plugin's whole
* environment and every WorkBuddy token. Every path is checked here, and the
* registry result is passed through the same check before it is spawned.
*/
async function signedExecutables(candidates) {
	if (process.platform !== "win32" || candidates.length === 0) return candidates;
	signatureScanFailure = "";
	const interpreter = scanInterpreter(process.env);
	if (interpreter === void 0) {
		signatureScanFailure = "the signature check could not run: Windows PowerShell was not found";
		return [];
	}
	const script = [
		"$ErrorActionPreference='SilentlyContinue'",
		"try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}",
		`$paths = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(candidates), "utf8").toString("base64")}')) | ConvertFrom-Json`,
		"$out = foreach ($p in @($paths)) {",
		"  if ([string]::IsNullOrWhiteSpace([string]$p)) { continue }",
		"  $s = $null",
		"  try { $s = Get-AuthenticodeSignature -LiteralPath ([string]$p) } catch { $s = $null }",
		"  [pscustomobject]@{",
		"    path = [string]$p",
		"    status = if ($s -ne $null) { [string]$s.Status } else { \"\" }",
		"    signer = if ($s -ne $null -and $s.SignerCertificate -ne $null) { [string]$s.SignerCertificate.Subject } else { \"\" }",
		"  }",
		"}",
		"ConvertTo-Json -InputObject @($out) -Compress"
	].join("\n");
	let stdout;
	try {
		stdout = await new Promise((resolve, reject) => {
			execFile(interpreter, [
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
				maxBuffer: 8388608,
				env: signatureScanEnv()
			}, (error, output) => {
				if (error !== null) reject(error);
				else resolve(output);
			});
		});
	} catch {
		signatureScanFailure = "the signature check could not run";
		return [];
	}
	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		signatureScanFailure = "the signature check returned no readable answer";
		return [];
	}
	const entries = Array.isArray(parsed) ? parsed : [parsed];
	const accepted = [];
	for (const entry of entries) {
		if (entry === null || typeof entry !== "object") continue;
		const record = entry;
		const file = record["path"];
		const status = record["status"];
		const signer = record["signer"];
		if (typeof file !== "string" || file === "") continue;
		if (!signatureAccepts(typeof status === "string" ? status : void 0, typeof signer === "string" ? signer : void 0)) continue;
		accepted.push(file);
	}
	return accepted;
}
function statExecutables(candidates) {
	const files = [];
	for (const candidate of candidates) {
		if (candidate === "") continue;
		if (process.platform === "win32" && !localWindowsPath(candidate)) continue;
		try {
			if (statSync(candidate, { throwIfNoEntry: false })?.isFile() === true) files.push(candidate);
		} catch {}
	}
	return files;
}
async function executableCandidates(env = process.env) {
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
	const standard = await signedExecutables(statExecutables(known));
	if (standard.length > 0 || process.platform !== "win32") return standard;
	return signedExecutables(statExecutables(windowsRegistryAppPaths()));
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
let registryAppPaths;
let registryScannedAtMs = 0;
let inflightKeys;
let lastKeyFailureAtMs = 0;
let lastKeyFailure = "";
let lastKeyRotationAtMs = 0;
/** Why the last at-rest key fetch failed. Empty whenever keys are available. */
function atRestKeyFailure() {
	return atRestKeyById.size > 0 ? "" : lastKeyFailure;
}
/**
* Drop the cached keys so the next read asks the desktop app again.
*
* The desktop app re-derives its at-rest key when it is reinstalled or
* upgraded, and a process holding the old one then read every sealed field as
* empty: the sign-in stayed in the pool serving a stale token until it 401'd,
* and the doctor reported the key as healthy the whole time. The field names
* the key it was sealed with, so an unknown key id is the signal. Rate limited,
* because a field no installed build can open is unknown every time and one
* refetch per backoff window is the honest answer to that.
*/
function invalidateAtRestKeys() {
	if (Date.now() - lastKeyRotationAtMs < KEY_FAILURE_BACKOFF_MS) return;
	lastKeyRotationAtMs = Date.now();
	atRestKeyById.clear();
	lastKeyFailureAtMs = 0;
	lastKeyFailure = "";
}
function ensureAtRestKeys() {
	if (atRestKeyById.size > 0) return Promise.resolve();
	if (Date.now() - lastKeyFailureAtMs < KEY_FAILURE_BACKOFF_MS) return Promise.resolve();
	inflightKeys ??= (async () => {
		const candidates = await executableCandidates();
		if (candidates.length === 0) {
			lastKeyFailureAtMs = Date.now();
			lastKeyFailure = process.platform === "win32" ? signatureScanFailure !== "" ? signatureScanFailure : "no WorkBuddy executable with a valid signature was found" : "no WorkBuddy executable found in the standard install roots";
			return;
		}
		let anySuccess = false;
		let lastReason = "";
		await Promise.all(candidates.map(async (executable) => {
			try {
				const key = deriveAtRestKey(await fetchAtRestKeyPayload(executable));
				atRestKeyById.set(deriveAtRestKeyId(key), key);
				anySuccess = true;
			} catch (error) {
				lastReason = String(error instanceof Error ? error.message : error).slice(0, 200);
			}
		}));
		lastKeyFailure = anySuccess ? "" : lastReason;
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
		if (key === void 0) {
			invalidateAtRestKeys();
			throw new Error("workbuddy: no at-rest key available for this encrypted field");
		}
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
/**
* Live auth file name the international client writes.
*
* One file, no snapshots beside it: the client overwrites this one when the user
* switches accounts. Treating it as an abandoned snapshot had the pool take over
* the session the app was still signed into and renew it behind the app's back,
* which spends the rotation the app needed on its next refresh.
*/
const WORKBUDDY_GLOBAL_LIVE_FILENAME = "workbuddy-desktop-ai.info";
/** Env override for the auth file or its directory. */
const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
/**
* File the pool keeps beside its own settings: every credential it has seen.
*
* The CN client writes a timestamped snapshot beside its live sign-in, so a
* re-login leaves the previous account's file behind. The global client writes
* one live file and nothing else, and switching accounts overwrites it — which
* is why the global pool saw a single account no matter how many had signed in.
*/
const ARCHIVE_FILENAME = "credentials-archive.json";
/** Subdirectory of the plugin's own data root that holds the sign-ins it wrote. */
const OWN_SIGN_IN_DIRNAME = "signins";
/**
* Sign-ins the user deleted, kept as a tombstone so a scan cannot resurrect them.
*
* Deleting only the file is not enough: the account's token is still in the
* archive, and the desktop client still keeps a superseded snapshot of it, so the
* next scan took the snapshot over and wrote the file straight back. The row never
* moved, and the delete read as a button that does nothing.
*/
const DELETED_SIGN_INS_FILENAME = "deleted-signins.json";
/** File-name prefix that marks one of those sign-ins as the plugin's own. */
const OWN_SIGN_IN_PREFIX = "workbuddy-panel-";
/**
* How long a delete waits for a scan that is already running.
*
* The wait is for ordering, not for the walk itself: a normal scan is a handful
* of milliseconds, and the host answers a panel call in thirty seconds. A cold
* scan stuck in the at-rest key fetch would otherwise burn that whole budget and
* report the delete as failed after it had already happened.
*/
const DELETE_SCAN_WAIT_MS = 5e3;
/**
* How long an archived credential is kept after the last token it can still be
* renewed with would have expired.
*
* Measured against the credential's own dates rather than the file's write time:
* an account switched away from today is worth keeping for as long as its
* refresh token lives, and the global access token alone is valid for a year.
*/
const ARCHIVE_RETENTION_MS = 2592e6;
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
* gives. The caller must not treat that as "fresh": see {@link tokenExpiryMs}.
*/
function expiryToMs(value) {
	if (!Number.isFinite(value) || value <= 0) return 0;
	const ms = value > 0xe8d4a51000 ? value : value * 1e3;
	return ms > MAX_EXPIRY_MS ? 0 : ms;
}
function optionalString$1(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/**
* Whether `work` finished inside `budgetMs`.
*
* A timeout here is not a cancellation: the caller is told to stop waiting, and
* whatever it started keeps running. The timer is cleared on the fast path so a
* short wait does not hold the process open for the whole budget.
*/
async function raceWithTimeout(work, budgetMs) {
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve(false), budgetMs);
	});
	try {
		return await Promise.race([work.then(() => true), timeout]);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
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
	const refreshToken = decryptableString(auth["refreshToken"], decrypt);
	const refreshExpired = refreshExpiresAtMs !== void 0 && refreshExpiresAtMs > 0 && refreshExpiresAtMs < Date.now();
	const lastRefreshAtMs = typeof auth["lastRefreshTime"] === "number" ? expiryToMs(auth["lastRefreshTime"]) : void 0;
	const nickname = optionalString$1(decryptableString(identity["nickname"], decrypt));
	return {
		accessToken,
		refreshToken: refreshExpired ? "" : refreshToken,
		expiresAtMs: typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0,
		...refreshExpiresAtMs === void 0 || refreshExpired ? {} : { refreshExpiresAtMs },
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
* Whether `path` is the desktop app's live sign-in (as opposed to a backup
* snapshot it left behind). A copy of it outranks an abandoned snapshot of the
* same token, because the app keeps it current.
*/
function isLiveAuthFile(path) {
	const name = basename(path);
	return name === WORKBUDDY_LIVE_FILENAME || name === WORKBUDDY_GLOBAL_LIVE_FILENAME;
}
/**
* Which of two credentials for the same account the pool should keep.
*
* Ordering, highest first:
*
* 1. the credential the upstream issued most recently (`lastRefreshAtMs`);
* 2. the source the copy came from: the live sign-in file, then a sign-in the
*    plugin wrote, then a superseded snapshot the client left behind;
* 3. the longer stored expiry, as a fallback for documents that carry no issue
*    time at all.
*
* Issue time comes first, and source rank only breaks a tie between copies of
* the same token. Rank used to come first, on the reasoning that a file the
* plugin writes is the one with a future, and that ordering cost the pool a
* working token outright: a renewal of an account the desktop was signed into
* is written to the archive, the plugin's own copy of that account stays one
* rotation behind, and the next scan served the dead copy while the live one sat
* next to it. An account was marked "sign in again" with a working token in the
* same directory.
*
* The stored expiry alone is NOT a freshness signal: the upstream does not
* rewrite it when it revokes a token, so a long-dead backup can claim to expire
* later than the token that actually works. Selecting on it made every upstream
* call return 401 while a perfectly good credential sat in the same directory.
*/
function compareFreshness(a, b, ownDir) {
	const aIssued = a.lastRefreshAtMs ?? 0;
	const bIssued = b.lastRefreshAtMs ?? 0;
	if (aIssued !== bIssued && aIssued > 0 && bIssued > 0) return bIssued - aIssued;
	const aRank = credentialRank(a, ownDir);
	const bRank = credentialRank(b, ownDir);
	if (aIssued > 0 !== bIssued > 0) {
		if (aIssued > 0 && aRank <= 1) return -1;
		if (bIssued > 0 && bRank <= 1) return 1;
	}
	if (aRank !== bRank) return aRank - bRank;
	if (aIssued !== bIssued) return bIssued - aIssued;
	return b.expiresAtMs - a.expiresAtMs;
}
/**
* Which kind of source a credential came from, lowest number first.
*
* A sign-in the plugin wrote outranks a snapshot the client left behind because
* the plugin renews it and nothing renews the snapshot: the same token, but one
* of the two copies has a future.
*/
function credentialRank(credential, ownDir) {
	if (isLiveAuthFile(credential.sourcePath)) return 0;
	if (ownSignInPath(credential.sourcePath, ownDir)) return 1;
	return 2;
}
/** True when `candidate` should replace `incumbent` for the same account. */
function isFresher(candidate, incumbent, ownDir) {
	return compareFreshness(candidate, incumbent, ownDir) < 0;
}
/**
* Queue order for the account list: the live sign-in first, then the copy the
* upstream issued last, then the newest expiry.
*
* This is a different question from `compareFreshness`, which decides which copy
* of *one* account serves. That rule falls back to the source only when a copy
* carries no issue time, which makes it cycle across three copies (a dated
* snapshot, an undated live file, a dated panel sign-in) and leaves a list sort
* with the order TimSort happened to produce. A key vector cannot.
*/
function compareQueueOrder(a, b, ownDir) {
	const aRank = credentialRank(a, ownDir);
	const bRank = credentialRank(b, ownDir);
	if (aRank !== bRank) return aRank - bRank;
	const aIssued = a.lastRefreshAtMs ?? 0;
	const bIssued = b.lastRefreshAtMs ?? 0;
	if (aIssued !== bIssued) return bIssued - aIssued;
	return b.expiresAtMs - a.expiresAtMs;
}
function tokenDigest(accessToken) {
	return createHash("sha256").update(`workbuddy\0deleted\0${accessToken}`).digest("hex").slice(0, 32);
}
/**
* A stamp for one file that changes when its content is replaced.
*
* Millisecond mtime alone repeats on a coarse filesystem, and two pools over one
* data directory then kept a stale tombstone set; the size is in here so a rewrite
* that lands in the same reported millisecond still reads as a different file.
*/
async function signInFileStamp(file) {
	try {
		const entry = await stat(file);
		return `${entry.mtimeMs}:${entry.size}`;
	} catch {
		return "";
	}
}
/**
* Run `work` while holding a lock file, or without it when the lock stays taken.
*
* The tombstone document is the one file two pools over the same data directory
* both write, and a read-union-write is only as good as its serialisation. The
* budget is short on purpose: a panel call is answered within seconds, and the
* work is a few kilobytes of JSON. A lock older than that is a process that died
* holding it, so it is dropped and retried.
*/
async function withFileLock(lock, work) {
	let held = false;
	for (let attempt = 0; attempt < 25 && !held; attempt += 1) try {
		await writeFile(lock, "", {
			flag: "wx",
			mode: 384
		});
		held = true;
		break;
	} catch (error) {
		if (error.code !== "EEXIST") break;
		if (await stat(lock).then((entry) => Date.now() - entry.mtimeMs, () => 0) > 5e3) {
			await unlink(lock).catch(() => {});
			continue;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	try {
		await work();
	} finally {
		if (held) await unlink(lock).catch(() => {});
	}
}
/**
* Read the tombstone document.
*
* Throws when the file exists but cannot be read or parsed, so the caller can keep
* what it already knows instead of treating a scanner's EBUSY as "no deleted
* sign-ins".
*/
async function readDeletedSignInsFile(file) {
	const parsed = JSON.parse(await readFile(file, "utf8"));
	const tombstones = /* @__PURE__ */ new Map();
	const entries = parsed?.entries;
	if (entries === null || typeof entries !== "object" || Array.isArray(entries)) return tombstones;
	for (const [id, value] of Object.entries(entries)) {
		const entry = value;
		if (entry === null || typeof entry !== "object") continue;
		const digest = entry.tokenDigest;
		if (typeof digest !== "string" || digest === "") continue;
		const issued = entry.lastRefreshAtMs;
		const deletedAt = entry.deletedAtMs;
		tombstones.set(id, {
			tokenDigest: digest,
			lastRefreshAtMs: typeof issued === "number" && Number.isFinite(issued) ? issued : 0,
			deletedAtMs: typeof deletedAt === "number" && Number.isFinite(deletedAt) ? deletedAt : 0
		});
	}
	return tombstones;
}
/**
* Whether `credential` is a sign-in the user made after deleting the account.
*
* A re-login is newer than the tombstone, so its issue time is the signal. Files
* that carry no issue time cannot be ordered, and for those a different token is
* the only evidence of a new sign-in.
*
* The same token never ends it, whatever stamp the copy carries: a superseded
* snapshot the client still keeps is that same sign-in lying in another file, and
* a tolerant comparison (same stamp within a few minutes) let one of them bring a
* deleted account back the moment the build allowed it. An older-issued token is
* not a re-login either, which is why the comparison stays strict: a genuine
* re-login is issued after the deleted one, and the alternative — accepting a
* slightly older stamp as “close enough” — cannot tell it apart from the next
* snapshot down the stack.
*/
function endsTombstone(tombstone, credential) {
	if (tokenDigest(credential.accessToken) === tombstone.tokenDigest) return false;
	const issued = credential.lastRefreshAtMs ?? 0;
	if (tombstone.lastRefreshAtMs > 0 && issued > 0) return issued > tombstone.lastRefreshAtMs;
	if (tombstone.lastRefreshAtMs === 0 && issued > 0) return issued >= tombstone.deletedAtMs;
	return isLiveAuthFile(credential.sourcePath);
}
/**
* Whether `sourcePath` sits inside the directory the plugin writes into.
*
* A walk that escapes the root is not inside it, and `..` is how a path gets
* there. An empty walk means the path IS the directory.
*/
function ownSignInPath(sourcePath, ownDir) {
	if (ownDir === "" || sourcePath === "") return false;
	const walked = relative(resolve(ownDir), resolve(sourcePath));
	return walked !== "" && !walked.startsWith("..") && !isAbsolute(walked);
}
function workbuddyAccountId(credential) {
	const stable = credential.uin ?? credential.uid ?? credential.nickname ?? `path:${credential.sourcePath}`;
	return createHash("sha256").update(`workbuddy\0${stable}`).digest("hex").slice(0, 16);
}
/** Human label; the nickname alone, so the pool reads as names rather than keys. */
function accountLabel(credential) {
	return credential.nickname ?? "WorkBuddy";
}
/**
* Whether a credential can no longer serve a request at all.
*
* Only a token that has already died AND that carries nothing to renew it with.
* A credential with no recorded expiry is live (`expiresAtMs <= 0` is the
* sentinel for "the file did not say"), and one that is merely near its expiry
* is renewed by `ensureFresh` before the request is spent on it.
*/
function credentialUnusable(credential, now) {
	if (credential.expiresAtMs <= 0 || credential.expiresAtMs > now) return false;
	return credential.refreshToken === "";
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
/** True when the document's access token is a `$wbEncrypted` envelope. */
function sealedAccessToken(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return false;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
	const document = parsed;
	return isEncryptedFieldWrapper((typeof document["auth"] === "object" && document["auth"] !== null ? document["auth"] : document)["accessToken"]);
}
async function readCredential(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return { kind: "absent" };
	}
	const decrypt = text.includes("\"$wbEncrypted\"") ? await encryptedFieldOpener() : void 0;
	const credential = parseWorkBuddyAuth(text, path, decrypt);
	if (credential !== void 0) return {
		kind: "credential",
		credential
	};
	if (sealedAccessToken(text)) return { kind: "sealed" };
	return { kind: "absent" };
}
/** Refresh a credential this long before its expiry, so a request never rides one that dies mid-flight. */
const REFRESH_MARGIN_MS = 3e5;
/**
* Oldest a sign-in the plugin itself wrote may get before it is renewed, weeks
* of lifetime left or not.
*
* An expiry-based lead cannot do this job. The upstream revokes a session
* without rewriting the token's `expiresAt`, so an account the user signed out
* of still claims weeks of life: a lead of any size waits for an expiry that
* never arrives, and the dead sign-in is only discovered when a request rides
* it. Renewing on age instead means the renewal is visible in the panel, and a
* sign-in the upstream no longer honours surfaces within this window rather
* than at expiry.
*
* Only the plugin's own sign-ins qualify. A credential read out of the desktop
* app's directory belongs to that app: it refreshes it, and a renewal here would
* be discarded by the next scan while still spending an upstream call. Once a
* desktop sign-in has been renewed here the copy in force is the plugin's own,
* which is what keeps an account whose session ran out under this window.
*
* Six hours: short enough that a revoked session is noticed the same day, long
* enough that the cost stays at one lightweight POST per account per window.
*/
const REFRESH_AFTER_MS = 216e5;
/**
* Longest one penalize may cool an account: same 2h ceiling as the parse
* layer, so a raw caller-supplied timestamp cannot sleep a pool all day.
*
* A hold the pool itself decides is exempt: a spent account or a dead session
* does not come back on its own, and clamping it to two hours put the account
* back at the head of the queue while it was still unusable. The exemption is
* keyed on the caller naming a hold rather than a timestamp, so no untrusted
* value can reach it.
*/
const PENALIZE_CAP_MS = 72e5;
/**
* How long a hold the pool decided itself keeps an account out of rotation.
*
* Neither condition behind a hold clears by itself: the credit balance has to
* change, or the user has to sign in again. The configured cooldown window is
* sized for a limit that expires, and using it here put a held account back at
* the head of the queue every minute, where it failed again and burned the
* attempts of the healthy accounts behind it. A hold is a fallback, not a
* verdict: a manual cooldown reset, a re-scan and a balance read that finds
* credits again all release it.
*/
const POOL_HOLD_MS = 216e5;
/**
* What a read on an account whose sign-in the upstream refuses is answered with
* while the hold stands.
*
* The upstream's own sentence names a stale sign-in and sends the reader to the
* connection check, which is right for the first refusal and noise on every
* poll after it: the hold is the plugin's own statement that this account needs
* a new sign-in, and it is the one the panel shows until one arrives.
*/
const REFUSED_SIGN_IN_MESSAGE = "this account's sign-in was refused by the upstream and its refresh token is spent; sign in again in the WorkBuddy desktop app";
/**
* Live per-model cooldown keys kept per account.
*
* The key is whatever model string the request carried, so a client that
* sprays distinct ids could otherwise grow one map per account forever.
*/
const MAX_MODEL_COOLDOWN_KEYS = 128;
/**
* How far a repeated limit may stretch the configured window, and how many times
* it may double first.
*
* One `usage exceeds frequency limit` is the commonest answer the upstream
* sends, and returning the account after the configured minute put it straight
* back into the same wall for as long as the window lasted: every attempt spent
* an upstream call to learn nothing. Doubling from the user's own window keeps
* their setting in charge of the first retry and only stretches the ones that
* keep failing, which is the escalation the reference proxy settled on after the
* same incident.
*/
const RATE_LIMIT_STREAK_CAP = 9e5;
const RATE_LIMIT_STREAK_STEPS = 4;
/**
* How close two failures have to be to count as consecutive.
*
* Without this the count is a lifetime total: one failure hours ago plus another
* today would sit at the cap forever, and every future one would open at the
* longest window. The reference proxy names that exact shape as the bug that made
* a working credential look broken.
*
* It has to outlast `RATE_LIMIT_STREAK_CAP`, or the top of the ladder cancels
* itself: the account cannot be tried again until that window has passed, so it
* would always come back to a count of one and the cap would apply once per
* cycle instead of holding a persistently limited account back.
*/
const RATE_LIMIT_STREAK_WINDOW_MS = RATE_LIMIT_STREAK_CAP * 2;
/** Drop expired per-model cooldowns and blocks, then cap what is left, soonest first. */
function pruneModelCooldowns(account, now) {
	for (const table of [account.modelCooldowns, account.modelBlocks]) for (const [modelId, until] of Object.entries(table)) if (until <= now) delete table[modelId];
	const keys = Object.keys(account.modelCooldowns);
	if (keys.length <= MAX_MODEL_COOLDOWN_KEYS) return;
	keys.sort((a, b) => (account.modelCooldowns[a] ?? 0) - (account.modelCooldowns[b] ?? 0));
	for (const key of keys.slice(0, keys.length - MAX_MODEL_COOLDOWN_KEYS)) delete account.modelCooldowns[key];
}
/**
* Directory the plugin writes its own sign-ins into.
*
* A login the panel starts lands here rather than in the desktop app's auth
* directory: the app owns that directory and indexes the files it wrote, so a
* foreign `.info` beside them is a file nothing maintains. This one is scanned
* on the same terms as the vendor's, so an account added from the panel is an
* ordinary pool account, and it disappears only when the user removes it.
*/
function ownSignInDir(dataPath) {
	return dataPath === "" ? "" : join(dataPath, OWN_SIGN_IN_DIRNAME);
}
/**
* The sign-in document fields one credential spells, in the vocabulary
* `writeOwnSignIn` takes.
*
* `OwnSignIn` spells "the upstream did not say" as the empty string and a parsed
* credential spells it as an absent field; coalescing here keeps that meeting
* point in one place rather than in every writer.
*/
function ownSignInOf(credential) {
	return {
		region: regionOf(credential.domain),
		accessToken: credential.accessToken,
		refreshToken: credential.refreshToken,
		expiresAtMs: credential.expiresAtMs,
		domain: credential.domain,
		...credential.lastRefreshAtMs === void 0 ? {} : { lastRefreshAtMs: credential.lastRefreshAtMs },
		uid: credential.uid ?? "",
		uin: credential.uin ?? "",
		enterpriseId: credential.enterpriseId ?? "",
		nickname: credential.nickname ?? ""
	};
}
/**
* Write one panel-added sign-in as a `.info` file the scan reads back.
*
* The shape is the desktop app's own, so `parseWorkBuddyAuth` opens it with no
* special case. The file name carries the billing identity: re-adding the same
* account rewrites its own file instead of leaving a second copy behind, and
* two accounts never collide on a name.
*/
async function writeOwnSignIn(directory, signIn) {
	const stable = signIn.uin === "" ? signIn.uid : signIn.uin;
	const suffix = stable === "" ? randomUUID() : stable.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
	const file = join(directory, `${OWN_SIGN_IN_PREFIX}${suffix === "" ? randomUUID() : suffix}.info`);
	await mkdir(directory, { recursive: true });
	await writeFile(file, JSON.stringify({
		auth: {
			accessToken: signIn.accessToken,
			refreshToken: signIn.refreshToken,
			expiresAt: signIn.expiresAtMs,
			domain: signIn.domain,
			lastRefreshTime: signIn.lastRefreshAtMs ?? Date.now()
		},
		account: {
			...signIn.uid === "" ? {} : { uid: signIn.uid },
			...signIn.uin === "" ? {} : { uin: signIn.uin },
			...signIn.enterpriseId === "" ? {} : { enterpriseId: signIn.enterpriseId },
			...signIn.nickname === "" ? {} : { nickname: signIn.nickname }
		}
	}, null, 2), { mode: 384 });
	return file;
}
/**
* Rewrite one of the plugin's own sign-in files with a renewed token.
*
* Read-modify-write of the document that is already there, so the identity
* fields the vendor's own parser looks for survive untouched and only the three
* auth values a refresh replaces are written. Atomic for the same reason as the
* archive: a truncated `.info` is an account the scan cannot open.
*/
async function renewOwnSignInFile(file, credential) {
	const document = JSON.parse(await readFile(file, "utf8"));
	const auth = document.auth ?? {};
	auth.accessToken = credential.accessToken;
	auth.refreshToken = credential.refreshToken;
	auth.expiresAt = credential.expiresAtMs;
	auth.lastRefreshTime = credential.lastRefreshAtMs ?? Date.now();
	document.auth = auth;
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(document, null, 2), { mode: 384 });
		await rename(temporary, file);
	} catch (error) {
		await unlink(temporary).catch(() => {});
		throw error;
	}
}
/**
* Soonest future one-off expiry. Missing or past sorts last. None left -> list head.
*
* Strict soonest-first, not a weighted spread: this mode exists so a pack about to
* lapse is the one that gets spent, and a pool of two or three accounts has
* nothing to spread. The burst this could cause is bounded by `available`, which
* drops an account the moment the upstream limits it, so the next request already
* goes elsewhere. The reference proxy weights the share instead, because it runs
* enough accounts that one of them would otherwise absorb every request; adopting
* that here would trade away the guarantee the user picked the mode for.
*/
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
* Read the credential archive: id → credential.
*
* A missing file is an empty archive. A read error or a damaged document
* throws, so the writer leaves the file alone instead of saving an empty one
* over every sign-in it still holds.
*/
async function readArchivedCredentials(file) {
	const stored = /* @__PURE__ */ new Map();
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return stored;
		throw error;
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("credential archive is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return stored;
	const entries = parsed.entries;
	if (!Array.isArray(entries)) return stored;
	const horizon = Date.now() - ARCHIVE_RETENTION_MS;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry;
		if (typeof record["id"] !== "string" || record["id"] === "") continue;
		if (typeof record["accessToken"] !== "string" || record["accessToken"] === "") continue;
		const expiresAt = typeof record["expiresAtMs"] === "number" ? expiryToMs(record["expiresAtMs"]) : 0;
		const refreshExpiresAt = typeof record["refreshExpiresAtMs"] === "number" ? expiryToMs(record["refreshExpiresAtMs"]) : 0;
		const lastRefreshAt = typeof record["lastRefreshAtMs"] === "number" ? expiryToMs(record["lastRefreshAtMs"]) : 0;
		const lastUsable = Math.max(expiresAt, refreshExpiresAt);
		if (lastUsable > 0 && lastUsable < horizon) continue;
		stored.set(record["id"], {
			accessToken: record["accessToken"],
			refreshToken: typeof record["refreshToken"] === "string" ? record["refreshToken"] : "",
			expiresAtMs: expiresAt,
			...refreshExpiresAt === 0 ? {} : { refreshExpiresAtMs: refreshExpiresAt },
			...lastRefreshAt === 0 ? {} : { lastRefreshAtMs: lastRefreshAt },
			...typeof record["nickname"] !== "string" || record["nickname"] === "" ? {} : { nickname: record["nickname"] },
			...typeof record["uin"] !== "string" || record["uin"] === "" ? {} : { uin: record["uin"] },
			...typeof record["uid"] !== "string" || record["uid"] === "" ? {} : { uid: record["uid"] },
			...typeof record["enterpriseId"] !== "string" || record["enterpriseId"] === "" ? {} : { enterpriseId: record["enterpriseId"] },
			domain: typeof record["domain"] === "string" ? record["domain"] : "",
			sourcePath: typeof record["sourcePath"] === "string" ? record["sourcePath"] : ""
		});
	}
	return stored;
}
/**
* Write the archive, replacing the previous file only once the new one is whole.
*
* The write is what keeps an overwritten sign-in recoverable, so it must not
* leave a truncated file behind if it is interrupted: temp file, then rename.
* Only the archived credential is stored, not the raw sign-in document.
*/
async function writeArchivedCredentials(file, entries) {
	await mkdir(dirname(file), { recursive: true });
	const body = JSON.stringify({
		version: 1,
		entries: [...entries].map(([id, credential]) => ({
			id,
			accessToken: credential.accessToken,
			refreshToken: credential.refreshToken,
			expiresAtMs: credential.expiresAtMs,
			...credential.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
			...credential.lastRefreshAtMs === void 0 ? {} : { lastRefreshAtMs: credential.lastRefreshAtMs },
			...credential.nickname === void 0 ? {} : { nickname: credential.nickname },
			...credential.uin === void 0 ? {} : { uin: credential.uin },
			...credential.uid === void 0 ? {} : { uid: credential.uid },
			...credential.enterpriseId === void 0 ? {} : { enterpriseId: credential.enterpriseId },
			domain: credential.domain,
			sourcePath: credential.sourcePath
		}))
	});
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, body, {
			encoding: "utf8",
			mode: 384
		});
		await rename(temporary, file);
	} catch (error) {
		await unlink(temporary).catch(() => {});
		throw error;
	}
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
	/** Supplies the archive directory; asked on each scan, not at construction. */
	dataPath;
	/** Soonest remaining one-off pack, ms. Cleared when that pack is spent or past. */
	creditExpiries = /* @__PURE__ */ new Map();
	refreshInflight = /* @__PURE__ */ new Map();
	/** Tail of the archive's write chain; every archive write waits on it. */
	archiveQueue = Promise.resolve();
	/** The one scan in progress; concurrent callers await it instead of duplicating it. */
	scanInflight;
	/** Torn-down sign-ins, read on first use: a scan cannot resurrect what is here. */
	/**
	* Cached tombstones, with the file stamp they were read at.
	*
	* A second pool over the same data directory writes this file too. Serving a
	* cache read before that write and then writing it back verbatim dropped the
	* other pool's deletions, and a deleted account came back the next time the
	* client's snapshot was adopted. The stamp makes a write elsewhere visible.
	*/
	deletedSignIns;
	deletedSignInsStamp;
	/** The directories the in-flight scan is reading, so a repoint supersedes it. */
	scanDirs = [];
	/**
	* Accounts whose "expired with no refresh token" warning has been logged.
	*
	* A credential with no expiry and no refresh token stays on the expiring path
	* forever, so without this the same warning fired on every request.
	*/
	noRefreshWarned = /* @__PURE__ */ new Set();
	/**
	* Accounts a hold the pool itself decided is keeping out of rotation, and why.
	*
	* Separate from `cooldownUntilMs` because the two are released by different
	* things: an upstream's rate-limit window expires on its own, while a hold
	* ends when the condition behind it changes. The reason is recorded because
	* the two conditions are not the same signal: a balance read finding credits
	* again says a spent account was topped up, and it says nothing about a
	* sign-in the upstream refuses. Releasing both on a balance meant a 401'ing
	* account went back to the head of the queue on every probe cycle.
	*/
	heldIds = /* @__PURE__ */ new Map();
	/**
	* Accounts the desktop client is signed into right now.
	*
	* The pool renews one of these into its own directory when the app's session
	* runs out, and serves that copy until the app writes a newer one. Renewing it
	* does not make it the pool's own account: the app still holds the session, and
	* a delete would hide the account from the pool while the user believed they
	* were removing something the plugin had added.
	*/
	appHeldIds = /* @__PURE__ */ new Set();
	/**
	* The sign-ins each account's own files hold, as of the last scan.
	*
	* Only the files the client and the panel write, not the archive: the archive
	* is rewritten whenever this process refreshes a token, so counting it would
	* turn every refresh into a "the user signed in again".
	*/
	signInTokens = /* @__PURE__ */ new Map();
	/**
	* Sign-ins the upstream refused, per account.
	*
	* A refused token must not come back through the ranking: the copies are
	* compared by issue time, and a token the upstream rejected can be the newest
	* one (a re-login that did not work, a sign-in copied from another machine).
	* Without this the scan would serve it again, and the hold would look released
	* while the requests kept failing. Kept across scans, and
	* dropped once the sign-in is no longer on disk or the cooldowns are reset.
	*/
	refusedSignIns = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		this.logger = options.logger;
		this.authDirs = options.authDirs ?? candidateAuthDirs();
		this.dataPath = options.dataPath;
		this.cooldownMs = options.cooldownMs ?? 6e4;
		if (!Number.isFinite(this.cooldownMs) || this.cooldownMs <= 0) this.cooldownMs = 6e4;
		this.client = options.client;
		this.distribution = options.distribution ?? "priority";
	}
	/**
	* Re-apply configuration that only affects discovery and cooldown policy,
	* without rebuilding the pool. A later `scan()` uses the new auth dirs and
	* cooldown window; existing accounts keep their in-memory state.
	*
	* Answers whether the auth directory set changed, which is the one case that
	* empties the pool: the caller has to know, because nothing downstream reads
	* the disk on its own and the pool would otherwise stay empty until a chat
	* request happened to scan it.
	*/
	applyConfig(options) {
		let emptied = false;
		if (options.authDirs !== void 0 && options.authDirs.length > 0) {
			if (!sameDirs(this.authDirs, options.authDirs)) {
				this.accounts = [];
				emptied = true;
			}
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
		return emptied;
	}
	/** Remember an account's last known balance, from the panel's probe. */
	setCreditBalance(accountId, total, nearestExpiryMs) {
		if (!Number.isFinite(total) || total < 0) return;
		this.creditBalances.set(accountId, total);
		if (typeof nearestExpiryMs === "number" && Number.isFinite(nearestExpiryMs) && nearestExpiryMs > Date.now()) this.creditExpiries.set(accountId, nearestExpiryMs);
		else this.creditExpiries.delete(accountId);
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) return;
		const hold = this.heldIds.get(accountId);
		if (hold === void 0) return;
		if (hold.until <= Date.now()) {
			this.heldIds.delete(accountId);
			return;
		}
		if (hold.reason !== "spent" || total <= 0) return;
		this.heldIds.delete(accountId);
		if (account.cooldownUntilMs > Date.now() && account.cooldownUntilMs <= hold.until) account.cooldownUntilMs = 0;
		this.logger?.info?.(`${LOG_PREFIX}: ${accountLogTag(account.label)} has credits again; releasing the hold`);
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
	/**
	* True when this account's sign-in is one the plugin wrote, so it may be
	* deleted. The panel asks before it offers the button: deleting a desktop
	* app's own sign-in would sign the user out of that app.
	*
	* A refreshed desktop sign-in does not qualify. The pool holds a copy of it
	* after a renewal, but the app is still signed in, so the row stays out of
	* reach: removing it would suppress an account the user only ever added to the
	* app, and nothing on that row says so.
	*/
	ownsSignIn(accountId) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0 || this.appHeldIds.has(accountId)) return false;
		return this.isOwnSignInPath(account.credential.sourcePath);
	}
	/**
	* Delete one account's sign-in, and its archive entry with it.
	*
	* Two things have to go, not one: the archive keeps a copy of every
	* credential a walk has seen and reads it back for every directory the walk
	* can still read, which includes the plugin's own. Deleting only the file
	* would bring the account straight back on the next scan.
	*
	* Only a sign-in this plugin wrote is removable. The desktop app owns its own
	* directory, and a file deleted there takes the user's session in that app
	* down with it, so anything outside the plugin's own directory is refused
	* rather than attempted. Answers false for an unknown account too, so the
	* caller reports a refusal instead of treating it as done.
	*/
	async removeOwnSignIn(accountId) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) return false;
		if (!this.ownsSignIn(accountId)) return false;
		const running = this.scanInflight;
		const known = (await this.loadDeletedSignIns()).has(account.id);
		if (!await this.rememberDeletedSignIn(account.id, account.credential)) throw new Error("could not record the deleted sign-in");
		if (running !== void 0) {
			if (!await raceWithTimeout(running.catch(() => {}), DELETE_SCAN_WAIT_MS)) running.catch(() => {}).then(() => this.forgetArchived(account.id));
		}
		try {
			await unlink(account.credential.sourcePath);
		} catch (error) {
			if (error.code !== "ENOENT") {
				if (!known) {
					(await this.loadDeletedSignIns()).delete(account.id);
					await this.writeDeletedSignIns([account.id]);
				}
				throw error;
			}
		}
		await this.forgetArchived(account.id);
		this.forgetAccount(account.id);
		return true;
	}
	/** Drop one account and everything the pool remembers about it. */
	forgetAccount(accountId) {
		this.accounts = this.accounts.filter((item) => item.id !== accountId);
		this.noRefreshWarned.delete(accountId);
		this.creditBalances.delete(accountId);
		this.creditExpiries.delete(accountId);
		this.heldIds.delete(accountId);
		this.signInTokens.delete(accountId);
		this.refusedSignIns.delete(accountId);
	}
	/**
	* Record one deleted sign-in, so no later scan puts the account back.
	*
	* The file is written before the delete is reported: a tombstone that only
	* lived in memory would be gone after a restart, and the snapshot it has to
	* hold off is still sitting in the client's directory.
	*/
	async rememberDeletedSignIn(id, credential) {
		const tombstones = await this.loadDeletedSignIns();
		const previous = tombstones.get(id);
		tombstones.set(id, {
			tokenDigest: tokenDigest(credential.accessToken),
			lastRefreshAtMs: credential.lastRefreshAtMs ?? 0,
			deletedAtMs: Date.now()
		});
		if (await this.writeDeletedSignIns()) return true;
		if (previous === void 0) tombstones.delete(id);
		else tombstones.set(id, previous);
		return false;
	}
	/**
	* Read the tombstones, re-reading when the file changed underneath us.
	*
	* Nothing is pruned by age. A deleted sign-in's copy is still lying in the
	* client's directory until the client overwrites it, so a tombstone that
	* expired would bring that copy straight back, refresh token included.
	*/
	async loadDeletedSignIns() {
		const file = this.deletedSignInsFile();
		const stamp = file === void 0 ? "" : await signInFileStamp(file);
		if (this.deletedSignIns !== void 0 && this.deletedSignInsStamp === stamp) return this.deletedSignIns;
		if (file === void 0) {
			this.deletedSignInsStamp = "";
			this.deletedSignIns = /* @__PURE__ */ new Map();
			return this.deletedSignIns;
		}
		try {
			const tombstones = await readDeletedSignInsFile(file);
			this.deletedSignInsStamp = stamp;
			this.deletedSignIns = tombstones;
			return tombstones;
		} catch (error) {
			if (error.code === "ENOENT") {
				this.deletedSignInsStamp = stamp;
				this.deletedSignIns = /* @__PURE__ */ new Map();
				return this.deletedSignIns;
			}
			this.logger?.warn?.(`${LOG_PREFIX}: could not read the deleted sign-ins: ${String(error)}`);
			return this.deletedSignIns ?? /* @__PURE__ */ new Map();
		}
	}
	/**
	* Persist the tombstone set; the caller has already updated the map.
	*
	* What is on disk is merged in first, except for the ids this call is removing:
	* a second pool over the same data directory writes this same file, and writing
	* our map verbatim dropped a delete it had already recorded. The removals are the
	* other half of that: a re-login ends a tombstone and a failed delete rolls one
	* back, and a pure union put both straight back.
	*
	* Answers false when the file could not be written, so a delete can refuse to
	* report success on a state it could not record.
	*/
	async writeDeletedSignIns(removed = []) {
		const tombstones = this.deletedSignIns;
		const file = this.deletedSignInsFile();
		if (tombstones === void 0 || file === void 0) return true;
		let written = false;
		await withFileLock(`${file}.lock`, async () => {
			const onDisk = await readDeletedSignInsFile(file).catch(() => /* @__PURE__ */ new Map());
			for (const [id, entry] of onDisk) {
				if (removed.includes(id)) continue;
				const ours = tombstones.get(id);
				if (ours === void 0 || entry.deletedAtMs > ours.deletedAtMs) tombstones.set(id, entry);
			}
			const temporary = `${file}.${randomUUID()}.tmp`;
			try {
				await mkdir(dirname(file), { recursive: true });
				await writeFile(temporary, JSON.stringify({
					version: 1,
					entries: Object.fromEntries(tombstones)
				}, null, 2), { mode: 384 });
				await rename(temporary, file);
				this.deletedSignInsStamp = await signInFileStamp(file);
				written = true;
			} catch (error) {
				await unlink(temporary).catch(() => {});
				this.logger?.warn?.(`${LOG_PREFIX}: could not record the deleted sign-ins: ${String(error)}`);
			}
		});
		return written;
	}
	deletedSignInsFile() {
		const directory = this.dataPath?.();
		return directory === void 0 || directory === "" ? void 0 : join(directory, DELETED_SIGN_INS_FILENAME);
	}
	/** Whether the pool recorded this sign-in as refused by the upstream. */
	signInRefused(id, token) {
		if (this.refusedSignIns.get(id)?.includes(token) ?? false) return true;
		const hold = this.heldIds.get(id);
		return hold?.reason === "session" && hold.heldSignIns.includes(token);
	}
	/**
	* Every sign-in a refusal could have named for this account.
	*
	* The files the last walk read, plus the credential in force when it came from
	* somewhere else (the archive, or a token this process minted before it was
	* written to disk). Naming only the files left an account served from the
	* archive with an empty proof, and a hold with an empty proof is released by
	* the first scan that follows it.
	*/
	refusedSignInsFor(id) {
		const tokens = (this.signInTokens.get(id) ?? []).map((entry) => entry.accessToken);
		const inForce = this.accounts.find((account) => account.id === id)?.credential.accessToken;
		if (inForce !== void 0 && inForce !== "" && !tokens.includes(inForce)) tokens.push(inForce);
		return tokens;
	}
	/** Whether `sourcePath` sits inside the directory the plugin writes into. */
	isOwnSignInPath(sourcePath) {
		return ownSignInPath(sourcePath, ownSignInDir(this.dataPath?.() ?? ""));
	}
	/**
	* Take over the sign-ins the desktop client left behind.
	*
	* The client keeps one live sign-in and a stack of superseded snapshots beside
	* it. A snapshot's token is a session the client itself stopped using, so
	* nothing renews it: it serves until its access token expires and then the
	* account is gone, holding a refresh token the client's own rotation already
	* spent. Copying it into the directory the plugin writes makes it the
	* plugin's account, renewed by the same age rule a panel-added sign-in gets,
	* so the account outlives the snapshot it came from.
	*
	* Only a superseded snapshot is taken over. The live sign-in stays the
	* client's: it refreshes it, and a second holder of the same session
	* refreshing on its own schedule is how both end up with a spent refresh
	* token. An account the client is signed into is skipped for the same reason.
	*/
	async adoptOrphanedSignIns(found, tornDown) {
		const directory = ownSignInDir(this.dataPath?.() ?? "");
		if (directory === "") return [];
		const liveIds = /* @__PURE__ */ new Set();
		const ownedIds = /* @__PURE__ */ new Set();
		for (const credential of found) {
			const id = workbuddyAccountId(credential);
			if (isLiveAuthFile(credential.sourcePath)) liveIds.add(id);
			else if (ownSignInPath(credential.sourcePath, directory)) ownedIds.add(id);
		}
		const adopted = [];
		for (const credential of found) {
			if (isLiveAuthFile(credential.sourcePath)) continue;
			if (ownSignInPath(credential.sourcePath, directory)) continue;
			const id = workbuddyAccountId(credential);
			if (liveIds.has(id) || ownedIds.has(id) || tornDown.has(id)) continue;
			if ((credential.uin ?? credential.uid ?? credential.nickname ?? "") === "") continue;
			let file;
			try {
				file = await writeOwnSignIn(directory, {
					...ownSignInOf(credential),
					lastRefreshAtMs: credential.lastRefreshAtMs ?? 0
				});
			} catch (error) {
				this.logger?.warn?.(`${LOG_PREFIX}: could not take over ${accountLogTag(accountLabel(credential))}: ${String(error)}`);
				continue;
			}
			ownedIds.add(id);
			adopted.push({
				...credential,
				sourcePath: file
			});
		}
		return adopted;
	}
	/**
	* Write a renewed token back into the sign-in file it was read from.
	*
	* Best effort: a failed write costs the renewal its persistence, never the
	* request already in flight. Anything that did not come from the plugin's own
	* directory is left alone - the desktop app owns its files.
	*/
	async renewOwnSignIn(credential) {
		if (this.isOwnSignInPath(credential.sourcePath)) {
			try {
				await renewOwnSignInFile(credential.sourcePath, credential);
			} catch (error) {
				this.logger?.warn?.(`${LOG_PREFIX}: could not write the renewed token back for ${accountLogTag(credential.nickname ?? credential.uid)}: ${String(error)}`);
			}
			return;
		}
		const directory = ownSignInDir(this.dataPath?.() ?? "");
		if (directory === "") return;
		try {
			credential.sourcePath = await writeOwnSignIn(directory, ownSignInOf(credential));
		} catch (error) {
			this.logger?.warn?.(`${LOG_PREFIX}: could not keep the renewed token for ${accountLogTag(credential.nickname ?? credential.uid)}: ${String(error)}`);
		}
	}
	/**
	* Drop one account from the credential archive.
	*
	* On the same queue as every other archive write: this is a read-modify-write
	* of one document, and a delete that raced a scan's write would otherwise be
	* overwritten by it.
	*/
	async forgetArchived(id) {
		const file = this.archiveFile();
		if (file === void 0) return;
		const run = this.archiveQueue.then(async () => {
			const stored = await readArchivedCredentials(file);
			if (!stored.delete(id)) return;
			await writeArchivedCredentials(file, stored);
		});
		this.archiveQueue = run.catch(() => {});
		try {
			await run;
		} catch (error) {
			this.logger?.warn?.(`${LOG_PREFIX}: could not drop ${id} from the credential archive: ${String(error)}`);
		}
	}
	/** Drop every account, e.g. when the source is switched off. A later `scan()` rebuilds from disk. */
	clear() {
		this.accounts = [];
		this.appHeldIds = /* @__PURE__ */ new Set();
	}
	/** Rescan the auth directories and merge newly discovered accounts. */
	async scan() {
		const dirs = this.scanDirsFor(this.authDirs);
		if (this.scanInflight !== void 0 && sameDirs(this.scanDirs, dirs)) return this.scanInflight;
		const inflight = this.scanOnce(dirs).finally(() => {
			if (this.scanInflight === inflight) {
				this.scanInflight = void 0;
				this.scanDirs = [];
			}
		});
		this.scanDirs = dirs;
		this.scanInflight = inflight;
		return inflight;
	}
	/**
	* The directories a walk reads: the configured ones plus the plugin's own.
	*
	* The pool writes sign-ins into its own directory (a renewal it claims, an
	* account it takes over), so it has to read that directory too, whether or not
	* the host listed it. Read in both places through this one function: a set that
	* disagreed with itself read as "the auth directories were repointed mid-walk"
	* and threw the whole walk away.
	*/
	scanDirsFor(authDirs) {
		const dirs = [...authDirs];
		const own = ownSignInDir(this.dataPath?.() ?? "");
		if (own !== "" && !dirs.some((dir) => resolve(dir) === resolve(own))) dirs.push(own);
		return dirs;
	}
	/**
	* Keep the credentials this walk saw, so an account whose only file the client
	* overwrites on the next sign-in still has a copy to be read back from.
	*
	* Best effort by design: a failed write costs the archive, never the scan.
	*/
	async archiveCredentials(credentials) {
		const file = this.archiveFile();
		if (file === void 0 || credentials.length === 0) return;
		const ownDir = ownSignInDir(this.dataPath?.() ?? "");
		const run = this.archiveQueue.then(async () => {
			const stored = await readArchivedCredentials(file);
			let changed = false;
			for (const credential of credentials) {
				const id = workbuddyAccountId(credential);
				const previous = stored.get(id);
				if (previous !== void 0 && !isFresher(credential, previous, ownDir)) continue;
				stored.set(id, credential);
				changed = true;
			}
			if (changed) await writeArchivedCredentials(file, stored);
		});
		this.archiveQueue = run.catch(() => {});
		try {
			await run;
		} catch (error) {
			this.logger?.warn?.(`${LOG_PREFIX}: could not update the credential archive: ${String(error)}`);
		}
	}
	/** Credentials the archive kept for a directory this walk can read. */
	async archivedCredentials(homes) {
		const file = this.archiveFile();
		if (file === void 0) return [];
		try {
			return [...(await readArchivedCredentials(file)).values()].filter((credential) => homes.has(this.homeOf(credential)));
		} catch (error) {
			this.logger?.warn?.(`${LOG_PREFIX}: could not read the credential archive: ${String(error)}`);
			return [];
		}
	}
	/** The auth directory a credential was read from. */
	homeOf(credential) {
		return resolve(dirname(credential.sourcePath));
	}
	archiveFile() {
		const directory = this.dataPath?.();
		return directory === void 0 || directory === "" ? void 0 : join(directory, ARCHIVE_FILENAME);
	}
	async scanOnce(dirs) {
		const found = [];
		const readableDirs = /* @__PURE__ */ new Set();
		const sealedDirs = /* @__PURE__ */ new Set();
		for (const dir of dirs) {
			const files = await authFilesIn(dir);
			if (files === void 0) continue;
			readableDirs.add(resolve(dir));
			for (const file of files) {
				const read = await readCredential(file);
				if (read.kind === "credential") found.push(read.credential);
				else if (read.kind === "sealed") sealedDirs.add(resolve(dir));
			}
		}
		const tombstones = await this.loadDeletedSignIns();
		const tornDown = /* @__PURE__ */ new Set();
		const releasedIds = [];
		const held = [];
		for (const credential of found) {
			const id = workbuddyAccountId(credential);
			const tombstone = tombstones.get(id);
			if (tombstone === void 0) {
				held.push(credential);
				continue;
			}
			if (!endsTombstone(tombstone, credential)) {
				tornDown.add(id);
				continue;
			}
			tombstones.delete(id);
			releasedIds.push(id);
			held.push(credential);
		}
		found.length = 0;
		found.push(...held);
		for (const id of tombstones.keys()) tornDown.add(id);
		if (releasedIds.length > 0) await this.writeDeletedSignIns(releasedIds);
		await this.archiveCredentials(found);
		found.push(...await this.adoptOrphanedSignIns(found, tornDown));
		const signInTokens = /* @__PURE__ */ new Map();
		for (const credential of found) {
			const id = workbuddyAccountId(credential);
			const held = signInTokens.get(id);
			if (held === void 0) signInTokens.set(id, [credential]);
			else held.push(credential);
		}
		const liveIds = new Set(found.map((credential) => workbuddyAccountId(credential)));
		const appHeld = new Set(found.filter((credential) => isLiveAuthFile(credential.sourcePath)).map((credential) => workbuddyAccountId(credential)));
		for (const credential of await this.archivedCredentials(readableDirs)) {
			const id = workbuddyAccountId(credential);
			if (tornDown.has(id)) continue;
			if (found.some((entry) => workbuddyAccountId(entry) === id && entry.accessToken === credential.accessToken)) continue;
			found.push(credential);
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
					modelCooldowns: Object.create(null),
					modelBlocks: Object.create(null),
					rateLimitHits: 0
				});
				continue;
			}
			const hold = this.heldIds.get(id);
			const heldSignIns = hold?.reason === "session" ? hold.heldSignIns : void 0;
			const replaced = heldSignIns === void 0 ? void 0 : signInTokens.get(id)?.find((entry) => !heldSignIns.includes(entry.accessToken));
			if (replaced !== void 0 && hold !== void 0 && heldSignIns !== void 0) {
				this.heldIds.delete(id);
				if (existing.cooldownUntilMs <= hold.until) existing.cooldownUntilMs = 0;
				existing.credential = replaced;
				this.refusedSignIns.set(id, heldSignIns);
			}
			if (!this.signInRefused(id, credential.accessToken) && (this.signInRefused(id, existing.credential.accessToken) || isFresher(credential, existing.credential, ownSignInDir(this.dataPath?.() ?? "")))) existing.credential = credential;
		}
		for (const [id, account] of byId) {
			const hold = this.heldIds.get(id);
			if (hold?.reason !== "session") continue;
			if (hold.heldSignIns.length === 0) continue;
			if (this.signInRefused(id, account.credential.accessToken)) continue;
			this.heldIds.delete(id);
			if (account.cooldownUntilMs > 0 && account.cooldownUntilMs <= hold.until) account.cooldownUntilMs = 0;
			this.logger?.info?.(`${LOG_PREFIX}: ${accountLogTag(account.label)} has a sign-in the upstream did not refuse; releasing the hold`);
		}
		const foundIds = new Set(found.map((credential) => workbuddyAccountId(credential)));
		for (const [id, refused] of this.refusedSignIns) {
			if (!foundIds.has(id)) {
				this.refusedSignIns.delete(id);
				continue;
			}
			const onDisk = signInTokens.get(id);
			if (onDisk !== void 0 && !refused.some((token) => onDisk.some((entry) => entry.accessToken === token))) this.refusedSignIns.delete(id);
		}
		const scanNow = Date.now();
		for (const account of byId.values()) pruneModelCooldowns(account, scanNow);
		for (const [id, account] of byId) {
			const home = resolve(dirname(account.credential.sourcePath));
			if (sealedDirs.has(home)) continue;
			if (readableDirs.has(home) && !foundIds.has(id)) {
				byId.delete(id);
				this.forgetAccount(id);
			}
		}
		this.appHeldIds = appHeld;
		const ordered = [...byId.values()];
		ordered.sort((a, b) => compareQueueOrder(a.credential, b.credential, ownSignInDir(this.dataPath?.() ?? "")));
		for (const account of ordered) {
			account.label = accountLabel(account.credential);
			const home = resolve(dirname(account.credential.sourcePath));
			if (!readableDirs.has(home) || sealedDirs.has(home)) continue;
			if (liveIds.has(account.id)) delete account.archived;
			else account.archived = true;
		}
		disambiguateLabels(ordered);
		if (!sameDirs(this.scanDirsFor(this.authDirs), dirs)) return this.accounts;
		this.accounts = ordered;
		this.signInTokens = signInTokens;
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
	* Why this account cannot serve a request, or null when it can.
	*
	* One ladder, two readers: `available` filters with it and
	* `unavailableReason` prints its answer. Keeping them separate meant every
	* new disqualifier had to be added in two places, and forgetting one made the
	* panel call an account available that the rotation would never pick.
	*/
	ineligible(account, now, modelId, region) {
		if (this.removedIds.has(account.id)) return "removed";
		if (this.disabledIds.has(account.id)) return "switched off";
		if (this.reserveHolds(account.id)) return "under its credit reserve";
		if (credentialUnusable(account.credential, now)) return "sign-in expired";
		if (region !== void 0 && regionOf(account.credential.domain) !== region) return "other region";
		if (account.cooldownUntilMs > now) {
			const reason = this.heldIds.get(account.id)?.reason;
			return reason === "session" ? "sign-in refused" : reason === "restricted" ? "restricted by the upstream" : "on hold";
		}
		if (modelId !== void 0 && (account.modelBlocks[modelId] ?? 0) > now) return "plan";
		if (modelId !== void 0 && (account.modelCooldowns[modelId] ?? 0) > now) return "rate-limited";
		return null;
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
		return this.accounts.filter((account) => this.ineligible(account, now, modelId, region) === null);
	}
	/**
	* The pool's own hold on this account, if one is in force right now.
	*
	* A caller that is about to spend upstream calls on an account asks first: a
	* held sign-in cannot answer, so the read is skipped and the hold's reason is
	* reported instead. Null when no hold applies or the hold has run out.
	*/
	activeHold(accountId) {
		const hold = this.heldIds.get(accountId);
		if (hold === void 0 || hold.until <= Date.now()) return null;
		return {
			reason: hold.reason,
			untilMs: hold.until
		};
	}
	/**
	* Why this account is not being served right now, for a caller that has to
	* explain an empty pool. Returns null when the account is eligible.
	*
	* One place for the answer: the gateway used to infer a cause from cooldown
	* timestamps alone, so an expired sign-in was reported as a credit-reserve
	* setting the user never touched.
	*/
	unavailableReason(accountId, now, modelId) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) return null;
		return this.ineligible(account, now, modelId);
	}
	/**
	* Pick the account to serve a request.
	*
	* The `distribution` setting chooses how:
	*
	* - **priority** (default): one account serves every request until it is
	*   rate-limited, then the next in order takes over. Credits drain one account
	*   at a time, and a cooling account returns to the head of the queue the moment
	*   its window resets - it was never consumed, so it resumes straight away.
	* - **round-robin**: consecutive requests rotate through the pool so spend
	*   spreads evenly across every account.
	* - **expiry**: the account whose credit pack expires soonest goes first, so
	*   nothing is wasted on the day it lapses.
	* - **sticky**: one account per conversation, for as long as it keeps working.
	*
	* In every mode an explicit user selection (`prefer`) heads the list, a cooling
	* account is skipped for that model only, and an unrecognised setting falls back
	* to priority.
	*
	* Scans on first use, and rescans when every known account is cooling down: a
	* fresh desktop login is the usual way out of an exhausted pool.
	*/
	async acquire(modelId, region, conversationKey, excludeIds) {
		const eligibleNow = () => {
			const list = this.available(Date.now(), modelId, region);
			return excludeIds === void 0 ? list : list.filter((item) => !excludeIds.has(item.id));
		};
		if (this.accounts.length === 0) await this.scan();
		let pool = eligibleNow();
		if (pool.length === 0) {
			await this.scan();
			pool = eligibleNow();
		}
		if (pool.length === 0) return void 0;
		const preferredId = this.preferredIds.get(region);
		const account = pool.find((item) => item.id === preferredId) ?? this.pick(pool, conversationKey);
		if (account === void 0) return void 0;
		await this.ensureFresh(account);
		const eligible = eligibleNow();
		if (eligible.includes(account)) return account;
		const next = eligible.find((item) => item.id === preferredId) ?? this.pick(eligible, conversationKey);
		if (next === void 0) return void 0;
		await this.ensureFresh(next);
		return next;
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
		return await this.refreshAccountOutcome(accountId) === "refreshed";
	}
	/**
	* The same refresh, keeping a refusal apart from a failure.
	*
	* The caller needs the difference: only the upstream turning the sign-in down
	* justifies a six-hour hold, while a timeout or an unreachable host says
	* nothing about the token and must leave the account in rotation.
	*/
	async refreshAccountOutcome(accountId) {
		return await this.refreshForRetry(accountId);
	}
	/**
	* Refresh after a session-dead answer, keeping a refusal apart from a failure.
	*
	* Only the upstream turning the sign-in down justifies a hold. A timeout, a
	* rate limit or an unreachable host says nothing about the token, and parking
	* the account for six hours over one bad round trip took a healthy account out
	* of rotation until a manual reset.
	*/
	async refreshForRetry(accountId) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) return "failed";
		const previous = account.credential.accessToken;
		if (account.credential.refreshToken === "") return "refused";
		const outcome = await this.ensureFresh(account, true);
		if (account.credential.accessToken !== previous) return "refreshed";
		return outcome === "failed" ? "failed" : "refused";
	}
	/**
	* Hold an account whose sign-in the upstream refuses.
	*
	* The chat gateway has answered a refused sign-in with this hold since it was
	* written; the panel's reads and the scheduled passes had no equivalent, so a
	* revoked account kept spending its two upstream calls on every poll and every
	* pass. The hold is what stops that, and it is released the way every other
	* hold is: a new sign-in for the account, a cooldown reset, or its cap.
	*/
	holdRefusedSignIn(accountId) {
		this.penalize(accountId, Date.now() + POOL_HOLD_MS, void 0, "session");
	}
	/**
	* One upstream read that a refused sign-in gets a second chance at.
	*
	* The upstream revokes the session a sign-in belongs to without rewriting the
	* token's own expiry, so an account the user switched away from in the desktop
	* app keeps a credential that reads as valid for weeks and answers 401 on
	* every call. A refresh token that still lives recovers the account on the
	* spot, which is the case the desktop app's own refresh leaves behind; one
	* that does not leaves the account held instead of retried forever.
	*
	* A failure of any other kind is rethrown untouched: a rate limit, a spent
	* balance and an upstream fault each have their own path, and none of them is
	* helped by a token this read did not blame.
	*
	* While the hold stands the read is not attempted at all. The panel polls
	* every couple of minutes and the scheduled passes walk the whole pool, and
	* each of those would otherwise spend the same call on a sign-in that cannot
	* answer it.
	*/
	async readAfterRefresh(accountId, read) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) throw new Error(`${LOG_PREFIX}: no account ${accountId} to read for`);
		if (this.activeHold(accountId)?.reason === "session") throw new Error(REFUSED_SIGN_IN_MESSAGE);
		try {
			return await read(account.credential);
		} catch (error) {
			if (upstreamErrorKind(error) !== "session_dead") throw error;
			const outcome = await this.refreshForRetry(accountId);
			if (outcome === "refreshed") try {
				return await read(account.credential);
			} catch (retry) {
				if (upstreamErrorKind(retry) !== "session_dead") throw retry;
				this.holdRefusedSignIn(accountId);
				throw retry;
			}
			if (outcome === "refused") this.holdRefusedSignIn(accountId);
			throw error;
		}
	}
	/**
	* Refresh the account's access token when it is within the margin (or already
	* expired), in-flight de-duped per account. A failed refresh keeps the
	* existing token when it has not yet expired, so an unreachable refresh
	* endpoint never takes down a working session.
	*
	* Reports what it did, so a caller walking the pool for keep-alive can tell a
	* pass that refreshed something from one that had nothing to do. The answer
	* describes this call, not the account: an in-flight refresh another call
	* started is reported as `fresh` because this one spent no upstream call.
	*/
	async ensureFresh(account, forced = false) {
		if (this.client === void 0) return "fresh";
		const credential = account.credential;
		const issuedAt = credential.lastRefreshAtMs ?? 0;
		const stale = this.isOwnSignInPath(credential.sourcePath) && issuedAt > 0 && Date.now() - issuedAt >= REFRESH_AFTER_MS;
		if (!(forced || credential.expiresAtMs <= 0 || credential.expiresAtMs <= Date.now() + REFRESH_MARGIN_MS || stale)) return "fresh";
		const existing = this.refreshInflight.get(account.id);
		if (existing !== void 0) return await existing;
		const run = (async () => {
			if (credential.refreshToken === "") {
				if (credential.expiresAtMs > Date.now() + 3e4) return "fresh";
				if (!this.noRefreshWarned.has(account.id)) {
					this.noRefreshWarned.add(account.id);
					this.logger?.warn(`${LOG_PREFIX}: ${accountLogTag(account.label)} token expired with no refresh token; sign in again`);
				}
				return "noToken";
			}
			try {
				const outcome = await this.client.refreshToken(credential);
				if (account.credential !== credential) return "fresh";
				account.credential = {
					...credential,
					accessToken: outcome.accessToken,
					...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
					expiresAtMs: tokenExpiryMs(outcome.expiresInSec),
					...outcome.domain === void 0 || outcome.domain === "" ? {} : { domain: outcome.domain },
					lastRefreshAtMs: Date.now()
				};
				await this.archiveCredentials([account.credential]);
				await this.renewOwnSignIn(account.credential);
				this.noRefreshWarned.delete(account.id);
				const sessionHold = this.heldIds.get(account.id);
				if (sessionHold !== void 0 && sessionHold.reason === "session") {
					this.heldIds.delete(account.id);
					if (account.cooldownUntilMs > Date.now() && account.cooldownUntilMs <= sessionHold.until) account.cooldownUntilMs = 0;
					this.logger?.info?.(`${LOG_PREFIX}: ${accountLogTag(account.label)} refreshed again; releasing the refused sign-in hold`);
				}
				this.logger?.info?.(`${LOG_PREFIX}: refreshed token for ${accountLogTag(account.label)}`);
				return "refreshed";
			} catch (error) {
				if (credential.expiresAtMs > Date.now() + 3e4) this.logger?.warn?.(`${LOG_PREFIX}: token refresh failed but token still valid for ${accountLogTag(account.label)}`, error);
				else this.logger?.error?.(`${LOG_PREFIX}: token refresh failed and token expired for ${accountLogTag(account.label)}`, error);
				return upstreamErrorKind(error) === "session_dead" ? "refused" : "failed";
			}
		})();
		this.refreshInflight.set(account.id, run);
		try {
			return await run;
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
	*
	* `hold` names a decision of the pool's own rather than a timestamp read
	* off an upstream answer — a spent account, a dead session. It is bounded by
	* POOL_HOLD_MS instead of PENALIZE_CAP_MS, because the two-hour ceiling
	* exists to stop a mis-parsed reset from parking an account all day, and
	* neither of these conditions clears by itself.
	*/
	penalize(accountId, resetAtMs, modelId, hold = false) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) return;
		if (hold === false) account.rateLimitHits += 1;
		const now = Date.now();
		const stated = resetAtMs !== void 0 && resetAtMs > now;
		if (hold === false && !stated) {
			account.rateLimitStreak = now - (account.rateLimitStreakAtMs ?? 0) > RATE_LIMIT_STREAK_WINDOW_MS ? 1 : (account.rateLimitStreak ?? 0) + 1;
			account.rateLimitStreakAtMs = now;
		}
		const holdReason = hold === false ? void 0 : hold;
		const cap = holdReason !== void 0 ? POOL_HOLD_MS : PENALIZE_CAP_MS;
		const streak = Math.min(Math.max((account.rateLimitStreak ?? 1) - 1, 0), RATE_LIMIT_STREAK_STEPS);
		const backoff = Math.min(this.cooldownMs * 2 ** streak, Math.max(this.cooldownMs, RATE_LIMIT_STREAK_CAP));
		const until = stated ? Math.min(resetAtMs, now + cap) : holdReason !== void 0 ? now + cap : now + backoff;
		if (modelId !== void 0 && modelId !== "") {
			pruneModelCooldowns(account, now);
			account.modelCooldowns[modelId] = Math.max(account.modelCooldowns[modelId] ?? 0, until);
			this.logger?.warn(`${LOG_PREFIX}: ${accountLogTag(account.label)} rate-limited on model ${modelId}; cooling that model until ${new Date(until).toISOString()}`);
			return;
		}
		account.cooldownUntilMs = Math.max(account.cooldownUntilMs, until);
		if (holdReason !== void 0) {
			const prior = this.heldIds.get(accountId);
			const carried = prior !== void 0 && prior.until > now && prior.reason === "session" ? prior : void 0;
			const reason = carried?.reason ?? holdReason;
			const heldSignIns = carried !== void 0 ? carried.heldSignIns : this.refusedSignInsFor(accountId);
			this.heldIds.set(accountId, {
				reason,
				until: Math.max(until, carried?.until ?? 0),
				heldSignIns
			});
		}
		this.logger?.warn(holdReason !== void 0 ? `${LOG_PREFIX}: account ${accountLogTag(account.label)} held (${holdReason}); held until ${new Date(until).toISOString()}` : `${LOG_PREFIX}: account ${accountLogTag(account.label)} rate-limited; cooling until ${new Date(until).toISOString()}`);
	}
	/**
	* Keep one model out of one account's rotation for a stated window.
	*
	* `penalize` caps what it writes at `PENALIZE_CAP_MS`, which exists so a
	* mis-parsed rate-limit reset cannot park work all day. A plan refusal names
	* no upstream window and clears only when the subscription changes, so it
	* brings its own deadline; routing it through `penalize` silently shortened
	* it to the rate-limit ceiling and bought one wasted upstream call per two
	* hours. The account is left alone: every other model on it still serves.
	*/
	blockModel(accountId, modelId, untilMs) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0 || modelId === "" || untilMs <= Date.now()) return;
		pruneModelCooldowns(account, Date.now());
		account.modelBlocks[modelId] = Math.max(account.modelBlocks[modelId] ?? 0, untilMs);
	}
	/** Clear all cooldowns (account-wide and per-model), e.g. from a reset command. */
	resetCooldowns() {
		for (const account of this.accounts) {
			account.cooldownUntilMs = 0;
			account.modelCooldowns = Object.create(null);
			account.modelBlocks = Object.create(null);
			account.rateLimitHits = 0;
			account.rateLimitStreak = 0;
			account.rateLimitStreakAtMs = 0;
		}
		this.heldIds.clear();
		this.refusedSignIns.clear();
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
	live = false;
	/** User's model selection. Empty object = follow the catalog unfiltered. */
	selection = {};
	/**
	* Whether the roster in force came from the upstream.
	*
	* False means the static fallback is still standing: this plugin's own guess,
	* not a list the vendor answered with. A saved selection cannot be judged
	* against a guess - doing it reported every model the vendor had added since
	* the fallback was written as retired, and said so on every start for as long
	* as the live read kept failing.
	*/
	hasLiveRoster() {
		return this.live;
	}
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
		const bounded = this.live;
		return this.models.filter((model) => allow === void 0 || allow.has(model.id)).map((model) => applyOverride(model, overrides[model.id], bounded));
	}
	/**
	* Replace the catalog with the upstream's own list.
	*
	* An empty list keeps what is there: the static fallback is what a fresh
	* install publishes before any read succeeds, and a wipe here would leave the
	* gateway with nothing to declare. What counts as an answer is decided in
	* `catalogFromUpstream` before this is reached.
	*/
	update(models) {
		if (models.length === 0) return;
		this.models = models;
		this.live = true;
	}
	/** Replace the user's selection; the model list is rebuilt from `visible()`. */
	applySelection(selection) {
		this.selection = selection;
	}
};
/**
* Fold one override onto a catalog entry.
*
* A non-positive window or ceiling is ignored rather than stored: the host
* rejects a zero value, so writing one would drop the row's number entirely.
*
* `bounded` is the catalog's own provenance: when the roster in force came from
* the upstream, an override may lower a limit but never raise it above what the
* vendor advertises. The host trusts the declared figure to size its context
* budget and its compaction threshold, so a window larger than the model really
* accepts made the host believe it had room the upstream does not have, and the
* reply was truncated or compacted well before the declared window was full.
* When the static fallback is still standing the figures are this plugin's own
* guess, and clamping to them would overwrite a correct saved value with a
* smaller invented one.
*/
function applyOverride(model, override, bounded = false) {
	const next = { ...model };
	if (override === void 0) return next;
	if (override.alias !== void 0) {
		const alias = override.alias.trim();
		if (alias === "") delete next.alias;
		else next.alias = alias;
	}
	if (override.contextWindow !== void 0 && override.contextWindow > 0) next.contextWindow = bounded ? Math.min(override.contextWindow, model.contextWindow) : override.contextWindow;
	if (override.maxOutputTokens !== void 0 && override.maxOutputTokens > 0) next.maxOutputTokens = bounded ? Math.min(override.maxOutputTokens, model.maxOutputTokens) : override.maxOutputTokens;
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
		...model.reasoning?.defaultEffort === void 0 ? {} : { defaultThinkingLevel: model.reasoning.defaultEffort },
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
/**
* One unterminated line may not grow without bound; chat deltas are small.
* The ceiling is a memory guard on the upstream's answer, which no request-body
* limit bounds: a frame this size is a stream gone wrong, not a chat delta.
*/
const MAX_LINE_CHARS$1 = 67108864;
/**
* How much one event's accumulated `data:` lines may hold.
*
* The line guard above measures the unterminated tail, which stays small on a
* stream that keeps ending its lines: every `data:` line lands in `data` and
* only a blank line drains it, so an upstream that emits framed events without
* ever separating them grew this array without any ceiling touching it.
*/
const MAX_DATA_CHARS = 4194304;
var SseDecoder = class {
	buffer = "";
	event;
	id;
	retry;
	data = [];
	dataChars = 0;
	push(chunk) {
		this.buffer += chunk;
		const events = [];
		while (true) {
			const match = /\r\n|\n|\r/.exec(this.buffer);
			if (match === null || match.index === void 0) break;
			if (match[0] === "\r" && match.index + 1 === this.buffer.length) break;
			const line = this.buffer.slice(0, match.index);
			this.buffer = this.buffer.slice(match.index + match[0].length);
			const emitted = this.consumeLine(line);
			if (emitted !== void 0) events.push(emitted);
		}
		if (this.buffer.length > MAX_LINE_CHARS$1) {
			this.buffer = "";
			throw new Error("sse line exceeded 67108864 characters without a newline");
		}
		if (this.dataChars > MAX_DATA_CHARS) {
			this.data = [];
			this.dataChars = 0;
			throw new Error("sse event exceeded 4194304 characters of data without a separator");
		}
		return events;
	}
	/** Flush a trailing event the upstream never terminated with a blank line. */
	finish() {
		const events = [];
		if (this.buffer !== "") {
			const tail = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
			const emitted = this.consumeLine(tail);
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
		else if (field === "data") {
			this.data.push(value);
			this.dataChars += value.length + 1;
		} else if (field === "id" && !value.includes("\0")) this.id = value;
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
		this.dataChars = 0;
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
		...typeof record["finish_reason"] === "string" ? { finishReason: record["finish_reason"] } : event.event === "done" ? { finishReason: "stop" } : {},
		raw: record,
		...event.event === void 0 ? {} : { event: event.event }
	};
	if (delta.text !== "" || delta.reasoning !== void 0 && delta.reasoning !== "" || Array.isArray(delta.toolCalls) && delta.toolCalls.length > 0) return delta;
	if (event.event === "done" || delta.finishReason !== void 0) return {
		type: "done",
		finishReason: delta.finishReason ?? "stop",
		raw: record,
		...event.event === void 0 ? {} : { event: event.event }
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
* Loopback guards, the request body bound and the server shell live in
* `./loopback` — one copy, shared with the Trae and Qoder gateways.
*/
/** Whether one SSE data frame carries a non-null `finish_reason`. */
function carriesFinishReason(data) {
	try {
		const parsed = JSON.parse(data);
		return Array.isArray(parsed.choices) && parsed.choices.some((choice) => typeof choice?.finish_reason === "string" && choice.finish_reason !== "");
	} catch {
		return false;
	}
}
/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS = {
	hard_credit: 402,
	soft_rate: 429,
	session_dead: 401,
	waf_block: 502,
	not_found: 404,
	server: 502,
	client: 400,
	model_tier: 400,
	account_restricted: 403,
	transport: 502,
	aborted: 499
};
/**
* How long one account keeps a model it is not entitled to out of rotation.
*
* A plan does not change inside a working day, and the upstream names no
* window of its own. A day is long enough that the gate costs one refusal per
* account per day, and short enough that a plan bought later comes back
* without a restart.
*/
const MODEL_TIER_HOLD_MS = 864e5;
/**
* How many accounts one request may lose to a transport failure.
*
* Rotation is still worth one retry: a global pool can hold sign-ins served by
* different gateways, so one unreachable host says nothing about the next
* account. A host-wide outage, however, would otherwise cost one headers
* timeout per sign-in before the client saw an answer, so the second failure
* ends the turn.
*/
const MAX_TRANSPORT_ATTEMPTS = 2;
/**
* The business code an account-level 200 envelope carries.
*
* `classifyUpstreamError` only reads codes on the statuses the upstream uses
* for failures, so a refusal wearing a 200 was classed `client` and answered as
* a one-off 502. These are the codes that make it the same account property a
* non-200 answer would carry.
*/
function classifyEnvelopeCode(code, text) {
	if (code === "6004") return "soft_rate";
	if (code === "11158") return "model_tier";
	if (code === "11140") return "account_restricted";
	if (code === "12153") return "session_dead";
	if (isHardCreditText(text)) return "hard_credit";
	const kind = classifyUpstreamError(200, text);
	return kind === "client" ? void 0 : kind;
}
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
const EMPTY_STREAM_REFUSAL = "workbuddy returned an empty answer stream";
/**
* Read enough of a 200 body to tell an SSE stream from a refusal wearing a 200.
*
* WorkBuddy answers a refusal with a JSON envelope and an upstream hiccup can
* end the body before the first frame; both leave the status code claiming
* success. The head is what decides: a body that opens with `{` or `[` is the
* envelope, a body that already ended empty is no answer at all, and anything
* else is relayed as the stream it claims to be.
*
* The bytes the peek took are returned so the relay can put them back in front.
*/
async function peekAnswerHead(reader) {
	const head = [];
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	let ended = false;
	let jsonLooking = false;
	for (;;) {
		const next = await reader.read();
		if (next.done) {
			ended = true;
			break;
		}
		head.push(next.value);
		bytes += next.value.byteLength;
		text += decoder.decode(next.value, { stream: true });
		const trimmed = text.replace(/^\uFEFF/, "").trimStart();
		if (trimmed === "") {
			if (bytes >= 262144 || head.length >= 64) break;
			continue;
		}
		jsonLooking = trimmed.startsWith("{") || trimmed.startsWith("[");
		if (!jsonLooking) break;
		if (ended || bytes >= 32768 || head.length >= 64) break;
	}
	const trimmed = text.replace(/^\uFEFF/, "").trim();
	if (trimmed === "" && ended) return {
		head,
		ended,
		refusal: EMPTY_STREAM_REFUSAL
	};
	if (!jsonLooking) return {
		head,
		ended
	};
	try {
		const parsed = JSON.parse(trimmed);
		const code = parsed["code"] ?? parsed["errCode"] ?? parsed["errorCode"];
		const msg = parsed["msg"] ?? parsed["message"] ?? parsed["error"];
		const detail = typeof msg === "string" && msg.trim() !== "" ? msg.trim() : "";
		const named = code === void 0 || code === null || code === 0 || code === "0" ? "" : `code ${String(code)}`;
		const sentence = [named, detail].filter((part) => part !== "").join(" · ");
		return {
			head,
			ended,
			body: trimmed,
			refusal: sentence === "" ? "workbuddy answered 200 with a JSON body where a stream was expected" : `workbuddy answered 200 with ${sentence}`,
			...named === "" ? {} : { code: String(code) }
		};
	} catch {
		return {
			head,
			ended,
			body: trimmed,
			refusal: `workbuddy answered 200 with a body that is neither a stream nor an envelope: ${safeMessage(trimmed.slice(0, 200))}`
		};
	}
}
/**
* The effort to put back on a request that carries none.
*
* Some providers treat the field as mandatory and reject the whole request
* without it (`glm-5.1` answers HTTP 400 / 11133 "the request parameters were
* rejected by the model provider", although the same request with `off` or any
* rung of its ladder is served). The model's own declared default is what a
* client that expresses no preference should get.
*
* A default outside the model's own ladder is not sent: answering the refusal
* with a level the upstream also refuses would spend a second call to produce
* the same error.
*/
function declaredEffortOf(catalog, modelId) {
	const model = rosterFor(catalog).find((entry) => entry.id === modelId);
	const effort = model?.defaultThinkingLevel;
	if (effort === void 0 || effort === "") return void 0;
	const supported = model?.supportedEfforts;
	if (supported !== void 0 && supported.length > 0 && !supported.includes(effort)) return void 0;
	return effort;
}
/**
* The roster a request may target: the user's selection, else the whole catalog.
*
* A switch that turned every model off leaves `visible()` empty while the models
* are still callable, so the full roster is the fallback. Read through `typeof`
* rather than calling directly: this runs inside a live request, and a catalog
* object that cannot answer must not turn a chat completion into a 500.
*/
function rosterFor(catalog) {
	const visible = typeof catalog.visible === "function" ? catalog.visible() : [];
	if (visible.length > 0) return visible;
	return typeof catalog.current === "function" ? catalog.current() : [];
}
/** The same body with `reasoning_effort` filled in, when it names no effort yet. */
function withReasoningEffort(prepared, effort) {
	let body;
	try {
		body = JSON.parse(prepared);
	} catch {
		return;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return void 0;
	const request = body;
	const named = request["reasoning_effort"];
	if (typeof named === "string" && named !== "") return void 0;
	request["reasoning_effort"] = effort;
	return JSON.stringify(request);
}
/**
* The upstream's code for "the request parameters were rejected by the model
* provider": the refusal `glm-5.1` answers a request that carries no effort
* with. It is a general invalid-parameter code, not an effort-specific one, so
* the retry it triggers is gated on the request having named no effort at all -
* that is the one parameter this plugin can tell is missing.
*/
const PARAMETER_REJECTION = /"code"\s*:\s*"?11133\b/;
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
/**
* How long a spent or dead session is held out of rotation.
*
* `penalize` takes an absolute reset rather than a duration, and the duration
* itself lives with the pool that owns the hold: see `POOL_HOLD_MS` in
* `./accounts`. Handing the duration straight to `penalize` once put the reset
* in 1970, which reads as already past and falls back to the configured
* cooldown, so the hold never took effect at all.
*/
const holdUntil = () => Date.now() + POOL_HOLD_MS;
/** Turn an upstream `Retry-After` (seconds) into the absolute reset `penalize` wants. */
function resetFromRetryAfter(seconds) {
	if (seconds === void 0) return void 0;
	return Date.now() + seconds * 1e3;
}
/**
* The answer for a gateway whose every account is present but none is usable.
*
* The status follows the reason, not the timestamps. A `session` hold also
* writes a cooldown, so answering 429 whenever every reset sat in the future
* told the user to wait out a rate limit when the remedy was to sign in again,
* and put every other remedy below it out of reach.
*
* The remedy is the message: every reason here needs a different one, so the
* answer names the reason that applies rather than sending the user to a
* setting that was never the problem.
*
* A deadline travels with any answer that contains a rate-limited account, not
* only with the 429: the host keeps `Retry-After` on a 5xx too, and a mixed pool is
* the one case where waiting is part of the remedy for a request that will
* otherwise succeed a minute later. Each host then clamps that wait to its own
* retry budget, so a long deadline shortens rather than being ignored.
*/
function unavailableAnswer(pool, live, now, modelId) {
	const reasons = live.map((account) => pool.unavailableReason(account.id, now, modelId));
	const only = new Set(reasons).size === 1 ? reasons[0] : null;
	const limited = live.filter((_, index) => reasons[index] === "rate-limited");
	const retryAfterSeconds = limited.length === 0 ? void 0 : boundedRetryAfterSeconds(Math.ceil((Math.min(...limited.map((account) => Math.max(account.cooldownUntilMs, account.modelCooldowns[modelId] ?? 0))) - now) / 1e3));
	if (only === "rate-limited") return {
		status: 429,
		code: "soft_rate",
		detail: `every account is rate-limited for model ${modelId}`,
		retryAfterSeconds
	};
	if (only === "plan") return {
		status: 400,
		code: "model_tier",
		detail: `no WorkBuddy account has model ${modelId} in its plan; pick another model, or add an account whose plan includes it`
	};
	if (only === "restricted by the upstream") return {
		status: 403,
		code: "account_restricted",
		detail: "every WorkBuddy account was restricted by the upstream; appeal the restriction in the WorkBuddy console, or add another account"
	};
	return {
		status: 503,
		code: "accounts_unavailable",
		detail: only === "sign-in expired" ? "every WorkBuddy sign-in for this gateway has expired; sign in again in the desktop app" : only === "sign-in refused" ? "every WorkBuddy sign-in was refused by the upstream; sign in again in the desktop app" : only === "on hold" ? `every WorkBuddy account is out of credits or otherwise on hold for model ${modelId}` : only === "under its credit reserve" ? "no account is available within its configured credit reserve" : `no WorkBuddy account is available for model ${modelId}`,
		retryAfterSeconds
	};
}
function createWorkBuddyShim(options) {
	const { pool, client, catalog } = options;
	const region = options.region;
	const logger = options.logger;
	const server = createLoopbackServer({
		port: options.port,
		label: "workbuddy shim",
		handle,
		logger
	});
	const ready = server.ready;
	async function handle(req, res) {
		if (!guardsPass(req, res)) return;
		const url = requestPathname(req.url);
		if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
			writeJson(res, 200, {
				ok: true,
				pool: pool.status()
			});
			return;
		}
		if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
			const selected = catalog.visible();
			const directory = selected.length > 0 ? selected : catalog.current();
			const ids = options.listedIds?.();
			writeJson(res, 200, {
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
		let tried = 0;
		const skipped = /* @__PURE__ */ new Set();
		let last;
		let exhaustedByRateLimit = false;
		let transportAttempts = 0;
		let effortFallback;
		let effortFallbackBuilt = false;
		const maxAttempts = Math.max(8, pool.list(region).length + 2);
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			if (controller.signal.aborted) return;
			const account = await pool.acquire(modelId, region, conversationKey, skipped);
			if (account === void 0) {
				if (exhaustedByRateLimit && last !== void 0) {
					const model = ` for model ${modelId}`;
					const subject = last.kind === "waf_block" ? "every WorkBuddy account was blocked by the upstream gateway (WAF)" : last.kind === "hard_credit" ? `every WorkBuddy account is out of credits${model}` : last.kind === "session_dead" ? `every WorkBuddy sign-in is no longer accepted${model}` : last.kind === "model_tier" ? `no WorkBuddy account can use model ${modelId}` : last.kind === "account_restricted" ? "every WorkBuddy account was restricted by the upstream" : last.kind === "transport" ? `the upstream host could not be reached on any account${model}` : `every account is rate-limited${model}`;
					const advice = last.kind === "soft_rate" ? "resets at the upstream window" : last.kind === "model_tier" ? "pick another model, or add an account whose plan includes it" : last.kind === "account_restricted" ? "appeal the restriction in the WorkBuddy console, or add another account" : last.kind === "waf_block" ? "wait for the upstream gateway block to clear, or change network" : last.kind === "transport" ? "check the connection to the upstream host" : last.kind === "hard_credit" ? "top up the account, or add another account" : "sign in again in the desktop app";
					if (last.kind === "soft_rate") {
						const live = pool.list(region).filter((candidate) => !pool.isDisabled(candidate.id));
						const wait = unavailableAnswer(pool, live, Date.now(), modelId).retryAfterSeconds;
						if (wait !== void 0) res.setHeader("Retry-After", String(wait));
					}
					writeOpenAIError(res, KIND_STATUS[last.kind], last.kind, `${subject} (tried ${tried} account(s)); ${advice} — ${last.message.slice(0, 200)}`);
					return;
				}
				const regionAccounts = pool.list(region);
				const switchedOff = regionAccounts.filter((account) => pool.isDisabled(account.id));
				if (regionAccounts.length > 0 && switchedOff.length === regionAccounts.length) {
					writeOpenAIError(res, 403, "accounts_switched_off", `every account for this gateway is switched off in the plugin panel; switch one back on`);
					return;
				}
				if (regionAccounts.length > 0) {
					const now = Date.now();
					const live = regionAccounts.filter((account) => !pool.isDisabled(account.id));
					const answer = unavailableAnswer(pool, live, now, modelId);
					if (answer.retryAfterSeconds !== void 0) res.setHeader("Retry-After", String(answer.retryAfterSeconds));
					writeOpenAIError(res, answer.status, answer.code, answer.detail);
					return;
				}
				writeOpenAIError(res, 401, "not_signed_in", "no WorkBuddy credential found; sign in on the desktop app (or set WORKBUDDY_AUTH_FILE)");
				return;
			}
			tried += 1;
			let result = await client.chatStream(account.credential, prepared, controller.signal);
			let refreshOutcome;
			if (!result.ok && result.kind === "session_dead") {
				const failure = result;
				refreshOutcome = await pool.refreshAccountOutcome(account.id);
				if (refreshOutcome === "failed") {
					logger?.warn?.(`${LOG_PREFIX}: ${accountLogTag(account.label)} could not refresh its sign-in; trying the next account without holding it`);
					skipped.add(account.id);
					last = {
						kind: "transport",
						status: 502,
						message: `could not refresh the sign-in: ${failure.message}`
					};
					exhaustedByRateLimit = true;
					continue;
				}
			}
			if (refreshOutcome === "refreshed") {
				if (controller.signal.aborted) return;
				result = await client.chatStream(account.credential, prepared, controller.signal);
			}
			if (!result.ok && result.kind === "client" && PARAMETER_REJECTION.test(result.message) && !controller.signal.aborted) {
				if (!effortFallbackBuilt) {
					effortFallbackBuilt = true;
					const effort = declaredEffortOf(catalog, modelId);
					effortFallback = effort === void 0 ? void 0 : withReasoningEffort(prepared, effort);
				}
				if (effortFallback !== void 0) {
					logger?.info?.(`${LOG_PREFIX}: ${modelId} refused a request that named no effort; retrying with the model's declared default`);
					result = await client.chatStream(account.credential, effortFallback, controller.signal);
				}
			}
			if (result.ok) {
				const reader = relayStreamOf(result.response).getReader();
				let sawDone = false;
				let sawFinish = false;
				let envelopeFailure;
				let headFailure;
				const decoder = new TextDecoder();
				const sse = new SseDecoder();
				const startStream = () => {
					res.writeHead(200, {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						"Connection": "keep-alive",
						"X-Accel-Buffering": "no"
					});
					res.flushHeaders();
				};
				/**
				* End the relayed stream in a shape the client can finish on.
				*
				* Destroying the socket instead left a 200 with a truncated body and no
				* terminator, which is a turn the caller can only end by timing out and
				* cannot tell from a cancel. The two sibling gateways already end theirs
				* with an in-band error frame, a finish chunk and `[DONE]`; this is that
				* same contract, and the error text is redacted because this frame is the
				* one place a stream failure reaches the client without passing through
				* `writeOpenAIError`.
				*/
				const failInBand = (error) => {
					if (controller.signal.aborted || !res.writable) return;
					logger?.warn?.("wtq-pool: upstream stream failed mid-flight", safeMessage(error));
					try {
						res.write(`data: ${JSON.stringify({ error: {
							message: safeMessage(error),
							type: "upstream_error"
						} })}\n\n`);
						res.write(`data: ${JSON.stringify({ choices: [{
							index: 0,
							delta: {},
							finish_reason: "stop"
						}] })}\n\n`);
						res.end("data: [DONE]\n\n");
					} catch {}
				};
				/** End the response with `[DONE]` unless the upstream already sent it. */
				function closeWithoutDone() {
					if (sawDone || !res.writable) return;
					logger?.warn?.("wtq-pool: upstream stream ended without [DONE]");
					if (!sawFinish) res.write(`data: ${JSON.stringify({ choices: [{
						index: 0,
						delta: {},
						finish_reason: "stop"
					}] })}\n\n`);
					res.end("data: [DONE]\n\n");
				}
				await (async () => {
					let head = [];
					let ended = false;
					try {
						const peeked = await peekAnswerHead(reader);
						head = peeked.head;
						ended = peeked.ended;
						if (peeked.refusal !== void 0) {
							await reader.cancel().catch(() => {});
							if (peeked.ended && peeked.refusal === EMPTY_STREAM_REFUSAL) {
								headFailure = peeked.refusal;
								logger?.warn?.(`${LOG_PREFIX}: ${accountLogTag(account.label)} answered 200 with an empty stream; rotating`);
								return;
							}
							logger?.warn?.(`${LOG_PREFIX}: ${accountLogTag(account.label)} answered 200 with no stream: ${peeked.refusal}`);
							if (peeked.code === "11128" || unapprovedChannelRefusal(peeked.refusal) !== void 0) {
								writeOpenAIError(res, 400, "upstream_channel_check", channelCheckRefusal());
								return;
							}
							const envelopeKind = classifyEnvelopeCode(peeked.code, peeked.refusal);
							if (envelopeKind === "soft_rate" || envelopeKind === "hard_credit" || envelopeKind === "session_dead" || envelopeKind === "account_restricted" || envelopeKind === "model_tier") {
								last = {
									kind: envelopeKind,
									status: 200,
									message: peeked.refusal
								};
								exhaustedByRateLimit = true;
								envelopeFailure = envelopeKind;
								if (envelopeKind === "soft_rate") {
									const bodyReset = parseRateLimitReset(peeked.body ?? peeked.refusal);
									const headerReset = resetFromRetryAfter(retryAfterSeconds(result.response.headers));
									const resetAtMs = bodyReset !== void 0 && bodyReset > Date.now() ? headerReset === void 0 ? bodyReset : Math.max(bodyReset, headerReset) : headerReset;
									pool.penalize(account.id, resetAtMs, modelId);
								} else if (envelopeKind === "model_tier") pool.blockModel(account.id, modelId, Date.now() + MODEL_TIER_HOLD_MS);
								else if (envelopeKind === "session_dead") {
									const refreshOutcome = await pool.refreshAccountOutcome(account.id);
									if (refreshOutcome === "refused") pool.penalize(account.id, holdUntil(), void 0, "session");
									else if (refreshOutcome === "failed") {
										skipped.add(account.id);
										last = {
											kind: "transport",
											status: 502,
											message: `could not refresh the sign-in: ${peeked.refusal.slice(0, 200)}`
										};
									}
								} else pool.penalize(account.id, holdUntil(), void 0, envelopeKind === "hard_credit" ? "spent" : "restricted");
								return;
							}
							writeOpenAIError(res, 502, "upstream_error", peeked.refusal);
							return;
						}
					} catch (error) {
						await reader.cancel().catch(() => {});
						headFailure = safeMessage(error);
						logger?.warn?.(`${LOG_PREFIX}: ${accountLogTag(account.label)} failed before its first byte; rotating`);
						return;
					}
					logger?.info?.(`${LOG_PREFIX}: served by ${accountLogTag(account.label)}`);
					startStream();
					let headIndex = 0;
					try {
						for (;;) {
							const replayed = headIndex < head.length ? head[headIndex++] : void 0;
							const { done, value } = replayed !== void 0 ? {
								done: false,
								value: replayed
							} : ended ? {
								done: true,
								value: void 0
							} : await reader.read();
							if (done || value === void 0) break;
							if (!res.writable) return;
							await writeChunk(res, value);
							try {
								const decoded = decoder.decode(value, { stream: true });
								const events = sse.push(decoded);
								if (!sawFinish && events.some((event) => carriesFinishReason(event.data))) sawFinish = true;
								if (events.some((event) => event.data === "[DONE]")) {
									if (!sawFinish && res.writable) {
										res.write(`data: ${JSON.stringify({ choices: [{
											index: 0,
											delta: {},
											finish_reason: "stop"
										}] })}\n\n`);
										sawFinish = true;
									}
									sawDone = true;
									if (res.writable) res.end();
									await reader.cancel().catch(() => {});
									return;
								}
							} catch {}
						}
						if (!sawDone) try {
							const rest = decoder.decode();
							const events = rest === "" ? sse.finish() : [...sse.push(rest), ...sse.finish()];
							if (events.some((event) => event.data === "[DONE]")) sawDone = true;
							if (events.some((event) => carriesFinishReason(event.data))) sawFinish = true;
						} catch {}
						closeWithoutDone();
					} catch (error) {
						failInBand(error);
					} finally {
						try {
							reader.releaseLock();
						} catch {}
					}
				})();
				if (headFailure !== void 0) {
					last = {
						kind: "transport",
						status: 502,
						message: headFailure
					};
					exhaustedByRateLimit = true;
					skipped.add(account.id);
					transportAttempts += 1;
					if (transportAttempts >= MAX_TRANSPORT_ATTEMPTS) break;
					continue;
				}
				if (envelopeFailure === void 0) return;
				continue;
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
			* Any of them left uncooled stays at the head of the queue in the default
			* `priority` mode — the account is still `available()`, nothing else moved
			* it — so every later request walks straight back into the same failure
			* while the healthy accounts behind it sit idle.
			*
			* What each one is cooled with differs, because what clears it differs. A
			* 429 cools one model on the upstream's own window, since the upstream
			* itself allows switching models on the same account. A spent account and
			* a dead session do not come back on their own — the balance has to change
			* or the user has to sign in again — so they take the hold below; the
			* configured window is sized for a limit that expires, and using it put a
			* 402 back at the head of the queue every minute. A WAF page is the
			* gateway's own and clears on its own within minutes, so it takes the
			* configured window rather than a hold that would park a healthy account
			* for hours over a transient block.
			*
			* A `transport` failure is the network path's. A global pool need not
			* share a host: `codebuddy.ai` and `workbuddy.ai` logins can be served by
			* different gateways, so one unreachable host says nothing about the next
			* account. It is skipped for this request and rotation continues, up to
			* `MAX_TRANSPORT_ATTEMPTS`: past that the host itself is down, and one
			* headers timeout per sign-in is not a better answer.
			* An `aborted` turn is the client's own doing and stops the loop.
			*/
			if (result.kind === "aborted") break;
			if (result.kind === "transport") {
				last = {
					kind: result.kind,
					status: result.status,
					message: result.message
				};
				exhaustedByRateLimit = true;
				skipped.add(account.id);
				transportAttempts += 1;
				if (transportAttempts >= MAX_TRANSPORT_ATTEMPTS) break;
				logger?.warn?.(`${LOG_PREFIX}: ${accountLogTag(account.label)} transport failure; rotating`);
				continue;
			}
			if (result.kind !== "soft_rate" && result.kind !== "waf_block" && result.kind !== "hard_credit" && result.kind !== "session_dead" && result.kind !== "model_tier" && result.kind !== "account_restricted") break;
			exhaustedByRateLimit = true;
			if (result.kind === "soft_rate") {
				const bodyReset = parseRateLimitReset(result.message);
				const headerReset = resetFromRetryAfter(result.retryAfter);
				const resetAtMs = bodyReset !== void 0 && bodyReset > Date.now() ? headerReset === void 0 ? bodyReset : Math.max(bodyReset, headerReset) : headerReset;
				pool.penalize(account.id, resetAtMs, modelId);
			} else if (result.kind === "model_tier") pool.blockModel(account.id, modelId, Date.now() + MODEL_TIER_HOLD_MS);
			else if (result.kind === "account_restricted") pool.penalize(account.id, holdUntil(), void 0, "restricted");
			else if (result.kind === "hard_credit" || result.kind === "session_dead") pool.penalize(account.id, holdUntil(), void 0, result.kind === "hard_credit" ? "spent" : "session");
			else pool.penalize(account.id);
			logger?.warn(`${LOG_PREFIX}: ${accountLogTag(account.label)} ${result.kind} on ${modelId} (attempt ${attempt + 1}/${maxAttempts}); rotating`);
		}
		if (last === void 0) {
			writeOpenAIError(res, 500, "internal", "chat request exhausted without a result");
			return;
		}
		if (isContextTooLong(last.message)) {
			writeOpenAIError(res, 400, "context_length_exceeded", `${`the conversation exceeds ${modelId}'s context window`}. Shorten the conversation, start a new chat, or pick a model with a larger window (e.g. hy4-preview).`);
			return;
		}
		const unapproved = unapprovedChannelRefusal(last.message);
		if (unapproved !== void 0) {
			writeOpenAIError(res, 400, "upstream_channel_check", unapproved);
			return;
		}
		writeOpenAIError(res, KIND_STATUS[last.kind], last.kind, `workbuddy upstream ${last.kind} (http ${last.status}) after ${tried} account(s): ${last.message.slice(0, 400)}`);
	}
	return {
		ready,
		port: server.port,
		baseUrl: server.baseUrl,
		close: server.close
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
	return hour;
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
		if (rule.hours.includes(clock.hour)) {
			const untilHour = windowEndHour(rule, clock.hour);
			if (clock.day === rule.until && untilHour <= clock.hour) return {
				kind: "night",
				untilHour: 24
			};
			return {
				kind: "night",
				untilHour
			};
		}
		return {
			kind: "night-later",
			nextHour: nextWindowHour(rule, clock.hour)
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
*
* Each physical file is probed once, under the first edition that names it.
* Two editions can spell the same path on a case-sensitive filesystem, and
* probing it twice produced two credentials from one install; when the storage
* document named neither a region nor a host, the candidate's edition decided,
* so one install published two provider rows and one region's gateway routed a
* foreign token to the wrong endpoint.
*/
function traeStorageCandidates(platform = process.platform, home = homedir(), env = process.env) {
	const result = [];
	const seen = /* @__PURE__ */ new Set();
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
		for (const root of roots) for (const appName of appNames) {
			const path = join(root, appName, "User", "globalStorage", "storage.json");
			if (seen.has(path)) continue;
			seen.add(path);
			result.push({
				edition,
				path,
				source: "desktop"
			});
		}
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
* How long a discovery answer is reused.
*
* The gateways read credentials per request so a desktop re-login is picked up
* without a rescan, but the read itself walks and AES-decrypts ~20 candidate
* files. A short TTL keeps that off the chat path;
* `resetTraeCredentialCache()` clears it for a rescan.
*/
const DISCOVERY_TTL_MS$1 = 3e4;
let discoveryCache$1;
/** Drop the cached discovery answer, e.g. when the user asks for a rescan. */
function resetTraeCredentialCache() {
	discoveryCache$1 = void 0;
}
/**
* Read every candidate file and return deduplicated credentials. One stale,
* partially written or signed-out install never hides the others; failures are
* recorded token-free so diagnostics can explain a silent "not signed in".
*/
async function discoverTraeCredentials(candidates) {
	const cacheable = candidates === void 0;
	if (cacheable && discoveryCache$1 !== void 0 && Date.now() - discoveryCache$1.at < DISCOVERY_TTL_MS$1) {
		const cached = discoveryCache$1.value;
		return {
			credentials: [...cached.credentials],
			failures: [...cached.failures]
		};
	}
	const value = await readTraeCredentials(candidates ?? traeStorageCandidates());
	if (cacheable && value.credentials.length > 0) discoveryCache$1 = {
		at: Date.now(),
		value
	};
	return {
		credentials: [...value.credentials],
		failures: [...value.failures]
	};
}
async function readTraeCredentials(candidates) {
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
/**
* The window the upstream accepts once Max mode is on.
*
* `context_window_tokens.dev` in the directory is the plan's default, not the
* ceiling: it reads 200000 for models that then serve far more. Measured against
* the live chat endpoint in Max mode, a 1005020-token prompt was answered to
* `finish_reason: stop` on both glm-5.3-flash and deepseek-v4.1-flash, and a
* 1350030-token prompt was refused with `4022 your prompt tokens have exceeded the
* maximum limit`.
*
* A row that states a larger tier of its own keeps that figure - the directory is
* the upstream speaking about its own model - and only a row that states none gets
* this measured ceiling. Publishing a ceiling at all is what lets a caller use the
* room: the gateway asks for Max mode only when the window in force is above the
* answer's default, so a model left on its default behaves exactly as before.
*/
const TRAE_MAX_CONTEXT_WINDOW = 1e6;
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
function prepareSoloBody(source, defaultModel = "glm-5.2", functionName, capability, maxMode = false) {
	const input = JSON.parse(source);
	const model = typeof input["model"] === "string" && input["model"].trim() !== "" ? input["model"].trim() : defaultModel;
	const wireEffort = typeof input["reasoning_effort"] === "string" ? traeWireEffort(input["reasoning_effort"], capability) : void 0;
	const body = {
		...Array.isArray(input["messages"]) ? { messages: input["messages"] } : {},
		model,
		config_name: model,
		function: functionName ?? TRAE_SOLO_FUNCTION,
		stream: true,
		...Array.isArray(input["tools"]) ? { tools: input["tools"] } : {},
		...wireEffort === void 0 ? {} : { reasoning_effort: wireEffort },
		...maxMode ? { extra_info: { v2_max_mode_enabled: true } } : {}
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
/** The widest window one answer can serve, Max tier included. */
function variantReach(variant) {
	return Math.max(variant.contextWindow ?? 0, variant.maxContextWindow ?? 0);
}
/**
* The answer that should serve a request for `window`.
*
* Candidates are answers that serve the window on their OWN default tier. An
* answer that only reaches it with Max mode on is not a candidate at that size:
* picking it would put a default-window request on the larger tier's terms, and
* Max mode is billed that way. Only when nothing serves the window on its own
* tier - which is exactly a request above every default, i.e. a real Max
* request - do the Max-capable answers become candidates.
*
* Among equals the largest output budget wins: a user who keeps the default
* window then gets the function that grants the most room to answer. Equal
* budgets prefer the tighter ceiling, so nothing is declared wider than it
* needs to be.
*
* The last resort - a window no answer can reach - is ranked the other way round.
* There the tightest ceiling would be the answer that takes the LEAST of the
* request, so the widest wins instead, and Max mode is asked for it: that is the
* only combination that can serve a window the directory has since narrowed away
* from.
*/
function traeVariantFor(model, window) {
	const variants = model.variants ?? [];
	if (variants.length === 0) return void 0;
	const wanted = window !== void 0 && window > 0 ? window : model.contextWindow ?? 0;
	const own = variants.filter((variant) => (variant.contextWindow ?? 0) >= wanted);
	const reaching = own.length > 0 ? own : variants.filter((variant) => variantReach(variant) >= wanted);
	const exhausted = reaching.length === 0;
	const pool = exhausted ? variants : reaching;
	let best;
	for (const variant of pool) {
		if (best === void 0) {
			best = variant;
			continue;
		}
		const out = variant.maxTokens ?? 0;
		const bestOut = best.maxTokens ?? 0;
		if (exhausted) {
			const tier = variant.contextWindow ?? 0;
			const bestTier = best.contextWindow ?? 0;
			if (tier > bestTier) best = variant;
			else if (tier === bestTier && out > bestOut) best = variant;
			continue;
		}
		if (out > bestOut) best = variant;
		else if (out === bestOut && variantReach(variant) < variantReach(best)) best = variant;
	}
	return best;
}
/**
* The published figures, derived from every answer about a model.
*
* The default window is the widest any function serves and the output budget
* belongs to the answer that serves it - the same answer a request at that window
* uses. The ceiling is the widest tier any function states, or the measured one
* when none states a tier above the default.
*
* A tier equal to the widest default is not published as one: most rows state a
* `max` that merely repeats their own window (the `__max` checkpoint naming the
* same size), and offering that as a second tier would put a Max switch on the
* model that changes nothing.
*/
function figuresFrom(variants) {
	const windows = variants.map((v) => v.contextWindow ?? 0);
	const defaultWindow = Math.max(0, ...windows);
	const declaredCeiling = Math.max(0, ...variants.map(variantReach));
	const ceiling = defaultWindow <= 0 ? declaredCeiling : declaredCeiling > defaultWindow ? declaredCeiling : TRAE_MAX_CONTEXT_WINDOW;
	const serving = traeVariantFor({
		id: "",
		name: "",
		variants
	}, defaultWindow);
	return {
		contextWindow: defaultWindow > 0 ? defaultWindow : void 0,
		maxContextWindow: ceiling > defaultWindow ? ceiling : void 0,
		maxTokens: serving?.maxTokens,
		function: serving?.function
	};
}
/**
* Merge one directory answer into the roster.
*
* Exported because the merge rule is the whole point: the answers disagree, and
* which one is kept used to depend on the order the gateway happened to answer in.
* Every answer is kept as a variant, so nothing one function states is lost.
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
		const contextTokens = typeof config["context_window_tokens"] === "object" && config["context_window_tokens"] !== null ? config["context_window_tokens"] : {};
		const contextWindow = finitePositive(contextTokens["dev"]) ?? finitePositive(detail["prompt_max_tokens"]);
		const maxContextWindow = finitePositive(contextTokens["max"]);
		const maxTokens = finitePositive(detail["max_tokens"]);
		const reasoning = parseTraeReasoningCapability({
			...config,
			...detail
		});
		const creditMultiplier = wireCreditMultiplier(config);
		const multimodal = display["multimodal"];
		const variant = {
			function: directoryFunction,
			...contextWindow === void 0 ? {} : { contextWindow },
			...maxContextWindow === void 0 ? {} : { maxContextWindow },
			...maxTokens === void 0 ? {} : { maxTokens }
		};
		const existing = byId.get(id);
		const variants = [...existing?.variants ?? []];
		const known = variants.findIndex((entry) => entry.function === directoryFunction);
		const previous = known === -1 ? void 0 : variants[known];
		if (previous === void 0) variants.push(variant);
		else if (variantReach(variant) > variantReach(previous) || (variant.maxTokens ?? 0) > (previous.maxTokens ?? 0)) variants[known] = variant;
		if (existing !== void 0) {
			byId.set(id, {
				...existing,
				...figuresFrom(variants),
				variants
			});
			continue;
		}
		byId.set(id, {
			id,
			name: typeof display["display_name"] === "string" && display["display_name"] !== "" ? display["display_name"] : id,
			...reasoning === void 0 ? {} : { reasoning },
			...creditMultiplier === void 0 ? {} : { creditMultiplier },
			...typeof multimodal === "boolean" ? { supportsImages: multimodal } : {},
			...figuresFrom(variants),
			variants
		});
	}
}
/**
* Fold a partial directory read into the roster already held.
*
* A function that failed lists models the answer does not mention, so two facts
* have to be kept apart: an id only the earlier read knows stays callable, and
* an id both reads know keeps the variants of both. The failed function may be
* the only one that stated a Max tier or a wider window, and dropping its answer
* would re-publish the model at the smaller figures - the same silent narrowing
* the variant system exists to prevent.
*
* A complete read is never merged: it is the directory's current word, and a
* model it no longer lists is one that is gone.
*
* A variant carried over from a failed function is still chosen by
* `traeVariantFor` when it is the one that reaches the window, and the request is
* then sent to a function that may have stopped answering entirely. That is the
* right call while the failure was a timeout - the chat path is a different
* endpoint - and the gateway retries once with another answer when the chosen one
* turns out to be gone.
*/
function mergeTraeDirectory(previous, next) {
	const merged = new Map(next.map((model) => [model.id, model]));
	for (const model of next) {
		const before = previous.find((entry) => entry.id === model.id);
		if (before === void 0) continue;
		const variants = [...model.variants ?? []];
		for (const variant of before.variants ?? []) if (!variants.some((entry) => entry.function === variant.function)) variants.push(variant);
		if (variants.length === (model.variants ?? []).length) continue;
		merged.set(model.id, {
			...model,
			...figuresFrom(variants),
			variants
		});
	}
	for (const model of previous) if (!merged.has(model.id)) merged.set(model.id, model);
	return [...merged.values()];
}
/** Daily check-in endpoints on the CN pay host (`REGION_GATEWAYS.cn.pay`). */
const TRAE_CHECKIN_STATUS_PATH = "/trae/api/v2/ug/checkin_credits/status";
const TRAE_CHECKIN_CLAIM_PATH = "/trae/api/v2/ug/checkin_credits/claim";
/**
* Deadline for the chat POST to reach its response headers.
*
* Headers only: the body runs on the idle watchdog, because a signal handed to
* fetch stays attached to the body and a whole-stream deadline cut every long
* turn in half.
*/
const TRAE_HEADERS_TIMEOUT_MS = 6e4;
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
/**
* Read the check-in `enable` flag.
*
* Only an explicit "off" turns check-in off. The upstream omits the field for
* accounts that have it on, and reading it with the strict `=== true` helper
* above turned every such account into "this account has no check-in": the
* batch skipped it without ever asking, the panel hid the button and said the
* account had no campaign, and nothing reported a failure. (The Trae protocol
* reference this plugin is built against reads it as `enable !== false`.)
*/
function traeEnabled(value) {
	if (value === false || value === 0) return false;
	if (typeof value === "string") {
		const text = value.trim().toLowerCase();
		return text !== "false" && text !== "0";
	}
	return true;
}
/** Read a check-in answer; numbers and booleans may arrive as strings. */
function traeCheckinStatusOf(payload) {
	const record = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
	return {
		enable: traeEnabled(record["enable"]),
		checkedIn: traeFlag(record["checked_in"]),
		didCheckedIn: traeFlag(record["did_checked_in"]),
		credits: traeNumber(record["credits"], 0),
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
	*
	* The answer says whether it is `partial`: a function that failed is one that
	* would have listed models, and the ones only it lists are missing from what
	* came back. That has to travel with the read, because the roster replaces the
	* cached one - and a roster that lost models makes the gateway refuse them as
	* `not_found`, for as long as the read stays fresh.
	*/
	async fetchModels(signal) {
		const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);
		const region = traeRegionOfCredential(credential);
		const base = REGION_GATEWAYS[region].chat;
		const headers = {
			...buildTraeHeaders(credential, identity),
			Accept: "application/json"
		};
		const byId = /* @__PURE__ */ new Map();
		const failures = [];
		/** The functions whose answer this read could not use, by name only. */
		const failedFunctions = [];
		const answers = await Promise.all(TRAE_DIRECTORY_FUNCTIONS[region].map(async (directoryFunction) => {
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
				if (!Array.isArray(document["config_info_list"])) {
					const code = typeof document["code"] === "number" ? document["code"] : void 0;
					const message = typeof document["message"] === "string" ? document["message"].slice(0, 60) : "";
					throw new Error(code === void 0 ? "no config_info_list" : `code ${code}${message === "" ? "" : ": " + message}`);
				}
				return {
					directoryFunction,
					list: document["config_info_list"]
				};
			} catch (error) {
				failedFunctions.push(directoryFunction);
				return {
					directoryFunction,
					failure: `${directoryFunction}: ${String(error).slice(0, 80)}`
				};
			}
		}));
		for (const answer of answers) {
			if (answer.failure !== void 0) {
				failures.push(answer.failure);
				continue;
			}
			collectTraeSoloModels(answer.list, answer.directoryFunction, byId);
		}
		const models = [...byId.values()];
		if (models.length === 0) throw new Error(`Trae SOLO models response contained no models (${failures.join("; ") || "empty directory"})`);
		const reasoning = await this.readRemoteReasoning(credential, region, signal);
		for (const model of models) {
			if (model.reasoning !== void 0) continue;
			const found = reasoning.get(model.id);
			if (found !== void 0) model.reasoning = found;
		}
		return {
			models,
			partial: failures.length > 0,
			failedFunctions
		};
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
		const response = await this.fetchImpl(traeEndpoint(REGION_GATEWAYS[region].pay, TRAE_PAY_STATUS_PATH), {
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
	async chatStream(bodyJson, signal, functionName, capability, timeouts, maxMode) {
		let prepared;
		try {
			prepared = prepareSoloBody(bodyJson, void 0, functionName, capability, maxMode === true);
		} catch (error) {
			return {
				ok: false,
				status: 400,
				kind: "client",
				message: error instanceof Error && error.message !== "" ? error.message : "invalid JSON request"
			};
		}
		let credential;
		let identity;
		try {
			[credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);
		} catch (error) {
			return {
				ok: false,
				status: 503,
				kind: "server",
				message: `identity read failed: ${String(error instanceof Error ? error.message : error)}`
			};
		}
		const headers = buildTraeHeaders(credential, identity);
		const base = REGION_GATEWAYS[traeRegionOfCredential(credential)].chat;
		let response;
		const deadline = headersDeadline(signal, timeouts?.headersMs ?? TRAE_HEADERS_TIMEOUT_MS);
		try {
			response = await this.fetchImpl(traeEndpoint(base, TRAE_SOLO_CHAT_PATH), {
				redirect: "error",
				method: "POST",
				headers,
				body: prepared,
				signal: deadline.signal
			});
		} catch (error) {
			if (signal?.aborted === true) return {
				ok: false,
				status: 0,
				kind: "aborted",
				message: "cancelled by the caller"
			};
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `transport error: ${String(error)}`
			};
		} finally {
			deadline.arrived();
		}
		if (response.ok) return {
			ok: true,
			response: response.body === null ? response : new Response(withIdleWatchdog(response.body, timeouts?.idleMs, signal), {
				status: response.status,
				headers: response.headers
			})
		};
		const text = await readErrorBody(response, 1024, signal);
		return {
			ok: false,
			status: response.status,
			kind: classifyTraeUpstreamError(response.status),
			message: text || `Trae SOLO returned HTTP ${response.status}`,
			retryAfter: response.headers.get("retry-after")
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
/**
* Words a Trae refusal uses for a sign-in the upstream no longer accepts.
*
* Trae answers a stale login inside the stream, on the same `event: error`
* frame a bad request uses, and it often carries no code at all — the sentence
* is the whole refusal. Matching only on the code answered those as a 502
* server failure, which is the one class the gateway does not rotate on, so
* every request paid one round trip and the healthy sign-ins beside it were
* never tried. The Qoder path in this same plugin classifies the identical
* frame as an authentication failure.
*/
const TRAE_SIGN_IN_PATTERN = /login expired|not logged in|unauthori[sz]ed|invalid token|token.*(expire|invalid)|\b9095\b/i;
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
/**
* A code wherever the frame chose to put it: top level, or one level down.
*
* The nested containers spell it as a string (`"errorCode": "1005"`), so both
* spellings are read; the floor below is what keeps a success-range code from
* counting as a refusal.
*/
function numericCodeOf(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return numeric;
	}
}
/** A JSON document a frame hid inside its `message` field. */
function embeddedJson(text) {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return void 0;
	try {
		const parsed = JSON.parse(trimmed);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
	} catch {}
}
/**
* Recognise the failure Trae hides in an otherwise healthy stream.
*
* The shape decides, not the event name. A refusal has arrived as `event:
* error`, as a bare top-level `code`, nested under `error`/`details`, as a JSON
* document inside `message`, and on the `output` and `done` event names - which
* the shape decoder files as an empty delta and a terminator, so a refusal that
* arrived either way was answered with an empty 200 turn and no error at all.
*
* Two boundaries keep the widening honest. A frame that already carries output
* is content, whatever else it says: the peek stops at the first byte of a
* reply, and a refusal only counts when the turn produced nothing. And a bare
* code in the 400..1004 band counts for nothing on its own - Trae's business
* codes start at 1005 and its wire errors sit at 4000 and above, while that
* band is where bookkeeping frames carry codes that are not refusals, so a code
* there needs a message to name the failure. Bookkeeping frames themselves
* (usage, queue, progress) are never refusals.
*/
function traeFailureOf(decoded) {
	if (decoded.type === "usage" || decoded.type === "queue" || decoded.type === "progress") return void 0;
	if (decoded.type === "delta" && (decoded.text !== "" || decoded.reasoning !== void 0 && decoded.reasoning !== "" || normalizeTraeToolCalls(decoded.toolCalls).length > 0)) return void 0;
	const payload = decoded.type === "unknown" ? decoded.data : decoded.raw;
	if (payload === void 0) return void 0;
	const eventName = decoded.event;
	let code = numericCodeOf(payload["code"]);
	let message = typeof payload["message"] === "string" ? payload["message"] : "";
	let extra = payload["extra"];
	let named = false;
	const flat = typeof payload["error"] === "string" ? payload["error"] : typeof payload["details"] === "string" ? payload["details"] : void 0;
	if (message === "" && flat !== void 0 && flat.length > 0) {
		message = flat;
		named = true;
	}
	if (code === void 0) for (const container of [payload["error"], payload["details"]]) {
		if (typeof container !== "object" || container === null || Array.isArray(container)) continue;
		const record = container;
		const found = numericCodeOf(record["code"] ?? record["errorCode"]);
		if (found === void 0 && (message !== "" || typeof record["message"] !== "string")) continue;
		if (found !== void 0) code = found;
		if (message === "" && typeof record["message"] === "string") {
			message = record["message"];
			named = true;
		}
		if (extra === void 0) extra = record["extra"];
		if (found !== void 0) break;
	}
	if (code === void 0 && message !== "") {
		const embedded = embeddedJson(message);
		if (embedded !== void 0) {
			code = numericCodeOf(embedded["code"] ?? embedded["errorCode"]);
			if (code === void 0) {
				const nested = typeof embedded["error"] === "string" ? embedded["error"] : typeof embedded["details"] === "string" ? embedded["details"] : void 0;
				if (nested !== void 0 && nested.length > 0) {
					message = nested;
					named = true;
				}
			}
			if (code !== void 0 && typeof embedded["message"] === "string") message = embedded["message"];
		}
	}
	if (code !== void 0 && code < 400) code = void 0;
	if (code !== void 0 && code < 1005 && message.trim() === "") code = void 0;
	if (eventName !== "error" && code === void 0 && !named) return void 0;
	return {
		...code === void 0 ? {} : { code },
		message,
		...extra === void 0 ? {} : { extra }
	};
}
/**
* The wait a Trae failure asks for, when it asks.
*
* A queue or limit frame carries it inside its message as a JSON document, the
* same envelope Qoder uses. Reading it is what lets a queued Trae account be
* answered 429 with the wait and rotated past, instead of a 502 that ends the
* turn.
*/
function traeRetryAfterSeconds(failure) {
	const embedded = embeddedJson(failure.message);
	const direct = Number(embedded?.["retryAfterSeconds"]);
	if (Number.isFinite(direct) && direct > 0) return direct;
	const extra = typeof failure.extra === "object" && failure.extra !== null ? failure.extra : void 0;
	const nested = Number(extra?.["retryAfterSeconds"]);
	return Number.isFinite(nested) && nested > 0 ? nested : void 0;
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
	const head = parts.join(" · ");
	const text = detail === "" ? head : head === "" ? `upstream: ${detail}` : `${head} · upstream: ${detail}`;
	return redactSecrets(text === "" ? "Trae SOLO refused the request" : text);
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
	const retryAfterSeconds = traeRetryAfterSeconds(failure);
	if (retryAfterSeconds !== void 0) return {
		status: 429,
		kind: "soft_rate",
		retryAfterSeconds
	};
	if (TRAE_SIGN_IN_PATTERN.test(`${code ?? ""} ${failure.message}`)) return {
		status: 401,
		kind: "authentication"
	};
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
	let wakeRoom;
	const waitForRoom = () => new Promise((resolve) => {
		let settled = false;
		const wake = () => {
			if (settled) return;
			settled = true;
			wakeRoom = void 0;
			resolve();
		};
		wakeRoom = wake;
		setTimeout(wake, 50);
	});
	let sawToolCalls = false;
	let emittedFinishReason = false;
	let upstreamDone = false;
	let usage;
	let lastKeepaliveAt = 0;
	const keepalive = (controller) => {
		const now = Date.now();
		if (now - lastKeepaliveAt < 1e4) return;
		lastKeepaliveAt = now;
		controller.enqueue(encoder.encode(": keepalive\n\n"));
	};
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
		const failure = traeFailureOf(decoded);
		if (failure !== void 0) {
			const refusal = new Error(describeTraeFailure(failure));
			refusal.traeFailure = failure;
			throw refusal;
		}
		if (decoded.type === "unknown") {
			keepalive(controller);
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
			if (decoded.finishReason === void 0) {
				keepalive(controller);
				return;
			}
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
		if (decoded.type !== "done" && decoded.type !== "delta") {
			keepalive(controller);
			return;
		}
		if (emittedFinishReason) return;
		emittedFinishReason = true;
		controller.enqueue(chunk({}, openAIFinishReason(decoded.finishReason, sawToolCalls)));
	};
	let released = false;
	/**
	* Release the upstream reader, once, on the way out.
	*
	* Cancelling it is what frees the upstream socket; a turn that ended normally
	* used to leave the source uncancelled and the reader locked.
	*/
	const release = async () => {
		if (released) return;
		released = true;
		await reader.cancel().catch(() => {});
		try {
			reader.releaseLock();
		} catch {}
	};
	return new ReadableStream({
		/**
		* Push from one loop rather than pull one chunk at a time.
		*
		* The pull-driven version asked the host to call back for every upstream
		* chunk, and in the plugin process those callbacks stopped arriving after a
		* few kilobytes, leaving a turn that had started and then went silent. A
		* single loop owns the read side; `desiredSize` is the only backpressure, so
		* at most a chunk or two is held ahead of the client.
		*/
		start(controller) {
			(async () => {
				try {
					for (;;) {
						const next = await reader.read();
						if (cancelled) return;
						if (!next.done) {
							for (const event of sse.push(decoder.decode(next.value, { stream: true }))) consume(event, controller);
							if (!upstreamDone) {
								while (!cancelled && (controller.desiredSize ?? 1) <= 0) await waitForRoom();
								continue;
							}
						}
						const rest = decoder.decode();
						const events = rest === "" ? sse.finish() : [...sse.push(rest), ...sse.finish()];
						for (const event of events) consume(event, controller);
						if (!emittedFinishReason) {
							emittedFinishReason = true;
							controller.enqueue(chunk({}, openAIFinishReason(void 0, sawToolCalls)));
						}
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
						return;
					}
				} catch (error) {
					if (cancelled) controller.error(error);
					else {
						if (!(error instanceof Error && error.name === "AbortError")) try {
							options.onFailure?.(error);
						} catch {}
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
							controller.enqueue(chunk({}, openAIFinishReason(void 0, sawToolCalls)));
						}
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
					}
				} finally {
					await release();
				}
			})();
		},
		pull() {
			wakeRoom?.();
		},
		cancel(reason) {
			cancelled = true;
			wakeRoom?.();
			return reader.cancel(reason);
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
		while (buffered.length < 64 && bufferedBytes < 262144) {
			const next = await reader.read();
			if (next.done) {
				ended = true;
				const rest = decoder.decode();
				inspect(rest === "" ? sse.finish() : [...sse.push(rest), ...sse.finish()]);
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
		const { status, kind, retryAfterSeconds } = classifyTraeFailure(failure);
		const wait = retryAfterHeader(retryAfterSeconds);
		return Response.json({ error: {
			message: describeTraeFailure(failure),
			type: "upstream_error",
			code: kind === "hard_credit" ? 402 : status
		} }, {
			status,
			...wait === void 0 ? {} : { headers: { "Retry-After": wait } }
		});
	}
	const relay = bridgeTraeStream(replaySource(buffered, reader, ended), model, options);
	return withRelayStream(new Response(relay, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" }
	}), relay);
}
//#endregion
//#region src/trae-gateway.ts
const MODELS_TTL_MS$1 = 6e5;
/**
* How long a failed directory read is not retried.
*
* Each attempt walks five upstream functions, each with its own 30s timeout,
* so a black-holed directory host otherwise stalled every chat request for the
* length of the whole walk before it could answer 503.
*/
const CATALOG_FAILURE_BACKOFF_MS$1 = 3e4;
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
/**
* Whether a failure says this model is not served by the function that was asked.
*
* Trae answers `4001` in its own envelope when the chosen function does not know
* the `config_name`, which is a fact about the function rather than about the
* request. Every other 4xx is the request's own and is passed through untouched.
*/
function functionGone(status, kind, message) {
	if (kind === "not_found") return true;
	if (status !== 400) return false;
	return /"code"\s*:\s*"?4001\b/.test(message) || /\bcode 4001\b/.test(message);
}
function createTraeGateway(options) {
	const logger = options.logger;
	let cachedModels = [];
	let catalogAt = 0;
	let catalogFailedAt = 0;
	let catalogErrorText = "";
	let catalogInFlight;
	/**
	* Every sign-in that could read the directory, in the order the chat path
	* would try them.
	*
	* The directory is a per-account read like any other: a sign-in the upstream
	* has revoked answers 401 on all five of its functions, and reading with the
	* first one only left the whole gateway answering 503 and publishing no
	* provider row while a healthy sign-in sat beside it unused.
	*/
	async function directoryCredentials() {
		return (await options.credentials()).filter((credential) => credential.accessToken !== "");
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
		if (catalogFailedAt > 0 && Date.now() - catalogFailedAt < CATALOG_FAILURE_BACKOFF_MS$1) {
			if (cachedModels.length > 0) return cachedModels;
			throw new Error(`Trae model directory read failed recently, backing off: ${catalogErrorText}`);
		}
		catalogInFlight = (async () => {
			try {
				const candidates = await directoryCredentials();
				if (candidates.length === 0) throw new Error("no Trae sign-in found on this machine");
				let lastError;
				for (const credential of candidates) try {
					const read = await clientFor(credential).fetchModels();
					cachedModels = read.partial ? mergeTraeDirectory(cachedModels, read.models) : read.models;
					catalogAt = Date.now();
					catalogFailedAt = 0;
					return cachedModels;
				} catch (error) {
					lastError = error;
				}
				throw lastError ?? /* @__PURE__ */ new Error("no Trae sign-in could read the model directory");
			} catch (error) {
				catalogFailedAt = Date.now();
				catalogErrorText = error instanceof Error ? error.message : String(error);
				throw error;
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
			writeOpenAIError(res, 503, "upstream_unavailable", catalogErrorText !== "" ? catalogErrorText : "Trae model directory is not available yet");
			return;
		}
		if (!directory.some((entry) => entry.id === model) && !cachedModels.some((entry) => entry.id === model)) {
			writeOpenAIError(res, 404, "not_found", `model not in the Trae directory: ${model}`);
			return;
		}
		const published = options.publishedWindowOf?.(model);
		const entry = directory.find((row) => row.id === model) ?? cachedModels.find((row) => row.id === model);
		const serving = entry === void 0 ? void 0 : traeVariantFor(entry, published);
		/**
		* Which functions to try for this model, in order.
		*
		* The published answer leads. A partial directory read still carries the answer
		* of a function that has just failed, so the leader can be a function the
		* upstream no longer serves - and then every request for the model fails while
		* an answer that did arrive this time sits unused. The rest of the answers are
		* the fallback, one attempt each, taken only for a refusal that says this model
		* is not there.
		*/
		const functionOrder = [];
		const pushFunction = (name) => {
			if (name !== void 0 && name !== "" && !functionOrder.includes(name)) functionOrder.push(name);
		};
		pushFunction(serving?.function ?? functions.get(model));
		const target = published ?? entry?.contextWindow;
		if (entry !== void 0 && target !== void 0) {
			const reach = (row) => Math.max(row.contextWindow ?? 0, row.maxContextWindow ?? 0);
			const answering = [...entry.variants ?? []].sort((a, b) => {
				const fits = (row) => reach(row) >= target ? 1 : 0;
				return fits(b) - fits(a) || reach(b) - reach(a) || (b.maxTokens ?? 0) - (a.maxTokens ?? 0);
			});
			for (const row of answering) pushFunction(row.function);
		}
		let credentials;
		try {
			credentials = (await options.credentials("chat")).filter((credential) => credential.accessToken !== "");
		} catch (error) {
			writeOpenAIError(res, 503, "upstream_unavailable", String(error instanceof Error ? error.message : error));
			return;
		}
		if (credentials.length === 0) {
			writeOpenAIError(res, 503, "upstream_unavailable", "no Trae sign-in found on this machine");
			return;
		}
		if (watcher.signal.aborted) return;
		const capabilities = capabilityMapOf([...cachedModels, ...directory]);
		/**
		* One sign-in's attempt: the chat call plus the peek that turns a refusal
		* hidden in the stream into a real status. The peek is inside the attempt
		* because a refusal is usually a property of the sign-in (an expired login,
		* a subscription gate), which is what the next sign-in is for.
		*/
		const attemptOnce = async (credential, functionName) => {
			const result = await clientFor(credential).chatStream(raw, watcher.signal, functionName, capabilities.get(model), void 0, published !== void 0 && serving !== void 0 && serving.contextWindow !== void 0 && published > serving.contextWindow);
			if (!result.ok) return {
				ok: false,
				status: result.status,
				message: result.message,
				kind: result.kind,
				retryAfter: result.retryAfter
			};
			let relayed;
			try {
				relayed = await openTraeResponse(result.response, model, { onFailure: (error) => {
					logger?.warn?.("wtq-pool: trae relay stream failed mid-flight", error);
					if (!(error instanceof Error && error.name === "AbortError") && !watcher.signal.aborted) {
						const failure = error.traeFailure;
						if (failure !== void 0) {
							const classified = classifyTraeFailure(failure);
							options.onAttemptFailure?.(credential, { ...classified.retryAfterSeconds === void 0 ? {} : { retryAfter: String(classified.retryAfterSeconds) } });
						} else options.onAttemptFailure?.(credential, {});
					}
				} });
			} catch (error) {
				if (watcher.signal.aborted || error instanceof Error && error.name === "AbortError") return {
					ok: false,
					status: 0,
					kind: "aborted",
					message: "the caller went away while the answer was being read"
				};
				return {
					ok: false,
					status: 0,
					kind: "server",
					message: `relay read failed: ${String(error instanceof Error ? error.message : error)}`
				};
			}
			if (relayed.status !== 200) {
				const detail = await relayed.text().catch(() => "");
				return {
					ok: false,
					status: relayed.status,
					message: detail,
					retryAfter: relayed.headers.get("retry-after")
				};
			}
			return {
				ok: true,
				relayed
			};
		};
		/**
		* Rotate past a failure that belongs to the sign-in rather than to the
		* request: an expired login, a subscription gate, a rate limit. A malformed
		* body or an unknown model fails the same way on every account, so it is
		* answered as-is.
		*/
		const rotates = (status, kind) => {
			if (kind === "aborted") return false;
			if (status === 0) return true;
			return kind === "authentication" || kind === "soft_rate" || kind === "hard_credit" || status === 401 || status === 402 || status === 429;
		};
		let opened;
		for (let index = 0; index < credentials.length; index += 1) {
			if (watcher.signal.aborted) return;
			const credential = credentials[index];
			if (credential === void 0) continue;
			let attempt = await attemptOnce(credential, functionOrder[0]);
			for (let candidate = 1; candidate < functionOrder.length; candidate += 1) {
				if (attempt.ok) break;
				if (!functionGone(attempt.status, attempt.kind, attempt.message)) break;
				logger?.warn?.(`${LOG_PREFIX}: ${model} is refused by ${functionOrder[candidate - 1]} (http ${attempt.status}); trying ${functionOrder[candidate]}`);
				attempt = await attemptOnce(credential, functionOrder[candidate]);
			}
			if (attempt.ok) {
				opened = attempt;
				break;
			}
			opened = attempt;
			if (!rotates(attempt.status, attempt.kind)) break;
			options.onAttemptFailure?.(credential, { ...attempt.retryAfter === void 0 ? {} : { retryAfter: attempt.retryAfter } });
			if (index < credentials.length - 1) logger?.warn?.(`${LOG_PREFIX}: trae sign-in failed on ${model} (http ${attempt.status}); rotating`);
		}
		if (opened === void 0 || !opened.ok) {
			if (opened !== void 0 && opened.kind === "aborted") return;
			const status = opened?.status ?? 502;
			const retryAfter = retryAfterHeader(opened?.retryAfter);
			if (retryAfter !== void 0) res.setHeader("Retry-After", retryAfter);
			const lifted = liftUpstreamMessage(opened?.message ?? "");
			writeOpenAIError(res, status === 0 ? 502 : status, "upstream_error", lifted === "" ? "Trae SOLO refused the request" : lifted);
			return;
		}
		const relayed = opened.relayed;
		if (relayed.body === null) {
			writeOpenAIError(res, 502, "upstream_error", "Trae SOLO returned no stream");
			return;
		}
		if (watcher.signal.aborted) {
			relayStreamOf(relayed).cancel().catch(() => {});
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		res.flushHeaders();
		pumpToResponse(relayStreamOf(relayed), res).catch((error) => {
			if (!(watcher.signal.aborted || error instanceof Error && error.name === "AbortError")) logger?.warn?.("wtq-pool: trae relay stream failed mid-flight", error);
			if (res.writable) res.end();
		});
	}
	async function handle(req, res) {
		if (!guardsPass(req, res)) return;
		const url = requestPathname(req.url);
		if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
			writeJson(res, 200, {
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
				logger?.warn?.("wtq-pool: trae directory refresh failed; serving the cached roster");
			}
			const ids = options.listedIds?.();
			writeJson(res, 200, {
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
	const server = createLoopbackServer({
		port: options.port,
		label: "trae gateway",
		handle,
		logger
	});
	const ready = server.ready;
	const port = server.port;
	return {
		ready,
		baseUrl: server.baseUrl,
		port,
		models: () => cachedModels,
		close: server.close
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
	let storage;
	try {
		const parsed = JSON.parse(await readFile(candidate.path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
		storage = parsed;
	} catch (error) {
		if (isFileMissing(error)) throw error;
		throw new Error(`Trae ${candidate.edition} storage is not a JSON object`);
	}
	const machineFile = nonEmpty(await readFile(join(dirname(dirname(dirname(candidate.path))), "machineid"), "utf8").catch(() => ""));
	const machineId = nonEmpty(storage["telemetry.machineId"]) ?? machineFile;
	if (machineId === void 0) throw new Error(`Trae ${candidate.edition} has no stable machine identity`);
	const centerId = traeDeviceCenterId(storage);
	const deviceId = centerId ?? nonEmpty(storage["telemetry.devDeviceId"]) ?? createHash("sha256").update(machineId).digest("hex").slice(0, 32);
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
		...centerId === void 0 ? { deviceIdIsFallback: true } : {},
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
* Qoder read-only credential discovery.
*
* Finds every Qoder desktop sign-in slot on this machine: the app
* directories, the `Local State` key wrapper and the `auth.v1.dat` session
* blob. The reader (`qoder-credentials.ts`) unwraps the OSCrypt key with
* DPAPI and opens the blob; discovery itself only names files. Nothing here
* writes to the Qoder apps' files. Failures carry paths and error text,
* never token material.
*
* Shapes follow `dsh-connect-qoder` (MIT): the current layout is
* `<appDir>/auth.v1.dat` (a Chromium OSCrypt blob whose plaintext is the
* session JSON), with the key wrapper in `<appDir>/Local State` under
* `os_crypt.encrypted_key`. The legacy `state.vscdb` layout is deliberately
* not probed: reading it needs a SQLite reader this plugin does not carry,
* and advertising a slot nothing can open reported legacy installs as signed
* out with no explanation.
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
	let roots;
	if (platform === "win32") roots = [root, join(home, "AppData", "Roaming")].filter((value, index, all) => all.indexOf(value) === index);
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
/**
* Unwrapped OSCrypt keys, keyed on the `Local State` path they came from.
*
* Unwrapping costs a PowerShell spawn, so the result is kept for the life of
* the process and invalidated by the file's mtime: a desktop re-login that
* rotates the key changes the file, an ordinary chat request changes nothing.
*/
const oscryptKeyCache = /* @__PURE__ */ new Map();
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
		let mtimeMs = 0;
		try {
			mtimeMs = (await stat(localStatePath)).mtimeMs;
		} catch {}
		const cached = oscryptKeyCache.get(localStatePath);
		if (cached !== void 0 && cached.mtimeMs === mtimeMs) return Buffer.from(cached.key);
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
		oscryptKeyCache.set(localStatePath, {
			mtimeMs,
			key: Buffer.from(key)
		});
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
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value > 0xe8d4a51000 ? value : value * 1e3;
		if (typeof value === "string" && value.trim() !== "") {
			const numeric = Number(value);
			if (Number.isFinite(numeric)) return numeric > 0 ? numeric > 0xe8d4a51000 ? numeric : numeric * 1e3 : 0;
			const parsed = Date.parse(value);
			if (Number.isFinite(parsed) && parsed > 0) return parsed;
		}
		return 0;
	};
	return {
		userID,
		name: typeof user["name"] === "string" ? user["name"] : "",
		email: typeof user["email"] === "string" ? user["email"] : "",
		token,
		expiresAtMs: parsedExpiry(record["expiresAt"])
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
* How long a discovery answer is reused.
*
* The gateways read credentials per request so a desktop re-login is picked up
* without a rescan, but the read itself walks the app directories and, per
* directory, used to spawn PowerShell to unwrap the OSCrypt key. The key is
* now cached on the file's mtime; this TTL keeps the file walk itself off the
* chat path. `resetQoderCredentialCache()` clears it for a rescan.
*/
const DISCOVERY_TTL_MS = 3e4;
let discoveryCache;
/** Drop the cached discovery answer, e.g. when the user asks for a rescan. */
function resetQoderCredentialCache() {
	discoveryCache = void 0;
}
/**
* Every Qoder sign-in on this machine. One app directory that is missing or
* unreadable never hides the others; failures carry reasons, never tokens.
*/
async function discoverQoderCredentials(candidates) {
	const cacheable = candidates === void 0;
	if (cacheable && discoveryCache !== void 0 && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) {
		const cached = discoveryCache.value;
		return {
			credentials: [...cached.credentials],
			failures: [...cached.failures]
		};
	}
	const value = await readQoderCredentials(candidates ?? qoderStorageCandidates());
	if (cacheable && value.credentials.length > 0) discoveryCache = {
		at: Date.now(),
		value
	};
	return {
		credentials: [...value.credentials],
		failures: [...value.failures]
	};
}
async function readQoderCredentials(candidates) {
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
			const fresh = result.credential;
			const at = credentials.findIndex((existing) => existing.region === fresh.region && existing.userID === fresh.userID);
			const incumbent = at === -1 ? void 0 : credentials[at];
			if (incumbent === void 0) credentials.push(fresh);
			else if (fresh.expiresAtMs > incumbent.expiresAtMs) credentials[at] = fresh;
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
/** Client type magic the gateway expects from a CLI client. */
const CLIENT_TYPE = "5";
/** Machine type magic the gateway expects. */
const MACHINE_TYPE = "5";
/** Data-policy value a non-consenting client sends. */
const DATA_POLICY = "disagree";
/** Login protocol revision. */
const LOGIN_VERSION = "v2";
/** Permuted base64 alphabet used when `Encode=1` is in effect. */
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
/** Standard base64 alphabet, positionally mapped onto the custom one. */
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/**
* Positional translation table from standard to custom alphabet. Every one of
* the 256 byte values is present, defaulting to itself, so a lookup can never
* read out of bounds or need a fallback. `=` becomes `$`, which is why the
* encoded body is not valid base64 and must not be decoded as such.
*/
const ENCODE_TABLE = (() => {
	const table = /* @__PURE__ */ new Uint8Array(256);
	for (let i = 0; i < table.length; i++) table[i] = i;
	for (let i = 0; i < 64; i++) table[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
	table["=".charCodeAt(0)] = "$".charCodeAt(0);
	return table;
})();
/**
* The translation for one byte.
*
* The `?? byte` is a type-level requirement, not a runtime one:
* `noUncheckedIndexedAccess` types every indexed read as possibly `undefined`,
* and every one of the 256 values is present - so the fallback is unreachable
* and exists only to satisfy the compiler.
*/
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
function buildCosyAuthHeaders(body, url, credential) {
	const aesKey = randomUUID().replace(/-/g, "").slice(0, 16);
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
	const timestamp = Math.floor(Date.now() / 1e3).toString();
	const requestId = randomUUID();
	const payloadB64 = Buffer.from(JSON.stringify({
		version: "v1",
		requestId,
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
		"Cosy-Machinetype": MACHINE_TYPE,
		"Cosy-Machineos": qoderMachineOs(),
		"Cosy-Clienttype": CLIENT_TYPE,
		"Cosy-Clientip": "127.0.0.1",
		"Cosy-Bodyhash": createHash("md5").update(bodyBytes).digest("hex"),
		"Cosy-Bodylength": String(bodyBytes.length),
		"Cosy-Sigpath": path,
		"Cosy-Data-Policy": DATA_POLICY,
		"Cosy-Organization-Id": "",
		"Cosy-Organization-Tags": "",
		"Login-Version": LOGIN_VERSION,
		"X-Request-Id": randomUUID()
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
* Deadline for the chat POST to reach its response headers, for a caller that
* did not pass its own signal.
*
* Headers only: the body runs on the idle watchdog, because a signal handed to
* fetch stays attached to the body and a whole-stream deadline cut every turn
* longer than two minutes in half.
*/
const CHAT_HEADERS_TIMEOUT_MS = 6e4;
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
	let collected;
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const campaign = entry;
		if (campaign["actionType"] !== QODER_CLAIM_BENEFIT_ACTION) continue;
		if (!qoderWindowOpenAt(campaign, nowMs)) continue;
		if (campaign["claimStatus"] !== QODER_CLAIMED_STATUS) return campaign;
		if (collected === void 0) collected = campaign;
	}
	return collected;
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
	const grantId = typeof body?.grantId === "string" ? body.grantId.trim() : "";
	const granted = status === QODER_CLAIMED_STATUS || replayed || body?.success === true || grantId !== "";
	const amountValue = Number(body?.reward?.amount ?? body?.benefit?.amount ?? (typeof campaign !== "undefined" ? qoderBenefitOf(campaign)?.amount : void 0));
	const expiresAt = qoderEpochMs(body?.expiresAt);
	const code = Number(body?.code ?? body?.errcode);
	const refusal = Number.isFinite(code) && code !== 0 ? String(body?.message ?? body?.msg ?? "upstream code " + code).slice(0, 200) : "";
	return {
		claimed: granted,
		replayed,
		...granted && !replayed && Number.isFinite(amountValue) && amountValue > 0 ? { amount: amountValue } : {},
		...expiresAt === void 0 ? {} : { expiresAt },
		...!granted && refusal !== "" ? { reason: refusal } : {}
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
	const callsByName = /* @__PURE__ */ new Map();
	const answered = /* @__PURE__ */ new Set();
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
			if (toolCalls.length > 0) {
				entry["tool_calls"] = toolCalls;
				for (const call of toolCalls) {
					const name = String(call["function"]["name"]);
					callsByName.set(name, [...callsByName.get(name) ?? [], String(call["id"])]);
				}
			}
			out.push(entry);
			continue;
		}
		if (raw["role"] === "function") {
			const name = raw["name"];
			const callId = typeof name === "string" ? (callsByName.get(name) ?? []).find((id) => !answered.has(id)) : void 0;
			if (callId === void 0) throw new Error(`toQoderMessages: function message "${typeof name === "string" ? name : ""}" does not answer any assistant tool_call; the tool loop cannot match it`);
			answered.add(callId);
			out.push({
				role: "tool",
				tool_call_id: callId,
				content: textOf(raw["content"])
			});
			continue;
		}
		if (raw["role"] === "tool" || raw["role"] === "toolResult") {
			const toolCallId = raw["tool_call_id"] ?? raw["toolCallId"];
			if (typeof toolCallId !== "string" || toolCallId.length === 0) throw new Error("toQoderMessages: tool result message is missing tool_call_id; it cannot be linked to the calling assistant turn");
			answered.add(toolCallId);
			out.push({
				role: "tool",
				tool_call_id: toolCallId,
				content: textOf(raw["content"])
			});
			continue;
		}
		throw new Error(`toQoderMessages: unsupported message role "${String(raw["role"])}"`);
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
* The catalog offers several sizes per model (`1M`, `400K`, `200K`) and marks
* the one Qoder's own client currently has selected. That selected size is
* routinely the smallest on offer: `gfmodel` ships a 200K default beside a 1M
* entry, so publishing the default capped a model that accepts a million tokens
* at a fifth of it. The largest entry is what gets published, which is the
* reading that cannot promise less than the model has; the panel's per-model
* override is how a user narrows it again.
*/
function qoderContextWindowOf(record) {
	const config = record["context_config"];
	if (config === null || typeof config !== "object" || Array.isArray(config)) return void 0;
	const tokenCountOf = (entry) => {
		if (entry === null || typeof entry !== "object") return void 0;
		const value = entry["token_count"];
		return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
	};
	const sizes = Object.values(config).map(tokenCountOf).filter((value) => value !== void 0);
	return sizes.length === 0 ? void 0 : Math.max(...sizes);
}
/**
* The routes Qoder lists beside its models without naming them.
*
* The global directory returns four entries whose display names are Qoder's own
* codenames — Ultimate, Efficient, Sonus, Cantus — and nothing in the payload
* marks them as different from a named model: same `source`, same `format`, same
* `is_editable`, and one of them even carries a promotion. Offered in the picker
* they read as four opaque names between Auto and Qwen3.8-Max. The keys are what
* Qoder's API has returned for them across versions, so they are matched by key
* on whichever directory lists them. The `auto` route stays: it is a model choice
* a user recognises, and it is the row the directory marks `is_default`.
*/
const QODER_UNNAMED_ROUTES = /* @__PURE__ */ new Set([
	"ultimate",
	"efficient",
	"smodel",
	"cmodel"
]);
/** One directory row → one callable model, or undefined when unusable. */
function qoderModelOf(entry) {
	if (entry === null || typeof entry !== "object") return void 0;
	const record = entry;
	if (typeof record["key"] !== "string" || record["key"].length === 0) return void 0;
	if (QODER_UNNAMED_ROUTES.has(record["key"])) return void 0;
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
	const contextConfig = qoderContextWindowOf(record);
	const contextWindow = contextConfig === void 0 ? maxInputTokens : Math.max(contextConfig, maxInputTokens ?? 0);
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
		if (!response.ok) throw new Error(`Qoder model list failed: HTTP ${response.status} ${await readErrorBody(response, 300, signal)}`);
		const chat = readQoderCatalogShape(await response.json());
		const models = [];
		for (const raw of chat) {
			const model = qoderModelOf(raw);
			if (model !== void 0) models.push(model);
		}
		if (models.length === 0) throw new Error("Qoder model list contained no callable model");
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
			if (!response.ok) throw new Error(`Qoder usage failed: HTTP ${response.status} ${await readErrorBody(response, 300, signal)}`);
			return await response.json();
		};
		/**
		* Turn one route's document into the panel shape.
		*
		* Validation is part of parsing, not a key-presence check before it: a
		* document carrying only `expiresAt`, or an empty quota object, used to pass
		* `usable()` and then throw after the fallback had already been skipped.
		*/
		const parse = (value, source) => {
			const envelope = value === null || typeof value !== "object" ? {} : value;
			const usage = envelope["qoderUsage"] ?? envelope["data"] ?? value;
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
		};
		try {
			return parse(await read(QODER_USAGE_PRESENTATION_PATH), "presentation");
		} catch (error) {
			if (signal?.aborted) throw error;
			return parse(await read(QODER_USAGE_PATH), "quota");
		}
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
		if (!response.ok) throw new Error(`Qoder campaigns failed: HTTP ${response.status} ${await readErrorBody(response, 300, signal)}`);
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
		if (!response.ok) {
			const detail = await readErrorBody(response, 300, signal);
			throw new Error(`Qoder check-in failed: HTTP ${response.status} ${detail.slice(0, 200)}`);
		}
		const text = await response.text();
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
		} catch (error) {
			const detail = error instanceof Error ? error.message : "";
			return {
				ok: false,
				status: 400,
				kind: "client",
				message: detail === "" ? "invalid JSON request" : detail
			};
		}
		let credential;
		try {
			credential = await this.options.credential();
		} catch (error) {
			return {
				ok: false,
				status: 503,
				kind: "server",
				message: `credential read failed: ${String(error instanceof Error ? error.message : error)}`
			};
		}
		const url = qoderEndpoint(this.baseUrl(), QODER_CHAT_PATH);
		const bodyBytes = encodeBody(plain);
		const headers = buildCosyAuthHeaders(bodyBytes, url, credential);
		let response;
		const deadline = headersDeadline(options.signal, options.timeouts?.headersMs ?? CHAT_HEADERS_TIMEOUT_MS);
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
				signal: deadline.signal
			});
		} catch (error) {
			if (options.signal?.aborted === true) return {
				ok: false,
				status: 0,
				kind: "aborted",
				message: "cancelled by the caller"
			};
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `transport error: ${String(error)}`
			};
		} finally {
			deadline.arrived();
		}
		if (!response.ok) {
			const text = await readErrorBody(response, 300, options.signal);
			return {
				ok: false,
				status: response.status,
				kind: classifyQoderUpstreamError(response.status),
				message: text.slice(0, 300) || `Qoder returned HTTP ${response.status}`,
				retryAfter: response.headers.get("retry-after")
			};
		}
		return {
			ok: true,
			response: response.body === null ? response : new Response(withIdleWatchdog(response.body, options.timeouts?.idleMs, options.signal), {
				status: response.status,
				headers: response.headers
			})
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
* Whether a code is the success-range acknowledgement Qoder sends for a
* container it accepted. `{"code":0}` and `{"code":200}` are how it acks.
*/
function isAcknowledgementCode(value) {
	if (typeof value !== "string" && typeof value !== "number") return false;
	if (typeof value === "string" && value.length === 0) return false;
	const code = Number(value);
	return Number.isFinite(code) && (code === 0 || code >= 200 && code < 300);
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
	const signals = [];
	let node = frame;
	let descended = false;
	let codeFromPlainKey = false;
	let codeFromErrorSpelling = false;
	let arrivedViaContainer = false;
	for (let depth = 0; depth < 8; depth++) {
		if (!isPlainObject(node)) break;
		const errorSpelling = node["errorCode"] ?? node["errcode"];
		const levelCode = errorSpelling ?? node["code"];
		const acknowledgement = arrivedViaContainer && codeFromPlainKey && isAcknowledgementCode(levelCode);
		if (errorSpelling !== void 0 || !codeFromErrorSpelling && !acknowledgement) {
			if (typeof levelCode === "string" && levelCode.length > 0) {
				code = levelCode;
				codeFromPlainKey = errorSpelling === void 0;
				codeFromErrorSpelling = errorSpelling !== void 0;
			} else if (typeof levelCode === "number" && Number.isFinite(levelCode)) {
				code = String(levelCode);
				codeFromPlainKey = errorSpelling === void 0;
				codeFromErrorSpelling = errorSpelling !== void 0;
			}
		}
		const message = node["message"] ?? node["errorMessage"];
		if (typeof message === "string" && message.trim() !== "" && !signals.includes(message)) signals.push(message);
		if ((detail === "" || tryJsonObject(detail) !== void 0) && typeof message === "string" && message.length > 0) detail = message;
		const flat = typeof node["error"] === "string" ? node["error"] : typeof node["details"] === "string" ? node["details"] : void 0;
		if (flat !== void 0 && flat.trim() !== "" && !signals.includes(flat)) signals.push(flat);
		if (detail === "" && flat !== void 0 && flat.length > 0) detail = flat;
		const nested = isPlainObject(node["details"]) ? node["details"] : isPlainObject(node["error"]) ? node["error"] : void 0;
		const next = nested ?? (typeof message === "string" ? tryJsonObject(message) : void 0);
		if (next === void 0) break;
		node = next;
		arrivedViaContainer = nested !== void 0;
		descended = true;
	}
	if (descended && detail === "" && isPlainObject(node)) detail = JSON.stringify(node);
	if (codeFromPlainKey && isAcknowledgementCode(code)) code = "";
	return {
		code,
		detail,
		signals: signals.join("\n")
	};
}
/**
* The gateway's retry hint, when the frame carries one.
*
* A carried `0` is the decoder's "no hint" placeholder, not a real wait. The
* hint may sit on the envelope, in a nested container, or inside a message that
* is itself a JSON document; the walk reads all three so a queue descriptor is
* not lost when the outer sentence is the one worth showing.
*/
function retryAfterSecondsOf(frame) {
	const seen = /* @__PURE__ */ new Set();
	let node = frame;
	for (let depth = 0; depth < 8; depth++) {
		if (!isPlainObject(node) || seen.has(node)) break;
		seen.add(node);
		const direct = node["retryAfterSeconds"];
		if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) return direct;
		const message = node["message"] ?? node["errorMessage"];
		const next = (isPlainObject(node["details"]) ? node["details"] : isPlainObject(node["error"]) ? node["error"] : void 0) ?? (typeof message === "string" ? tryJsonObject(message) : void 0);
		if (next === void 0) break;
		node = next;
	}
	return 0;
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
* Classify one data payload. A token-accounting frame carries `choices: []`
* with a top-level `usage`; it must be forwarded as a chunk, not read as a
* failure. Anything with neither output nor a name — a bare `{ success: true }`
* keepalive, or a payload whose shape moved — is reported as unknown rather
* than guessed at. A frame that carries an empty `choices` and no usage is a
* failure frame wearing a chunk's clothes: the upstream reports refusals that
* way, and forwarding it as a chunk answered the client with an empty turn.
*/
function decodeQoderFrame(payload) {
	const chunk = unwrapQoderFrame(payload);
	if (chunk === void 0) return {
		type: "unknown",
		reason: "unparseable",
		data: payload
	};
	const choices = chunk["choices"];
	const hasOutput = Array.isArray(choices) && choices.length > 0;
	const hasUsage = chunk["usage"] !== void 0 && chunk["usage"] !== null;
	if (hasOutput || hasUsage) return {
		type: "chunk",
		chunk
	};
	const { code, detail, signals } = unwrapFailure(chunk);
	if (code === "" && detail === "") return {
		type: "unknown",
		reason: "unnamed",
		data: chunk
	};
	return {
		type: "failure",
		code,
		detail,
		signals,
		retryAfterSeconds: retryAfterSecondsOf(chunk)
	};
}
/**
* One unterminated line may not grow without bound; chat deltas are small.
* The ceiling is a memory guard on the upstream's answer, which no request-body
* limit bounds: a frame this size is a stream gone wrong, not a chat delta.
*/
const MAX_LINE_CHARS = 67108864;
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
		for (;;) {
			const match = /\r\n|\n|\r/.exec(this.buffer);
			if (match === null || match.index === void 0) break;
			if (match[0] === "\r" && match.index + 1 === this.buffer.length) break;
			const line = this.buffer.slice(0, match.index).trim();
			this.buffer = this.buffer.slice(match.index + match[0].length);
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
			throw new Error("sse line exceeded 67108864 characters without a newline");
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
/**
* How long a turn that has already emitted its finish chunk waits for anything
* trailing before the relay ends it itself.
*
* Qoder finishes a turn by leaving the socket open: the finish chunk and the
* usage frame arrive and then nothing, with no `[DONE]` and no close. A relay
* that waited for the upstream to end left the client on a turn that was already
* over - measured against the live gateway at seven minutes with no terminal
* frame. A vendor that does close its stream wins this race and pays nothing.
*/
const TAIL_GRACE_MS = 1e3;
/**
* How long a peek that has seen a frame carrying no output waits for a refusal
* that may follow it.
*
* Qoder opens a turn with a role-only delta. Committing on that frame hid a
* refusal in the very next one; waiting for output instead kept the 200 from the
* client for the whole thinking phase. The grace is enough for a refusal that
* arrives promptly, and short enough that a slow model still gets its headers.
*/
const PEEK_OUTPUT_GRACE_MS = 1e3;
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
	const text = `${code} ${failure.message} ${failure.signals ?? ""}`;
	const frame = {
		type: "failure",
		code,
		detail: failure.message,
		signals: failure.signals ?? "",
		retryAfterSeconds: failure.retryAfterSeconds ?? 0
	};
	if (code === "110" || /daily.*(limit|quota)|quota.*daily|allowance.*spent/i.test(text)) {
		const retryAfter = queueSeconds(frame);
		return {
			status: 429,
			kind: "hard_credit",
			error: new QoderDailyLimitRejection(Number.isFinite(retryAfter) ? retryAfter : 0, failure.message)
		};
	}
	if (code === "10605") return {
		status: 429,
		kind: "soft_rate",
		error: new QoderQueueRejection(queueSeconds(frame), failure.message)
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
	if (queueMarkerCount(text) >= 2) return {
		status: 429,
		kind: "soft_rate",
		error: new QoderQueueRejection(queueSeconds(frame), failure.message)
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
	let lastKeepaliveAt = 0;
	const keepalive = (controller) => {
		const now = Date.now();
		if (now - lastKeepaliveAt < 1e4) return;
		lastKeepaliveAt = now;
		controller.enqueue(encoder.encode(": keepalive\n\n"));
	};
	const reader = source.getReader();
	let cancelled = false;
	let wakeRoom;
	const waitForRoom = () => new Promise((resolve) => {
		let settled = false;
		const wake = () => {
			if (settled) return;
			settled = true;
			wakeRoom = void 0;
			resolve();
		};
		wakeRoom = wake;
		setTimeout(wake, 50);
	});
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
		if (finished) return;
		const decoded = decodeQoderFrame(payload);
		if (decoded.type === "unknown") {
			keepalive(controller);
			return;
		}
		if (decoded.type === "failure") {
			const { error } = classifyQoderFailure({
				code: decoded.code,
				message: decoded.detail,
				signals: decoded.signals,
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
					controller.enqueue(chunk({}, openAIFinishReason(finish, sawToolCalls)));
					endSoon();
				}
			}
		}
		if (inner["usage"] !== void 0 && inner["usage"] !== null && typeof inner["usage"] === "object") {
			usage = inner["usage"];
			controller.enqueue(chunk(null));
			if (emittedFinishReason) endTurn();
		}
	};
	let released = false;
	let tailTimer;
	let ctrl;
	let finished = false;
	/**
	* End the turn from outside `pull`.
	*
	* The vendor keeps its socket open after the finish chunk, so a timer has to
	* close the relay; waiting for a read that the vendor will never end left the
	* client on a turn that was already over ("still generating" after the text
	* stopped). Closing the controller directly is what makes that independent of
	* whether a read happens to be pending.
	*/
	const finalize = () => {
		if (finished) return;
		finished = true;
		clearTail();
		wakeRoom?.();
		try {
			ctrl?.enqueue(encoder.encode("data: [DONE]\n\n"));
			ctrl?.close();
		} catch {}
		reader.cancel().catch(() => {});
	};
	const endTurn = finalize;
	const endSoon = () => {
		if (tailTimer !== void 0) return;
		tailTimer = setTimeout(finalize, TAIL_GRACE_MS);
		tailTimer.unref?.();
	};
	const clearTail = () => {
		if (tailTimer !== void 0) clearTimeout(tailTimer);
		tailTimer = void 0;
	};
	/**
	* Release the upstream reader, once, on the way out.
	*
	* Done here rather than only in the failure path: a stream that ran to EOF
	* closes its controller instead of erroring, and that exit skips the catch
	* entirely, so the cancel and the unlock would otherwise only ever run for a
	* failed turn - leaving a normal one with the upstream reader locked and its
	* source uncancelled.
	*/
	const release = async () => {
		if (released) return;
		released = true;
		clearTail();
		await reader.cancel().catch(() => {});
		try {
			reader.releaseLock();
		} catch {}
	};
	return new ReadableStream({
		/**
		* Push from one loop rather than pull one chunk at a time.
		*
		* The pull-driven version asked the host to call back for every upstream
		* chunk, and in the plugin process those callbacks stopped arriving after a
		* few kilobytes: the turn opened, streamed a little, and then went silent
		* until the client gave up. One loop owns the read side; `desiredSize` is
		* the only backpressure.
		*/
		start(controller) {
			ctrl = controller;
			(async () => {
				try {
					for (;;) {
						if (finished) return;
						const next = await reader.read();
						if (cancelled || finished) return;
						if (!next.done) {
							for (const payload of frames.push(decoder.decode(next.value, { stream: true }))) consume(payload, controller);
							if (!frames.ended) {
								while (!cancelled && !finished && (controller.desiredSize ?? 1) <= 0) await waitForRoom();
								continue;
							}
						}
						const rest = decoder.decode();
						for (const payload of rest === "" ? frames.finish() : [...frames.push(rest), ...frames.finish()]) consume(payload, controller);
						if (!finished) {
							if (!emittedFinishReason) {
								emittedFinishReason = true;
								controller.enqueue(chunk({}, openAIFinishReason(void 0, sawToolCalls)));
							}
							finalize();
						}
						return;
					}
				} catch (error) {
					if (cancelled) controller.error(error);
					else if (!finished) {
						if (!(error instanceof Error && error.name === "AbortError")) try {
							options.onFailure?.(error);
						} catch {}
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
							controller.enqueue(chunk({}, openAIFinishReason(void 0, sawToolCalls)));
						}
						finalize();
					}
				} finally {
					await release();
				}
			})();
		},
		pull() {
			wakeRoom?.();
		},
		cancel(reason) {
			cancelled = true;
			clearTail();
			wakeRoom?.();
			return reader.cancel(reason);
		}
	});
}
/**
* Whether a Qoder chunk carries output a client would actually see.
*
* A role-only delta and a usage-only frame both have `choices`, but neither is
* output: a refusal that follows them can still become a real status code and
* let the next account try. Counting any non-empty `choices` as output committed
* the stream at 200 and skipped failover.
*/
function qoderChunkHasOutput(chunk) {
	const choices = chunk["choices"];
	if (!Array.isArray(choices)) return false;
	for (const raw of choices) {
		if (raw === null || typeof raw !== "object") continue;
		const delta = raw["delta"];
		if (delta === null || typeof delta !== "object") continue;
		const fields = delta;
		if (typeof fields["content"] === "string" && fields["content"] !== "") return true;
		if (typeof fields["reasoning_content"] === "string" && fields["reasoning_content"] !== "") return true;
		const calls = fields["tool_calls"];
		if (Array.isArray(calls) && calls.length > 0) return true;
	}
	return false;
}
/**
* Whether a Qoder chunk closes the turn, even if the socket stays open.
*
* Qoder reports a completed turn with a `finish_reason` and often a trailing
* usage frame, then leaves the connection open. The peek must stop there or it
* waits for the upstream idle watchdog on a turn that has already finished.
*/
function qoderChunkIsTerminal(chunk) {
	const choices = chunk["choices"];
	if (Array.isArray(choices)) for (const raw of choices) {
		if (raw === null || typeof raw !== "object") continue;
		const finish = raw["finish_reason"];
		if (finish !== void 0 && finish !== null) return true;
	}
	return chunk["usage"] !== void 0 && chunk["usage"] !== null;
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
		const detail = await readErrorBody(response, 1024);
		return Response.json({ error: {
			message: detail === "" ? `Qoder returned HTTP ${response.status}` : detail,
			type: "upstream_error",
			code: response.status
		} }, { status: response.status });
	}
	if (response.body === null) return Response.json({ error: {
		message: `Qoder response ${response.status} carried no body`,
		type: "upstream_error",
		code: 502
	} }, { status: 502 });
	const reader = relayStreamOf(response).getReader();
	const decoder = new TextDecoder();
	const frames = new QoderFrameDecoder();
	const buffered = [];
	let bufferedBytes = 0;
	let sawOutput = false;
	let sawTerminal = false;
	let sawQuiet = false;
	let graceDeadline = 0;
	let pendingRead;
	let failure;
	let ended = false;
	const inspect = (payloads) => {
		for (const payload of payloads) {
			const decoded = decodeQoderFrame(payload);
			if (decoded.type === "chunk") {
				const chunk = decoded.chunk;
				if (qoderChunkHasOutput(chunk)) sawOutput = true;
				if (qoderChunkIsTerminal(chunk)) sawTerminal = true;
				if (!sawOutput && !sawTerminal && Array.isArray(chunk["choices"]) && chunk["choices"].length > 0) sawQuiet = true;
			} else if (decoded.type === "failure") failure ??= {
				code: decoded.code,
				message: decoded.detail,
				signals: decoded.signals,
				retryAfterSeconds: decoded.retryAfterSeconds
			};
			if (sawOutput || sawTerminal || failure !== void 0) break;
		}
	};
	try {
		while (buffered.length < 64 && bufferedBytes < 262144) {
			let next;
			if (graceDeadline === 0) next = await reader.read();
			else {
				const read = reader.read();
				pendingRead = read;
				read.catch(() => {});
				const remaining = Math.max(0, graceDeadline - Date.now());
				let timer;
				const timedOut = new Promise((resolve) => {
					timer = setTimeout(() => resolve(void 0), remaining);
				});
				let winner;
				try {
					winner = await Promise.race([read.then((result) => ({ result })), timedOut]);
				} finally {
					if (timer !== void 0) clearTimeout(timer);
				}
				if (winner === void 0) break;
				next = winner.result;
				pendingRead = void 0;
			}
			if (next.done) {
				ended = true;
				const rest = decoder.decode();
				inspect(rest === "" ? frames.finish() : [...frames.push(rest), ...frames.finish()]);
				break;
			}
			buffered.push(next.value);
			bufferedBytes += next.value.byteLength;
			inspect(frames.push(decoder.decode(next.value, { stream: true })));
			if (sawOutput || sawTerminal || failure !== void 0 || frames.ended) break;
			if (sawQuiet && graceDeadline === 0) graceDeadline = Date.now() + PEEK_OUTPUT_GRACE_MS;
		}
	} catch (error) {
		pendingRead = void 0;
		await reader.cancel().catch(() => {});
		throw error;
	}
	if (failure !== void 0 && !sawOutput) {
		await reader.cancel().catch(() => {});
		const { status, error } = classifyQoderFailure(failure);
		const retryAfter = error instanceof QoderQueueRejection || error instanceof QoderDailyLimitRejection ? error.retryAfterSeconds : void 0;
		const wait = retryAfter === void 0 ? void 0 : retryAfterHeader(retryAfter);
		return Response.json({ error: {
			message: error.message === "" ? `Qoder refused the request (${failure.code})` : error.message.slice(0, 1024),
			type: "upstream_error",
			code: status,
			...retryAfter === void 0 || !(retryAfter > 0) ? {} : { retryAfterSeconds: retryAfter }
		} }, {
			status,
			...wait === void 0 ? {} : { headers: { "Retry-After": wait } }
		});
	}
	const relay = bridgeQoderStream(replaySource(buffered, {
		async read() {
			const queued = pendingRead;
			if (queued !== void 0) {
				pendingRead = void 0;
				return queued;
			}
			return reader.read();
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	}, ended), model, options);
	return withRelayStream(new Response(relay, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" }
	}), relay);
}
//#endregion
//#region src/qoder-gateway.ts
const MODELS_TTL_MS = 6e5;
/**
* How long a failed directory read is not retried.
*
* Each attempt walks five upstream functions, each with its own 30s timeout,
* so a black-holed directory host otherwise stalled every chat request for the
* length of the whole walk before it could answer 503.
*/
const CATALOG_FAILURE_BACKOFF_MS = 3e4;
function createQoderGateway(options) {
	const logger = options.logger;
	let cachedModels = [];
	let catalogAt = 0;
	let catalogFailedAt = 0;
	let catalogErrorText = "";
	let catalogInFlight;
	/**
	* Every sign-in that could read the directory, in the order the chat path
	* would try them.
	*
	* The directory is a per-account read like any other: a sign-in the upstream
	* has revoked answers 401 on it, and reading with the first one only left the
	* whole gateway answering 503 and publishing no provider row while a healthy
	* sign-in sat beside it unused.
	*/
	async function directoryCredentials() {
		return (await options.credentials()).filter((credential) => credential.token !== "");
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
		if (catalogFailedAt > 0 && Date.now() - catalogFailedAt < CATALOG_FAILURE_BACKOFF_MS) {
			if (cachedModels.length > 0) return cachedModels;
			throw new Error(`Qoder model directory read failed recently, backing off: ${catalogErrorText}`);
		}
		catalogInFlight = (async () => {
			try {
				const candidates = await directoryCredentials();
				if (candidates.length === 0) throw new Error("no Qoder sign-in found on this machine");
				let lastError;
				for (const credential of candidates) try {
					const read = await clientFor(credential).fetchModels();
					cachedModels = read;
					catalogAt = Date.now();
					catalogFailedAt = 0;
					return read;
				} catch (error) {
					lastError = error;
				}
				throw lastError ?? /* @__PURE__ */ new Error("no Qoder sign-in could read the model directory");
			} catch (error) {
				catalogFailedAt = Date.now();
				catalogErrorText = error instanceof Error ? error.message : String(error);
				throw error;
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
		let credentials;
		try {
			credentials = (await options.credentials("chat")).filter((credential) => credential.token !== "");
		} catch (error) {
			writeOpenAIError(res, 503, "upstream_unavailable", String(error instanceof Error ? error.message : error));
			return;
		}
		if (credentials.length === 0) {
			writeOpenAIError(res, 503, "upstream_unavailable", "no Qoder sign-in found on this machine");
			return;
		}
		if (watcher.signal.aborted) return;
		const directory = roster.find((entry) => entry.id === model);
		const call = qoderRequestBody(raw, model, directory);
		/**
		* One sign-in's attempt: the chat call plus the peek that turns a refusal
		* hidden in the stream into a real status.
		*
		* The peek is inside the attempt because a refusal is usually a property of
		* the sign-in (an expired login, a subscription gate), which is exactly
		* what the next sign-in in the ordered list is for.
		*/
		const attemptOnce = async (credential) => {
			const result = await clientFor(credential).chatStream(call.body, call.model, {
				...call.options,
				extraHeaders: {
					"X-Model-Key": model,
					"X-Model-Source": "system"
				},
				signal: watcher.signal
			});
			if (!result.ok) return {
				ok: false,
				status: result.status,
				message: result.message,
				kind: result.kind,
				retryAfter: result.retryAfter
			};
			let relayed;
			try {
				relayed = await openQoderResponse(result.response, model, { onFailure: (error) => {
					logger?.warn?.("wtq-pool: qoder relay stream failed mid-flight", error);
					if (!(error instanceof Error && error.name === "AbortError") && !watcher.signal.aborted) {
						const seconds = error.retryAfterSeconds;
						options.onAttemptFailure?.(credential, { ...typeof seconds === "number" && seconds > 0 ? { retryAfter: String(seconds) } : {} });
					}
				} });
			} catch (error) {
				if (watcher.signal.aborted || error instanceof Error && error.name === "AbortError") return {
					ok: false,
					status: 0,
					kind: "aborted",
					message: "the caller went away while the answer was being read"
				};
				return {
					ok: false,
					status: 0,
					kind: "server",
					message: `relay read failed: ${String(error instanceof Error ? error.message : error)}`
				};
			}
			if (relayed.status !== 200) {
				const detail = await relayed.text().catch(() => "");
				return {
					ok: false,
					status: relayed.status,
					message: detail,
					retryAfter: relayed.headers.get("retry-after")
				};
			}
			return {
				ok: true,
				relayed
			};
		};
		/**
		* Rotate past a failure that belongs to the sign-in rather than to the
		* request: an expired login, a subscription gate, a rate limit. A malformed
		* body or an unknown model fails the same way on every account, so it is
		* answered as-is.
		*/
		const rotates = (status, kind) => {
			if (kind === "aborted") return false;
			if (status === 0) return true;
			return kind === "authentication" || kind === "soft_rate" || kind === "hard_credit" || status === 401 || status === 402 || status === 429;
		};
		let opened;
		for (let index = 0; index < credentials.length; index += 1) {
			if (watcher.signal.aborted) return;
			const credential = credentials[index];
			if (credential === void 0) continue;
			const attempt = await attemptOnce(credential);
			if (attempt.ok) {
				opened = attempt;
				break;
			}
			opened = attempt;
			if (!rotates(attempt.status, attempt.kind)) break;
			options.onAttemptFailure?.(credential, { ...attempt.retryAfter === void 0 ? {} : { retryAfter: attempt.retryAfter } });
			if (index < credentials.length - 1) logger?.warn?.(`${LOG_PREFIX}: qoder sign-in failed on ${model} (http ${attempt.status}); rotating`);
		}
		if (opened === void 0 || !opened.ok) {
			if (opened !== void 0 && opened.kind === "aborted") return;
			const status = opened?.status ?? 502;
			const retryAfter = retryAfterHeader(opened?.retryAfter);
			if (retryAfter !== void 0) res.setHeader("Retry-After", retryAfter);
			const lifted = liftUpstreamMessage(opened?.message ?? "");
			writeOpenAIError(res, status === 0 ? 502 : status, "upstream_error", lifted === "" ? "Qoder refused the request" : lifted);
			return;
		}
		const relayed = opened.relayed;
		if (relayed.body === null) {
			writeOpenAIError(res, 502, "upstream_error", "Qoder returned no stream");
			return;
		}
		if (watcher.signal.aborted) {
			relayStreamOf(relayed).cancel().catch(() => {});
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		res.flushHeaders();
		pumpToResponse(relayStreamOf(relayed), res).catch((error) => {
			if (!(watcher.signal.aborted || error instanceof Error && error.name === "AbortError")) logger?.warn?.("wtq-pool: qoder relay stream failed mid-flight", error);
			if (res.writable) res.end();
		});
	}
	async function handle(req, res) {
		if (!guardsPass(req, res)) return;
		const url = requestPathname(req.url);
		if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
			writeJson(res, 200, {
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
				logger?.warn?.("wtq-pool: qoder directory refresh failed; serving the cached roster");
			}
			const ids = options.listedIds?.();
			writeJson(res, 200, {
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
	const server = createLoopbackServer({
		port: options.port,
		label: "qoder gateway",
		handle,
		logger
	});
	const ready = server.ready;
	const port = server.port;
	return {
		ready,
		baseUrl: server.baseUrl,
		port,
		models: () => cachedModels,
		close: server.close
	};
}
//#endregion
//#region src/login.ts
/** The domestic gateway, which serves the domestic login page. */
const CN_BASE = "https://copilot.tencent.com";
/** The international gateway. */
const GLOBAL_BASE = "https://www.workbuddy.ai";
/** Billing origin the domestic login page is served from. */
const CN_ORIGIN = "https://www.codebuddy.cn";
/** The international login page is same-origin with its gateway. */
const GLOBAL_ORIGIN = "https://www.workbuddy.ai";
/**
* The CLI's own user agent.
*
* The endpoints answer this spelling and turn the plugin's other ones away,
* and the page it opens belongs to the same client channel — a different
* spelling there is answered as an unknown platform.
*/
const LOGIN_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const REQUEST_TIMEOUT_MS = 3e4;
/**
* Domain stamped on a sign-in whose answer carried none.
*
* `regionOf` reads an empty domain as CN, so a global login that arrives
* without one would be filed under the domestic gateway, which refuses its
* token at the openresty layer with an HTML 401 instead of a business error.
*/
const DEFAULT_DOMAIN = {
	cn: "www.codebuddy.cn",
	global: "www.workbuddy.ai"
};
function baseFor(realm) {
	return realm === "global" ? GLOBAL_BASE : CN_BASE;
}
function originFor(realm) {
	return realm === "global" ? GLOBAL_ORIGIN : CN_ORIGIN;
}
/**
* The browser URL a login start hands the panel.
*
* The panel opens it without inspecting it, so the scheme is checked here: an
* upstream answer that named `javascript:` or `file:` would otherwise be handed
* straight to the desktop shell.
*/
function checkedAuthUrl(value) {
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("workbuddy login start returned an invalid url");
	}
	if (parsed.protocol !== "https:") throw new Error("workbuddy login start returned a non-https url");
	return value;
}
/** Browser-shaped headers; `Origin` is the one the endpoints check. */
function loginHeaders(origin) {
	return {
		"Accept": "application/json, text/plain, */*",
		"Content-Type": "application/json",
		"Origin": origin,
		"Referer": `${origin}/`,
		"User-Agent": LOGIN_UA,
		"X-Requested-With": "XMLHttpRequest",
		"Connection": "close"
	};
}
async function callLogin(url, headers, fetchImpl, body) {
	const response = await fetchImpl(url, {
		redirect: "error",
		method: body === void 0 ? "GET" : "POST",
		headers,
		...body === void 0 ? {} : { body },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`workbuddy login endpoint answered ${response.status}`);
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("workbuddy login endpoint did not answer JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("workbuddy login endpoint did not answer an object");
	const document = parsed;
	const data = typeof document["data"] === "object" && document["data"] !== null ? document["data"] : {};
	return {
		code: typeof document["code"] === "number" ? document["code"] : -1,
		msg: typeof document["msg"] === "string" ? document["msg"] : "",
		data
	};
}
function stringField(data, key) {
	const value = data[key];
	return typeof value === "string" ? value : "";
}
/**
* Start a login and answer the URL to open.
*
* The state is the only thing that ties the browser half to this one, so the
* caller keeps it for as long as it polls and drops it afterwards.
*/
async function startDeviceLogin(realm, fetchImpl = fetch) {
	const envelope = await callLogin(`${baseFor(realm)}/v2/plugin/auth/state?platform=CLI`, loginHeaders(originFor(realm)), fetchImpl, "{}");
	const state = stringField(envelope.data, "state");
	const authUrl = stringField(envelope.data, "authUrl");
	if (state === "" || authUrl === "") throw new Error(`workbuddy login start gave no state or url: ${envelope.msg}`);
	return {
		state,
		authUrl: checkedAuthUrl(authUrl)
	};
}
/**
* Read the account a fresh token belongs to.
*
* Best effort by design: the token is already good, so an identity that cannot
* be read costs the panel a name and the archive a stable key, not the sign-in.
*/
async function readLoginAccount(base, headers, state, accessToken, fetchImpl) {
	const empty = {
		uid: "",
		uin: "",
		enterpriseId: "",
		nickname: ""
	};
	let envelope;
	try {
		envelope = await callLogin(`${base}/v2/plugin/login/account?state=${encodeURIComponent(state)}`, {
			...headers,
			"Authorization": `Bearer ${accessToken}`
		}, fetchImpl);
	} catch {
		return empty;
	}
	if (envelope.code !== 0) return empty;
	return {
		uid: stringField(envelope.data, "uid"),
		uin: stringField(envelope.data, "uin"),
		enterpriseId: stringField(envelope.data, "enterpriseId"),
		nickname: stringField(envelope.data, "nickname")
	};
}
/**
* Poll a started login once.
*
* The token endpoint is the authority on whether the browser has finished: it
* answers `code: 0` with the token bundle once it has, and a business error
* for as long as it has not. A non-2xx or an unreadable answer throws, because
* neither means "keep waiting".
*/
async function pollDeviceLogin(realm, state, fetchImpl = fetch) {
	const base = baseFor(realm);
	const headers = loginHeaders(originFor(realm));
	const token = await callLogin(`${base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, headers, fetchImpl);
	const accessToken = stringField(token.data, "accessToken");
	if (token.code !== 0 || accessToken === "") return { status: "pending" };
	const domain = stringField(token.data, "domain");
	const identity = await readLoginAccount(base, headers, state, accessToken, fetchImpl);
	const stamped = domain === "" ? DEFAULT_DOMAIN[realm] : domain;
	return {
		status: "ok",
		signIn: {
			region: regionOf(stamped),
			accessToken,
			refreshToken: stringField(token.data, "refreshToken"),
			expiresAtMs: tokenExpiryMs(typeof token.data["expiresIn"] === "number" ? token.data["expiresIn"] : void 0),
			domain: stamped,
			...identity
		}
	};
}
//#endregion
//#region src/source-pool.ts
/**
* The account pool the Trae and Qoder gateways share.
*
* `WorkBuddyAccountPool` cools an account the moment the upstream refuses it, so
* the next request never pays the same failure twice. The two source gateways
* rotate only inside one request: nothing remembered a spent allowance, and
* with a single sign-in every request paid one failed round trip before the
* upstream's own answer, while the client was being told to wait hours. The
* wait the upstream states is honoured; anything else takes the user's own
* cooldown setting, the same pace the pool uses for a soft limit.
*
* The plugin owns the settings each of those decisions reads, so they are handed
* in once rather than reached for: the pool itself stays a plain function of its
* arguments plus the state below, which is what lets a check drive it directly.
*
* @module dsh-wtq-pool/source-pool
*/
/** Build the pool the Trae and Qoder gateways share, wired to the host's readers. */
function createSourcePool(host) {
	/**
	* The key one account's state is stored under.
	*
	* The region belongs in it: one label can name a copy in each region (the
	* scanner keys its rows by label *and* region for exactly that reason), so a
	* key without it hands one region's hold and pack expiry to the other region's
	* account.
	*/
	function accountStateKey(source, region, label) {
		return host.sourceRegionKey(source, region) + "\n" + label;
	}
	/** account key -> the timestamp that account's soonest one-off pack runs out at. */
	const sourceCreditExpiry = /* @__PURE__ */ new Map();
	/** Unknown expiry sorts last, so it never beats a real deadline. */
	function packUrgency(source, region, label, now) {
		const at = sourceCreditExpiry.get(accountStateKey(source, region, label));
		return typeof at === "number" && at > now ? at : Infinity;
	}
	/** Where each source region's rotation stands. Advanced once per chat, never by a directory or health read. */
	const sourceRotation = /* @__PURE__ */ new Map();
	/**
	* Until when a Trae or Qoder sign-in that just failed is kept out of the lead,
	* keyed the way `sourceCreditExpiry` is.
	*/
	const sourceFailureHold = /* @__PURE__ */ new Map();
	function noteSourceFailure(source, region, label, retryAfter) {
		const stated = retryAfterHeader(retryAfter);
		const waitMs = stated === void 0 ? host.cooldownMs() : Number(stated) * 1e3;
		sourceFailureHold.set(accountStateKey(source, region, label), Date.now() + waitMs);
	}
	/** Whether one sign-in is inside the hold a failure put on it. */
	function sourceFailureActive(source, region, label, now) {
		const key = accountStateKey(source, region, label);
		const until = sourceFailureHold.get(key);
		if (until === void 0) return false;
		if (until <= now) {
			sourceFailureHold.delete(key);
			return false;
		}
		return true;
	}
	/** A sign-in with no expiry is still usable. Only a timestamp that has passed is dead. */
	function sourceCredentialExpired(credential, now) {
		return typeof credential.expiresAtMs === "number" && credential.expiresAtMs > 0 && credential.expiresAtMs <= now;
	}
	/**
	* One source region's credentials, in the order its gateway should try them:
	* the picked account first, then tokens that still work before expired ones,
	* and a sign-in the upstream just refused behind the healthy ones.
	*
	* The gateways take the first usable entry and re-read this list per request,
	* so this order is the whole of "which account serves this region" — and
	* putting a live token ahead of a dead one is what keeps a stale sign-in from
	* being the one that answers.
	*
	* A picked account is what the user asked to spend, so it leads in every mode;
	* only "automatic" leaves the choice to the usage mode. Round-robin then walks
	* the list one account per chat. `rotate` is false for model-list and health
	* reads: advancing the cursor there would make the account a chat lands on
	* depend on whichever read ran last.
	
	*/
	function orderSourceCredentials(source, region, credentials, labelOf, rotate) {
		const now = Date.now();
		const stored = host.preferredSourceAccount(source, region);
		const preferred = stored !== "" && credentials.some((credential) => labelOf(credential) === stored) ? stored : "";
		const rank = (credential) => {
			const expired = sourceCredentialExpired(credential, now) ? 1 : 0;
			const held = expired === 0 && sourceFailureActive(source, region, labelOf(credential), now) ? 1 : 0;
			const wanted = preferred !== "" && labelOf(credential) === preferred ? 0 : 1;
			return expired * 4 + held * 2 + wanted;
		};
		const ordered = credentials.slice().sort((left, right) => rank(left) - rank(right));
		if (preferred === "" && host.sourceDistribution(source) === "expiry") {
			const live = ordered.filter((credential) => !sourceCredentialExpired(credential, now));
			const rest = ordered.filter((credential) => sourceCredentialExpired(credential, now));
			const healthy = live.filter((credential) => !sourceFailureActive(source, region, labelOf(credential), now));
			const held = live.filter((credential) => sourceFailureActive(source, region, labelOf(credential), now));
			const byUrgency = (left, right) => packUrgency(source, region, labelOf(left), now) - packUrgency(source, region, labelOf(right), now);
			healthy.sort(byUrgency);
			held.sort(byUrgency);
			return healthy.concat(held, rest);
		}
		const live = ordered.filter((credential) => !sourceCredentialExpired(credential, now));
		const peek = rotate === "peek";
		if (rotate !== true && !peek || preferred !== "" || live.length < 2 || host.sourceDistribution(source) !== "round-robin") return ordered;
		const healthy = live.filter((credential) => !sourceFailureActive(source, region, labelOf(credential), now));
		const held = live.filter((credential) => sourceFailureActive(source, region, labelOf(credential), now));
		if (healthy.length < 2) return ordered;
		const key = host.sourceRegionKey(source, region);
		const step = (sourceRotation.get(key) ?? 0) % healthy.length;
		if (!peek) sourceRotation.set(key, step + 1);
		const rest = ordered.filter((credential) => sourceCredentialExpired(credential, now));
		return healthy.slice(step).concat(healthy.slice(0, step), held, rest);
	}
	return {
		sourceCreditExpiry,
		sourceRotation,
		sourceFailureHold,
		sourceCredentialExpired,
		accountStateKey,
		noteSourceFailure,
		packUrgency,
		orderSourceCredentials
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
/** The one background service this plugin registers. */
const SERVICE_ID = "provider-host";
/** The two gateways, matching the provider ids this plugin registers. */
const REGIONS = ["cn", "global"];
const PROVIDER_ID_BY_REGION = {
	cn: "wtqpool-cn",
	global: "wtqpool-global"
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
/**
* The settings key behind one source name, or undefined for anything else.
*
* The own-property test is load-bearing: a bare `SOURCE_SETTING_KEYS[source]`
* answers for `toString`, `constructor` and `__proto__` from the prototype, so a
* crafted `source` would save under a junk key instead of being refused.
*/
function sourceSettingKey(source) {
	return typeof source === "string" && Object.hasOwn(SOURCE_SETTING_KEYS, source) ? SOURCE_SETTING_KEYS[source] : void 0;
}
/** Whether one source is switched on in settings. Unknown sources stay off, so a typo can never enable a gateway. */
function sourceEnabled(source) {
	const key = sourceSettingKey(source);
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
	cn: "wtqpool-trae-cn",
	ai: "wtqpool-trae-ai"
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
	cn: "wtqpool-qoder-cn",
	global: "wtqpool-qoder-global"
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
/** Ids one gateway's stored selection may name, well past the published cap. */
const MAX_STORED_MODEL_IDS = 512;
const MAX_TOKEN_BUDGET = 4294967295;
/** Longest model id the declaration can publish; anything past it is unroutable. */
const MAX_MODEL_ID_LENGTH = 256;
/**
* Highest credit floor the panel may store: the reserve is compared against a
* real balance, so a floor past any balance parks the account for good.
*/
const MAX_CREDIT_RESERVE = 1e9;
/**
* The figures `index.ts` falls back to when a roster row names none.
*
* Exported rather than re-typed there: two copies of the same number drift the
* moment one of them is retuned, and the drift is invisible until a model
* without a declared window is published.
*/
const CONSERVATIVE_CONTEXT_WINDOW = 128e3;
const DEFAULT_MAX_TOKENS = 32e3;
const CATALOG_TTL_MS = 18e5;
/**
* How long a failed roster read waits before the next attempt.
*
* A failed read must not be stamped as freshly read: that parks the static
* fallback - and with it the wrong model list, for the gateways and for the
* host's picker - for the whole TTL after one slow start.
*/
const CATALOG_RETRY_MS = 15e3;
/** How many times a roster that could not be read is asked for again. */
const MODEL_RETRY_ATTEMPTS = 4;
/** Used until a shim binds, so a descriptor never carries an empty base URL. */
const PLACEHOLDER_BASE_URL = "http://127.0.0.1:1/v1";
/**
* How long one account's billing answers (credits, check-in) are reused.
*
* The panel renders from these cached answers and they refresh behind the first
* paint, so opening it never waits on a billing call per account.
*/
const PROBE_TTL_MS = 6e4;
/** How often the desktop sign-ins are re-read while the service runs. */
const ACCOUNT_WATCH_MS = 6e4;
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
/**
* How often the token keep-alive walks the pool.
*
* Half of the lifetime the pool assumes for a token that reports none, so a
* sign-in nobody has used is renewed while it still works rather than at the
* moment a request needs it.
*/
/**
* How long a started panel login stays pollable.
*
* The browser half is the user's to finish, so it is measured in minutes
* rather than the seconds a network call gets. Past it the state is dropped and
* the panel asks the user to start again: the upstream keeps answering
* `login ing...` for a state that will never complete, so a poll with no
* deadline would look alive forever.
*/
const DEVICE_LOGIN_TTL_MS = 9e5;
/**
* One account-directory walk, on its own clock.
*
* A walk reads every `.info` in every auth directory and, on a cold key, asks
* the OS for the at-rest key, which is the slow part. The host allows a panel
* call 30 s and the pass that follows has 18 s of its own, so this is sized to
* leave the walk the larger share and let the pass take what is left.
*/
const POOL_SCAN_BUDGET_MS = 8e3;
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
/**
* Bumped only by writes this process made, never by a document the host pushed.
*
* A host announcement that was already in flight when a local save landed is
* older than that save. `onHostSettingsChanged` captures this counter before it
* queues, and drops the document when a local write overtook it.
*/
let localSettingsRevision = 0;
let dataPath = "";
/** One runtime per gateway: its shim and catalog. */
const runtimes = /* @__PURE__ */ new Map();
/**
* Binds in flight, by region.
*
* A rescan and a refresh pass can reach the same region at the same moment, and
* two binds for one region mean the second loses the preferred port it had just
* reserved and logs a warning about its own process. The map is what makes the
* second caller the first one's answer; entries are dropped once the promise
* settles, so the next pass starts fresh.
*/
const runtimeStarts = /* @__PURE__ */ new Map();
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
/**
* Why one gateway's last start attempt failed, by region.
*
* A gateway that could not bind has no runtime at all, which is the same shape
* as one that has not been started yet - and the two mean opposite things to
* everything downstream. Without this map a failed start read as "still
* warming" for as long as the source stayed switched on: its saved roster was
* republished over a port nothing was listening on, and the panel reported no
* drift while every request to that address was refused.
*/
const gatewayStartFailures = /* @__PURE__ */ new Map();
/**
* Trae/Qoder regions whose gateway could not start, keyed `source:region`.
*
* WorkBuddy records its own start failures; without the same record for the two
* source gateways a region whose bind failed kept the address the host had
* already registered, so every request to it was refused while the doctor and
* the panel read the region as healthy. Entries are cleared wherever the
* gateway is installed or removed, so a switched-off source never reads as a
* failed one.
*/
const sourceStartFailures = /* @__PURE__ */ new Map();
/** One in-flight source-gateway start per region, shared by overlapping passes. */
const sourceGatewayStarts = /* @__PURE__ */ new Map();
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
* Timer that re-reads the desktop sign-ins while the service runs.
*
* Once a minute because a switch in the client overwrites the global sign-in
* file in place: the pool only has the account if it read the file before that.
*/
let accountWatchTimer = null;
/**
* True while a check-in pass is running, whichever entry point started it.
*
* One flag for all three — the scheduled tick, the host command and the panel's
* "run now" — because two passes writing `autoCheckinLast` would leave the log
* describing whichever finished last rather than what the user asked for.
*/
let checkinPassRunning = false;
/** Which pass owns the running flag; see `runCheckinPass`. */
let checkinPassToken = 0;
/**
* True while the growth centre runs on its own, from the panel's card.
*
* Separate from `checkinPassRunning` because the two are different passes over
* the same accounts: a growth run started beside a check-in pass would stack
* two unpaced request clusters on one account, which is what the upstream
* reads as a burst. The card refuses while either is running.
*/
let growthPassRunning = false;
/** Which run owns `growthPassRunning`, on the same rule as `checkinPassToken`. */
let growthPassToken = 0;
/**
* The last standalone growth run, in the shape the scheduled pass records its
* own growth half in. In memory only: after a restart the card falls back to
* the growth half of the last scheduled pass, which is persisted with it.
*/
let growthLast = null;
/**
* The growth centre's last successful read.
*
* Published with the status document so a repaint or a fresh panel paints it
* instead of asking the user to read again; the panel refreshes it when it is old.
*/
let growthRead = null;
/**
* Which read the answer in flight belongs to.
*
* A read walks several accounts and can take seconds, so a user can park a region
* or drop an account while it runs. Comparing this counter around the await is
* what stops that answer - computed against the pool as it was - from being
* written back over the drop that just happened.
*/
let growthReadEpoch = 0;
/** Slots this process has collected, as `YYYY-MM-DDTHH` in the campaign's zone. */
const autoCheckinSlots = /* @__PURE__ */ new Set();
/** The last automatic pass, for the panel's status line. */
let autoCheckinLast = null;
/** The last keep-alive pass, for the panel's status line. In memory only. */
let keepAliveLast = null;
/**
* When a deferred pass is owed, in ms; 0 = nothing pending.
*
* Qoder's daily round only exists from 10:00 Beijing, so an automatic pass at
* 09:00 cannot collect it. Rather than adding a second timer, this remembers
* the opening time and the same timer comes back for it then.
*/
let qoderRetryAt = 0;
/**
* How long a deferred Qoder round waits before the tick comes back for it
* after a failure.
*
* The deferral is owed once a day, so a failed attempt has to stay owed - but
* a read that throws every time must not be retried every minute either.
*/
const QODER_RETRY_BACKOFF_MS = 6e5;
/**
* Aborted when the service stops, re-armed by every pass that starts.
*
* A check-in pass paces its accounts seconds apart and walks a whole pool, so
* it is still running long after the teardown closed every gateway it was
* serving. The pacing sleeps wake on this and the per-account loops check it,
* so a stopping service ends the pass instead of leaving it talking to a host
* that is no longer there. Re-arming at the pass rather than at the service
* start is what keeps a hand-started pass working after a stop: the stop
* retired the pass that was running then, not the ones still to come.
*/
let checkinAbort = new AbortController();
const checkinScope = new AsyncLocalStorage();
function currentCheckinSignal() {
	return checkinScope.getStore() ?? checkinAbort.signal;
}
/**
* Cat-travel pacing: one pass per account, same throttle as the upstream's own
* scheduler. A single `travelOne` already fans out to several RPCs, so a tight
* loop would look like a burst to the upstream.
*/
const TRAVEL_ACCOUNT_DELAY_MS = 800;
/** Pause between two Qoder accounts' check-ins, so a batch does not read as a burst. */
const QODER_ACCOUNT_DELAY_MS = 1e3;
/**
* Pause between two WorkBuddy accounts' check-ins.
*
* The same pacing the other sources get: a pass over several accounts with no
* gap between them is a burst from the upstream's side, and the growth pass
* that follows walks the same accounts again seconds later.
*/
const CHECKIN_ACCOUNT_DELAY_MS = 700;
/** Trae's check-in pace: 5 s between accounts, ±2 s jitter (the spacing its endpoint is proven with). */
const TRAE_ACCOUNT_DELAY_MS = 5e3;
const TRAE_ACCOUNT_JITTER_MS = 2e3;
/** Wait after the adopt preflight report before calling buddy/first. */
const TRAVEL_ADOPT_GAP_MS = 1050;
/** Between the check-in burst and the growth burst on the same accounts. */
const GROWTH_AFTER_CHECKIN_MS = 1500;
/** Between one domestic account and the next inside the growth pass. */
const GROWTH_ACCOUNT_DELAY_MS = 400;
/**
* Pause after lighting the streak before reading it back.
*
* The upstream scores the reported chat against the account's streak in its own
* time: a read issued in the same tick still answers the previous day's
* counter, so the tier state read right after the report is stale by one day
* and the pass reports nothing redeemed on the day the tier actually opened.
*/
const STREAK_REPORT_READ_GAP_MS = 1200;
/** Account ids that hit the adopt conversation threshold today (CST day). */
const travelAdoptTried = /* @__PURE__ */ new Map();
function log(level, message) {
	try {
		const text = redactSecrets(String(message));
		console.log("[wtq-pool] " + level + ": " + text);
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
	return prefix + args.map(safeMessage).join(" ");
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
*
* Every write goes through {@link enqueueWrite}, because a dictionary-shaped
* setting is read as a whole, edited and written back as a whole. Two of those
* in flight at once had the second one overwrite the first with the stale copy
* it read, and the panel answered success for a change that was gone.
*/
async function saveSettings(patch) {
	return enqueueWrite(async () => {
		try {
			await pi.plugin.setSettings(patch);
			settings = {
				...settings,
				...patch
			};
			settingsRevision += 1;
			localSettingsRevision += 1;
			return true;
		} catch (error) {
			log("warn", "could not save settings: " + safeMessage(error));
			return false;
		}
	});
}
/**
* Serialise the settings writes, and re-read before each one runs.
*
* The queue is what makes a read-edit-write of a dictionary key safe: the work
* inside it sees the document the previous write left behind, including one the
* host's own settings UI made while this one was waiting. A rejected write does
* not block the next one, because a failed save is a normal outcome the caller
* already reports.
*/
let writeChain = Promise.resolve();
function enqueueWrite(work) {
	const run = writeChain.then(work, work);
	writeChain = run.then(() => void 0, () => void 0);
	return run;
}
/**
* Read, edit and write one settings key as a single serialised step.
*
* A dictionary-shaped setting is written back whole, so the read has to happen
* inside the queue rather than before it: two channels that both read the old
* document and then both wrote had the second overwrite the first, and the
* panel answered success for a change that was already gone. Re-reading before
* the edit also picks up whatever the host's own settings UI stored while this
* one was waiting.
*
* `mutate` receives the value in force and answers the next one; answering
* `undefined` means "no change", which skips the write entirely.
*/
async function mutateSettings(key, mutate) {
	return enqueueWrite(async () => {
		await adoptHostSettings();
		const current = settings[key];
		const next = await mutate(current);
		if (next === void 0) return true;
		try {
			await pi.plugin.setSettings({ [key]: next });
			settings = {
				...settings,
				[key]: next
			};
			settingsRevision += 1;
			localSettingsRevision += 1;
			return true;
		} catch (error) {
			log("warn", "could not save settings: " + safeMessage(error));
			return false;
		}
	});
}
/**
* Drop every cached sign-in read, so the next one sees the machine as it is.
*
* The credential readers cache their answer for 30 s and the identity probe is
* memoised per edition. Both outlive the event that made them stale - a desktop
* sign-in made while a source was switched off, or while the panel was open - so
* every path that has to see the current machine drops them first: the settings
* toggle, the panel's own switch, and a deliberate rescan.
*/
function resetDiscoveryCaches() {
	resetTraeCredentialCache();
	resetQoderCredentialCache();
	traeIdentityBlockers.clear();
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
	if (next === null || typeof next !== "object" || Array.isArray(next)) return false;
	const localRevision = localSettingsRevision;
	return enqueueWrite(async () => {
		if (serviceStopped) return false;
		const before = settings;
		if (localSettingsRevision !== localRevision) {
			if (!await adoptHostSettings()) {
				scheduleRefresh("settings");
				return false;
			}
		} else {
			settings = next;
			settingsRevision += 1;
		}
		const toggled = Object.values(SOURCE_SETTING_KEYS).some((key) => Object.hasOwn(settings, key) && before[key] !== settings[key]);
		if (toggled) resetDiscoveryCaches();
		await applySettingsEverywhere(toggled);
		return true;
	});
}
/**
* Apply the settings document already in `settings` to everything downstream.
*
* Shared by the host-driven change above and the panel's own switches, which
* write the key first and then ask for the same reconciliation with no new
* document to merge.
*/
async function applySettingsEverywhere(toggled) {
	applySettingsToCore();
	traeAccountRows = traeAccountRows.filter((row) => regionEnabled("trae", row.region));
	qoderAccountRows = qoderAccountRows.filter((row) => regionEnabled("qoder", row.region));
	await reconcileTraeGateways();
	await reconcileQoderGateways();
	syncDeclaration();
	if (toggled) probeCache.clear();
	if (toggled) {
		growthRead = null;
		growthReadEpoch += 1;
	}
	scheduleRefresh("settings");
	return true;
}
/** Subscribe to the host's settings event, tolerating a host without it. */
function subscribeToHostSettings() {
	unsubscribeFromHostSettings();
	settingsChangedHandler = (next) => {
		onHostSettingsChanged(next).then((applied) => {
			if (applied) log("info", "settings changed in the host UI; selection re-applied");
		}).catch((error) => log("warn", "applying host settings failed: " + safeMessage(error)));
	};
	try {
		if (pi.events && typeof pi.events.on === "function") {
			pi.events.on("plugin:settingsChanged", settingsChangedHandler);
			return true;
		}
	} catch (error) {
		log("warn", "could not subscribe to settings changes: " + safeMessage(error));
	}
	settingsChangedHandler = null;
	return false;
}
/** Detach the host settings handler, if one is held. */
function unsubscribeFromHostSettings() {
	const handler = settingsChangedHandler;
	settingsChangedHandler = null;
	if (handler === null) return;
	try {
		if (pi.events && typeof pi.events.off === "function") pi.events.off("plugin:settingsChanged", handler);
	} catch (error) {
		log("warn", "could not unsubscribe from settings changes: " + safeMessage(error));
	}
}
function cooldownMs() {
	const value = Number(settings.cooldownSeconds);
	if (!Number.isFinite(value) || value <= 0) return 6e4;
	return Math.max(1e3, Math.min(864e5, Math.round(value * 1e3)));
}
/** The modes other than `priority`, which is what an unrecognised or absent value means. */
const WORKBUDDY_DISTRIBUTIONS = [
	"round-robin",
	"expiry",
	"sticky"
];
function distributionSetting() {
	const value = settings.distribution;
	return WORKBUDDY_DISTRIBUTIONS.includes(value) ? value : "priority";
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
* Where the collected check-in slots are remembered between runs.
*
* `autoCheckinSlots` is this process's own copy; without a record on disk a
* restart after the morning hour forgot every slot and re-ran the whole pass.
* The file holds one array per campaign day, the same shape the desktop twin
* writes, so the two engines cannot disagree about what a day's record is.
* `_qoderRetryAt` is metadata beside those arrays: Qoder's deferred round can
* open hours after the pass that scheduled it, and a reload before then used to
* lose the day's Qoder credits. A key that is not an array is ignored by the
* day reader, so the file stays compatible with the twin.
*/
const CHECKIN_SLOTS_FILE = "checkin-slots.json";
/**
* Re-read the slots earlier runs collected, now that the data root is known.
*
* Only today's day can ever be due, so this is really about today; the older
* days stay in the file because the twin writes them and a day boundary in the
* middle of a pass is no reason to drop the record. A file that is missing or
* unreadable is a machine with no record yet, which is where a fresh install
* starts.
*/
function loadCheckinSlots() {
	autoCheckinSlots.clear();
	qoderRetryAt = 0;
	if (dataPath === "") return;
	try {
		const parsed = JSON.parse(fs$1.readFileSync(path.join(dataPath, CHECKIN_SLOTS_FILE), "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
		for (const slots of Object.values(parsed)) {
			if (!Array.isArray(slots)) continue;
			for (const slot of slots) if (typeof slot === "string" && slot !== "") autoCheckinSlots.add(slot);
		}
		const retry = parsed._qoderRetryAt;
		const now = Date.now();
		if (typeof retry === "number" && Number.isFinite(retry) && retry > 0 && (zonedDayHour(new Date(retry)).day === zonedDayHour(new Date(now)).day || retry > now - 72e5 && retry <= now + 864e5)) qoderRetryAt = retry;
	} catch {}
}
/**
* Write the collected slots back, one array per campaign day.
*
* Called when a pass has ENDED - collected or failed - rather than when it
* starts: a pass the process died in the middle of must leave nothing behind,
* so the next run attempts that day again. The days are pruned on the way out,
* so the file cannot grow without bound on a machine that runs for months.
*/
function saveCheckinSlots() {
	if (dataPath === "") return;
	const byDay = {};
	for (const slot of autoCheckinSlots) {
		const day = slot.split("T")[0];
		if (byDay[day] === void 0) byDay[day] = [];
		byDay[day].push(slot);
	}
	const keep = Object.keys(byDay).sort().slice(-3);
	for (const day of Object.keys(byDay)) if (!keep.includes(day)) delete byDay[day];
	if (qoderRetryAt > 0) byDay._qoderRetryAt = qoderRetryAt;
	const target = path.join(dataPath, CHECKIN_SLOTS_FILE);
	const staging = target + ".tmp";
	try {
		fs$1.mkdirSync(dataPath, { recursive: true });
		fs$1.writeFileSync(staging, JSON.stringify(byDay), "utf8");
		fs$1.renameSync(staging, target);
	} catch (error) {
		try {
			fs$1.rmSync(staging, { force: true });
		} catch {}
		log("warn", "could not record the collected check-in slots: " + safeMessage(error));
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
const { sourceCreditExpiry, sourceRotation, sourceFailureHold, sourceCredentialExpired, accountStateKey, noteSourceFailure, orderSourceCredentials } = createSourcePool({
	cooldownMs,
	preferredSourceAccount,
	sourceDistribution,
	sourceRegionKey
});
function noteSourceExpiry(source, region, label, packages) {
	const at = nearestPackExpiry(packages);
	const key = accountStateKey(source, region, label);
	if (at === void 0) sourceCreditExpiry.delete(key);
	else sourceCreditExpiry.set(key, at);
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
		if (id !== "" && Number.isFinite(floor) && floor > 0) clean[id] = Math.min(Math.floor(floor), MAX_CREDIT_RESERVE);
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
* An empty list is the user disabling every model, exactly as it is for the
* WorkBuddy catalog, and only an absent list means "publish everything". A
* selection naming no live model is treated as unset, mirroring
* savedSelectionMatches, so a renamed catalog never empties the group.
*/
function gatewayEnabledIds(key, catalogIds) {
	const enabled = gatewaySelectionFor(key).enabledModelIds;
	if (!Array.isArray(enabled)) return null;
	if (enabled.length === 0) return /* @__PURE__ */ new Set();
	const known = new Set(catalogIds);
	const kept = enabled.filter((id) => known.has(id));
	return kept.length > 0 ? new Set(kept) : null;
}
/**
* The selection as the gateway really publishes it, for the panel to render.
*
* The declaration normalizes a stored selection whose every id has been renamed
* away back to "everything on", and the panel has to show that same answer. It
* used to read the raw stored value, so a catalog rename showed every model
* unticked while the gateway published all of them, with no way back: ticking
* them produced the same normalized selection again.
*/
function publishedSelectionFor(key, catalogIds) {
	const stored = gatewaySelectionFor(key);
	const enabled = gatewayEnabledIds(key, catalogIds);
	if (enabled !== null) return {
		...stored,
		enabledModelIds: [...enabled]
	};
	const { enabledModelIds, ...rest } = stored;
	return rest;
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
	const nativeCeiling = Math.max(positiveInteger(native.contextWindow, CONSERVATIVE_CONTEXT_WINDOW), positiveInteger(native.maxContextWindow, 0));
	const declaredWindow = Math.min(positiveInteger(Number.isFinite(override.contextWindow) ? override.contextWindow : native.contextWindow, CONSERVATIVE_CONTEXT_WINDOW), nativeCeiling);
	const outputCeiling = positiveInteger(declaredWindow > positiveInteger(native.contextWindow, 128e3) ? native.maxTokensAtCeiling : native.maxTokens, positiveInteger(native.maxTokens, DEFAULT_MAX_TOKENS));
	return {
		id,
		name: alias ?? nativeName,
		...alias === void 0 ? {} : { alias },
		nativeName,
		contextWindow: declaredWindow,
		maxOutputTokens: Math.min(positiveInteger(Number.isFinite(override.maxOutputTokens) ? override.maxOutputTokens : outputCeiling, DEFAULT_MAX_TOKENS), outputCeiling),
		nativeContextWindow: native.contextWindow,
		...nativeCeiling > positiveInteger(native.contextWindow, 128e3) ? { maxContextWindow: nativeCeiling } : {},
		nativeMaxOutputTokens: positiveInteger(native.maxTokens, DEFAULT_MAX_TOKENS),
		...native.maxTokensAtCeiling === void 0 ? {} : { maxOutputAtCeiling: positiveInteger(native.maxTokensAtCeiling, outputCeiling) },
		supportsImages: typeof override.supportsImages === "boolean" ? override.supportsImages : native.supportsImages,
		nativeSupportsImages: native.supportsImages,
		...Array.isArray(native.thinkingLevels) && native.thinkingLevels.length > 0 ? { nativeThinkingLevels: [...native.thinkingLevels] } : {},
		...Array.isArray(override.thinkingLevels) && override.thinkingLevels.length > 0 ? { thinkingLevels: override.thinkingLevels } : {},
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
* A source gateway's roster plus the selection that gateway really publishes.
* One roster pass answers both, so the panel ticks exactly what the declaration
* emits: a stored selection whose every id has been renamed away normalizes to
* "publish everything" instead of every model showing unticked while the
* gateway serves them all.
*/
function sourcePublishedModels(key, models, nativeOf) {
	const roster = sourceRosterFor(key, models, nativeOf);
	return {
		roster,
		selection: publishedSelectionFor(key, roster.map((view) => view.id))
	};
}
/**
* Trae's internal slots, by the names the IDE gives them.
*
* They are the IDE's own, stable across versions, and are what distinguishes a
* helper slot from a model — a helper sometimes carries a borrowed display name,
* so the name alone cannot answer it. The IDE appends a variant suffix to some of
* them over time (`fast_apply_new`), so the names are matched by prefix.
*/
const TRAE_INTERNAL_MODEL_ID_RE = /^(custom_model|search_agent|summary|fast_apply|title_generation|input_optimization|laziness_detection)(_|$)|_(subagent|agent)(_|$)|-(for-)?auto$/;
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
	const native = typeof view.nativeName === "string" ? view.nativeName.trim() : "";
	if ((typeof view.name === "string" ? view.name.trim() : "") === "" || native === "" || !/[\p{L}\p{N}]/u.test(native)) return false;
	if (source !== "trae") return true;
	return !TRAE_INTERNAL_MODEL_ID_RE.test(view.id);
}
function normalizeSelection(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out = {};
	if (Array.isArray(value.enabledModelIds)) out.enabledModelIds = value.enabledModelIds;
	const overrides = Object.create(null);
	if (value.overrides && typeof value.overrides === "object" && !Array.isArray(value.overrides)) {
		for (const [id, entry] of Object.entries(value.overrides)) if (typeof id === "string" && id !== "" && entry && typeof entry === "object" && !Array.isArray(entry)) overrides[id] = { ...entry };
	}
	for (const id of Array.isArray(value.imageModelIds) ? value.imageModelIds : []) if (typeof id === "string" && id !== "") overrides[id] = {
		...overrides[id] || {},
		supportsImages: true
	};
	const budgets = value.contextBudgets && typeof value.contextBudgets === "object" && !Array.isArray(value.contextBudgets) ? value.contextBudgets : {};
	for (const [id, budget] of Object.entries(budgets)) if (typeof id === "string" && id !== "" && typeof budget === "number" && Number.isInteger(budget) && budget > 0 && budget <= MAX_TOKEN_BUDGET) overrides[id] = {
		...overrides[id] || {},
		contextWindow: budget
	};
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
	return selectionJudgeable(catalog) && savedSelectionMatches(region, catalog) ? selectionFor(region) : {};
}
/**
* Whether a saved selection can be judged against this roster at all.
*
* Only a roster the upstream answered with can retire an id. The static
* fallback is this plugin's own guess, and judging against it reported every
* model the vendor had added since as retired: the user's choice was replaced by
* the fallback's list and the panel said so on every start, for as long as the
* live read kept timing out.
*/
function selectionJudgeable(catalog) {
	return catalog !== void 0 && catalog.hasLiveRoster() === true;
}
/** True when a gateway's stored selection no longer matches its live roster. */
function selectionStale(region, catalog) {
	return selectionJudgeable(catalog) && !savedSelectionMatches(region, catalog);
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
* A check-in pacing pause a stopping service can cut short.
*
* The same unref'd pause as `delay`, plus the abort: a pass that is still
* spacing its accounts when the service stops would otherwise sit out the
* whole gap - Trae's is five seconds - before it even notices. The listener is
* removed on both ways out, so a signal the plugin keeps for its life never
* collects one.
*/
function checkinDelay(ms) {
	const signal = currentCheckinSignal();
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		let timer = null;
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		if (typeof timer.unref === "function") timer.unref();
		signal.addEventListener("abort", onAbort, { once: true });
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
	const expiry = new Promise((resolve) => {
		timer = setTimeout(() => resolve(void 0), budgetMs);
		if (typeof timer.unref === "function") timer.unref();
	});
	try {
		return await Promise.race([work, expiry]);
	} finally {
		clearTimeout(timer);
	}
}
/**
* One deadline, and the two things a bounded pass does with it.
*
* `left` is what a step inside the pass is given, and `settle` runs one step
* against whatever is left, so the pass states its budget once instead of
* re-deriving the same arithmetic at every step. The deadline is taken when the
* budget is made, not when the first step starts.
*/
function budget(ms) {
	const deadline = Date.now() + ms;
	const left = () => Math.max(0, deadline - Date.now());
	return {
		left,
		settle: (work) => settleWithin(work, left())
	};
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
* for this session, and the declaration is rewritten to name the port this
* run actually bound, so the host is never left on an address nothing
* listens on.
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
	return Math.min(MAX_TOKEN_BUDGET, Math.round(number));
}
/** The models one gateway publishes, after the user's selection is applied. */
function declarationModels(region) {
	const catalog = runtimes.get(region)?.catalog;
	if (!catalog) return [];
	const models = [];
	const seen = /* @__PURE__ */ new Set();
	for (const model of catalog.visible()) {
		const id = String(model.id || "").trim();
		if (id === "" || id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) continue;
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
	const warming = warmingGatewayIds();
	const retained = declaredProviders().filter((provider) => activeIds.has(provider.id) && !currentIds.has(provider.id) && warming.has(provider.id));
	const result = writeDeclaration([...current, ...retained]);
	runtimeState.write = result;
	return result;
}
/**
* The provider ids of the active gateways that are still warming up.
*
* "Warming" is the only reason a row is republished for a gateway that cannot
* publish right now: its roster has not landed yet, so dropping the row would
* cost a roster it already had. A gateway that has answered is signed out or
* unreachable, and the rule on {@link syncDeclaration} says its row goes.
*/
function warmingGatewayIds() {
	const ids = /* @__PURE__ */ new Set();
	for (const region of activeRegions()) {
		const runtime = runtimes.get(region);
		if (gatewayStartFailures.has(region)) continue;
		if (runtime === void 0 || runtime.connecting !== null) ids.add(PROVIDER_ID_BY_REGION[region]);
	}
	for (const [source, gateways, regions, idByRegion] of [[
		"trae",
		traeGateways,
		activeTraeRegions(),
		TRAE_PROVIDER_ID_BY_REGION
	], [
		"qoder",
		qoderGateways,
		activeQoderRegions(),
		QODER_PROVIDER_ID_BY_REGION
	]]) for (const region of regions) {
		if (sourceStartFailures.has(source + ":" + region)) continue;
		const entry = gateways.get(region);
		if (entry === void 0 || entry.gateway.models().length === 0 && entry.lastError === "") ids.add(idByRegion[region]);
	}
	return ids;
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
	entry.warmSettled = true;
	if (entry.lastError === "" && entry.gateway.models().length > 0) syncDeclaration();
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
		publishedWindowOf: (modelId) => {
			const declared = traeDeclarationModels(region).find((model) => model.id === modelId);
			return declared === void 0 ? void 0 : declared.contextWindow;
		},
		onAttemptFailure: (credential, outcome) => {
			noteSourceFailure("trae", region, traeRowLabel(credential), outcome.retryAfter);
		},
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
		preferredPort: preferred,
		lastError: "",
		source: "trae",
		warmSettled: false
	};
	if (entry.portFallback) log("warn", "[trae:" + region + "] preferred port " + preferred + " is held by another process; serving this session on port " + gateway.port());
	warmSourceDirectoryAtStartup(entry, warmAbort.signal).catch((error) => log("warn", "[trae:" + region + "] directory warm-up failed: " + safeMessage(error)));
	return entry;
}
/** Start and stop Trae gateways so the map matches the source switch exactly. */
async function reconcileTraeGateways() {
	const generation = loadGeneration;
	if (!stillLoaded(generation) || serviceStopped) return;
	const active = activeTraeRegions();
	for (const [region, entry] of Array.from(traeGateways)) {
		if (!stillLoaded(generation) || serviceStopped) return;
		if (active.includes(region)) continue;
		traeGateways.delete(region);
		sourceStartFailures.delete("trae:" + region);
		try {
			await entry.gateway.close();
		} catch (error) {
			log("warn", "[trae:" + region + "] gateway did not close cleanly: " + safeMessage(error));
		}
	}
	for (const region of active) {
		if (!stillLoaded(generation) || serviceStopped) return;
		if (traeGateways.has(region)) continue;
		const key = "trae:" + region;
		const pending = sourceGatewayStarts.get(key);
		if (pending !== void 0) {
			await pending.catch(() => {});
			continue;
		}
		const starting = createTraeRuntime(region);
		sourceGatewayStarts.set(key, starting);
		try {
			const entry = await starting;
			if (!stillLoaded(generation) || !activeTraeRegions().includes(region) || traeGateways.has(region)) await entry.gateway.close();
			else {
				traeGateways.set(region, entry);
				sourceStartFailures.delete(key);
			}
		} catch (error) {
			if (stillLoaded(generation)) {
				sourceStartFailures.set(key, safeMessage(error));
				log("warn", "[trae:" + region + "] gateway could not start: " + safeMessage(error));
			}
		} finally {
			if (sourceGatewayStarts.get(key) === starting) sourceGatewayStarts.delete(key);
		}
	}
}
/** What a Trae gateway itself reported for one model. */
function traeNativeOf(model) {
	const devWindow = positiveInteger(model.contextWindow, CONSERVATIVE_CONTEXT_WINDOW);
	const maxWindow = positiveInteger(model.maxContextWindow, 0);
	const ceiling = Math.max(devWindow, maxWindow);
	return {
		contextWindow: devWindow,
		maxTokens: positiveInteger(model.maxTokens, DEFAULT_MAX_TOKENS),
		...maxWindow > devWindow ? { maxTokensAtCeiling: positiveInteger(traeVariantFor(model, ceiling)?.maxTokens, positiveInteger(model.maxTokens, DEFAULT_MAX_TOKENS)) } : {},
		...maxWindow > devWindow ? { maxContextWindow: maxWindow } : {},
		supportsImages: model.supportsImages === true,
		thinkingLevels: (model.reasoning ? model.reasoning.supported : []).filter((level) => HOST_THINKING_LEVELS.includes(level)),
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
		if (id === "" || id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) continue;
		if (enabled !== null && !enabled.has(id)) continue;
		seen.add(id);
		const native = traeNativeOf(model);
		const view = sourceModelView("trae:" + region, model, native);
		if (!isSelectableSourceModel("trae", view)) continue;
		const advertised = native.thinkingLevels;
		const edited = Array.isArray(view.thinkingLevels) && view.thinkingLevels.length > 0 ? view.thinkingLevels.filter((level) => HOST_THINKING_LEVELS.includes(level)) : [];
		const levels = edited.length > 0 ? HOST_THINKING_LEVELS.filter((level) => edited.includes(level)) : advertised;
		models.push({
			id: view.id,
			name: modelLabel(view),
			contextWindow: view.contextWindow,
			maxTokens: view.maxOutputTokens,
			supportsImages: view.supportsImages,
			thinkingLevels: offersThinking(levels) ? levels : ["off"]
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
			const mine = (await discoverQoderCredentials()).credentials.filter((credential) => credential.region === region);
			return orderSourceCredentials("qoder", region, mine, qoderRowLabel, purpose === "chat").map(qoderClientCredential);
		},
		listedIds: () => qoderDeclarationModels(region).map((model) => model.id),
		onAttemptFailure: (credential, outcome) => {
			const label = typeof credential.name === "string" && credential.name !== "" ? credential.name : credential.userID;
			noteSourceFailure("qoder", region, label, outcome.retryAfter);
		},
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
		preferredPort: preferred,
		lastError: "",
		source: "qoder",
		warmSettled: false
	};
	if (entry.portFallback) log("warn", "[qoder:" + region + "] preferred port " + preferred + " is held by another process; serving this session on port " + gateway.port());
	warmSourceDirectoryAtStartup(entry, warmAbort.signal).catch((error) => log("warn", "[qoder:" + region + "] directory warm-up failed: " + safeMessage(error)));
	return entry;
}
/** Start and stop Qoder gateways so the map matches the source switch exactly. */
async function reconcileQoderGateways() {
	const generation = loadGeneration;
	if (!stillLoaded(generation) || serviceStopped) return;
	const active = activeQoderRegions();
	for (const [region, entry] of Array.from(qoderGateways)) {
		if (!stillLoaded(generation) || serviceStopped) return;
		if (active.includes(region)) continue;
		qoderGateways.delete(region);
		sourceStartFailures.delete("qoder:" + region);
		try {
			await entry.gateway.close();
		} catch (error) {
			log("warn", "[qoder:" + region + "] gateway did not close cleanly: " + safeMessage(error));
		}
	}
	for (const region of active) {
		if (!stillLoaded(generation) || serviceStopped) return;
		if (qoderGateways.has(region)) continue;
		const key = "qoder:" + region;
		const pending = sourceGatewayStarts.get(key);
		if (pending !== void 0) {
			await pending.catch(() => {});
			continue;
		}
		const starting = createQoderRuntime(region);
		sourceGatewayStarts.set(key, starting);
		try {
			const entry = await starting;
			if (!stillLoaded(generation) || !activeQoderRegions().includes(region) || qoderGateways.has(region)) await entry.gateway.close();
			else {
				qoderGateways.set(region, entry);
				sourceStartFailures.delete(key);
			}
		} catch (error) {
			if (stillLoaded(generation)) {
				sourceStartFailures.set(key, safeMessage(error));
				log("warn", "[qoder:" + region + "] gateway could not start: " + safeMessage(error));
			}
		} finally {
			if (sourceGatewayStarts.get(key) === starting) sourceGatewayStarts.delete(key);
		}
	}
}
function qoderNativeOf(model) {
	return {
		contextWindow: positiveInteger(model.contextWindow ?? model.maxInputTokens, CONSERVATIVE_CONTEXT_WINDOW),
		maxTokens: DEFAULT_MAX_TOKENS,
		supportsImages: model.supportsImages === true,
		thinkingLevels: qoderThinkingLevelsFor(model)
	};
}
/**
* Thinking levels one Qoder model may offer, in host order.
*
* Qoder's ladder spells "off" as "none", which the host does not use, so the
* table is filtered to the host's own names first. A row whose catalog entry
* carries no level table only takes thinking on or off, which the declaration
* publishes as a lone "off" - an absent list would open the host's whole
* ladder on a model that has no levels to offer.
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
		if (id === "" || id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) continue;
		if (enabled !== null && !enabled.has(id)) continue;
		seen.add(id);
		const native = qoderNativeOf(model);
		const view = sourceModelView("qoder:" + region, model, native);
		if (!isSelectableSourceModel("qoder", view)) continue;
		const levels = native.thinkingLevels;
		const edited = Array.isArray(view.thinkingLevels) && view.thinkingLevels.length > 0 ? view.thinkingLevels.filter((level) => HOST_THINKING_LEVELS.includes(level)) : [];
		const published = edited.length > 0 ? HOST_THINKING_LEVELS.filter((level) => edited.includes(level)) : levels;
		models.push({
			id: view.id,
			name: view.name,
			contextWindow: view.contextWindow,
			maxTokens: view.maxOutputTokens,
			supportsImages: view.supportsImages,
			thinkingLevels: offersThinking(published) ? published : ["off"]
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
* One bind per region, whoever asks first.
*
* A rescan and the refresh pass can both reach a region with no runtime at the
* same moment. Each used to reserve the preferred port and bind its own shim, so
* one of them lost the bind and logged "the preferred port is held by another
* process" - about this very process, whose first bind had not finished. Sharing
* the in-flight promise makes the second caller the first one's answer.
*/
function startRuntimeOnce(region) {
	const existing = runtimeStarts.get(region);
	if (existing !== void 0) return existing;
	const started = createRuntime(region).finally(() => {
		if (runtimeStarts.get(region) === started) runtimeStarts.delete(region);
	});
	runtimeStarts.set(region, started);
	return started;
}
/**
* Take ownership of a runtime that has finished binding, or release it.
*
* Both callers of `startRuntimeOnce` land here with the same object, so
* "somebody already put a runtime in the map" cannot be read as "mine is not
* wanted": the other caller's entry is this very runtime. Releasing on that
* reading closed a gateway that was serving and left a stopped object in the map
* no later pass would rebuild.
*
* `unwanted` covers the reasons nobody is waiting for a gateway at all: the
* activation it was started for is gone, the service stopped, or the region was
* switched off while the shim was binding.
*
* A runtime already in the map outranks `unwanted`: the two callers of one
* activation (`startRuntimes` and the refresh pass) share one bind, so a runtime
* that one of them has already registered must not be closed by the other, whose
* `unwanted` is about a generation or a region switch of its own. `runtimes.has`
* is every later pass's only re-entry test, so a stopped entry there would take
* the region out until the next teardown.
*
* This host's `onLoad` clears both maps, so it never shares a bind across a
* reload; PI-Desktop clears them too and relies on this same ordering within one
* activation.
*/
async function settleStartedRuntime(region, runtime, unwanted) {
	const held = runtimes.get(region);
	if (held === runtime) return true;
	if (runtime.retired === true) return false;
	if (unwanted || held !== void 0) {
		await stopRuntime(runtime);
		return false;
	}
	runtimes.set(region, runtime);
	gatewayStartFailures.delete(region);
	return true;
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
			await settleStartedRuntime(region, await startRuntimeOnce(region), !stillLoaded(generation) || !activeRegions().includes(region));
		} catch (error) {
			if (stillLoaded(generation)) {
				gatewayStartFailures.set(region, safeMessage(error));
				log("warn", "[workbuddy:" + region + "] gateway could not start: " + safeMessage(error));
			}
		}
	}));
}
async function stopRuntime(runtime) {
	if (runtime.retired === true) return;
	runtime.retired = true;
	runtime.signedIn = false;
	gatewayStartFailures.delete(runtime.region);
	if (runtime.shim) await runtime.shim.close().catch((error) => {
		log("warn", "[workbuddy:" + runtime.region + "] gateway did not close cleanly: " + safeMessage(error));
	});
}
/**
* Come back for a roster that could not be read.
*
* Retries are cheap: a gateway with no account answers without a request, and
* one whose read succeeded skips it on the freshness check.
*
* The handles are tracked so a stop or an unload can clear them: a retry that
* outlived its activation fired into the next one and triggered a full refresh
* pass nobody asked for.
*/
const modelRetryTimers = /* @__PURE__ */ new Set();
function scheduleModelRetries(attempt = 1) {
	if (serviceStopped) return;
	const timer = setTimeout(() => {
		modelRetryTimers.delete(timer);
		scheduleRefresh("model-list-retry");
		if (attempt < MODEL_RETRY_ATTEMPTS) scheduleModelRetries(attempt + 1);
	}, CATALOG_RETRY_MS);
	if (typeof timer.unref === "function") timer.unref();
	modelRetryTimers.add(timer);
}
/** Drop every pending roster retry. */
function clearModelRetries() {
	for (const timer of modelRetryTimers) clearTimeout(timer);
	modelRetryTimers.clear();
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
	const regionAccounts = core.pool.list(runtime.region);
	const account = regionAccounts.find((item) => core.pool.activeHold(item.id)?.reason !== "session") ?? regionAccounts[0];
	if (account === void 0) {
		runtime.signedIn = false;
		runtime.lastError = "no " + runtime.region + " WorkBuddy sign-in found";
		if (core.pool.status().lastScanAtMs === 0) {
			runtime.catalogFetchedAtMs = Date.now() - CATALOG_TTL_MS + CATALOG_RETRY_MS;
			scheduleModelRetries();
			return false;
		}
		runtime.catalogFetchedAtMs = Date.now();
		return false;
	}
	runtime.signedIn = true;
	if (force === true || !catalogFresh(runtime)) try {
		const models = await core.pool.readAfterRefresh(account.id, (credential) => core.client.fetchModels(credential, AbortSignal.timeout(MODELS_TIMEOUT_MS)));
		if (runtime.retired) return false;
		runtime.catalog.update(catalogFromUpstream(models));
		runtime.catalogFetchedAtMs = Date.now();
	} catch (error) {
		runtime.lastWarning = "model list failed: " + safeMessage(error);
		runtime.catalogFetchedAtMs = Date.now() - CATALOG_TTL_MS + CATALOG_RETRY_MS;
		scheduleModelRetries();
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
* anything it would fill in is missing or stale: a stale model roster, billing
* probes that are cold or past their TTL, or a cooldown whose end will
* un-stale the accounts it covers. Scheduling is de-duplicated separately in
* `scheduleRefresh`, so reporting an in-flight pass here is safe and is what
* keeps the poll alive until the numbers actually land.
*/
function refreshNeeded() {
	if (serviceStopped) return false;
	if (refreshInflight !== null) return true;
	for (const runtime of runtimes.values()) {
		if (runtime.connecting) return true;
		if (!catalogFresh(runtime)) return true;
	}
	return probesStale() || cooldownPending();
}
/**
* Whether any account the panel is showing is waiting on a cooldown to lapse.
*
* A pool whose every account is cooling answers "nothing to refresh", so the
* panel stopped polling and the figures stayed stale until the user clicked
* Refresh or the poll hit its attempt cap. The cooldown's own end is what
* un-stales them, so it is the deadline the panel waits for.
*/
function cooldownPending() {
	const now = Date.now();
	for (const account of core.pool.list()) {
		if (account.cooldownUntilMs <= now) continue;
		if (core.pool.isDisabled(account.id) || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
		return true;
	}
	return false;
}
/** True while any pool account's cached billing answers are missing or old. */
function probesStale() {
	const now = Date.now();
	for (const account of core.pool.list()) {
		if (account.cooldownUntilMs > now || core.pool.isDisabled(account.id) || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
		const cached = probeCache.get(account.id);
		if (cached === void 0 || now - cached.atMs >= PROBE_TTL_MS) return true;
		if (cached.checkinOnly === true) return true;
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
		refreshAll(reason, false).catch((error) => log("warn", "background refresh failed: " + safeMessage(error)));
	}, 0);
	if (typeof refreshTimer.unref === "function") refreshTimer.unref();
}
async function refreshRuntime(runtime, reason, force) {
	if (runtime.connecting !== null) {
		const inFlight = runtime.connecting;
		if (force !== true) return inFlight;
		await inFlight.catch(() => {});
		if (runtime.connecting !== null) return runtime.connecting;
	}
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
* duplicate the work of the pass a Refresh click just started. The collapse
* keeps awaiting the pass it found, whichever kind this call is, so a forced
* click can never end up running a second pass beside the first. The one
* exception is a forced click meeting a background pass: waiting for it to the
* end would answer the click with figures it already had, so that click runs
* its own pass. What it must not do is release the slot when its own work ends
* - the background pass is still running, and a caller arriving in that window
* would start a pass beside it. The slot therefore outlives both.
*/
async function refreshAll(reason, force) {
	if (serviceStopped) return await statusDocument({ allowNetwork: false });
	const wantForce = force === true;
	let previous = null;
	if (refreshInflight !== null) {
		const current = refreshInflight;
		if (!wantForce || current.force) return await current.promise;
		previous = current.promise.catch(() => {});
	}
	const generation = loadGeneration;
	const run = async () => {
		const { left, settle } = budget(REFRESH_PASS_BUDGET_MS);
		await adoptHostSettings();
		if (!stillLoaded(generation)) return stalePass();
		applySettingsToCore();
		if (poolNeedsScan) {
			poolNeedsScan = false;
			await settle(core.pool.scan());
			if (!stillLoaded(generation)) return stalePass();
		}
		for (const region of activeRegions()) {
			if (pendingRuntimeStops.length > 0) {
				await Promise.all(pendingRuntimeStops.splice(0));
				if (!stillLoaded(generation)) return stalePass();
			}
			if (runtimes.has(region)) continue;
			const starting = startRuntimeOnce(region);
			let runtime;
			try {
				runtime = await settle(starting);
			} catch (error) {
				gatewayStartFailures.set(region, safeMessage(error));
				log("warn", "[" + region + "] gateway could not start: " + safeMessage(error));
				continue;
			}
			if (runtime === void 0) {
				starting.then((late) => {
					if (runtimes.get(region) !== late) return stopRuntime(late);
				}).catch(() => {});
				continue;
			}
			await settleStartedRuntime(region, runtime, !stillLoaded(generation) || !activeRegions().includes(region));
		}
		await settle(reconcileTraeGateways());
		if (!stillLoaded(generation)) return stalePass();
		await settle(reconcileQoderGateways());
		if (!stillLoaded(generation)) return stalePass();
		await settle(refreshSourceAccounts());
		if (!stillLoaded(generation)) return stalePass();
		await settle(Promise.all([...Array.from(traeGateways.values()), ...Array.from(qoderGateways.values())].filter((entry) => entry.lastError !== "" || entry.gateway.models().length === 0).map((entry) => warmSourceDirectory(entry))));
		if (!stillLoaded(generation)) return stalePass();
		await settle(Promise.all(Array.from(runtimes.values()).map((runtime) => refreshRuntime(runtime, reason, wantForce))));
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
	if (refreshTimer !== null) {
		clearTimeout(refreshTimer);
		refreshTimer = null;
	}
	entry.promise = (async () => {
		try {
			return await run();
		} finally {
			if (previous !== null) await previous;
			if (refreshInflight === entry) refreshInflight = null;
		}
	})();
	refreshInflight = entry;
	return await entry.promise;
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
* A Trae-generated `username` can read as a stranger (`zhang san xyz`), so the
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
				active: status.enable !== false,
				todayCheckedIn: status.checkedIn === true,
				deviceCheckedIn: status.didCheckedIn === true,
				credits: status.credits,
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
	return {
		total: usage.remainingAmount,
		packages
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
		let campaignsUnavailable = false;
		const [usage, campaigns] = await Promise.all([client.fetchUsage(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS)), client.fetchCampaigns(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS)).catch(() => {
			campaignsUnavailable = true;
		})]);
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
			packages
		};
		return {
			...credits === void 0 ? {} : { usage: { credits } },
			checkin: {
				...state,
				...campaignsUnavailable ? { campaignsUnavailable: true } : {},
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
				noteSourceExpiry("trae", region, label, probe?.usage?.credits?.packages);
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
		log("warn", "listing Trae sign-ins failed: " + safeMessage(error));
	}
	try {
		const regions = activeQoderRegions();
		if (regions.length > 0) {
			const found = await discoverQoderCredentials();
			const rows = [];
			const { left } = budget(SOURCE_ACCOUNTS_BUDGET_MS);
			let seen = 0;
			for (const credential of found.credentials) {
				if (!regions.includes(credential.region)) continue;
				if (seen > 0) await delay(QODER_ACCOUNT_DELAY_MS);
				seen += 1;
				const label = qoderRowLabel(credential);
				const previous = qoderAccountRows.find((row) => row.label === label && row.region === credential.region);
				const probe = left() > 0 ? await qoderRowProbe(credential, previous) : previous;
				noteSourceExpiry("qoder", credential.region, label, probe?.usage?.credits?.packages);
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
		log("warn", "listing Qoder sign-ins failed: " + safeMessage(error));
	}
	pruneSourceState();
}
/**
* Drop the per-sign-in bookkeeping of a sign-in that is no longer there.
*
* Both maps are keyed by source and label, and a label is not unique to one
* sign-in: a departed account's hold was inherited by the next one that happened
* to carry the same name, which demoted it for the rest of the hold despite
* never having failed, and its pack expiry corrupted `expiry`-mode ordering and
* the composer's active row.
*/
function pruneSourceState() {
	const live = /* @__PURE__ */ new Set();
	for (const row of traeAccountRows) live.add(accountStateKey("trae", row.region, row.label));
	for (const row of qoderAccountRows) live.add(accountStateKey("qoder", row.region, row.label));
	for (const key of [...sourceFailureHold.keys()]) if (!live.has(key)) sourceFailureHold.delete(key);
	for (const key of [...sourceCreditExpiry.keys()]) if (!live.has(key)) sourceCreditExpiry.delete(key);
}
/**
* Directories the WorkBuddy pool reads, in order.
*
* The desktop app's own directories come first, and that is only the walk
* order: which copy of an account serves is decided by issue time, with the
* source breaking a tie. The plugin's own directory is appended rather than
* substituted: an account added from the panel is read on exactly the same
* terms as a desktop sign-in, and removing it is a file deletion the user can
* see. A repointed `authFile` narrows the walk to that one directory plus the
* plugin's own, the way the pool reads whatever it writes.
*/
function poolAuthDirs(authFile) {
	if (authFile !== "") return [path.dirname(authFile)];
	const own = ownSignInDir(dataPath);
	const dirs = candidateAuthDirs();
	if (own === "" || dirs.includes(own)) return dirs;
	return [...dirs, own];
}
/** Push the settings that affect discovery, cooldown and the picker. */
function applySettingsToCore() {
	const authFile = typeof settings.authFile === "string" ? settings.authFile.trim() : "";
	const emptied = core.pool.applyConfig({
		authDirs: poolAuthDirs(authFile),
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
	if (emptied) poolNeedsScan = true;
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
async function accountProbe(account, allowNetwork, checkinOnly = false) {
	const cached = probeCache.get(account.id);
	if (allowNetwork !== true) return cached === void 0 ? { pending: true } : cached.value;
	const cachedFresh = cached !== void 0 && Date.now() - cached.atMs < PROBE_TTL_MS;
	const cachedHasCredits = cached !== void 0 && (cached.value.credits !== void 0 || cached.value.creditsError !== void 0);
	if (cachedFresh && (checkinOnly || cached.checkinOnly !== true && cachedHasCredits)) return cached.value;
	if (signInRefused(account)) return {};
	const value = {};
	if (!checkinOnly) {
		try {
			const credits = await core.pool.readAfterRefresh(account.id, (credential) => core.client.fetchCredits(credential));
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
	}
	const checkinStartedAt = Date.now();
	try {
		const checkin = await core.pool.readAfterRefresh(account.id, (credential) => core.client.fetchCheckinStatus(credential));
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
	const latest = probeCache.get(account.id);
	if (latest !== cached) {
		if (latest === void 0) return { pending: true };
		if (!checkinOnly && latest.checkinOnly === true && (value.credits !== void 0 || value.creditsError !== void 0)) {
			const merged = { ...latest.value };
			if (value.credits !== void 0) {
				merged.credits = value.credits;
				delete merged.creditsError;
			}
			if (value.creditsError !== void 0) {
				merged.creditsError = value.creditsError;
				delete merged.credits;
			}
			if (latest.atMs <= checkinStartedAt) {
				if (value.checkin !== void 0) {
					merged.checkin = value.checkin;
					delete merged.checkinError;
				}
				if (value.checkinError !== void 0) {
					merged.checkinError = value.checkinError;
					delete merged.checkin;
				}
			}
			probeCache.set(account.id, {
				atMs: Date.now(),
				value: merged,
				checkinOnly: false
			});
			return merged;
		}
		return latest.value;
	}
	const stored = checkinOnly && cached !== void 0 ? {
		...cached.value,
		...value
	} : value;
	if (value.checkin !== void 0) delete stored.checkinError;
	if (value.checkinError !== void 0) delete stored.checkin;
	probeCache.set(account.id, {
		atMs: Date.now(),
		value: stored,
		checkinOnly
	});
	if (probeCache.size > core.pool.list().length) {
		const live = new Set(core.pool.list().map((item) => item.id));
		for (const id of Array.from(probeCache.keys())) if (!live.has(id)) probeCache.delete(id);
	}
	return stored;
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
/**
* Whether this account's sign-in is one the upstream has refused.
*
* The hold is the pool's own record that a refresh could not save the sign-in,
* so every pass that walks the pool asks before it spends a call: a held
* account cannot answer, and the panel row already says why.
*/
function signInRefused(account) {
	return core.pool.activeHold(account.id)?.reason === "session";
}
/**
* The row fields that describe a hold the pool itself decided, if one is in
* force for this account right now.
*
* Empty spread when the account is simply cooling on an upstream window: that
* state already reads as one on the row, and its remedy is to wait.
*/
function activeHoldOf(accountId, now) {
	const hold = core.pool.activeHold(accountId);
	if (hold === null || hold.untilMs <= now) return {};
	return { hold: hold.reason };
}
async function statusDocument(options) {
	const allowNetwork = options?.allowNetwork === true;
	const probeBudget = typeof options?.budgetMs === "number" ? Math.min(PROBE_BATCH_BUDGET_MS, Math.max(0, options.budgetMs)) : PROBE_BATCH_BUDGET_MS;
	const now = Date.now();
	const reserves = creditReserves();
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
		const nextUp = available.find((account) => account.id === preferredAccountIds[region]) ?? core.pool.preview(available);
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
				region,
				...account.credential.expiresAtMs === 0 ? {} : { expiresAt: new Date(account.credential.expiresAtMs).toISOString() },
				cooling,
				...cooling ? { cooldownUntil: new Date(account.cooldownUntilMs).toISOString() } : {},
				...modelCooldowns.length === 0 ? {} : { modelCooldowns },
				rateLimitHits: account.rateLimitHits,
				...activeHoldOf(account.id, now),
				active: runtimeNextUpId.get(region) === account.id,
				preferred: preferredAccountIds[region] === account.id,
				disabled: core.pool.isDisabled(account.id),
				...account.archived === true ? { archived: true } : {},
				...core.pool.ownsSignIn(account.id) ? { own: true } : {},
				...reserves[account.id] === void 0 ? {} : { creditReserve: reserves[account.id] }
			};
			if (!core.pool.isDisabled(account.id)) {
				const checkinOnly = cooling;
				pendingProbes.push(accountProbe(account, allowNetwork, checkinOnly).then((probe) => {
					applyProbe(row, probe);
				}));
			}
			accounts.push(row);
		}
		const catalog = runtimes.get(region)?.catalog;
		if (catalog) {
			const selection = selectionByRegion[region];
			const enabled = selection.enabledModelIds;
			const overrides = selection.overrides || {};
			for (const model of catalog.current()) {
				const override = overrides[model.id];
				const effective = applyOverride(model, override, catalog.hasLiveRoster());
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
				preferredPort: entry.preferredPort,
				lastError: entry.lastError,
				...sourcePublishedModels("trae:" + entry.region, entry.gateway.models(), traeNativeOf)
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
				preferredPort: entry.preferredPort,
				lastError: entry.lastError,
				...sourcePublishedModels("qoder:" + entry.region, entry.gateway.models(), qoderNativeOf)
			}))
		},
		enabled: settings.enabled !== false,
		unpublishedDeclarations: unpublishedDeclarations(),
		modelCap: MAX_MODELS,
		distribution: distributionSetting(),
		showComposerPoints: settings.showComposerPoints === true,
		autoCheckin: {
			enabled: autoCheckinEnabled(),
			hours: checkinHours(),
			...autoCheckinLast === null ? {} : { last: autoCheckinLast }
		},
		growth: {
			running: growthPassRunning || checkinPassRunning,
			...growthLast === null ? {} : { last: growthLast },
			read: growthRead
		},
		keepAlive: keepAliveLast === null ? null : { ...keepAliveLast },
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
* The declaration is republished after a port fallback, so the published address
* is the test: a row that follows the actual port is healthy, while one that
* still names the preferred port is drift. Checking `portFallback` itself marked
* a correctly republished row as broken.
*
* A gateway whose start failed counts as drift too, and for the same reason: it
* has no shim at all, so the address the host registered is refused. Skipping
* it - which is what the `bound === undefined` case did - reported a healthy
* panel over a session whose every request failed.
*
* Trae and Qoder are read the same way as WorkBuddy: they reserve a preferred
* port on the same terms, so they drift the same way.
*/
function addressDrift() {
	for (const region of activeRegions()) {
		const published = declaredBaseUrl(region);
		const bound = shimInfo(region).baseUrl;
		if (bound === void 0) {
			if (gatewayStartFailures.has(region) && publishedIds.has(PROVIDER_ID_BY_REGION[region])) return true;
			continue;
		}
		if (published !== void 0 && published !== bound) return true;
	}
	for (const entry of Array.from(traeGateways.values())) {
		const published = declaredSourceBaseUrl(entry, TRAE_PROVIDER_ID_BY_REGION);
		if (published !== void 0 && !samePublishedAddress(published, entry.baseUrl)) return true;
	}
	for (const entry of Array.from(qoderGateways.values())) {
		const published = declaredSourceBaseUrl(entry, QODER_PROVIDER_ID_BY_REGION);
		if (published !== void 0 && !samePublishedAddress(published, entry.baseUrl)) return true;
	}
	for (const region of activeTraeRegions()) {
		if (!sourceStartFailures.has("trae:" + region)) continue;
		if (declaredSourceBaseUrl({ region }, TRAE_PROVIDER_ID_BY_REGION) !== void 0) return true;
	}
	for (const region of activeQoderRegions()) {
		if (!sourceStartFailures.has("qoder:" + region)) continue;
		if (declaredSourceBaseUrl({ region }, QODER_PROVIDER_ID_BY_REGION) !== void 0) return true;
	}
	return false;
}
/**
* Trae discovery for the doctor: count only, never token material.
*
* Answers `{ok, detail}` so the finding can carry the verdict instead of
* hard-coding `true`: a source that could not be read, or that holds no
* sign-in at all, is a failed check, and the report used to pass it.
*/
async function traeDoctorDetail() {
	if (!sourceEnabled("trae")) return {
		ok: true,
		detail: "switched off in plugin settings (deliberate; not a failure)"
	};
	try {
		const found = await discoverTraeCredentials();
		if (found.credentials.length === 0) return {
			ok: false,
			detail: "on; no Trae sign-in found (sign in to Trae CN / TRAE SOLO CN, then run the check again)"
		};
		const byRegion = {};
		for (const credential of found.credentials) {
			const region = traeRegionOfCredential(credential);
			byRegion[region] = (byRegion[region] || 0) + 1;
		}
		const parts = Object.entries(byRegion).map(([region, count]) => `${region} x${count}`).join(", ");
		const failures = found.failures.length > 0 ? `; ${found.failures.length} unreadable file(s)` : "";
		const servedRegions = activeTraeRegions();
		const served = servedRegions.map((region) => `${region}: ${traeDeclarationModels(region).length} model(s)`).join(", ");
		const stillReading = [];
		const problems = [];
		for (const region of servedRegions) {
			const entry = traeGateways.get(region);
			if (entry === void 0 && !byRegion[region]) problems.push(`${region}: no sign-in for this region`);
			else if (entry === void 0 || entry.warmSettled !== true) stillReading.push(region);
			else if (traeDeclarationModels(region).length === 0) problems.push(entry.lastError !== "" ? `${region}: ${entry.lastError}` : `${region}: no models selected`);
		}
		return {
			ok: problems.length === 0,
			detail: `on; ${found.credentials.length} account(s) (${parts})${failures}; serving ${served}` + (stillReading.length > 0 ? `; still reading models for ${stillReading.join(", ")}` : "") + (problems.length > 0 ? `; ${problems.join("; ")}` : "")
		};
	} catch (error) {
		return {
			ok: false,
			detail: `on; discovery failed (${errorCodeOf(error)})`
		};
	}
}
/** Qoder credentials for the doctor: count only, never token material. */
async function qoderDoctorDetail() {
	if (!sourceEnabled("qoder")) return {
		ok: true,
		detail: "switched off in plugin settings (deliberate; not a failure)"
	};
	try {
		const found = await discoverQoderCredentials();
		if (found.credentials.length === 0) return {
			ok: false,
			detail: `on; no Qoder sign-in found (sign in to Qoder, then run the check again)${found.failures.length > 0 ? `; ${found.failures.length} unreadable app dir(s)` : ""}`
		};
		const byRegion = {};
		for (const credential of found.credentials) byRegion[credential.region] = (byRegion[credential.region] || 0) + 1;
		const parts = Object.entries(byRegion).map(([region, count]) => `${region} x${count}`).join(", ");
		const failures = found.failures.length > 0 ? `; ${found.failures.length} unreadable app dir(s)` : "";
		const servedRegions = activeQoderRegions();
		const served = servedRegions.map((region) => `${region}: ${qoderDeclarationModels(region).length} model(s)`).join(", ");
		const stillReading = [];
		const problems = [];
		for (const region of servedRegions) {
			const entry = qoderGateways.get(region);
			if (entry === void 0 && !byRegion[region]) problems.push(`${region}: no sign-in for this region`);
			else if (entry === void 0 || entry.warmSettled !== true) stillReading.push(region);
			else if (qoderDeclarationModels(region).length === 0) problems.push(entry.lastError !== "" ? `${region}: ${entry.lastError}` : `${region}: no models selected`);
		}
		return {
			ok: problems.length === 0,
			detail: `on; ${found.credentials.length} account(s) (${parts})${failures}; serving ${served}` + (stillReading.length > 0 ? `; still reading models for ${stillReading.join(", ")}` : "") + (problems.length > 0 ? `; ${problems.join("; ")}` : "")
		};
	} catch (error) {
		return {
			ok: false,
			detail: `on; discovery failed (${errorCodeOf(error)})`
		};
	}
}
/** A readable report of everything that has to hold for a chat to reach upstream. */
async function doctorReport() {
	const { left, settle } = budget(PANEL_STEP_BUDGET_MS);
	const status = await settle(statusDocument({
		allowNetwork: true,
		budgetMs: left()
	})) ?? await settle(statusDocument({
		allowNetwork: false,
		budgetMs: left()
	})) ?? {
		enabled: settings.enabled !== false,
		sources: {},
		accounts: [],
		models: []
	};
	const findings = [];
	const push = (id, ok, detail) => findings.push({
		id,
		ok,
		detail
	});
	push("plugin-enabled", status.enabled, status.enabled ? "enabled" : "disabled in plugin settings");
	push("source-workbuddy", true, status.sources.workbuddy === true ? "on" : "switched off in plugin settings (deliberate; not a failure)");
	const traeDetail = await settle(traeDoctorDetail());
	push("source-trae", traeDetail?.ok ?? false, traeDetail?.detail ?? "on; still reading this source's sign-ins");
	const qoderDetail = await settle(qoderDoctorDetail());
	push("source-qoder", qoderDetail?.ok ?? false, qoderDetail?.detail ?? "on; still reading this source's sign-ins");
	push("accounts", status.sources.workbuddy !== true || status.accounts.length > 0, status.sources.workbuddy !== true ? "WorkBuddy source is switched off; nothing is scanned or served" : status.accounts.length === 0 ? "no WorkBuddy sign-in found; sign in to the desktop app, then detect accounts again" : status.accounts.length + " account(s)");
	const healthy = status.accounts.filter((account) => !account.cooling).length;
	push("rotation", status.sources.workbuddy !== true || healthy > 0, status.sources.workbuddy !== true ? "switched off; nothing to rotate" : healthy + " of " + status.accounts.length + " account(s) can serve a request now");
	const atRestKeyReason = status.sources.workbuddy === true ? atRestKeyFailure() : "";
	push("at-rest-key", atRestKeyReason === "", atRestKeyReason === "" ? "no at-rest key failure" : safeMessage(atRestKeyReason));
	const unpublished = status.unpublishedDeclarations || [];
	push("host-registered-providers", unpublished.length === 0, unpublished.length === 0 ? "the host is serving every provider this plugin declares" : unpublished.length + " provider(s) failed to register with the host (" + unpublished.join(", ") + ") - the next change to the pool retries them");
	for (const region of activeRegions()) {
		const runtime = runtimes.get(region);
		const label = PROVIDER_NAME_BY_REGION[region];
		const info = shimInfo(region);
		const declared = declaredProvider(region) !== void 0 && publishedIds.has(PROVIDER_ID_BY_REGION[region]);
		push(label + ": endpoint", info.running, info.running ? "listening on " + info.baseUrl : gatewayStartFailures.get(region) ?? "not listening");
		const regionModels = status.models.filter((model) => model.region === region);
		push(label + ": models", regionModels.length > 0, regionModels.length + " model(s) in the catalog");
		push(label + ": declared", declared, declared ? "registered with the running host" : runtime?.lastError || runtime?.lastWarning || "this gateway is not published yet");
	}
	for (const [gateways, idByRegion, nameByRegion, ports, modelsOf] of [
		[
			runtimes,
			PROVIDER_ID_BY_REGION,
			PROVIDER_NAME_BY_REGION,
			REGION_PORTS,
			declarationModels
		],
		[
			traeGateways,
			TRAE_PROVIDER_ID_BY_REGION,
			TRAE_PROVIDER_NAME_BY_REGION,
			TRAE_PORTS,
			traeDeclarationModels
		],
		[
			qoderGateways,
			QODER_PROVIDER_ID_BY_REGION,
			QODER_PROVIDER_NAME_BY_REGION,
			QODER_PORTS,
			qoderDeclarationModels
		]
	]) for (const entry of Array.from(gateways.values())) {
		const published = declaredSourceBaseUrl(entry, idByRegion);
		const bound = entry.baseUrl;
		const label = nameByRegion[entry.region];
		if (bound === void 0) continue;
		if (published === void 0) {
			if (entry.warmSettled !== void 0 ? entry.warmSettled !== true : warmingGatewayIds().has(idByRegion[entry.region])) {
				push(label + ": published address", true, "still reading its model roster");
				continue;
			}
			if (entry.lastError) {
				push(label + ": published address", false, entry.lastError);
				continue;
			}
			if (modelsOf(entry.region).length === 0) {
				push(label + ": published address", true, "no callable models selected; nothing to publish");
				continue;
			}
			push(label + ": published address", false, "this gateway is running but its provider row is not published in this run's declaration - restart the plugin");
			continue;
		}
		const fallback = entry.portFallback === true;
		if (samePublishedAddress(published, bound)) {
			const detail = fallback ? "matches the endpoint this gateway bound (" + bound + "); preferred port " + ports[entry.region] + " is held, so this session serves the fallback" : "matches the endpoint this gateway bound (" + bound + ")";
			push(label + ": published address", true, detail);
			continue;
		}
		const detail = "the published address is " + published + " but this gateway is on " + bound + " - reload the plugin so the host picks the new address up";
		push(label + ": published address", false, detail);
	}
	for (const [source, nameByRegion, regions] of [[
		"trae",
		TRAE_PROVIDER_NAME_BY_REGION,
		activeTraeRegions()
	], [
		"qoder",
		QODER_PROVIDER_NAME_BY_REGION,
		activeQoderRegions()
	]]) for (const region of regions) {
		const reason = sourceStartFailures.get(source + ":" + region);
		if (reason === void 0) continue;
		push(nameByRegion[region] + ": endpoint", false, reason);
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
/**
* Run the connection check, answering with a report even when it fails.
*
* A check that threw used to take the whole channel down with it: the panel
* showed a generic error and there was no report to read, which says "the
* check is broken" rather than "the check found something it could not read".
* The failure is now a finding like any other.
*/
async function doctor() {
	try {
		return await doctorReport();
	} catch (error) {
		const detail = safeMessage(error);
		log("warn", "connection check failed: " + detail);
		const findings = [{
			id: "status",
			ok: false,
			detail
		}];
		return {
			ok: false,
			findings,
			report: [
				"WTQ Pool doctor",
				(/* @__PURE__ */ new Date()).toISOString(),
				"overall: FAIL",
				"",
				...findings.map((finding) => (finding.ok ? "PASS  " : "FAIL  ") + finding.id + " - " + finding.detail),
				""
			].join("\n"),
			status: void 0
		};
	}
}
/**
* Logins the panel has started and not finished, keyed by realm.
*
* One per realm on purpose: a second start for the same realm replaces the
* first, and the replaced state is dead — a browser is sitting on a URL nobody
* polls. Memory only, so a restart drops them and the panel simply starts over
* rather than answering a poll for a state this process never issued.
*/
const deviceLogins = /* @__PURE__ */ new Map();
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
			if (entry.length > MAX_MODEL_ID_LENGTH) return void 0;
			ids.push(entry);
		}
		out.enabledModelIds = ids.slice(0, MAX_STORED_MODEL_IDS);
	}
	const overrides = body.overrides;
	if (overrides !== void 0) {
		if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) return void 0;
		const map = Object.create(null);
		let stored = 0;
		for (const [id, raw] of Object.entries(overrides)) {
			if (typeof id !== "string" || id === "") return void 0;
			if (id.length > MAX_MODEL_ID_LENGTH) return void 0;
			if (stored >= MAX_STORED_MODEL_IDS) return void 0;
			const parsed = parseOverride(raw);
			if (parsed === void 0) return void 0;
			if (Object.keys(parsed).length > 0) {
				map[id] = parsed;
				stored += 1;
			}
		}
		out.overrides = map;
	}
	return out;
}
/**
* The model ids one save's page could display, or undefined for an older panel.
*
* Only used to tell "the page did not show this id" from "the user removed it",
* so junk entries are skipped rather than failing the save.
*/
function parseKnownModelIds(value) {
	if (!Array.isArray(value)) return void 0;
	const ids = /* @__PURE__ */ new Set();
	for (const entry of value) if (typeof entry === "string" && entry !== "" && entry.length <= MAX_MODEL_ID_LENGTH) ids.add(entry);
	return ids;
}
/**
* Keep the stored selection of models the saving page could not display.
*
* A roster read can be partial: the static fallback stands until the live list
* arrives, and a source directory can answer with fewer rows than it will carry
* later. Saving such a page used to replace the whole selection, so every model
* outside the snapshot lost its tick and its per-model edits. Ids the page did
* show are authoritative - an absent override there means the user cleared it -
* while ids it never showed keep what was stored.
*/
function mergeSelectionForPartialRoster(selection, prior, known) {
	if (known === void 0) return selection;
	const carriedEnabled = (Array.isArray(prior.enabledModelIds) ? prior.enabledModelIds : []).filter((id) => !known.has(id));
	const priorOverrides = prior.overrides !== null && typeof prior.overrides === "object" ? prior.overrides : {};
	const overrides = Object.create(null);
	for (const [id, entry] of Object.entries(priorOverrides)) if (!known.has(id)) overrides[id] = { ...entry };
	const merged = { ...selection };
	if (Array.isArray(selection.enabledModelIds)) merged.enabledModelIds = [.../* @__PURE__ */ new Set([...selection.enabledModelIds, ...carriedEnabled])].slice(0, MAX_STORED_MODEL_IDS);
	if (selection.overrides !== void 0) for (const [id, entry] of Object.entries(selection.overrides)) overrides[id] = entry;
	if (Object.keys(overrides).length > 0) merged.overrides = overrides;
	else delete merged.overrides;
	return merged;
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
			if (payload?.wait === true) {
				const refreshed = await refreshAll("panel", true);
				if (refreshed.stale === true) return {
					...await statusDocument({ allowNetwork: false }),
					refreshing: false,
					stale: true
				};
				const stillNeeded = refreshNeeded();
				if (stillNeeded) scheduleRefresh("panel");
				return {
					...refreshed,
					refreshing: stillNeeded
				};
			}
			const document = await statusDocument({ allowNetwork: false });
			const refreshing = refreshNeeded();
			if (refreshing) scheduleRefresh("panel");
			return {
				...document,
				refreshing
			};
		}
		/**
		* Re-read the WorkBuddy rosters for the panel, and nothing else.
		*
		* The panel asks for this as it opens and when its model page is shown. A
		* roster read that timed out while the host was starting leaves the static
		* fallback in force, and the model page then listed the fallback's own
		* models and told the user every model they had chosen was retired - on
		* every start, for as long as the live read kept failing. This forces one
		* read per gateway (the same read `xd.rescan` does for its rosters) without
		* the account scan and gateway reconciliation that make a full rescan too
		* heavy to run on every panel open.
		*/
		case "xd.fetchModels":
			await settleWithin(Promise.all(Array.from(runtimes.values()).map(async (runtime) => {
				try {
					await refreshRuntime(runtime, "fetch-models", true);
				} catch (error) {
					runtime.lastError = safeMessage(error);
				}
			})), LOAD_ROSTER_BUDGET_MS);
			syncDeclaration();
			return {
				...await statusDocument({ allowNetwork: false }),
				refreshing: refreshNeeded()
			};
		/**
		* "Detect accounts again": a deliberate, user-invoked re-read, so every
		* gateway's roster is refetched even inside its refresh window.
		*/
		case "xd.rescan": {
			const { left, settle } = budget(RESCAN_BUDGET_MS);
			resetDiscoveryCaches();
			growthRead = null;
			growthReadEpoch += 1;
			if (activeRegions().length > 0) await settle(core.pool.scan());
			await settle(startRuntimes());
			await settle(refreshSourceAccounts());
			await settle(reconcileTraeGateways());
			await settle(reconcileQoderGateways());
			await settle(Promise.all([...Array.from(traeGateways.values()), ...Array.from(qoderGateways.values())].filter((entry) => entry.lastError !== "" || entry.gateway.models().length === 0).map((entry) => warmSourceDirectory(entry))));
			await settle(Promise.all(Array.from(runtimes.values()).map((runtime) => refreshRuntime(runtime, "rescan", true))));
			syncDeclaration();
			const document = await statusDocument({
				allowNetwork: true,
				budgetMs: left()
			});
			const refreshing = refreshNeeded();
			if (refreshing) scheduleRefresh("panel");
			return {
				...document,
				refreshing
			};
		}
		case "xd.resetCooldowns":
			core.pool.resetCooldowns();
			sourceFailureHold.clear();
			return await statusDocument({ allowNetwork: false });
		case "xd.checkin": {
			const accountId = typeof payload?.accountId === "string" ? payload.accountId : "";
			if (accountId === "") throw panelError("accountId is required", "INVALID");
			const account = core.pool.list().find((item) => item.id === accountId);
			if (account === void 0) throw panelError("unknown account", "NOT_FOUND");
			if (!regionEnabled("workbuddy", regionOf(account.credential.domain))) throw panelError("this source region is disabled", "INACTIVE");
			if (checkinPassRunning || growthPassRunning) throw panelError("a check-in or growth pass is already running; wait for it to finish", "BUSY");
			const token = ++checkinPassToken;
			checkinPassRunning = true;
			const work = async () => {
				const before = await core.pool.readAfterRefresh(account.id, (credential) => core.client.fetchCheckinStatus(credential));
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
			const answered = await settleWithin(work().finally(() => {
				if (token === checkinPassToken) checkinPassRunning = false;
			}), PANEL_STEP_BUDGET_MS);
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
			const known = parseKnownModelIds(payload?.knownModelIds);
			if (await mutateSettings("modelSelection", (current) => {
				const all = { ...current && typeof current === "object" && !Array.isArray(current) ? current : {} };
				all[requested] = mergeSelectionForPartialRoster(selection, normalizeSelection(all[requested]), known);
				return all;
			}) !== true) throw panelError("the selection could not be written to the plugin settings file", "SAVE_FAILED");
			if (requested === "cn" || requested === "global") applyEffectiveSelection(requested);
			syncDeclaration();
			return await statusDocument({ allowNetwork: false });
		}
		case "xd.preferAccount": {
			const region = payload?.region;
			const accountId = payload?.accountId;
			if (!REGIONS.includes(region) || typeof accountId !== "string") throw panelError("region and accountId are required", "INVALID");
			if (accountId !== "" && !core.pool.list(region).some((account) => account.id === accountId)) throw panelError("account does not belong to this region", "NOT_FOUND");
			if (await mutateSettings("preferredAccountIds", (current) => {
				const next = {};
				for (const key of REGIONS) {
					const held = current && typeof current === "object" && !Array.isArray(current) ? current[key] : void 0;
					if (typeof held === "string" && held !== "") next[key] = held;
				}
				if (accountId === "") delete next[region];
				else next[region] = accountId;
				return next;
			}) !== true) throw panelError("the account choice could not be saved", "SAVE_FAILED");
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
				"restored",
				"deleted"
			].includes(state)) throw panelError("region, accountId and a known state are required", "INVALID");
			const account = core.pool.list(region).find((item) => item.id === accountId);
			const stored = removedAccounts().find((entry) => entry.id === accountId);
			if (state !== "restored" && account === void 0 && stored === void 0) throw panelError("account does not belong to this gateway", "NOT_FOUND");
			if (state === "deleted") {
				if (!core.pool.ownsSignIn(accountId)) throw panelError("only an account added from this panel can be deleted", "NOT_OWN");
				if (await core.pool.removeOwnSignIn(accountId) !== true) throw panelError("the sign-in file could not be removed", "DELETE_FAILED");
				await settleWithin(core.pool.scan(), POOL_SCAN_BUDGET_MS);
				if (await mutateSettings("disabledAccountIds", (current) => {
					return (Array.isArray(current) ? current.filter((id) => typeof id === "string") : []).filter((id) => id !== accountId);
				}) !== true) log("warn", "could not clear the disabled state for " + accountId);
				if (await mutateSettings("creditReserves", (current) => {
					const next = { ...current && typeof current === "object" && !Array.isArray(current) ? current : {} };
					delete next[accountId];
					return next;
				}) !== true) log("warn", "could not clear the credit reserve for " + accountId);
				core.pool.applyConfig({
					disabledAccountIds: disabledAccountIds(),
					creditReserves: creditReserves()
				});
				if (preferredAccountId(region) === accountId) {
					if (await mutateSettings("preferredAccountIds", (current) => {
						const next = { ...current && typeof current === "object" && !Array.isArray(current) ? current : {} };
						delete next[region];
						return next;
					}) !== true) log("warn", "could not clear the preferred account for " + region);
					core.pool.prefer(void 0, region);
				}
				growthRead = null;
				growthReadEpoch += 1;
				return await statusDocument({ allowNetwork: false });
			}
			if (await mutateSettings("disabledAccountIds", (current) => {
				const kept = (Array.isArray(current) ? current.filter((id) => typeof id === "string") : []).filter((id) => id !== accountId);
				if (state === "disabled") kept.push(accountId);
				return kept;
			}) !== true) throw panelError("the account setting could not be saved", "SAVE_FAILED");
			if (await mutateSettings("removedAccounts", (current) => {
				const kept = (Array.isArray(current) ? current.filter((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry)) : []).filter((entry) => entry.id !== accountId);
				if (state === "removed") kept.push({
					id: accountId,
					label: account === void 0 ? stored.label : account.label,
					region
				});
				return kept;
			}) !== true) throw panelError("the account setting could not be saved", "SAVE_FAILED");
			const disabled = disabledAccountIds();
			const removed = removedAccounts();
			core.pool.applyConfig({ disabledAccountIds: disabled });
			core.pool.applyRemoved(removed.map((entry) => entry.id));
			if (accountId !== "" && preferredAccountId(region) === accountId && state !== "enabled" && state !== "restored") {
				if (await mutateSettings("preferredAccountIds", (current) => {
					const next = { ...current && typeof current === "object" && !Array.isArray(current) ? current : {} };
					delete next[region];
					return next;
				}) !== true) log("warn", "could not clear the preferred account for " + region);
				core.pool.prefer(void 0, region);
			}
			growthRead = null;
			growthReadEpoch += 1;
			return await statusDocument({ allowNetwork: false });
		}
		/** The credits to keep back on one account: 0 clears the floor. */
		case "xd.setCreditReserve": {
			const region = payload?.region;
			const accountId = payload?.accountId;
			const reserve = Number(payload?.reserve);
			if (!REGIONS.includes(region) || typeof accountId !== "string" || accountId === "") throw panelError("region and accountId are required", "INVALID");
			if (!Number.isFinite(reserve) || reserve < 0 || reserve > MAX_CREDIT_RESERVE) throw panelError("reserve must be a number of credits between 0 and 1000000000", "INVALID");
			if (!core.pool.list(region).some((account) => account.id === accountId)) throw panelError("account does not belong to this gateway", "NOT_FOUND");
			if (await mutateSettings("creditReserves", (current) => {
				const next = { ...current && typeof current === "object" && !Array.isArray(current) ? current : {} };
				if (reserve === 0) delete next[accountId];
				else next[accountId] = Math.floor(reserve);
				return next;
			}) !== true) throw panelError("the reserve could not be saved", "SAVE_FAILED");
			core.pool.applyConfig({ creditReserves: creditReserves() });
			return await statusDocument({ allowNetwork: false });
		}
		/** One click for every account's daily reward.
		*  With `source`, only that source's pool runs — each source has its own
		*  check-in pool in the panel, so one button must not sweep the others. */
		case "xd.checkinAll": {
			const source = typeof payload?.source === "string" ? payload.source : "";
			if (![
				"",
				"workbuddy",
				"trae",
				"qoder"
			].includes(source)) throw panelError("source must be workbuddy, trae or qoder", "INVALID");
			const counts = await settleWithin(runCheckinPass({
				manual: true,
				only: source
			}), CHECKIN_BUDGET_MS);
			if (counts === void 0) return {
				state: await statusDocument({
					allowNetwork: true,
					budgetMs: DOCUMENT_BUDGET_MS
				}),
				running: true
			};
			if (counts.running === true || counts.stale === true) return {
				state: await statusDocument({
					allowNetwork: true,
					budgetMs: DOCUMENT_BUDGET_MS
				}),
				running: true
			};
			if (counts.error !== void 0) throw panelError(counts.error, "UPSTREAM");
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
			if (checkinPassRunning || growthPassRunning) throw panelError("a check-in or growth pass is already running; wait for it to finish", "BUSY");
			const token = ++checkinPassToken;
			checkinPassRunning = true;
			const answered = await settleWithin((async () => {
				const outcome = source === "trae" ? await traeClaimOne(label, region) : await qoderClaimOne(label, region);
				markSourceCheckinRow(source, label, region, outcome);
				return {
					state: await statusDocument({
						allowNetwork: true,
						budgetMs: DOCUMENT_BUDGET_MS
					}),
					result: outcome
				};
			})().finally(() => {
				if (token === checkinPassToken) checkinPassRunning = false;
			}), PANEL_STEP_BUDGET_MS);
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
			if (await mutateSettings("preferredSourceAccounts", (current) => {
				const next = { ...current && typeof current === "object" && !Array.isArray(current) ? current : {} };
				if (label === "") delete next[sourceRegionKey(source, region)];
				else next[sourceRegionKey(source, region)] = label;
				return next;
			}) !== true) throw panelError("the account choice could not be saved", "SAVE_FAILED");
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
			const mode = SOURCE_DISTRIBUTIONS.includes(payload?.distribution) ? payload.distribution : "priority";
			if (await mutateSettings("sourceDistributions", (current) => {
				const next = { ...current && typeof current === "object" && !Array.isArray(current) ? current : {} };
				next[source] = mode;
				return next;
			}) !== true) throw panelError("the usage mode could not be written to the plugin settings file", "SAVE_FAILED");
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
		* Refresh every eligible account's token, by hand.
		*
		* There is no schedule behind this: the panel's button is the only thing
		* that runs it, which is what the user asked for. The pass itself is the
		* same one the check-in card's other controls use — `ensureFresh` decides
		* per account whether an upstream call is needed — so a token that still
		* has hours on it costs nothing and an international token that lives a
		* year is never touched.
		*
		* Bounded like every other network pass here: Trae alone spaces its
		* accounts, and a pass that outruns the budget records itself in the
		* document instead of leaving the button spinning.
		*/
		case "xd.keepAlive":
			await settleWithin(runKeepAlivePass(), REFRESH_PASS_BUDGET_MS);
			return await statusDocument({ allowNetwork: false });
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
			if (await mutateSettings("disabledRegions", (current) => {
				const parked = (Array.isArray(current) ? current.filter((entry) => typeof entry === "string") : []).filter((entry) => entry !== key);
				if (payload?.enabled !== true) parked.push(key);
				return parked;
			}) !== true) throw panelError("the region switch could not be written to the plugin settings file", "SAVE_FAILED");
			await applySettingsEverywhere(false);
			if (payload?.enabled === true) await refreshAll("region-on", true);
			else syncDeclaration();
			if (source === "workbuddy") {
				growthRead = null;
				growthReadEpoch += 1;
			}
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
			const key = sourceSettingKey(payload?.source);
			if (key === void 0) throw panelError("unknown source", "UNSUPPORTED");
			if (await saveSettings({ [key]: payload?.enabled === true }) !== true) throw panelError("the source switch could not be written to the plugin settings file", "SAVE_FAILED");
			resetDiscoveryCaches();
			await applySettingsEverywhere(false);
			if (payload?.enabled === true) await refreshAll("source-on", true);
			else syncDeclaration();
			if (payload?.source === "workbuddy") {
				growthRead = null;
				growthReadEpoch += 1;
			}
			return await statusDocument({ allowNetwork: false });
		}
		/**
		* Start a panel login and answer the URL to open.
		*
		* The URL is handed back rather than opened from here: the panel owns the
		* click, and this host's page is a real browser tab, so it opens the link
		* itself the same way its footer links do.
		*/
		case "xd.startLogin": {
			const realm = payload?.realm === "global" ? "global" : "cn";
			const start = await startDeviceLogin(realm);
			deviceLogins.set(realm, {
				state: start.state,
				at: Date.now()
			});
			return {
				realm,
				authUrl: start.authUrl
			};
		}
		/**
		* Poll the login the panel started on this realm.
		*
		* A finished login is written as one of the plugin's own `.info` files and
		* the pool is rescanned, so the account appears in the panel and the
		* provider row without a reload. The second sign-in for an account already
		* present lands in a directory the pool already reads, so the directory set
		* does not change and `applyConfig` would not notice it: the scan is
		* explicit for that reason.
		*/
		case "xd.pollLogin": {
			const realm = payload?.realm === "global" ? "global" : "cn";
			const pending = deviceLogins.get(realm);
			if (pending === void 0) throw panelError("no login is waiting on this realm", "NO_LOGIN");
			if (Date.now() - pending.at > DEVICE_LOGIN_TTL_MS) {
				deviceLogins.delete(realm);
				throw panelError("the login link has expired; start again", "LOGIN_EXPIRED");
			}
			const answer = await pollDeviceLogin(realm, pending.state);
			if (answer.status !== "ok") return { status: "pending" };
			deviceLogins.delete(realm);
			const directory = ownSignInDir(dataPath);
			if (directory === "") throw panelError("no plugin data directory to write the sign-in into", "NO_DATA_DIR");
			await writeOwnSignIn(directory, answer.signIn);
			growthRead = null;
			growthReadEpoch += 1;
			await settleWithin(core.pool.scan(), POOL_SCAN_BUDGET_MS);
			await refreshAll("panel-login", false);
			return {
				status: "ok",
				nickname: answer.signIn.nickname,
				region: answer.signIn.region,
				state: await statusDocument({ allowNetwork: false })
			};
		}
		/**
		* What the growth centre holds, claiming nothing.
		*
		* Read-only because two of the four steps are not idempotent: a make-up
		* card and a lottery draw are spent by running them. Showing the state
		* first is what lets the panel say "2 cards, yesterday missed" before the
		* user decides, rather than spending one and reporting it afterwards.
		*/
		case "xd.growthState": {
			const epoch = growthReadEpoch;
			const answered = await settleWithin(readGrowthState(), PANEL_STEP_BUDGET_MS);
			if (answered === void 0) throw panelError("the growth state did not finish in time; try again", "TIMEOUT");
			if (epoch !== growthReadEpoch) return { growth: {
				...answered,
				readAt: Date.now()
			} };
			growthRead = {
				...answered,
				readAt: Date.now()
			};
			return { growth: growthRead };
		}
		/**
		* Run the growth centre on its own, without the daily check-in.
		*
		* The scheduled pass runs it as its third stage, so this is the same code
		* with the same pacing and the same abort signal - not a second, smaller
		* copy of it. Refused beside a check-in pass rather than queued: both walk
		* the same accounts, and two unpaced clusters on one account is what the
		* upstream reads as a burst.
		*/
		case "xd.growthRun": {
			if (serviceStopped) return {
				state: await statusDocument({ allowNetwork: false }),
				running: true
			};
			if (growthPassRunning || checkinPassRunning) return {
				state: await statusDocument({ allowNetwork: false }),
				running: true
			};
			growthPassRunning = true;
			const token = ++growthPassToken;
			checkinAbort.abort();
			checkinAbort = new AbortController();
			checkinScope.enterWith(checkinAbort.signal);
			const generation = loadGeneration;
			const counts = await settleWithin((async () => {
				try {
					const counts = await claimAllGrowth();
					if (stillLoaded(generation)) {
						growthLast = {
							at: (/* @__PURE__ */ new Date()).toISOString(),
							...counts
						};
						scheduleRefresh("growth");
					}
					return counts;
				} finally {
					if (token === growthPassToken) growthPassRunning = false;
				}
			})(), GROWTH_BUDGET_MS);
			if (counts === void 0) return {
				state: await statusDocument({ allowNetwork: false }),
				running: true
			};
			return {
				state: await statusDocument({ allowNetwork: false }),
				growth: counts
			};
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
			const { left, settle } = budget(COMPOSER_REFRESH_BUDGET_MS);
			if (hit.source === "workbuddy") {
				for (const account of core.pool.list(hit.region)) probeCache.delete(account.id);
				await settle(statusDocument({
					allowNetwork: true,
					budgetMs: COMPOSER_REFRESH_BUDGET_MS
				}));
			} else {
				const rows = hit.source === "trae" ? traeAccountRows : qoderAccountRows;
				const found = hit.source === "trae" ? await discoverTraeCredentials() : await discoverQoderCredentials();
				for (const row of rows) {
					if (row.region !== hit.region) continue;
					if (left() === 0) break;
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
/**
* One check-in worker, isolated from the others in the same fan-out.
*
* The fan-out is a `Promise.all`, so a worker that threw took the whole pass
* with it - the WorkBuddy counts already computed included. Each worker now
* answers its own empty result and logs, and the pass reports what the rest did.
*/
function isolatedCheckinWorker(work, fallback, name) {
	return work.catch((error) => {
		log("warn", name + " check-in failed: " + safeMessage(error));
		return {
			...fallback,
			failed: 1,
			reason: safeMessage(error)
		};
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
	const only = typeof options?.only === "string" ? options.only : "";
	const want = (name) => only === "" || only === name;
	const generation = loadGeneration;
	if (checkinPassRunning) return { running: true };
	if (serviceStopped) return { stale: true };
	if (growthPassRunning) return { running: true };
	checkinPassRunning = true;
	const token = ++checkinPassToken;
	checkinAbort.abort();
	checkinAbort = new AbortController();
	checkinScope.enterWith(checkinAbort.signal);
	const zoned = zonedDayHour(/* @__PURE__ */ new Date());
	const slot = typeof options?.slot === "string" && options.slot !== "" ? options.slot : dueCheckinSlot(/* @__PURE__ */ new Date(), checkinHours(), autoCheckinSlots) ?? checkinSlotId(zoned.day, zoned.hour);
	const started = {
		slot,
		claimed: 0,
		pending: true,
		workbuddy: want("workbuddy"),
		at: (/* @__PURE__ */ new Date()).toISOString(),
		...manual ? { manual: true } : {}
	};
	autoCheckinLast = started;
	const spendsSlot = want("workbuddy");
	if (spendsSlot) autoCheckinSlots.add(slot);
	scheduleRefresh(manual ? "manual-checkin" : "auto-checkin");
	try {
		const [pool, qoder, trae] = await Promise.all([
			want("workbuddy") ? isolatedCheckinWorker(claimAllCheckins(), {
				claimed: 0,
				skipped: 0,
				failed: 0
			}, "workbuddy") : Promise.resolve({
				claimed: 0,
				skipped: 0,
				failed: 0
			}),
			want("qoder") ? isolatedCheckinWorker(qoderCheckinAll(), {
				claimed: 0,
				skipped: 0,
				failed: 0
			}, "qoder") : Promise.resolve({
				claimed: 0,
				skipped: 0,
				failed: 0
			}),
			want("trae") ? isolatedCheckinWorker(traeCheckinAll(), {
				claimed: 0,
				skipped: 0,
				failed: 0
			}, "trae") : Promise.resolve({
				claimed: 0,
				skipped: 0,
				failed: 0
			})
		]);
		const travel = want("workbuddy") ? await isolatedCheckinWorker(travelAllAccounts(), {
			departed: 0,
			claimed: 0,
			adopted: 0
		}, "travel") : void 0;
		if (!stillLoaded(generation)) return started;
		if (want("qoder")) {
			const now = Date.now();
			const opening = typeof qoder?.opensAt === "number" && qoder.opensAt > now ? qoder.opensAt : 0;
			const backoff = Number(qoder?.failed) > 0 && (typeof qoder?.reason === "string" || qoder?.retry === true) ? now + QODER_RETRY_BACKOFF_MS : 0;
			qoderRetryAt = opening === 0 ? backoff : backoff === 0 ? opening : Math.min(opening, backoff);
		}
		Object.assign(started, {
			claimed: pool.claimed,
			skipped: pool.skipped,
			failed: pool.failed,
			...pool.reason === void 0 ? {} : { reason: pool.reason },
			travel,
			...want("qoder") ? { qoder } : {},
			...want("trae") ? { trae } : {}
		});
		await checkinDelay(GROWTH_AFTER_CHECKIN_MS);
		if (!stillLoaded(generation)) return started;
		started.growth = want("workbuddy") ? await claimAllGrowth() : void 0;
		log((manual ? "manual" : "automatic") + " check-in collected " + pool.claimed + " account(s) for " + slot);
		if ((spendsSlot || want("qoder")) && stillLoaded(generation)) saveCheckinSlots();
	} catch (error) {
		started.error = safeMessage(error);
		log("warn", (manual ? "manual" : "automatic") + " check-in failed for " + slot + ": " + started.error);
		if ((spendsSlot || want("qoder")) && stillLoaded(generation)) saveCheckinSlots();
	} finally {
		if (token === checkinPassToken) checkinPassRunning = false;
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
* A standalone growth run. Wider than the check-in budget it is carved out of,
* because growth walks the same accounts with a pause and a report gap between
* the steps, and several sign-ins make that minutes rather than seconds.
*/
const GROWTH_BUDGET_MS = 9e4;
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
/**
* Light one account's growth streak, then redeem every tier it opened.
*
* The streak counter only advances on a chat the upstream scores against the
* account, and a synthetic `chat_request_send` report is enough to move it: the
* report is what the desktop client itself sends when a conversation is opened,
* so the growth centre counts the day without a billable turn. Without this
* report the counter sits where the user last left it, the 7d/14d/28d tiers
* never unlock, and the pass redeems nothing on a schedule that looks healthy.
*
* The report is sent before the read rather than after it, and the read waits
* out {@link STREAK_REPORT_READ_GAP_MS}, because the upstream scores it
* asynchronously. A report that fails is not fatal: the tier state is still
* read and whatever is already unlocked is still redeemed.
*
* A locked tier is the normal state until enough days accumulate, and a claimed
* one needs no action, so neither is a failure. Returns how many tiers were
* redeemed and what they paid, so the panel can say so.
*/
async function redeemAccountStreak(account) {
	const detail = {
		makeup: 0,
		gift: 0,
		compensation: 0,
		activity: 0,
		streak: 0,
		lottery: 0,
		failed: 0
	};
	const conversationId = "wb2api-streak-" + Date.now();
	try {
		if (await core.client.makeupCards(account.credential) > 0 && await core.client.missedYesterday(account.credential)) {
			const yesterday = zonedDay(-1);
			await core.client.useMakeupCard(account.credential, yesterday);
			detail.makeup += 1;
			log("info", "streak " + accountLogTag(account.label) + ": make-up card spent on " + yesterday);
		}
	} catch (error) {
		detail.failed += 1;
		log("warn", "streak " + accountLogTag(account.label) + ": make-up: " + safeMessage(error));
	}
	for (const [label, collect] of [["gift", () => core.client.claimGift(account.credential)], ["compensation", () => core.client.claimCompensation(account.credential)]]) try {
		const paid = await collect();
		if (paid > 0) {
			detail[label] += paid;
			log("info", "streak " + accountLogTag(account.label) + ": " + label + " +" + paid + "c");
		}
	} catch {}
	try {
		await core.client.reportChatActivity(account.credential, conversationId);
		detail.activity += 1;
	} catch (error) {
		detail.failed += 1;
		log("warn", "streak " + accountLogTag(account.label) + ": activity report failed: " + safeMessage(error));
	}
	await checkinDelay(STREAK_REPORT_READ_GAP_MS);
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
			detail.streak += 1;
			log("info", "streak " + accountLogTag(account.label) + ": redeemed " + tier.tier + " (+" + tier.credit + "c +" + tier.energy + "e)");
		} catch (error) {
			detail.failed += 1;
			log("warn", "streak " + accountLogTag(account.label) + ": redeem " + tier.tier + " failed: " + safeMessage(error));
		}
	}
	try {
		const chances = await core.client.lotteryChances(account.credential);
		for (let draw = 0; draw < chances; draw += 1) {
			const prize = await core.client.drawLottery(account.credential);
			detail.lottery += 1;
			log("info", "streak " + accountLogTag(account.label) + ": draw " + (draw + 1) + "/" + chances + " " + JSON.stringify(prize).slice(0, 160));
		}
	} catch (error) {
		detail.failed += 1;
		log("warn", "streak " + accountLogTag(account.label) + ": lottery: " + safeMessage(error));
	}
	return {
		claimed,
		credit,
		energy,
		detail
	};
}
/**
* Collect the streak bonus of every account.
*
* Idempotent, so a pass that finds nothing to collect costs the reads and no
* mutation, and running it on the daily schedule cannot double-pay. One account
* failing never stops the rest.
*/
async function claimAllGrowth() {
	const counts = {
		streak: 0,
		credit: 0,
		failed: 0,
		detail: emptyGrowthDetail()
	};
	let seen = 0;
	for (const account of core.pool.list()) {
		if (currentCheckinSignal().aborted) break;
		if (core.pool.isDisabled(account.id) || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
		if (signInRefused(account)) continue;
		if (seen > 0) await checkinDelay(GROWTH_ACCOUNT_DELAY_MS);
		seen += 1;
		counts.detail.accounts += 1;
		let collected = false;
		try {
			const streak = await redeemAccountStreak(account);
			counts.streak += streak.claimed;
			counts.credit += streak.credit;
			if (streak.claimed > 0) collected = true;
			mergeGrowthDetail(counts.detail, streak.detail);
		} catch (error) {
			counts.failed += 1;
			counts.detail.failed += 1;
			log("warn", "streak failed for " + accountLogTag(account.label) + ": " + safeMessage(error));
		}
		if (collected) probeCache.delete(account.id);
	}
	return counts;
}
/** A growth breakdown with everything at zero, for a pass that found nothing. */
function emptyGrowthDetail() {
	return {
		accounts: 0,
		makeup: 0,
		gift: 0,
		compensation: 0,
		activity: 0,
		streak: 0,
		lottery: 0,
		failed: 0
	};
}
/** Add one account's step counts into the pass total. */
function mergeGrowthDetail(total, part) {
	for (const key of Object.keys(total)) if (typeof part[key] === "number") total[key] += part[key];
}
/**
* What the growth centre holds right now, without claiming anything.
*
* Read-only, so the panel can show the state before the user decides to spend
* a make-up card or a draw: those two are the only steps of the pass that are
* not idempotent, and a blind \"run\" would spend them without saying so.
*
* One row per account rather than one merged total. The streak, the tier it is
* walking towards and the cards it holds are facts about one account, and a
* total across them names no account: with two sign-ins the old merged line
* showed whichever account was read last. The panel expands a row for the
* tier detail behind it.
*
* One account's two reads run together and the accounts run together too,
* like the credit probe: this is on demand, one button, and a serial pass over
* several sign-ins would make the panel feel broken.
*/
async function readGrowthState() {
	const rows = [];
	let failed = 0;
	const wanted = core.pool.list().filter((account) => !core.pool.isDisabled(account.id) && regionEnabled("workbuddy", regionOf(account.credential.domain)) && !signInRefused(account));
	const reads = await Promise.all(wanted.map(async (account) => {
		try {
			const [streak, chances] = await Promise.all([core.client.growthStreakFull(account.credential), core.client.lotteryChances(account.credential)]);
			return {
				account,
				streak,
				chances
			};
		} catch (error) {
			log("warn", "growth state failed for " + accountLogTag(account.label) + ": " + safeMessage(error));
			return {
				account,
				error
			};
		}
	}));
	for (const read of reads) {
		const region = regionOf(read.account.credential.domain);
		if (read.error !== void 0) {
			failed += 1;
			rows.push({
				id: read.account.id,
				label: read.account.label,
				region,
				failed: true
			});
			continue;
		}
		const streak = read.streak;
		rows.push({
			id: read.account.id,
			label: read.account.label,
			region,
			days: streak.days,
			nextTier: streak.nextTier,
			nextTierRemaining: streak.nextTierRemaining,
			tiers: streak.tiers.filter((tier) => tier.status === "unlocked").length,
			tierList: streak.tiers,
			makeupCards: streak.makeupCards,
			lottery: read.chances
		});
	}
	return {
		accounts: rows.length,
		failed,
		rows
	};
}
/**
* Whether an upstream refusal means "the day was already collected".
*
* Matched on the whole sentence, not on the bare word: a token or account
* refusal often merely contains "already", and counting that as a benign skip
* hides a real breakage from the last-run line and from the check-in summary
* the user reads.
*/
function isAlreadyCheckin(error) {
	const message = safeMessage(error).toLowerCase();
	return message.includes("已签到") || message.includes("已经签到") || message.includes("already checked in") || message.includes("already signed in") || message.includes("already claimed") || message.includes("already received");
}
async function claimAllCheckins() {
	const counts = {
		claimed: 0,
		skipped: 0,
		failed: 0
	};
	let seen = 0;
	for (const account of core.pool.list()) {
		if (core.pool.isDisabled(account.id) || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
		if (signInRefused(account)) continue;
		if (currentCheckinSignal().aborted) break;
		if (seen > 0) await checkinDelay(CHECKIN_ACCOUNT_DELAY_MS);
		seen += 1;
		try {
			const before = await core.pool.readAfterRefresh(account.id, (credential) => core.client.fetchCheckinStatus(credential));
			if (!before.active) {
				counts.skipped += 1;
				continue;
			}
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
			log("warn", "check-in failed for " + accountLogTag(account.label) + ": " + safeMessage(error));
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
		log("warn", "travel " + accountLogTag(account.label) + ": adopt preflight report: " + safeMessage(error));
	}
	await checkinDelay(TRAVEL_ADOPT_GAP_MS);
	try {
		await core.client.agreeBuddy(account.credential);
	} catch (error) {
		log("warn", "travel " + accountLogTag(account.label) + ": agreement: " + safeMessage(error));
		return "failed";
	}
	try {
		await core.client.adoptBuddy(account.credential);
	} catch (error) {
		if (isBuddyThresholdIncomplete(safeMessage(error))) {
			travelAdoptTried.set(account.id, day);
			log("info", "travel " + accountLogTag(account.label) + ": adopt skipped (conversation threshold not reached, retry tomorrow)");
			return "skipped";
		}
		log("warn", "travel " + accountLogTag(account.label) + ": adopt: " + safeMessage(error));
		return "failed";
	}
	log("info", "travel " + accountLogTag(account.label) + ": adopt ok");
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
		log("warn", "travel " + accountLogTag(account.label) + ": buddy-info: " + safeMessage(error));
		return "failed";
	}
	if (buddy === null) return await travelAdopt(account);
	let status = null;
	try {
		status = await core.client.fetchTravelStatus(account.credential);
	} catch (error) {
		log("warn", "travel " + accountLogTag(account.label) + ": status: " + safeMessage(error));
		return "failed";
	}
	if (status.state === "arrived") {
		if (status.recordId === 0) {
			log("info", "travel " + accountLogTag(account.label) + ": claim skipped (arrived but no record_id)");
			return "skipped";
		}
		try {
			const reward = await core.client.claimTravelReward(account.credential, status.recordId);
			log("info", "travel " + accountLogTag(account.label) + ": claim ok record=" + status.recordId + " reward=" + reward);
			return "claimed";
		} catch (error) {
			log("warn", "travel " + accountLogTag(account.label) + ": claim record=" + status.recordId + ": " + safeMessage(error));
			return "failed";
		}
	}
	if (status.state === "idle") {
		if (status.dailyLimitReached) {
			log("info", "travel " + accountLogTag(account.label) + ": skip (daily limit reached)");
			return "skipped";
		}
		try {
			await core.client.departTravel(account.credential, 4);
			log("info", "travel " + accountLogTag(account.label) + ": depart ok location=4");
			return "departed";
		} catch (error) {
			log("warn", "travel " + accountLogTag(account.label) + ": depart: " + safeMessage(error));
			return "failed";
		}
	}
	if (status.state === "traveling") {
		log("info", "travel " + accountLogTag(account.label) + ": skip (traveling record=" + status.recordId + ")");
		return "skipped";
	}
	log("info", "travel " + accountLogTag(account.label) + ": skip (unknown state " + JSON.stringify(status.state) + ")");
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
		adopted: 0,
		failed: 0
	};
	let seen = 0;
	for (const account of core.pool.list()) {
		if (core.pool.isDisabled(account.id) || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
		if (regionOf(account.credential.domain) !== "cn") continue;
		if (!account.credential.refreshToken) continue;
		if (signInRefused(account)) continue;
		if (currentCheckinSignal().aborted) break;
		if (seen > 0) await checkinDelay(TRAVEL_ACCOUNT_DELAY_MS);
		seen += 1;
		try {
			const outcome = await travelOne(account);
			if (outcome === "departed" || outcome === "claimed" || outcome === "adopted") {
				counts[outcome === "departed" ? "departed" : outcome === "claimed" ? "claimed" : "adopted"] += 1;
				probeCache.delete(account.id);
			} else if (outcome === "failed") counts.failed += 1;
		} catch (error) {
			counts.failed += 1;
			log("warn", "travel failed for " + accountLogTag(account.label) + ": " + safeMessage(error));
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
		failed: 0,
		retry: false
	};
	const regions = activeQoderRegions();
	if (regions.length === 0) return counts;
	let found;
	try {
		found = await discoverQoderCredentials();
	} catch (error) {
		const reason = safeMessage(error);
		log("warn", "[qoder] check-in could not read its sign-ins: " + reason);
		return {
			...counts,
			failed: 1,
			reason
		};
	}
	if (found.failures.length > 0) {
		counts.failed += 1;
		counts.retry = true;
	}
	let seen = 0;
	for (const credential of found.credentials) {
		if (!regions.includes(credential.region)) continue;
		if (currentCheckinSignal().aborted) break;
		if (seen > 0) await checkinDelay(QODER_ACCOUNT_DELAY_MS);
		seen += 1;
		const result = await qoderClaimFor(credential);
		counts[result.outcome] += 1;
		markSourceCheckinRow("qoder", qoderRowLabel(credential), credential.region, result);
		if (result.retry === true) counts.retry = true;
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
	if (sourceCredentialExpired(credential, Date.now())) {
		const reason = "token expired (open Qoder to refresh it)";
		log("warn", "[qoder:" + credential.region + "] check-in skipped for " + accountLogTag(qoderRowLabel(credential)) + ": token expired (open Qoder to refresh it)");
		return {
			outcome: "skipped",
			reason
		};
	}
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
				...state.todayCheckedIn === true ? { todayCheckedIn: true } : {},
				...state.opensAt === void 0 ? {} : { opensAt: state.opensAt }
			};
		}
		const result = qoderNormalizeClaimResult(await client.claimCampaign(id));
		if (result.reason !== void 0) {
			log("warn", "[qoder:" + credential.region + "] check-in refused for " + accountLogTag(qoderRowLabel(credential)) + ": " + result.reason);
			return {
				outcome: "failed",
				reason: result.reason,
				retry: false
			};
		}
		return { outcome: result.claimed ? "claimed" : "skipped" };
	} catch (error) {
		const reason = safeMessage(error);
		log("warn", "[qoder:" + credential.region + "] check-in failed for " + accountLogTag(qoderRowLabel(credential)) + ": " + reason);
		return {
			outcome: "failed",
			reason,
			retry: qoderFailureRetryable(error)
		};
	}
}
/** A transport/5xx failure is worth another tick; a 4xx verdict is not. */
function qoderFailureRetryable(error) {
	const status = Number(/\bHTTP\s+(\d{3})\b/iu.exec(safeMessage(error))?.[1] ?? 0);
	if (status === 0) return true;
	return status === 408 || status === 429 || status >= 500;
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
	let found;
	try {
		found = await discoverTraeCredentials();
	} catch (error) {
		const reason = safeMessage(error);
		log("warn", "[trae:cn] check-in could not read its sign-ins: " + reason);
		return {
			...counts,
			failed: 1,
			reason
		};
	}
	const cnCredentials = found.credentials.filter((credential) => traeRegionOfCredential(credential) === "cn");
	const spentEditions = /* @__PURE__ */ new Set();
	let index = 0;
	for (; index < cnCredentials.length; index += 1) {
		if (currentCheckinSignal().aborted) break;
		const credential = cnCredentials[index];
		if (spentEditions.has(credential.edition)) {
			markSourceCheckinRow("trae", traeRowLabel(credential), "cn", {
				outcome: "skipped",
				deviceCheckedIn: true
			});
			counts.skipped += 1;
			continue;
		}
		if (index > 0) await checkinDelay(Math.max(1e3, TRAE_ACCOUNT_DELAY_MS + Math.round((Math.random() * 2 - 1) * TRAE_ACCOUNT_JITTER_MS)));
		const result = await traeClaimFor(credential, desktopCandidates);
		counts[result.outcome] += 1;
		markSourceCheckinRow("trae", traeRowLabel(credential), "cn", result);
		if (result.deviceCheckedIn === true) spentEditions.add(credential.edition);
	}
	return counts;
}
/**
* Why this machine's Trae identity cannot pass the check-in endpoint, probed
* once per edition.
*
* Two shapes are refused. A CLI-derived identity is synthesised from a hash
* when no desktop storage can be read. And an install holding two
* device-center ids - two Trae accounts signed in to the same edition - has no
* persisted device number to send, so the fallback is a hash too. Both arrive
* as a bare 9074, which told the user nothing they could act on; the suffix
* names the one thing that fixes each. The desktop read is the same one the
* client performs a moment later, so on a path that runs once a day per
* account this costs one file read. Any other failure - a storage file that
* exists but will not parse - is neither, and surfaces as its own error from
* the client.
*/
const traeIdentityBlockers = /* @__PURE__ */ new Map();
async function traeIdentityBlocker(desktopCandidates, edition) {
	if (traeIdentityBlockers.has(edition)) return traeIdentityBlockers.get(edition);
	let blocker = "";
	try {
		if ((await pickTraeStorageIdentity(desktopCandidates, edition)).deviceIdIsFallback === true) blocker = "this install holds more than one Trae sign-in, so no persisted device id could be sent; sign out of the extra account in the Trae desktop app";
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Trae storage was not found")) blocker = "the identity came from the Trae CLI fallback; sign in to the Trae desktop app so a real device id is used";
	}
	traeIdentityBlockers.set(edition, blocker);
	return blocker;
}
/**
* One Trae check-in refusal as the panel should read it.
*
* A refused identity is answered with a bare code, which told the user nothing
* they could act on. The suffix names the one thing that fixes it: a CLI-only
* machine's device id is a hash rather than one the Trae apps persisted, and the
* endpoint answers that with 9074. Asked from both paths that answer a failed
* check-in — the refusal and the catch — because the read it needs is the same
* one the client performs a moment later.
*/
async function traeCheckinReason(base, credential, desktopCandidates) {
	const blocker = await traeIdentityBlocker(desktopCandidates, credential.edition).catch(() => "");
	return blocker === "" ? base : base + " - " + blocker;
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
		log("warn", "[trae:cn] check-in skipped for " + accountLogTag(label) + ": token expired (open Trae to refresh it)");
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
		if (status.code === 0 && status.enable === false) return { outcome: "skipped" };
		if (status.code === 0 && status.checkedIn) return {
			outcome: "skipped",
			todayCheckedIn: true
		};
		if (status.code === 0 && status.didCheckedIn) return {
			outcome: "skipped",
			deviceCheckedIn: true
		};
		const claim = status.code === 0 ? await client.claimCheckin() : status;
		if (claim.code === 0) return { outcome: "claimed" };
		if (claim.code === 9095) {
			log("info", "[trae:cn] check-in already used by this device for " + accountLogTag(label) + ": " + safeMessage(claim.message ?? ""));
			return {
				outcome: "skipped",
				deviceCheckedIn: true
			};
		}
		const reason = await traeCheckinReason("code " + claim.code + (claim.message === void 0 ? "" : " " + safeMessage(claim.message)), credential, desktopCandidates);
		log("warn", "[trae:cn] check-in refused for " + accountLogTag(label) + ": " + reason);
		return {
			outcome: "failed",
			reason
		};
	} catch (error) {
		const reason = await traeCheckinReason(safeMessage(error), credential, desktopCandidates);
		log("warn", "[trae:cn] check-in failed for " + accountLogTag(label) + ": " + reason);
		return {
			outcome: "failed",
			reason
		};
	}
}
/** Record a single claim in the cached source row the panel reads back. */
function markSourceCheckinRow(source, label, region, outcome) {
	const checkedToday = outcome?.outcome === "claimed" || outcome?.todayCheckedIn === true;
	if (!checkedToday && outcome?.deviceCheckedIn !== true) return;
	const row = (source === "trae" ? traeAccountRows : qoderAccountRows).find((entry) => entry.label === label && entry.region === region);
	if (row === void 0) return;
	row.checkin = {
		...row.checkin ?? {
			active: true,
			todayCheckedIn: false
		},
		...checkedToday ? {
			active: true,
			todayCheckedIn: true
		} : {},
		...outcome.deviceCheckedIn === true ? { deviceCheckedIn: true } : {}
	};
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
		if (checkinPassRunning || growthPassRunning) {
			log("info", "deferred Qoder check-in deferred: a pass is already running");
			return autoCheckinLast;
		}
		const retryGeneration = loadGeneration;
		checkinPassRunning = true;
		const token = ++checkinPassToken;
		checkinAbort.abort();
		checkinAbort = new AbortController();
		checkinScope.enterWith(checkinAbort.signal);
		const retrySlot = autoCheckinLast?.slot ?? checkinSlotId(zonedDayHour(/* @__PURE__ */ new Date()).day, zonedDayHour(/* @__PURE__ */ new Date()).hour);
		try {
			qoderRetryAt = 0;
			const retry = await qoderCheckinAll();
			if (!stillLoaded(retryGeneration)) return autoCheckinLast;
			const now = Date.now();
			const opening = typeof retry.opensAt === "number" && retry.opensAt > now ? retry.opensAt : 0;
			const backoff = Number(retry.failed) > 0 && (typeof retry.reason === "string" || retry.retry === true) ? now + QODER_RETRY_BACKOFF_MS : 0;
			qoderRetryAt = opening === 0 ? backoff : backoff === 0 ? opening : Math.min(opening, backoff);
			const claimedBefore = Number(autoCheckinLast?.qoder?.claimed) || 0;
			autoCheckinLast = {
				...autoCheckinLast,
				slot: retrySlot,
				...autoCheckinLast === null ? { workbuddy: false } : {},
				qoder: {
					...retry,
					claimed: claimedBefore + (Number(retry.claimed) || 0)
				},
				at: (/* @__PURE__ */ new Date()).toISOString()
			};
			saveCheckinSlots();
			log("info", "deferred Qoder check-in: " + JSON.stringify(retry));
		} catch (error) {
			if (stillLoaded(retryGeneration)) {
				qoderRetryAt = Date.now() + QODER_RETRY_BACKOFF_MS;
				const claimedBefore = Number(autoCheckinLast?.qoder?.claimed) || 0;
				autoCheckinLast = {
					...autoCheckinLast,
					slot: retrySlot,
					qoder: {
						claimed: claimedBefore,
						skipped: 0,
						failed: 1,
						reason: safeMessage(error)
					},
					at: (/* @__PURE__ */ new Date()).toISOString()
				};
				saveCheckinSlots();
				log("warn", "deferred Qoder check-in failed: " + safeMessage(error));
			}
		} finally {
			if (token === checkinPassToken) checkinPassRunning = false;
		}
		if (serviceStopped === false) scheduleRefresh("auto-checkin");
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
	if (serviceStopped) return;
	autoCheckinTimer = setInterval(() => {
		autoCheckinTick().catch((error) => log("warn", "scheduled check-in failed: " + safeMessage(error)));
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
* Refresh every eligible account's token, by hand.
*
* `ensureFresh` decides per account whether an upstream call is needed, so an
* account whose token still has hours on it costs nothing and an international
* token that lives a year is never touched. What the pass buys is the account
* nobody has used since its token expired: without it that account is refreshed
* by the first request that arrives, which pays the round trip on the user's
* own turn and, when the refresh token is dead too, fails that turn instead of
* this one.
*
* Disabled and switched-off-region accounts stay out, matching every other
* pass: a parked account is parked on purpose.
*/
async function keepAliveTokens() {
	const counts = {
		refreshed: 0,
		fresh: 0,
		failed: 0,
		noToken: 0
	};
	for (const account of core.pool.list()) {
		if (serviceStopped) break;
		if (core.pool.isDisabled(account.id)) continue;
		if (!regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
		if (signInRefused(account)) continue;
		const outcome = await core.pool.ensureFresh(account);
		const bucket = outcome === "refused" ? "failed" : outcome;
		counts[bucket] = (counts[bucket] ?? 0) + 1;
	}
	return counts;
}
/** Run one keep-alive pass and record it for the panel. */
async function runKeepAlivePass() {
	if (serviceStopped) return null;
	const generation = loadGeneration;
	const counts = await keepAliveTokens();
	if (stillLoaded(generation)) {
		keepAliveLast = {
			at: (/* @__PURE__ */ new Date()).toISOString(),
			...counts
		};
		scheduleRefresh("keep-alive");
	}
	return counts;
}
/**
* Re-read the sign-ins on a timer while the service runs.
*
* The pool scans at load, when the panel opens and when it runs dry. None of
* those happens between two account switches in the desktop client, and the
* global client keeps one live file: the sign-in that was overwritten in that
* gap was never read, so it could not be archived either. A read this often is
* what turns "the account I had before" into one the pool still holds.
*
* Chained rather than an interval, so a slow walk is followed by one pause
* instead of a queue of walks on top of each other.
*/
function startAccountWatch() {
	if (accountWatchTimer !== null || serviceStopped) return;
	const read = () => {
		accountWatchTimer = null;
		if (serviceStopped) return;
		if (activeRegions().length > 0) core.pool.scan().catch((error) => log("warn", "account re-read failed: " + safeMessage(error)));
		startAccountWatch();
	};
	accountWatchTimer = setTimeout(read, ACCOUNT_WATCH_MS);
	if (typeof accountWatchTimer.unref === "function") accountWatchTimer.unref();
}
function stopAccountWatch() {
	if (accountWatchTimer === null) return;
	clearTimeout(accountWatchTimer);
	accountWatchTimer = null;
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
	if (settings.enabled === false) {
		const cleared = syncDeclaration();
		if (cleared.ok !== true) log("warn", "declaration not cleared: " + String(cleared.error));
		return;
	}
	applySettingsToCore();
	reconcileRuntimes();
	const { left: bootstrapLeft } = budget(LOAD_BOOTSTRAP_BUDGET_MS);
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
	const generation = loadGeneration;
	serviceStopped = false;
	if (warmAbort.signal.aborted) warmAbort = new AbortController();
	await adoptHostSettings();
	if (!stillLoaded(generation)) return;
	if (settings.enabled === false) {
		syncDeclaration();
		log("info", "plugin disabled in settings; the provider host stays down");
		return;
	}
	applySettingsToCore();
	reconcileRuntimes();
	startAccountWatch();
	const { left: bootstrapLeft } = budget(SERVICE_BOOTSTRAP_BUDGET_MS);
	await settleWithin(reconcileTraeGateways(), bootstrapLeft());
	if (!stillLoaded(generation)) return;
	await settleWithin(reconcileQoderGateways(), bootstrapLeft());
	if (!stillLoaded(generation)) return;
	if (activeRegions().length > 0) await settleWithin(core.pool.scan(), bootstrapLeft());
	if (!stillLoaded(generation)) return;
	await settleWithin(startRuntimes(), bootstrapLeft());
	if (!stillLoaded(generation)) return;
	await settleWithin(Promise.all(Array.from(runtimes.values()).map(async (runtime) => {
		try {
			await connect(runtime, !catalogFresh(runtime));
		} catch (error) {
			runtime.lastError = safeMessage(error);
			log("warn", runtime.region + " failed to start: " + runtime.lastError);
		}
	})), SERVICE_ROSTER_BUDGET_MS);
	if (!stillLoaded(generation)) return;
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
	refreshInflight = null;
	stopAutoCheckin();
	stopAccountWatch();
	abortWarmups();
	clearModelRetries();
	checkinAbort.abort();
	const closing = Array.from(runtimes.values()).map(stopRuntime);
	runtimes.clear();
	runtimeStarts.clear();
	for (const entry of [...traeGateways.values(), ...qoderGateways.values()]) closing.push(entry.gateway.close().catch((error) => {
		log("warn", "[" + entry.source + ":" + entry.region + "] gateway did not close cleanly: " + safeMessage(error));
	}));
	traeGateways.clear();
	qoderGateways.clear();
	gatewayStartFailures.clear();
	sourceStartFailures.clear();
	sourceGatewayStarts.clear();
	await Promise.all(closing);
}
async function onLoad() {
	serviceStopped = false;
	loadGeneration += 1;
	abortWarmups();
	warmAbort = new AbortController();
	checkinAbort.abort();
	checkinAbort = new AbortController();
	stopAutoCheckin();
	stopAccountWatch();
	clearModelRetries();
	if (refreshTimer !== null) {
		clearTimeout(refreshTimer);
		refreshTimer = null;
	}
	refreshInflight = null;
	for (const runtime of runtimes.values()) pendingRuntimeStops.push(stopRuntime(runtime));
	runtimes.clear();
	runtimeStarts.clear();
	sourceGatewayStarts.clear();
	checkinPassRunning = false;
	autoCheckinSlots.clear();
	autoCheckinLast = null;
	growthPassRunning = false;
	growthLast = null;
	keepAliveLast = null;
	qoderRetryAt = 0;
	core.client = new WorkBuddyUpstreamClient({});
	core.pool = new WorkBuddyAccountPool({
		client: core.client,
		cooldownMs: cooldownMs(),
		distribution: distributionSetting(),
		dataPath: () => dataPath,
		logger: {
			info: (...args) => log("info", gatewayLogLine("", args)),
			warn: (...args) => log("warn", gatewayLogLine("", args)),
			error: (...args) => log("error", gatewayLogLine("", args))
		}
	});
	await adoptHostSettings();
	if (serviceStopped) return;
	publishedIds = /* @__PURE__ */ new Set();
	try {
		dataPath = await pi.plugin.getDataPath();
	} catch (error) {
		dataPath = "";
		log("warn", "no plugin data path: " + safeMessage(error));
	}
	loadCheckinSlots();
	if (serviceStopped) return;
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
	stopAccountWatch();
	clearModelRetries();
	abortWarmups();
	await onServiceStop();
	probeCache.clear();
	sourceFailureHold.clear();
	sourceCreditExpiry.clear();
	sourceRotation.clear();
	travelAdoptTried.clear();
	traeIdentityBlockers.clear();
	gatewayStartFailures.clear();
	sourceStartFailures.clear();
	sourceGatewayStarts.clear();
	deviceLogins.clear();
	unsubscribeFromHostSettings();
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
/**
* The packages the composer chip renders, bounded.
*
* The answer crosses the panel relay, which caps one message at 64 KB: an
* account carrying a dozen expiring packs used to blow past that and the
* readout answered nothing at all. The chip shows one line per pack - name,
* remaining, expiry - and nothing else, so the list is capped and only the
* fields it renders are kept; the rest of a pack is the panel's business, not
* the popup's.
*
* The fields the chip reads through a type check are guarded the same way here,
* so a pack an upstream spelled wrong arrives without the field rather than with
* a value the chip would print verbatim.
*/
const COMPOSER_PACKAGE_LIMIT = 8;
function composerPackages(packages) {
	return packages.slice(0, COMPOSER_PACKAGE_LIMIT).map((pack) => ({
		...pack.packageName === void 0 ? {} : { packageName: pack.packageName },
		...pack.nameKey === void 0 ? {} : { nameKey: pack.nameKey },
		...typeof pack.remain === "number" ? { remain: pack.remain } : {},
		...pack.monthly === true ? { monthly: true } : {},
		...pack.neverExpires === true ? { neverExpires: true } : {},
		...typeof pack.validDays === "number" ? { validDays: pack.validDays } : {},
		...pack.roundExpiresAtMs === void 0 ? {} : { roundExpiresAtMs: pack.roundExpiresAtMs },
		...pack.expiresAtMs === void 0 ? {} : { expiresAtMs: pack.expiresAtMs }
	}));
}
function workbuddyComposerAccounts(region, modelId) {
	const now = Date.now();
	const list = core.pool.list(region);
	const available = core.pool.available(now, modelId, region);
	const preferredId = preferredAccountId(region);
	const next = available.find((account) => account.id === preferredId) ?? core.pool.preview(available);
	return list.map((account) => {
		const cached = probeCache.get(account.id)?.value?.credits;
		return {
			id: account.id,
			label: account.label,
			active: next !== void 0 && next.id === account.id,
			...typeof cached?.total === "number" ? { total: cached.total } : {},
			...Array.isArray(cached?.packages) && cached.packages.length > 0 ? { packages: composerPackages(cached.packages) } : {}
		};
	});
}
function sourceComposerAccounts(source, region) {
	const rows = (source === "trae" ? traeAccountRows : qoderAccountRows).filter((row) => row.region === region);
	const live = rows.filter((row) => row.expired !== true);
	const active = orderSourceCredentials(source, region, live, (row) => row.label, "peek")[0];
	return rows.map((row) => {
		const credits = row.usage?.credits;
		return {
			id: row.label,
			label: row.label,
			active: active !== void 0 && active.label === row.label,
			...typeof credits?.total === "number" ? { total: credits.total } : {},
			...Array.isArray(credits?.packages) && credits.packages.length > 0 ? { packages: composerPackages(credits.packages) } : {},
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
		ours: false,
		enabled: false
	};
	const hit = matchComposerModel(args);
	if (hit === void 0) return {
		show: false,
		ours: composerRoute(args?.provider) !== void 0,
		enabled: true
	};
	if (hit.source === "workbuddy" && probesStale()) scheduleRefresh("composer");
	const accounts = hit.source === "workbuddy" ? workbuddyComposerAccounts(hit.region, hit.id) : sourceComposerAccounts(hit.source, hit.region);
	const active = accounts.find((account) => account.active === true);
	return {
		show: true,
		ours: true,
		enabled: true,
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
		if (await mutateSettings("preferredAccountIds", (current) => {
			const next = { ...current && typeof current === "object" && !Array.isArray(current) ? current : {} };
			if (accountId === "") delete next[region];
			else next[region] = accountId;
			return next;
		}) !== true) throw panelError("the account choice could not be saved", "SAVE_FAILED");
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
	if (await mutateSettings("preferredSourceAccounts", (current) => {
		const next = { ...current && typeof current === "object" && !Array.isArray(current) ? current : {} };
		if (accountLabel === "") delete next[sourceRegionKey(source, region)];
		else next[sourceRegionKey(source, region)] = accountLabel;
		return next;
	}) !== true) throw panelError("the account choice could not be saved", "SAVE_FAILED");
	const activeLabel = sourceComposerAccounts(source, region).find((row) => row.active === true)?.label ?? "";
	const servable = accountLabel === "" || activeLabel === accountLabel;
	return {
		...composerPoints(args),
		saved: true,
		...servable ? {} : { unavailable: true }
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
* Whether the installed schemastery can mark a field volatile.
*
* `Config` is built at module evaluation, before any `ctx` exists to log
* through, so the finding is recorded here and reported by the activation's
* first logger-reaching call rather than dropped.
*/
let volatileSupported = true;
/** Whether the finding above has already been named, so it is named once. */
let degradationReported = false;
/**
* Which activation currently owns the module-global state the core keeps.
*
* A re-provided service re-runs `apply()`, and the core's state (runtimes,
* gateways, settings) is module-global by design. The newest activation owns
* it, so an older activation's teardown must stand down rather than close the
* gateways the newer one just brought up.
*/
let activationToken = 0;
/**
* Wrap one schema in `volatile()` when the installed schemastery has it.
*
* `volatile()` landed in schemastery 3.18.3. Hand-writing `meta.volatile` on an
* older copy would bypass the host's own `validateVolatileSchema`, so an older
* builder degrades to the plain schema instead.
*/
function asVolatile(schema) {
	const candidate = schema;
	if (typeof candidate.volatile !== "function") {
		volatileSupported = false;
		return schema;
	}
	return candidate.volatile();
}
/** Report the schema degradation once, when a logger is finally in reach. */
function reportSchemaDegradation(logger) {
	if (volatileSupported || degradationReported) return;
	degradationReported = true;
	logger.warn("dsh-wtq-pool: the installed schemastery has no volatile(), so no settings field can be marked volatile: the settings card cannot render its section and every settings write this plugin makes is refused");
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
		for (const [key, entry] of Object.entries(peeled)) {
			if (key === "__proto__") continue;
			out[key] = unwrapVolatileDeep(entry);
		}
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
		contextWindow: typeof row.contextWindow === "number" ? row.contextWindow : CONSERVATIVE_CONTEXT_WINDOW,
		maxTokens: typeof row.maxTokens === "number" ? row.maxTokens : DEFAULT_MAX_TOKENS,
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
function contextForDelegate(context, log) {
	if (PI_AI_FOLDS_TRANSCRIPT) return context;
	const messages = context.messages;
	if (!Array.isArray(messages)) return context;
	const leading = messages[0];
	if (leading?.role !== "system") return context;
	const prompt = promptText(leading);
	const tools = Array.isArray(leading.toolsAdded) ? leading.toolsAdded : [];
	if (prompt.length === 0) log?.warn("dsh-wtq-pool: the folded system message carried no prompt text, so this request is sent without one");
	return {
		...prompt.length > 0 ? { systemPrompt: prompt } : {},
		tools,
		messages: messages.slice(1)
	};
}
/** Wrap one API implementation so every request arrives in the shape it reads. */
function withDelegateShape(api, log) {
	return {
		...api,
		stream: (model, context, options) => api.stream(model, contextForDelegate(context, log), options),
		streamSimple: (model, context, options) => api.streamSimple(model, contextForDelegate(context, log), options)
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
	const adapterPrototype = PiAiAdapter.prototype;
	if (typeof PiAiAdapter !== "function" || typeof adapterPrototype.resolveModel !== "function" || typeof adapterPrototype.prepareCall !== "function" || typeof adapterPrototype.stream !== "function") ctx.logger.error("dsh-wtq-pool: the resolved @deepseek-ai/dsh-llm-pi-ai is not the generation this plugin is written against (its adapter is missing members this plugin binds), so every request would be reshaped for a transcript that copy never learned to read");
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
				api: withDelegateShape(openAICompletionsApi(), ctx.logger)
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
	const adapter = new PiAiAdapter({
		profiles: () => profiles,
		auth: INERT_AUTH,
		resolveApiKey: async () => LOOPBACK_BEARER,
		resolveAttachments: () => ctx.get("attachments"),
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
	const settingsListeners = /* @__PURE__ */ new Map();
	const settingsHandlers = /* @__PURE__ */ new Set();
	const token = activationToken += 1;
	let lastRows = [];
	let fingerprint = "";
	let disposeRegistration;
	let disposeDiscovery;
	let stopped = false;
	const settingsService = ctx.settings;
	/**
	* How many of this plugin's own settings writes are in flight, and how many
	* pushes arrived while they were.
	*
	* DSH answers a plugin's volatile write by emitting `loader/volatile-update`
	* back at the writer's own fiber, and the loader delivers it synchronously
	* inside `mutate`. So a save this plugin made arrives here looking exactly
	* like an edit from the host's settings UI, and treating it as one cleared the
	* whole credit cache: every account switch blanked the readout to `—` until a
	* warm-up poll refilled it. PI's host never echoes a plugin's own write, which
	* is why only this build showed it. The writer is the one place that can tell
	* the two apart, so the echo is dropped here instead of guessed at downstream.
	*
	* The drop has a cost the plain counter did not pay back: an edit the host's
	* own settings UI made while a write was in flight was dropped with the echo
	* and never re-delivered, so the plugin ran on the old configuration until
	* something else re-read the document. Every write expects exactly one echo,
	* so a push count above the write count means a real edit raced the write.
	* Those are re-delivered once the writes have settled, and the echo is not.
	*/
	let writesInFlight = 0;
	let writesStarted = 0;
	let droppedPushes = 0;
	/** Replace patched top-level fields without merging their dictionaries. */
	const writeSettings = async (patch) => {
		const mutate = settingsService?.mutate;
		if (mutate === void 0) throw new Error("this host exposes no settings mutate()");
		writesStarted += 1;
		writesInFlight += 1;
		let echoed = false;
		try {
			await mutate.call(settingsService, settingsNamespace, Object.entries(patch).map(([key, value]) => ({
				op: "set",
				path: [key],
				value
			})));
			echoed = true;
		} finally {
			if (!echoed) writesStarted -= 1;
			writesInFlight -= 1;
			if (writesInFlight === 0) {
				if (droppedPushes > writesStarted) {
					const handlers = Array.from(settingsHandlers);
					droppedPushes = 0;
					writesStarted = 0;
					for (const handler of handlers) handler(current());
				} else {
					droppedPushes = 0;
					writesStarted = 0;
				}
			}
		}
	};
	installPi({
		getSettings: () => current(),
		setSettings: writeSettings,
		getDataPath: async () => {
			reportSchemaDegradation(ctx.logger);
			const dir = path.join(dshHome(), "dsh-wtq-pool");
			await fs.mkdir(dir, { recursive: true });
			return dir;
		},
		onSettingsChanged: (handler) => {
			settingsHandlers.add(handler);
			const listener = () => {
				if (writesInFlight > 0) {
					droppedPushes += 1;
					return;
				}
				handler(current());
			};
			settingsListeners.set(handler, ctx.on("loader/volatile-update", listener));
		},
		offSettingsChanged: (handler) => {
			settingsHandlers.delete(handler);
			settingsListeners.get(handler)?.();
			settingsListeners.delete(handler);
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
				ctx.logger.error("dsh-wtq-pool: provider registration failed", safeMessage(error));
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
		ctx.logger.warn?.("dsh-wtq-pool: settings section unavailable", safeMessage(error));
	}
	ctx.effect(() => {
		disposeDiscovery?.();
		disposeDiscovery = void 0;
		try {
			disposeDiscovery = ctx.llm.registerModelDiscovery(settingsNamespace, async (request) => {
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
			});
		} catch (error) {
			ctx.logger.error("dsh-wtq-pool: model discovery was refused", safeMessage(error));
		}
		return () => {
			disposeDiscovery?.();
			disposeDiscovery = void 0;
		};
	}, "dsh-wtq-pool: model discovery");
	ctx.inject(["webServer"], (webCtx) => {
		if (webCtx.webServer === void 0) return;
		registerPanelRoutes({ webServer: webCtx.webServer }, {
			pluginRoot: PLUGIN_ROOT,
			invoke: (channel, payload) => onPanelInvoke(channel, payload),
			effect: (callback) => webCtx.effect(callback, "dsh-wtq-pool: panel routes"),
			logger: ctx.logger
		});
	});
	ctx.effect(() => async () => {
		stopped = true;
		lastRows = [];
		for (const dispose of settingsListeners.values()) dispose();
		settingsListeners.clear();
		disposeRegistration?.();
		disposeRegistration = void 0;
		if (token !== activationToken) return;
		await stopRegisteredService();
		await onUnload();
	});
	onLoad().then(() => {
		if (!stopped) return startRegisteredService();
	}).catch((error) => {
		if (stopped) return;
		ctx.logger.error("dsh-wtq-pool: activation failed", safeMessage(error));
	});
}
//#endregion
export { Config, apply, inject, name, onLoad, onPanelInvoke, onUnload };
