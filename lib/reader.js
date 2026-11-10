// dsh-session-archiver / reader
//
// 归档会话的读取层。两件事：
//   1. 多帧 zstd 解压 —— DSH 的 jsonl 日志是边写边追加的，每追加一次就是一个
//      独立压缩帧。Node 的 zstdDecompressSync / createZstdDecompress 都只啃第一帧
//      就收工（实测 1.1 MB 只解出 285 字节，正好是会话头），所以必须按帧魔数
//      28 B5 2F FD 切开逐个解。
//   2. 在归档区里定位并检索会话。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";

/** zstd 帧魔数。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 展开 ~ 与空值。 */
export function expandHome(p) {
	if (typeof p !== "string" || p.trim() === "") return "";
	if (p === "~") return os.homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** DSH 主目录。 */
export function dshHome() {
	const env = process.env.DSH_HOME;
	if (typeof env === "string" && env.trim() !== "") return env;
	return path.join(os.homedir(), ".dsh");
}

/** 归档根目录（配置为空时用默认）。 */
export function archiveRoot(configValue) {
	const expanded = expandHome(configValue);
	if (expanded !== "") return expanded;
	return path.join(os.homedir(), "DSH-Archive");
}

/**
 * 解压多帧 zstd。逐帧尝试，遇到切错就往后找下一个魔数重试。
 * @param {Buffer} buf 原始字节
 * @returns {{ text: string, frames: number, failed: number }}
 */
export function decompressMultiFrame(buf) {
	const parts = [];
	let pos = 0;
	let frames = 0;
	let failed = 0;

	while (pos < buf.length - 4) {
		if (buf[pos] !== 0x28 || buf[pos + 1] !== 0xb5 || buf[pos + 2] !== 0x2f || buf[pos + 3] !== 0xfd) {
			const next = buf.indexOf(ZSTD_MAGIC, pos);
			if (next < 0) break;
			pos = next;
			continue;
		}

		let end = buf.indexOf(ZSTD_MAGIC, pos + 4);
		if (end < 0) end = buf.length;

		let ok = false;
		while (!ok) {
			try {
				parts.push(zlib.zstdDecompressSync(buf.subarray(pos, end)));
				frames += 1;
				ok = true;
			} catch {
				const retry = buf.indexOf(ZSTD_MAGIC, end + 4);
				if (retry < 0) {
					failed += 1;
					ok = true;
				} else {
					end = retry;
				}
			}
		}
		pos = end;
	}

	return { text: Buffer.concat(parts).toString("utf8"), frames, failed };
}

/** 读一个会话目录里的日志：默认 zstd，宿主关掉压缩时落的是明文 .jsonl。 */
export function decompressSessionDir(dir) {
	const names = fs.readdirSync(dir);
	const compressed = names.filter((f) => f.endsWith(".zstd"));
	const plain = compressed.length === 0 ? names.filter((f) => f.endsWith(".jsonl")) : [];
	const chunks = [];
	let frames = 0;
	let failed = 0;
	for (const f of compressed) {
		const r = decompressMultiFrame(fs.readFileSync(path.join(dir, f)));
		if (r.text !== "") chunks.push(r.text);
		frames += r.frames;
		failed += r.failed;
	}
	for (const f of plain) {
		try {
			const text = fs.readFileSync(path.join(dir, f), "utf8");
			if (text !== "") chunks.push(text);
		} catch {
			failed += 1;
		}
	}
	return { text: chunks.join("\n"), frames, failed, files: compressed.length + plain.length };
}

/**
 * 收集归档根目录下所有 manifest。
 * 既认顶层 manifest.json，也认旧版按批次分目录的 `<batch>/manifest.json`。
 */
export function listManifests(root) {
	const out = [];
	if (!fs.existsSync(root)) return out;

	const top = path.join(root, "manifest.json");
	if (fs.existsSync(top)) {
		try {
			const man = JSON.parse(fs.readFileSync(top, "utf8"));
			out.push({ dir: root, manifest: man });
		} catch {}
	}

	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const mf = path.join(root, entry.name, "manifest.json");
		if (!fs.existsSync(mf)) continue;
		try {
			out.push({ dir: path.join(root, entry.name), manifest: JSON.parse(fs.readFileSync(mf, "utf8")) });
		} catch {}
	}

	return out;
}

