import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";

const archivedId = "session-11111111-1111-4111-8111-111111111111";
const liveId = "22222222-2222-4222-8222-222222222222";

function fixture(t, config = {}) {
	const temporaryParent = path.resolve(os.tmpdir());
	const root = fs.mkdtempSync(path.join(temporaryParent, "slumberpavilion-test-"));
	const home = path.join(root, ".dsh");
	const archive = path.join(root, "DSH-Archive");
	const workspace = path.join(home, "storages", "workspace.json");
	const previousHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	t.mock.method(os, "homedir", () => root);
	t.mock.method(os, "tmpdir", () => root);
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const write = (file, text) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
	};
	const logs = (id) => path.join(home, "sessions", "fixture", id);
	const projection = (id) => path.join(home, "storages", "session_projcache", "sessions", id + ".json");
	for (const id of [archivedId, liveId]) {
		write(path.join(logs(id), "session.v4.jsonl"), JSON.stringify({ fixture: id }) + "\n");
		write(projection(id), JSON.stringify({ fixture: id }));
	}
	write(workspace, JSON.stringify({ fixture: { archivedSessionIds: [archivedId] } }));
	const tools = new Map();
	const disposers = [];
	const warnings = [];
	const unarchived = [];
	const attached = [];
	const archivedIds = [archivedId];
	const workspacePath = path.join(root, "workspace");
	fs.mkdirSync(workspacePath, { recursive: true });
	const workspaceEntity = {
		path: workspacePath,
		sessionIds: [archivedId],
		async attachSession(id) {
			attached.push(id);
			if (!this.sessionIds.includes(id)) this.sessionIds.push(id);
		},
	};
	t.after(() => {
		for (const dispose of disposers.reverse()) dispose?.();
		if (previousHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previousHome;
		// Only remove the directory just created by mkdtemp, never a user session path.
		assert.equal(path.dirname(path.resolve(root)), temporaryParent);
		assert.equal(path.basename(root).startsWith("slumberpavilion-test-"), true);
		fs.rmSync(root, { recursive: true, force: true });
	});
	apply({
		effect(fn) { disposers.push(fn()); },
		logger: { info() {}, warn(value) { warnings.push(value); } },
		tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
		workspaceRegistry: {
			async unarchiveSession(id) {
				const at = archivedIds.indexOf(id);
				if (at >= 0) archivedIds.splice(at, 1);
				unarchived.push(id);
			},
			get archivedSessionIds() { return archivedIds; },
			list() { return [workspaceEntity]; },
		},
	}, config);
	return {
		home, archive, logs, projection, tools, warnings, unarchived, attached, archivedIds,
		workspace: workspaceEntity,
		manifest: () => JSON.parse(fs.readFileSync(path.join(archive, "manifest.json"), "utf8")),
	};
}

for (const [moveLogs, moveProjections] of [[false, true], [true, false], [true, true], [false, false]]) {
	test(`internal movement flags are independent: logs=${moveLogs}, projections=${moveProjections}`, (t) => {
		const f = fixture(t, { moveLogs, moveProjections });
		t.mock.timers.tick(15000);
		assert.equal(fs.existsSync(f.logs(archivedId)), !moveLogs);
		assert.equal(fs.existsSync(f.projection(archivedId)), !moveProjections);
		assert.equal(fs.existsSync(path.join(f.archive, "sessions", "fixture", archivedId)), moveLogs);
		assert.equal(fs.existsSync(path.join(f.archive, "projcache", archivedId + ".json")), moveProjections);
		assert.equal(fs.existsSync(f.logs(liveId)), true);
		assert.equal(fs.existsSync(f.projection(liveId)), true);
		if (moveLogs || moveProjections) {
			assert.equal(f.manifest().sessions.length, Number(moveLogs));
			assert.equal(f.manifest().projcache.length, Number(moveProjections));
			// A second poll must not duplicate manifest entries or warn.
			t.mock.timers.tick(20000);
			assert.equal(f.manifest().sessions.length, Number(moveLogs));
			assert.equal(f.manifest().projcache.length, Number(moveProjections));
		}
		assert.deepEqual(f.warnings, []);
	});
}

test("defaults wait 15 seconds, move only archived sessions and register five tools", (t) => {
	const f = fixture(t);
	assert.equal(f.tools.size, 5);
	t.mock.timers.tick(14999);
	assert.equal(fs.existsSync(f.logs(archivedId)), true);
	t.mock.timers.tick(1);
	assert.equal(fs.existsSync(f.logs(archivedId)), false);
	assert.equal(fs.existsSync(f.projection(archivedId)), false);
	assert.equal(fs.existsSync(f.logs(liveId)), true);
	assert.equal(fs.existsSync(f.projection(liveId)), true);
	assert.equal(f.manifest().sessions[0].from, f.logs(archivedId));
	assert.equal(f.manifest().projcache[0].from, f.projection(archivedId));
});

