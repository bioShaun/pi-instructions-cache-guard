import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import guard, {
	needsFill,
	hasBlankInstructions,
	resolveConfig,
	summarizeLog,
} from "../index.ts";

const TMP = join(import.meta.dirname, "..", ".test-tmp");

function freshDir(name) {
	const dir = join(TMP, name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeCtx(provider, modelId, cwd) {
	const statuses = [];
	const notes = [];
	return {
		ctx: {
			cwd,
			model: { provider, id: modelId },
			ui: {
				setStatus: (key, text) => statuses.push([key, text]),
				notify: (text, level) => notes.push([text, level]),
			},
		},
		statuses,
		notes,
	};
}

function makePi() {
	const handlers = new Map();
	const commands = new Map();
	return {
		pi: {
			on: (name, fn) => handlers.set(name, fn),
			registerCommand: (name, options) => commands.set(name, options),
		},
		handlers,
		commands,
	};
}

function readLog(file) {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

test("版本判定只对 6.2 及以上生效", () => {
	assert.equal(needsFill("gpt-6.2-sol", [6, 2]), true);
	assert.equal(needsFill("gpt-6.2-astra", [6, 2]), true);
	assert.equal(needsFill("gpt-7-luna", [6, 2]), true);
	assert.equal(needsFill("gpt-6.1-terra", [6, 2]), false);
	assert.equal(needsFill("gpt-6-luna", [6, 2]), false);
	assert.equal(needsFill("claude-sonnet-4", [6, 2]), false);
	assert.equal(needsFill(undefined, [6, 2]), false);
});

test("空白判定与 sub2api 的 trim 语义一致", () => {
	assert.equal(hasBlankInstructions(undefined), true);
	assert.equal(hasBlankInstructions(null), true);
	assert.equal(hasBlankInstructions(""), true);
	assert.equal(hasBlankInstructions("   "), true);
	assert.equal(hasBlankInstructions("\t\n"), true);
	assert.equal(hasBlankInstructions("."), false);
	assert.equal(hasBlankInstructions("You are helpful"), false);
});

test("配置项默认值只守卫 openai，并兼容旧环境变量", () => {
	const cfg = resolveConfig({});
	assert.deepEqual([...cfg.providers], ["openai"]);
	assert.equal(cfg.fill, ".");
	assert.deepEqual(cfg.minVersion, [6, 2]);
	assert.equal(resolveConfig({ PICG_FILL_PROVIDERS: "none" }).providers.size, 0);
	assert.equal(resolveConfig({ PI_TCUNI_FILL: "N/A" }).fill, "N/A");
});

test("自定义 provider 白名单可用环境变量覆盖默认值", () => {
	const cfg = resolveConfig({ PICG_FILL_PROVIDERS: "tcuni, tcuni-luna" });
	assert.deepEqual([...cfg.providers].sort(), ["tcuni", "tcuni-luna"]);
});

test("6.2 遇到空 instructions 时补哨兵，其余请求原样放行", () => {
	const dir = freshDir("fill");
	const logFile = join(dir, "guard.jsonl");
	process.env.PICG_LOG = logFile;
	const { pi, handlers } = makePi();
	guard(pi);
	const hook = handlers.get("before_provider_request");
	const payload = { input: [{ role: "developer" }], model: "gpt-6.2-sol" };

	const { ctx } = makeCtx("openai", "gpt-6.2-sol", dir);
	assert.equal(hook({ payload }, ctx).instructions, ".");

	const { ctx: c61 } = makeCtx("openai", "gpt-6.1-terra", dir);
	assert.equal(hook({ payload }, c61), undefined);

	const { ctx: other } = makeCtx("tcuni", "gpt-6.2-sol", dir);
	assert.equal(hook({ payload }, other), undefined, "白名单外的 provider 不应被改写");

	const { ctx: filled } = makeCtx("openai", "gpt-6.2-sol", dir);
	assert.equal(hook({ payload: { ...payload, instructions: "hi" } }, filled), undefined);

	rmSync(dir, { recursive: true, force: true });
});

test("请求与用量都写入日志，并把效果显示在 footer", () => {
	const dir = freshDir("log");
	const logFile = join(dir, "guard.jsonl");
	process.env.PICG_LOG = logFile;
	const { pi, handlers } = makePi();
	guard(pi);
	const { ctx, statuses } = makeCtx("openai", "gpt-6.2-sol", dir);

	handlers.get("before_provider_request")(
		{ payload: { input: [{ role: "developer" }, { role: "user" }] } },
		ctx,
	);
	handlers.get("message_end")(
		{
			message: {
				role: "assistant",
				usage: { input: 4839, output: 120, cacheRead: 11008, cacheWrite: 0 },
			},
		},
		ctx,
	);

	const rows = readLog(logFile);
	const request = rows.find((r) => r.kind === "request");
	const usage = rows.find((r) => r.kind === "usage");
	assert.equal(request.action, "fill");
	assert.equal(request.model, "gpt-6.2-sol");
	assert.equal(request.instructionsBefore, null);
	assert.equal(usage.input, 4839);
	assert.equal(usage.cacheRead, 11008);
	assert.match(statuses.at(-1)[1], /fill/);
	assert.match(statuses.at(-1)[1], /4\.8k/);
});

test("统计命令汇总 fill 与 skip 的输入差异", () => {
	const dir = freshDir("stats");
	const logFile = join(dir, "guard.jsonl");
	const rows = [
		{ kind: "request", action: "fill", model: "gpt-6.2-sol" },
		{ kind: "usage", action: "fill", input: 4839, cacheRead: 11008 },
		{ kind: "request", action: "skip-version", model: "gpt-6.1-terra" },
		{ kind: "usage", action: "skip-version", input: 10247, cacheRead: 7040 },
	];
	writeFileSync(logFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
	process.env.PICG_LOG = logFile;

	const summary = summarizeLog(readLog(logFile));
	assert.match(summary, /已拦截注入（fill）：1 次/);
	assert.match(summary, /版本未达阈值（skip-version）：1 次/);
	assert.match(summary, /输入均值 4\.8k/);
	assert.match(summary, /输入均值 10\.2k/);

	rmSync(dir, { recursive: true, force: true });
});

test("关闭日志时既不写文件也不报错", () => {
	const dir = freshDir("off");
	const logFile = join(dir, "guard.jsonl");
	process.env.PICG_LOG = "off";
	const { pi, handlers } = makePi();
	guard(pi);
	const { ctx } = makeCtx("openai", "gpt-6.2-sol", dir);
	handlers.get("before_provider_request")({ payload: { input: [] } }, ctx);
	handlers.get("message_end")(
		{ message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } },
		ctx,
	);
	assert.deepEqual(readLog(logFile), []);
	rmSync(dir, { recursive: true, force: true });
	delete process.env.PICG_LOG;
});

test("命令输出可直接看到启用效果，并能清空日志", async () => {
	const dir = freshDir("cmd");
	const logFile = join(dir, "guard.jsonl");
	process.env.PICG_LOG = logFile;
	const { pi, commands } = makePi();
	guard(pi);
	const { ctx, notes } = makeCtx("openai", "gpt-6.2-sol", dir);
	writeFileSync(
		logFile,
		[
			{ kind: "request", action: "fill", model: "gpt-6.2-sol" },
			{ kind: "usage", action: "fill", input: 4839, cacheRead: 11008 },
		]
			.map((r) => JSON.stringify(r))
			.join("\n") + "\n",
	);

	const command = commands.get("instructions-guard");
	assert.ok(command, "应注册 /instructions-guard 命令");
	await command.handler("", ctx);
	assert.match(notes.at(-1)[0], /共 1 次请求/);
	assert.match(notes.at(-1)[0], new RegExp(logFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

	await command.handler("clear", ctx);
	assert.match(notes.at(-1)[0], /已清空/);
	assert.equal(readFileSync(logFile, "utf8"), "");
	assert.deepEqual(readLog(logFile), []);
	rmSync(dir, { recursive: true, force: true });
	delete process.env.PICG_LOG;
});