/** 汇总所有归档会话条目。 */
export function listArchivedSessions(root) {
	const items = [];
	for (const { dir, manifest } of listManifests(root)) {
		for (const s of manifest.sessions || []) {
			items.push({
				id: s.id,
				workspace: s.ws || s.workspace || "",
				bytes: s.bytes || 0,
				dir: s.to ? (path.isAbsolute(s.to) ? s.to : path.join(dir, s.to)) : "",
				batch: path.basename(dir),
				// 还原要按这两项把会话挂回原工作区；旧批次没有就留空。
				wsPath: s.wsPath || "",
				sessionId: s.sessionId || "",
			});
		}
	}
	return items.sort((a, b) => b.bytes - a.bytes);
}

/**
 * 按 id 或 id 片段定位归档会话。
 * @returns {{id:string, workspace:string, dir:string, bytes:number} | null}
 */
export function findArchivedSession(root, query) {
	const all = listArchivedSessions(root);
	const q = String(query || "").trim();
	if (q === "") return null;
	const bare = q.replace(/^session-/, "");

	return (
		all.find((x) => x.id === q) ||
		all.find((x) => x.id.replace(/^session-/, "") === bare) ||
		all.find((x) => x.id.includes(q)) ||
		all.find((x) => x.id.includes(bare)) ||
		null
	);
}

/** 把一行 jsonl 压成人类能读的一行。 */
function summarizeLine(line, maxChars = 600) {
	try {
		const o = JSON.parse(line);
		const kind = o.type || o.kind || "";

		// DSH 的正文在 data.message.content（assistant/tool）或 data.content（user）里，
		// 是 { type: "text" | "tool-call" | ... } 的数组。
		const content =
			o.data?.message?.content ??
			o.data?.content ??
			o.content ??
			o.message?.content;

		let body = "";

		if (Array.isArray(content)) {
			const texts = [];
			const tools = [];
			for (const c of content) {
				if (!c || typeof c !== "object") continue;
				if (typeof c.text === "string" && c.text !== "") texts.push(c.text);
				else if (c.type === "tool-call" || c.type === "tool_use") tools.push(c.name || "tool");
			}
			body = texts.join(" ");
			if (tools.length > 0) body = (body === "" ? "" : body + "  ") + "→ " + tools.join(", ");
		} else if (typeof content === "string") {
			body = content;
		} else if (typeof o.text === "string") {
			body = o.text;
		} else if (o.data?.arguments !== undefined) {
			body = typeof o.data.arguments === "string" ? o.data.arguments : JSON.stringify(o.data.arguments);
		}

		if (body === "") body = typeof o.data === "object" ? JSON.stringify(o.data) : line;

		const turn = o.data?.turn;
		const step = o.data?.step;
		const where = typeof turn === "number" ? " #" + turn + (typeof step === "number" ? "." + step : "") : "";

		return { kind, where, body: String(body).replace(/\s+/g, " ").slice(0, maxChars) };
	} catch {
		return { kind: "", where: "", body: line.replace(/\s+/g, " ").slice(0, maxChars) };
	}
}

/**
 * 读取归档会话内容。
 *
 * `compact: true` 只保留真正的人类/模型对话轮次（user/message、assistant/message），
 * 丢掉 tool/call、tool/result、system 等噪音——一个 60 MB 的会话能从 56,701 行
 * 压到几千行，才可能塞进上下文做总结。
 *
 * @param {string} dir 会话目录
 * @param {{ keyword?: string, limit?: number, offset?: number, compact?: boolean, maxChars?: number }} opts
 */
export function readArchivedSession(dir, opts = {}) {
	const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(500, opts.limit)) : 60;
	const offset = Number.isFinite(opts.offset) ? Math.max(0, opts.offset) : 0;
	const keyword = typeof opts.keyword === "string" ? opts.keyword.trim() : "";
	const compact = opts.compact === true;
	const maxChars = Number.isFinite(opts.maxChars)
		? Math.max(80, Math.min(4000, opts.maxChars))
		: 600;

	const { text, frames, failed, files } = decompressSessionDir(dir);
	let lines = text.split("\n").filter((l) => l.trim() !== "");
	const total = lines.length;

	if (compact) {
		lines = lines.filter(
			(l) => l.includes('"type":"user/message"') || l.includes('"type":"assistant/message"'),
		);
	}
	if (keyword !== "") lines = lines.filter((l) => l.includes(keyword));

	const slice = lines.slice(offset, offset + limit).map((l) => summarizeLine(l, maxChars));

	return {
		total,
		matched: lines.length,
		frames,
		failed,
		files,
		offset,
		compact,
		items: slice,
		hasMore: offset + limit < lines.length,
	};
}
