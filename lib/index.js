// slumberpavilion（沉眠阁）
//
// ── 它解决什么 ──────────────────────────────────────────────────────────
//
// DSH 的「归档」只是给会话贴个标签：写进 storages/workspace.json 的
// archivedSessionIds 数组，归档会话不能再跑模型步骤。但它的日志仍在
// .dsh/sessions/<工作区>/<会话id>/，投影记录仍在
// .dsh/storages/session_projcache/sessions/<id>.json。
//
// 而 session_projcache 这个存储域用的是 JSON 后端，官方注释写明
// 「读写共享存储域内一致的内存状态」—— 全部记录常驻内存。所以归档
// 一百个会话，内存一个字节都不会少。
//
// 本插件做的事：检测到某个会话被归档后，把它的日志目录和投影记录
// **移动**出 DSH 的加载路径，放进 DSH-Archive。不是删除，manifest 完整
// 记录来源与去向，随时可还原。
//
// ── 为什么不用 archiveAdmission 事件 ────────────────────────────────────
//
// archiveAdmission() 是「准入查询」—— 归档前问一句「这个会话还有没有
// 没干完的活」，不是「归档发生了」的通知。所以这里改用最笨也最稳的办法：
// 盯着 workspace.json 里 archivedSessionIds 的长度变化。
//
// ── 安全 ────────────────────────────────────────────────────────────────
//
// 只在目标不存在时才移动；每一步都有 try/catch，单条失败不影响其余，
// 更不会阻断 DSH 启动。工具注册失败也只降级，归档功能照常。

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";

import {
	archiveRoot,
	dshHome,
	findArchivedSession,
	listArchivedSessions,
	listManifests,
	readArchivedSession,
} from "./reader.js";

/** 加载器诊断时显示的名字。 */
export const name = "slumber-pavilion";

/**
 * Cordis 的服务声明。没有这一行时 `ctx.tools` 一读就抛
 * 「cannot get property "tools" without inject」——原来那段注册代码把
 * 这个异常吞进了 try/catch，于是工具永远静默缺席。
 *
 * workspaceRegistry 供 archive_session 标记归档；宿主缺它时插件整体不激活，
 * 归档循环也会一起停，所以只在两者都是核心服务的前提下才这样声明。
 */
export const inject = ["tools", "workspaceRegistry"];

export const Config = z.object({
	/** 总开关。关掉后完全不干预，等同于没装。 */
	enabled: z.boolean().default(true).description("总开关。").volatile(),
	/** 归档根目录。留空 = ~/DSH-Archive。 */
	archiveRoot: z.string().default("").description("归档根目录。留空 = ~/DSH-Archive。").volatile(),
	/** 轮询间隔（毫秒）。 */
	checkIntervalMs: z
		.number()
		.default(20000)
		.description("检查 workspace.json 归档列表的间隔（毫秒）。")
		.volatile(),
	/** 是否搬走会话日志目录。 */
	moveLogs: z.boolean().default(true).description("是否移动 sessions 下的日志目录。").volatile(),
	/** 是否搬走投影缓存记录。 */
	moveProjections: z
		.boolean()
		.default(true)
		.description("是否移动 session_projcache 下的投影记录（内存收益主要来自这里）。")
		.volatile(),
});

function read(config, key, fallback) {
	const raw = config?.[key];
	const value = raw !== null && typeof raw === "object" && typeof raw.get === "function" ? raw.get() : raw;
	return value === undefined ? fallback : value;
}

function message(error) {
	return error && error.message ? error.message : String(error);
}

/** 宿主没给日志出口时的排障痕迹：%TEMP%/slumber-pavilion-diag.log。 */
function diag(message) {
	try {
		const file = path.join(os.tmpdir(), "slumber-pavilion-diag.log");
		if (fs.existsSync(file) && fs.statSync(file).size > 262144) fs.unlinkSync(file);
		fs.appendFileSync(file, new Date().toISOString() + " pid=" + process.pid + " " + message + "\n");
	} catch {}
}

/**
 * 取宿主的 defineTool。
 *
 * @deepseek-ai/dsh-tools 只跟着宿主一起打包在 app.asar 里，profile 的
 * node_modules 没有这个包 —— 所以 `await import()` 走 Node 的 ESM 解析器
 * 必然失败，工具就静默缺席了。Electron 主进程认得 asar 路径，createRequire
 * 能取到（同 profile 的 dsh-pc-pilot 就是这么做的）。
 */
