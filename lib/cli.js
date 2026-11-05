#!/usr/bin/env node
// 归档会话的命令行入口。不依赖 DSH 运行时，任何 node 都能跑。
//
//   node lib/cli.js list [条数]
//   node lib/cli.js read <会话ID或片段> [关键词] [行数]
//   node lib/cli.js info <会话ID或片段>

import path from "node:path";
import { archiveRoot, findArchivedSession, listArchivedSessions, readArchivedSession } from "./reader.js";

const [, , cmd = "list", a1, a2, a3] = process.argv;
const ROOT = archiveRoot(process.env.DSH_ARCHIVE_ROOT || "");

function mb(n) {
	return ((n || 0) / 1048576).toFixed(1);
}

if (cmd === "list") {
	const all = listArchivedSessions(ROOT);
	const limit = Math.max(1, Math.min(500, Number(a1) || 30));
	console.log("归档根目录：" + ROOT);
	console.log("共 " + all.length + " 个会话，列出前 " + Math.min(limit, all.length) + " 个：\n");
	for (const [i, x] of all.slice(0, limit).entries()) {
		console.log(String(i + 1).padStart(3) + ". " + mb(x.bytes).padStart(8) + " MB  " + x.id + "  @" + x.workspace);
	}
} else if (cmd === "info") {
	const hit = findArchivedSession(ROOT, a1);
	if (!hit) {
		console.log("找不到：" + a1);
		process.exit(1);
	}
	const r = readArchivedSession(hit.dir, { limit: 1 });
	console.log("会话：" + hit.id);
	console.log("工作区：" + hit.workspace);
	console.log("体积：" + mb(hit.bytes) + " MB");
	console.log("目录：" + hit.dir);
	console.log("总行数：" + r.total + "，压缩帧：" + r.frames);
} else if (cmd === "read") {
	const hit = findArchivedSession(ROOT, a1);
	if (!hit) {
		console.log("找不到：" + a1 + "\n先用 list 看看有哪些。");
		process.exit(1);
	}
	const keyword = a2 && a2 !== "-" ? a2 : "";
	const limit = Number(a3) || 40;
	const r = readArchivedSession(hit.dir, { keyword, limit });

	console.log("会话 " + hit.id + "  @" + hit.workspace);
	console.log("总行数 " + r.total + "，匹配 " + r.matched + "，压缩帧 " + r.frames);
	console.log("-".repeat(50));
	for (const x of r.items) {
		const tag = (x.kind ? "[" + x.kind + "]" : "") + (x.where || "");
		console.log(tag + " " + x.body);
	}
	if (r.hasMore) console.log("… 还有更多，加大行数或用关键词过滤。");
} else {
	console.log("用法:");
	console.log("  node lib/cli.js list [条数]");
	console.log("  node lib/cli.js read <会话ID或片段> [关键词| - ] [行数]");
	console.log("  node lib/cli.js info <会话ID或片段>");
}