test("restore dryRun preserves fixtures; restore returns files and clears the manifest", async (t) => {
	const f = fixture(t);
	t.mock.timers.tick(15000);
	const restore = f.tools.get("archive_restore");
	await restore.execute({ session: archivedId, dryRun: true });
	assert.equal(fs.existsSync(f.logs(archivedId)), false);
	assert.equal(f.manifest().sessions.length, 1);
	assert.deepEqual(f.unarchived, []);
	await restore.execute({ session: archivedId });
	assert.equal(fs.existsSync(f.logs(archivedId)), true);
	assert.equal(fs.existsSync(f.projection(archivedId)), true);
	assert.deepEqual(f.unarchived, [archivedId]);
	assert.equal(f.manifest().sessions.length, 0);
	assert.equal(f.manifest().projcache.length, 0);
});

test("delete dryRun is read-only; one subsequent call deletes archived fixtures without a second confirmation", async (t) => {
	const f = fixture(t);
	t.mock.timers.tick(15000);
	const remove = f.tools.get("archive_delete");
	const archivedLogs = path.join(f.archive, "sessions", "fixture", archivedId);
	const archivedProjection = path.join(f.archive, "projcache", archivedId + ".json");
	await remove.execute({ session: archivedId, dryRun: true });
	assert.equal(fs.existsSync(archivedLogs), true);
	assert.equal(fs.existsSync(archivedProjection), true);
	assert.equal(f.manifest().sessions.length, 1);
	await remove.execute({ session: archivedId });
	assert.equal(fs.existsSync(archivedLogs), false);
	assert.equal(fs.existsSync(archivedProjection), false);
	assert.equal(f.manifest().sessions.length, 0);
	assert.equal(f.manifest().projcache.length, 0);
	assert.equal(fs.existsSync(f.logs(liveId)), true);
});

test("archive_read reads an uncompressed .jsonl archive instead of requiring .zstd", async (t) => {
	const f = fixture(t);
	t.mock.timers.tick(15000);
	const output = await f.tools.get("archive_read").execute({ session: archivedId });
	assert.equal(output.includes(archivedId), true);
});

test("the self-archive guard matches one conversation across the session- spelling", async (t) => {
	const f = fixture(t);
	t.mock.timers.tick(15000);
	const output = await f.tools
		.get("archive_session")
		.execute({ session: liveId }, { agent: { id: "session-" + liveId } });
	assert.equal(output.startsWith("拒绝："), true);
	assert.equal(fs.existsSync(f.logs(liveId)), true);
});

test("archiving records the owning workspace so restore can re-attach a dropped session", async (t) => {
	const f = fixture(t);
	t.mock.timers.tick(15000);
	assert.equal(f.manifest().sessions[0].wsPath, f.workspace.path);
	assert.equal(f.manifest().sessions[0].sessionId, archivedId);
	// 宿主只要写过一次工作区，就会剔掉日志已不在盘上的会话。
	f.workspace.sessionIds = [];
	const output = await f.tools.get("archive_restore").execute({ session: archivedId });
	assert.deepEqual(f.attached, [archivedId]);
	assert.equal(output.includes("已挂回工作区：" + f.workspace.path), true);
	// 归档标记按宿主的 ID 写法撤销，撤销后归档集合里不再有它。
	assert.equal(f.archivedIds.length, 0);
});

test("restore reindexes a raw workspace member hidden by the restarted host header index", async (t) => {
	const f = fixture(t);
	t.mock.timers.tick(15000);
	// The archive mark may already have been cleared without rewriting the workspace record.
	f.archivedIds.length = 0;
	let recorded = [archivedId];
	const indexed = new Set();
	const attempts = [];
	Object.defineProperty(f.workspace, "sessionIds", {
		configurable: true,
		get() { return recorded.filter((id) => indexed.has(id)); },
	});
	t.mock.method(f.workspace, "attachSession", async (id) => {
		attempts.push(id);
		// DSH 0.2.2-rc.1 skips the header read for a raw record member, then
		// mutate() removes IDs absent from the canonical-cwd header index.
		if (!recorded.includes(id)) {
			if (!fs.existsSync(f.logs(id))) throw new Error("session header missing");
			indexed.add(id);
			recorded.push(id);
		}
		recorded = recorded.filter((value) => indexed.has(value));
	});
	const output = await f.tools.get("archive_restore").execute({ session: archivedId });
	assert.deepEqual(f.workspace.sessionIds, [archivedId]);
	assert.deepEqual(attempts, [archivedId, archivedId]);
	assert.equal(output.includes("已挂回工作区：" + f.workspace.path), true);
});

test("restore does not report workspace success when attach resolves without visible membership", async (t) => {
	const f = fixture(t);
	t.mock.timers.tick(15000);
	f.workspace.sessionIds = [];
	t.mock.method(f.workspace, "attachSession", async () => {});
	const output = await f.tools.get("archive_restore").execute({ session: archivedId });
	assert.equal(output.includes("已挂回工作区："), false);
	assert.equal(output.includes("⚠"), true);
	assert.equal(output.includes("宿主未确认会话归属"), true);
	assert.equal(fs.existsSync(f.logs(archivedId)), true);
});