function resolveDefineTool() {
	try {
		const mod = createRequire(import.meta.url)("@deepseek-ai/dsh-tools");
		const defineTool = mod?.defineTool ?? mod?.default?.defineTool;
		if (typeof defineTool === "function") return defineTool;
	} catch {}
	return null;
}

/**
 * 把简写定义（properties 里用 `required: true` 标记必填，即 defineTool 的
 * DSL）交给 defineTool；拿不到 defineTool 时就地展开成完整 JSON Schema。
 * 两条路的产物都能直接喂给 ctx.tools.register。
 */
function normalizeToolDefinition(definition, defineTool) {
	if (typeof defineTool === "function") {
		try {
			return defineTool(definition);
		} catch {}
	}

	const shorthand = definition?.parameters;
	const properties = {};
	const required = [];
	if (shorthand && typeof shorthand === "object") {
		for (const [name, spec] of Object.entries(shorthand)) {
			if (!spec || typeof spec !== "object") {
				properties[name] = spec;
				continue;
			}
			const { required: wanted, ...rest } = spec;
			properties[name] = rest;
			if (wanted === true) required.push(name);
		}
	}

	return {
		...definition,
		parameters:
			required.length > 0 ? { type: "object", properties, required } : { type: "object", properties },
	};
}

/** 递归找出 workspace.json 里所有 archivedSessionIds。 */
function collectArchivedIds(node, out = new Set(), depth = 0) {
	if (depth > 12 || node === null || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const v of node) collectArchivedIds(v, out, depth + 1);
		return out;
	}
	for (const [k, v] of Object.entries(node)) {
		if (k === "archivedSessionIds" && Array.isArray(v)) {
			for (const x of v) if (typeof x === "string" && x !== "") out.add(x);
		} else {
			collectArchivedIds(v, out, depth + 1);
		}
	}
	return out;
}

function dirSize(dir) {
	let total = 0;
	try {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, entry.name);
			try {
				total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
			} catch {}
		}
	} catch {}
	return total;
}

/** 目标是否真在某个目录里面：清单是可编辑文件，删/搬之前必须挡一下路径穿越。 */
function isInside(parent, child) {
	try {
		const p = path.resolve(parent);
		const c = path.resolve(child);
		return c === p || c.startsWith(p + path.sep);
	} catch {
		return false;
	}
}

/** 会话目录名就是会话 ID：可能是裸 UUID，也可能是 session-<UUID>。 */
const SESSION_DIR_PATTERN = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 在 .dsh/sessions 下按 ID 或片段找「还没归档」的会话。
 * 精确命中排在前面；模糊命中多于一条时由调用方拒绝执行，免得搬错。
 */
function findLiveSessions(sessionsDir, query) {
	const raw = String(query || "").trim();
	if (raw === "") return [];
	const q = raw.replace(/^session-/, "");

	let workspaceDirs = [];
	try {
		workspaceDirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const exact = [];
	const fuzzy = [];
	for (const workspace of workspaceDirs) {
		if (!workspace.isDirectory()) continue;
		const workspacePath = path.join(sessionsDir, workspace.name);

		let entries = [];
		try {
			entries = fs.readdirSync(workspacePath, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (!SESSION_DIR_PATTERN.test(entry.name)) continue;

			const bare = entry.name.replace(/^session-/, "");
			const item = {
				id: entry.name,
				workspace: workspace.name,
				dir: path.join(workspacePath, entry.name),
			};

			if (entry.name === raw || bare === q) exact.push(item);
			else if (entry.name.includes(q) || bare.includes(q)) fuzzy.push(item);
		}
	}

	return [...exact, ...fuzzy];
}

/** 宿主的会话 ID 有时带 `session-` 前缀、有时是裸 UUID，判断前先摊平。 */
function idVariants(id) {
	const raw = String(id || "").trim();
	if (raw === "") return [];
	const bare = raw.replace(/^session-/, "");
	return raw === bare ? [bare, "session-" + bare] : ["session-" + bare, bare];
}

/**
 * 归档前问宿主：这条会话记在哪个工作区、宿主用的是哪种 ID 写法。
 * 宿主一旦写工作区就会剔掉「日志已经不在盘上」的会话，所以这两项必须
 * 进清单，还原时才挂得回去。
 */
function matchWorkspace(registry, id) {
	if (!registry || typeof registry.list !== "function") return null;
	const variants = idVariants(id);
	try {
		for (const workspace of registry.list()) {
			let ids = [];
			try {
				ids = Array.from(workspace.sessionIds || []);
			} catch {
				ids = [];
			}
			for (const variant of variants) {
				if (ids.includes(variant)) return { path: String(workspace.path || ""), sessionId: variant };
			}
		}
	} catch {}
	return null;
}

/** 撤销归档标记：两种写法都试，再按宿主自己的归档集合确认，别信返回值。 */
async function clearArchiveMark(registry, id) {
	if (!registry || typeof registry.unarchiveSession !== "function") {
		return { ok: false, detail: "宿主没有 workspaceRegistry.unarchiveSession" };
	}
	const bare = String(id).replace(/^session-/, "");
	const stillArchived = () => {
		try {
			return (registry.archivedSessionIds || []).some((x) => String(x).replace(/^session-/, "") === bare);
		} catch {
			return false;
		}
	};
	let detail = "";
	for (const variant of idVariants(id)) {
		try {
			await registry.unarchiveSession(variant);
		} catch (e) {
			detail = message(e);
		}
		if (!stillArchived()) return { ok: true, detail: "" };
	}
	return { ok: false, detail: detail || "宿主的归档集合里还留着它" };
}

/** 还原后把会话挂回原工作区；宿主缺接口或校验失败时如实说明，不假装成功。 */
async function ensureWorkspaceAccounted(registry, hit) {
	if (!registry) return "⚠ 无法补回工作区归属：宿主没有 workspaceRegistry";
	const path = String(hit.wsPath || "");
	if (path === "") return "⚠ 清单里没记原工作区（旧批次条目），重启 DSH 后确认它回到列表";
	let workspace = null;
	try {
		workspace = registry.list().find((w) => String(w.path) === path) || null;
	} catch {}
	if (!workspace) return "⚠ 原工作区已不在注册表里（" + path + "）：文件已还原，重启 DSH 后到该目录重新打开";
	const variants = idVariants(hit.sessionId || hit.id);
	const accounted = () => {
		try {
			const ids = Array.from(workspace.sessionIds || []);
			return variants.some((v) => ids.includes(v));
		} catch {
			return false;
		}
	};
	if (accounted()) return "归属完好：" + path;
	if (typeof workspace.attachSession !== "function") return "⚠ 宿主不支持 attachSession：文件已还原，但工作区归属未确认";
	let detail = "";
	for (const variant of variants) {
		try {
			await workspace.attachSession(variant);
			if (accounted()) return "已挂回工作区：" + path;
			// DSH 0.2.2 首次 attach 可能只剔掉缺头索引的旧记录；同一 ID
			// 再试一次才会重读已还原的头。每次都回读 getter，不主动 detach。
			await workspace.attachSession(variant);
			if (accounted()) return "已挂回工作区：" + path;
			detail = "宿主未确认会话归属";
		} catch (e) {
			detail = message(e);
		}
	}
	return "⚠ 自动挂回失败（" + detail + "）：文件已还原，但工作区归属未确认，请重新打开原工作区检查；不保证重启可恢复";
}

function readManifest(root) {
	const file = path.join(root, "manifest.json");
	if (!fs.existsSync(file)) {
		return { version: 1, updatedAt: new Date().toISOString(), sessions: [], projcache: [] };
	}
	try {
		const man = JSON.parse(fs.readFileSync(file, "utf8"));
		man.sessions = Array.isArray(man.sessions) ? man.sessions : [];
		man.projcache = Array.isArray(man.projcache) ? man.projcache : [];
		return man;
	} catch {
		return { version: 1, updatedAt: new Date().toISOString(), sessions: [], projcache: [] };
	}
}

function writeManifest(root, man) {
	man.updatedAt = new Date().toISOString();
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(man, null, 2), "utf8");

	const lines = [
		"# DSH 归档会话索引",
		"",
		"更新时间：" + new Date().toLocaleString("zh-CN"),
		"会话数：" + man.sessions.length + "，投影记录：" + man.projcache.length,
		"",
		"| 大小 | 工作区 | 会话 ID |",
		"|---|---|---|",
	];
	for (const s of [...man.sessions].sort((a, b) => (b.bytes || 0) - (a.bytes || 0))) {
		lines.push("| " + ((s.bytes || 0) / 1048576).toFixed(1) + " MB | " + (s.ws || "") + " | " + s.id + " |");
	}
	fs.writeFileSync(path.join(root, "INDEX.md"), lines.join("\n"), "utf8");
}

export function apply(ctx, config) {
	const log = (level, msg) => {
		try {
			const logger = ctx?.logger;
			if (logger && typeof logger[level] === "function") logger[level]("[slumber-pavilion] " + msg);
			else if (level === "warn" || level === "error") console.warn("[slumber-pavilion] " + msg);
		} catch {}
	};

	let sweeping = false;
	let swept = false;

	diag("apply called; ctx.tools.register=" + typeof ctx?.tools?.register);

	/** 扫一轮：把新归档的会话搬出去。 */
	function sweep() {
		if (sweeping) return;
		if (read(config, "enabled", true) !== true) return;
		sweeping = true;
		try {
			const home = dshHome();
			const wsFile = path.join(home, "storages", "workspace.json");
			if (!fs.existsSync(wsFile)) return;

			let ws;
			try {
				ws = JSON.parse(fs.readFileSync(wsFile, "utf8"));
			} catch {
				return;
			}

			const archived = collectArchivedIds(ws);
			if (archived.size === 0) return;

			const root = archiveRoot(read(config, "archiveRoot", ""));
			const man = readManifest(root);
			const wantLogs = read(config, "moveLogs", true) === true;
			const wantProj = read(config, "moveProjections", true) === true;

			// done / doneProj 必须覆盖「顶层 + 各批次目录」的清单：老批次里的条目不在
			// 顶层 manifest.json 里，只读顶层会让它们被当成没搬过、每轮反复尝试。
			// 日志与投影分开记，两个开关才能各自独立生效。
			const done = new Set();
			const doneProj = new Set();
			for (const { manifest } of listManifests(root)) {
				for (const entry of manifest.sessions || []) {
					if (entry && typeof entry.id === "string" && entry.id !== "") done.add(entry.id);
				}
				for (const entry of manifest.projcache || []) {
					if (!entry || typeof entry.file !== "string") continue;
					doneProj.add(entry.file.replace(/\.json$/, "").replace(/^session-/, ""));
				}
			}

			const sessionsDir = path.join(home, "sessions");
			const pcDir = path.join(home, "storages", "session_projcache", "sessions");

			if (!fs.existsSync(sessionsDir)) return;

			// 空闲快路径：没有「新归档且尚未处理」的会话时，直接退出，一个目录都不扫。
			// 否则每轮都要 readdir 2000+ 个会话目录，纯属白烧 CPU。
			const pending = [...archived].filter((id) => {
				const bare = id.replace(/^session-/, "");
				const logsDone = done.has(id) || done.has(bare) || done.has("session-" + bare);
				const projDone = doneProj.has(bare);
				return (wantLogs && !logsDone) || (wantProj && !projDone);
			});
			if (pending.length === 0) return;

			let moved = 0;
			let projMoved = 0;

			for (const wsEntry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
				if (!wsEntry.isDirectory()) continue;
				const wsPath = path.join(sessionsDir, wsEntry.name);

				let inner;
				try {
					inner = fs.readdirSync(wsPath, { withFileTypes: true });
				} catch {
					continue;
				}

				for (const sess of inner) {
					if (!sess.isDirectory()) continue;
					const id = sess.name;

					const bare = id.replace(/^session-/, "");
					const isArchived =
						archived.has(id) || archived.has("session-" + bare) || archived.has(bare);
					if (!isArchived) continue;

					const logsDone = done.has(id) || done.has("session-" + bare);
					const projDone = doneProj.has(bare);
					const needLogs = wantLogs && !logsDone;
					const needProj = wantProj && !projDone;
					if (!needLogs && !needProj) continue;

					const src = path.join(wsPath, id);
					const dst = path.join(root, "sessions", wsEntry.name, id);

					try {
						if (needLogs && !fs.existsSync(dst) && fs.existsSync(src)) {
							fs.mkdirSync(path.dirname(dst), { recursive: true });
							const bytes = dirSize(src);
							// 先问清归属再搬：日志一旦离开 .dsh/sessions，宿主就再也算不出它属于谁。
							const owner = matchWorkspace(ctx?.workspaceRegistry, id);
							fs.renameSync(src, dst);
							man.sessions.push({
								id,
								ws: wsEntry.name,
								bytes,
								from: src,
								to: dst,
								wsPath: owner ? owner.path : "",
								sessionId: owner ? owner.sessionId : "",
							});
							done.add(id);
							moved += 1;
						}
					} catch (e) {
						log("warn", "移动日志失败 " + id + ": " + (e && e.message ? e.message : e));
					}

					// 投影记录才是内存收益的来源，和日志开关各自独立：只开投影也必须能搬。
					if (needProj) {
						for (const cand of [id + ".json", bare + ".json"]) {
							const p = path.join(pcDir, cand);
							if (!fs.existsSync(p)) continue;
							try {
								const pDst = path.join(root, "projcache", cand);
								if (fs.existsSync(pDst)) continue;
								fs.mkdirSync(path.dirname(pDst), { recursive: true });
								fs.renameSync(p, pDst);
								man.projcache.push({
									file: cand,
									bytes: fs.statSync(pDst).size,
									from: p,
									to: pDst,
								});
								doneProj.add(bare);
								projMoved += 1;
							} catch {}
						}
					}
				}
			}

			if (moved > 0 || projMoved > 0) {
				writeManifest(root, man);
				log("info", "已归档 " + moved + " 个会话、搬走 " + projMoved + " 份投影记录到 " + root);
			}
		} catch (e) {
			log("warn", "扫描失败: " + (e && e.message ? e.message : e));
		} finally {
			sweeping = false;
			swept = true;
		}
	}

	// 首次加载稍等再扫，避开启动高峰。
	ctx.effect(() => {
		const boot = setTimeout(() => {
			try {
				sweep();
			} catch {}
		}, 15000);

		const interval = Math.max(5000, Number(read(config, "checkIntervalMs", 20000)) || 20000);
		const timer = setInterval(() => {
			try {
				if (!swept) return;
				sweep();
			} catch {}
		}, interval);

		return () => {
			clearTimeout(boot);
			clearInterval(timer);
		};
	}, "slumber-pavilion: sweep loop");

	// ── 读取工具 ─────────────────────────────────────────────────────────
	// 取 defineTool 走 createRequire（见 resolveDefineTool 的注释），取不到就
	// 用本地展开的 ToolDefinition。全程同步，不跟加载器抢时序；注册失败只降级，
	// 不影响上面的归档功能。
	try {
		const tools = ctx.tools;
		if (!tools || typeof tools.register !== "function") {
			log("warn", "ctx.tools.register 不可用，读取工具未注册");
			diag("ctx.tools.register 不可用");
			return;
		}
		const defineTool = resolveDefineTool();
		diag("defineTool=" + (typeof defineTool === "function" ? "ok" : "null"));

		const listTool = {
			name: "archive_list",
			description:
				"列出已归档的 DSH 会话（被移出加载路径、不占内存的那些）。按体积降序，含工作区与会话 ID。",
			parameters: {
				limit: { type: "number", description: "最多返回多少条，默认 30。" },
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{ type: "text", text: String(value) }],
			},
			async execute(args) {
				const root = archiveRoot(read(config, "archiveRoot", ""));
				const all = listArchivedSessions(root);
				const limit = Math.max(1, Math.min(500, Number(args?.limit) || 30));
				if (all.length === 0) return "归档区里还没有会话。";
				const head = "归档根目录：" + root + "\n共 " + all.length + " 个会话，列出前 " + Math.min(limit, all.length) + " 个：\n";
				return (
					head +
					all
						.slice(0, limit)
						.map(
							(x, i) =>
								(i + 1) +
								". " +
								((x.bytes || 0) / 1048576).toFixed(1) +
								" MB  " +
								x.id +
								"  @" +
								x.workspace,
						)
						.join("\n")
				);
			},
		};

		const readTool = {
			name: "archive_read",
			description:
				"读取一个已归档 DSH 会话的内容。可给会话 ID（或片段）与关键词过滤。用于翻找归档里可能还有用的历史信息。",
			parameters: {
				session: { type: "string", required: true, description: "会话 ID 或其片段。" },
				keyword: { type: "string", description: "可选。只返回包含该关键词的行。" },
				limit: { type: "number", description: "最多返回多少行，默认 40。" },
				offset: { type: "number", description: "跳过前多少行，默认 0。" },
				compact: {
					type: "boolean",
					description:
						"可选。为 true 时只保留 user/assistant 对话轮次，丢掉工具调用与工具结果，用于大会话的快速通读与总结。",
				},
				maxChars: {
					type: "number",
					description: "可选。每条消息截断长度，默认 600 字符，范围 80~4000。",
				},
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{ type: "text", text: String(value) }],
			},
			async execute(args) {
				const root = archiveRoot(read(config, "archiveRoot", ""));
				const hit = findArchivedSession(root, args?.session);
				if (!hit) return "找不到这个归档会话：" + args?.session + "\n可先用 archive_list 看看有哪些。";
				const r = readArchivedSession(hit.dir, {
					keyword: args?.keyword,
					limit: args?.limit,
					offset: args?.offset,
					compact: args?.compact,
					maxChars: args?.maxChars,
				});
				const head =
					"会话 " +
					hit.id +
					"  @" +
					hit.workspace +
					"\n总行数 " +
					r.total +
					"，匹配 " +
					r.matched +
					"，压缩帧 " +
					r.frames +
					"\n" +
					"—".repeat(30) +
					"\n";
				const body = r.items
					.map((x) => (x.kind ? "[" + x.kind + "]" : "") + (x.where || "") + " " + x.body)
					.join("\n");
				return head + body + (r.hasMore ? "\n… 还有更多，用 offset 继续。" : "");
			},
		};

		const deleteTool = {
			name: "archive_delete",
			description:
				"永久删除一个已归档的 DSH 会话（日志目录 + 投影记录 + 清单条目），不可恢复，工具调用没有二次确认。配合记忆插件用于「先总结要点、再删掉原文」的清理流程。建议先用 dryRun 确认目标是哪一个。",
			parameters: {
				session: { type: "string", required: true, description: "会话 ID 或其片段。" },
				dryRun: {
					type: "boolean",
					description: "可选。为 true 时只报告将删除什么，不做任何删除。",
				},
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{ type: "text", text: String(value) }],
			},
			async execute(args) {
				const root = archiveRoot(read(config, "archiveRoot", ""));
				const hit = findArchivedSession(root, args?.session);
				if (!hit) {
					return "找不到这个归档会话：" + args?.session + "\n可先用 archive_list 看看有哪些。";
				}

				const bytes = dirSize(hit.dir);
				const mb = (bytes / 1048576).toFixed(1);

				if (!isInside(root, hit.dir)) {
					return "拒绝：清单里的目标路径不在归档根目录内，疑似被改过：\n  " + hit.dir;
				}

				const suffix = hit.id.replace(/^session-/, "");
				const projFiles = [];
				for (const { manifest } of listManifests(root)) {
					for (const p of manifest.projcache || []) {
						if (p && (p.file === hit.id + ".json" || p.file === suffix + ".json")) projFiles.push(p);
					}
				}

				if (args?.dryRun === true) {
					return (
						"将永久删除：\n" +
						"  会话   " + hit.id + "\n" +
						"  工作区 " + hit.workspace + "\n" +
						"  体积   " + mb + " MB\n" +
						"  目录   " + hit.dir + "\n" +
						"  投影   " + projFiles.length + " 个记录\n\n" +
						"确认无误后，去掉 dryRun 再调用一次。"
					);
				}

				try {
					fs.rmSync(hit.dir, { recursive: true, force: true });
				} catch (e) {
					return "删除失败：" + (e && e.message ? e.message : e);
				}

				for (const p of projFiles) {
					try {
						if (p.to && isInside(root, p.to) && fs.existsSync(p.to)) fs.rmSync(p.to, { force: true });
					} catch {}
				}

				// 顺手撤销 DSH 的归档标记，否则这个 id 会一直挂在 archivedSessionIds 里。
				let unarchived = false;
				try {
					unarchived = (await clearArchiveMark(ctx.workspaceRegistry, hit.id)).ok;
				} catch {}

				let cleared = 0;
				for (const { dir: batchDir, manifest } of listManifests(root)) {
					const before = manifest.sessions.length;
					manifest.sessions = manifest.sessions.filter((s) => s.id !== hit.id);
					const removed = before - manifest.sessions.length;
					const beforeProj = (manifest.projcache || []).length;
					manifest.projcache = (manifest.projcache || []).filter(
						(p) => !(p && (p.file === hit.id + ".json" || p.file === suffix + ".json")),
					);
					const removedProj = beforeProj - manifest.projcache.length;
					if (removed > 0 || removedProj > 0) {
						writeManifest(batchDir, manifest);
						cleared += removed + removedProj;
					}
				}

				return (
					"已永久删除 " + hit.id + "，释放约 " + mb + " MB。清单条目清理 " + cleared + " 条。" +
					(unarchived ? "归档标记已撤销。" : "归档标记未撤销（宿主没提供 unarchiveSession）。")
				);
			},
		};

		const archiveTool = {
			name: "archive_session",
			description:
				"归档一个还没归档的会话：先在 DSH 里标记归档（走 workspaceRegistry，需要的话顺带停掉它的工作），再立刻搬到归档区，不用等后台扫描。会话 ID 或唯一片段都可以；模糊命中多条时会拒绝执行并列出候选。dryRun 只报告不动作。",
			parameters: {
				session: { type: "string", required: true, description: "会话 ID 或其唯一片段。" },
				dryRun: {
					type: "boolean",
					description: "可选。为 true 时只报告将归档哪个会话，不做任何改动。",
				},
				stopActivity: {
					type: "boolean",
					description: "可选。为 true 时连正在跑的会话也归档（会请求停掉它的工作）；默认拒绝对活跃会话动手。",
				},
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{ type: "text", text: String(value) }],
			},
			async execute(args, exec) {
				const root = archiveRoot(read(config, "archiveRoot", ""));
				const home = dshHome();
				const matches = findLiveSessions(path.join(home, "sessions"), args?.session);

				if (matches.length === 0) {
					const already = findArchivedSession(root, args?.session);
					return already
						? "这个会话已经在归档区了：" + already.id + "\n用 archive_read / archive_list 看它。"
						: "找不到这个未归档会话：" + args?.session + "\n（已归档的用 archive_list 查）";
				}
				if (matches.length > 1) {
					return (
						"匹配到 " +
						matches.length +
						" 个会话，请给更长更精确的片段：\n" +
						matches
							.slice(0, 20)
							.map((x) => "  " + x.id + "  @" + x.workspace + "  " + (dirSize(x.dir) / 1048576).toFixed(1) + " MB")
							.join("\n")
					);
				}

				const hit = matches[0];
				const bytes = dirSize(hit.dir);
				const mb = (bytes / 1048576).toFixed(1);

				if (exec?.agent?.id && idVariants(exec.agent.id).some((v) => idVariants(hit.id).includes(v))) {
					return "拒绝：这条会话正在执行当前对话，归档它会把自己停掉。";
				}

				if (args?.dryRun === true) {
					return (
						"将归档：\n" +
						"  会话   " + hit.id + "\n" +
						"  工作区 " + hit.workspace + "\n" +
						"  体积   " + mb + " MB\n" +
						"  目录   " + hit.dir + "\n\n" +
						"确认无误后，去掉 dryRun 再调用一次。"
					);
				}

				const registry = ctx.workspaceRegistry;
				if (!registry || typeof registry.archiveSession !== "function") {
					return "宿主没有 workspaceRegistry.archiveSession，无法标记归档；可以继续用手动搬目录的方式。";
				}

				try {
					await registry.archiveSession(
						hit.id,
						args?.stopActivity === true ? { stopActivity: true } : {},
					);
				} catch (e) {
					return (
						"标记归档失败：" +
						message(e) +
						"\n如果它正在跑，确认要停就加 stopActivity=true 再来一次。"
					);
				}

				// 标记已落盘，立刻扫一轮把文件搬走，不等 20 秒轮询。
				try {
					sweep();
				} catch {}

				const moved = listArchivedSessions(root).find((x) => x.id === hit.id);
				if (moved) {
					return (
						"已归档并搬走：" + hit.id + "\n" +
						"  工作区 " + hit.workspace + "\n" +
						"  体积   " + mb + " MB\n" +
						"  目录   " + moved.dir + "\n" +
						"  归属   " + (moved.wsPath ? "已记录 " + moved.wsPath : "未取到（宿主没给），还原时可能挂不回工作区") + "\n" +
						"  内存   投影记录已离开磁盘加载路径，要完全退出并重启 DSH 才真正释放。"
					);
				}

				return (
					"已在 DSH 里标记归档：" + hit.id + "\n" +
					"文件这次没搬（归档开关关闭或扫描跳过）。后台扫描会在下次运行时搬走；" +
					"也可以用 archive_list 复查。"
				);
			},
		};

		const restoreTool = {
			name: "archive_restore",
			description:
				"还原一个已归档的会话：把日志目录与投影记录搬回 .dsh，撤销 DSH 的归档标记，并清掉清单条目。会话 ID 或唯一片段都可以；dryRun 只报告不动作。",
			parameters: {
				session: { type: "string", required: true, description: "会话 ID 或其唯一片段。" },
				dryRun: {
					type: "boolean",
					description: "可选。为 true 时只报告将还原到哪个目录，不做任何改动。",
				},
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{ type: "text", text: String(value) }],
			},
			async execute(args) {
				const root = archiveRoot(read(config, "archiveRoot", ""));
				const hit = findArchivedSession(root, args?.session);
				if (!hit) {
					return "归档区里没有这个会话：" + args?.session + "\n先用 archive_list 看看有哪些。";
				}

				// 找到承载它的那份清单（批次目录或顶层）
				let owner = null;
				for (const { dir, manifest } of listManifests(root)) {
					const entry = (manifest.sessions || []).find((s) => s.id === hit.id);
					if (entry) {
						owner = { dir, manifest, entry };
						break;
					}
				}

				const bytes = dirSize(hit.dir);
				const mb = (bytes / 1048576).toFixed(1);
				const home = dshHome();
				const suffix = hit.id.replace(/^session-/, "");
				const projFiles = ((owner && owner.manifest.projcache) || []).filter(
					(p) => p && (p.file === hit.id + ".json" || p.file === suffix + ".json"),
				);

				const sessionsRoot = path.join(home, "sessions");
				const original = (owner && owner.entry && owner.entry.from) || "";
				// 清单是可编辑文件，还原只允许落到 .dsh/sessions 里面。
				const target =
					typeof original === "string" && original !== "" && isInside(sessionsRoot, original)
						? original
						: path.join(sessionsRoot, hit.workspace, hit.id);

				if (!isInside(sessionsRoot, target)) {
					return "拒绝：清单里记录的原路径不在 .dsh/sessions 内，疑似被改过：\n  " + target;
				}

				if (args?.dryRun === true) {
					return (
						"将还原：\n" +
						"  会话   " + hit.id + "\n" +
						"  工作区 " + hit.workspace + "\n" +
						"  体积   " + mb + " MB\n" +
						"  来源   " + hit.dir + "\n" +
						"  去向   " + target + "\n" +
						"  投影   " + projFiles.length + " 个记录\n" +
						"  清单   " + (owner ? owner.dir : "(找不到，只搬文件)") + "\n\n" +
						"确认无误后，去掉 dryRun 再调用一次。"
					);
				}

				if (fs.existsSync(target)) {
					return (
						"目标位置已经有同名目录，先确认是不是重复还原：\n  " +
						target +
						"\n如果那是残留，手动确认后再来。"
					);
				}

				try {
					fs.mkdirSync(path.dirname(target), { recursive: true });
					fs.renameSync(hit.dir, target);
				} catch (e) {
					return "搬回失败：" + message(e);
				}

				let restoredProj = 0;
				for (const p of projFiles) {
					try {
						if (!p.to || !fs.existsSync(p.to)) continue;
						if (p.from && fs.existsSync(p.from)) continue;
						fs.mkdirSync(path.dirname(p.from), { recursive: true });
						fs.renameSync(p.to, p.from);
						restoredProj += 1;
					} catch {}
				}

				const registry = ctx.workspaceRegistry;
				// 宿主对 ID 的写法不统一，撤销与挂回都按两种写法各试一次再说结果。
				const cleared = await clearArchiveMark(registry, hit.id);
				const accounted = await ensureWorkspaceAccounted(registry, hit);

				if (owner) {
					owner.manifest.sessions = (owner.manifest.sessions || []).filter((s) => s.id !== hit.id);
					owner.manifest.projcache = (owner.manifest.projcache || []).filter(
						(p) => !projFiles.some((x) => x.file === (p && p.file)),
					);
					try {
						writeManifest(owner.dir, owner.manifest);
					} catch {}
				}

				const head =
					"已还原：" + hit.id + "\n" +
					"  工作区 " + hit.workspace + "\n" +
					"  体积   " + mb + " MB\n" +
					"  目录   " + target + "\n" +
					"  投影   " + restoredProj + "/" + projFiles.length + " 个已搬回\n" +
					"  清单   " + (owner ? "已清理" : "未找到，跳过") + "\n" +
					"  归属   " + accounted + "\n";

				return cleared.ok
					? head + "  DSH 归档标记已撤销。"
					: head + "  ⚠ DSH 归档标记没撤销（" + cleared.detail + "）；请在界面里取消归档，否则它仍算已归档。";
			},
		};

		const definitions = [listTool, readTool, deleteTool, archiveTool, restoreTool].map((definition) =>
			normalizeToolDefinition(definition, defineTool),
		);
		ctx.effect(() => {
			const disposers = [];
			for (const definition of definitions) {
				try {
					disposers.push(tools.register(definition));
					diag("registered " + definition.name);
				} catch (e) {
					log("warn", "注册 " + definition.name + " 失败：" + message(e));
					diag("register failed " + definition.name + ": " + message(e));
				}
			}
			return () => {
				for (const dispose of disposers) {
					try {
						if (typeof dispose === "function") dispose();
					} catch {}
				}
			};
		}, "slumber-pavilion: archive tools");
		log(
			"info",
			"读取工具已注册：archive_list / archive_read / archive_session / archive_restore / archive_delete（" +
				(defineTool ? "defineTool" : "本地兜底定义") +
				"）",
		);
	} catch (e) {
		log("warn", "读取工具注册失败: " + message(e));
		diag("registration block failed: " + message(e));
	}
}
