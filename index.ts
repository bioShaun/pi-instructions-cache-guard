/**
 * pi-instructions-cache-guard：阻止 Responses 网关注入默认 instructions，保住 OpenAI 系模型的 prompt cache。
 *
 * 背景：GPT-6.2 起，顶层 `instructions` 不参与 prompt cache。像 sub2api 这类网关在
 * `instructions` 去除空白后为空时，会注入数万字符的默认 Codex 指令，这段内容于是每轮
 * 都按未缓存输入计费。Pi 的 `openai-responses` 本来就把系统提示词放在 `input` 首条
 * `developer` 消息里，所以只需让该字段非空即可阻止注入，正文继续留在可缓存的位置。
 *
 * Public API:
 * - default：Pi 扩展入口，注册 `before_provider_request`、`message_end` 与 `/instructions-guard` 命令
 * - resolveConfig：解析环境变量配置（含旧 PI_TCUNI_FILL_* 兼容名）
 * - needsFill / hasBlankInstructions：模型版本与字段空值判定
 * - summarizeLog：把 JSONL 日志汇总成可读文本
 * Related:
 * - Pi 扩展钩子 `before_provider_request`（改写请求体）、`message_end`（读取 usage）
 * - sub2api `applyInstructions`（trim 后为空即注入）、OpenAI Responses 缓存行为
 *
 * 默认只守卫 provider 名为 `openai` 的请求；把网关配成自定义 provider 名（如 `tcuni`）时，
 * 用 `PICG_FILL_PROVIDERS` 指定白名单。
 */
import { appendFileSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_PROVIDERS = "openai";
const DEFAULT_FILL = ".";
const DEFAULT_MODELS = "^gpt-(\\d+)(?:\\.(\\d+))?";
const DEFAULT_MIN_VERSION = "6.2";
const DEFAULT_LOG = join(homedir(), ".pi", "agent", "logs", "instructions-cache-guard.jsonl");
const DEFAULT_DISPLAY: Display = "both";
const DEFAULT_WIDGET_TTL = 10000;
const STATUS_KEY = "instructions-cache-guard";

export interface GuardConfig {
	providers: Set<string>;
	fill: string;
	modelPattern: RegExp;
	minVersion: [number, number];
	logPath: string;
	/** 展示方式：footer 状态、编辑器上方 widget、两者、或关闭。 */
	display: Display;
	/** widget 自动清除的毫秒数，0 表示常驻。 */
	widgetTtl: number;
	/** display 是否启用（保留旧字段语义）。 */
	status: boolean;
	/** 写入 UI 调用结果，用于排查状态行不显示的问题。 */
	debug: boolean;
}

export type Display = "status" | "widget" | "both" | "notify" | "off";

const DISPLAYS: readonly Display[] = ["status", "widget", "both", "notify", "off"];

/** 读取环境变量，优先新名字，其次旧名字（PI_TCUNI_FILL_*），便于平滑升级。 */
function env(envs: Record<string, string | undefined>, name: string, legacy?: string): string | undefined {
	const value = envs[name];
	if (value !== undefined && value !== "") return value;
	if (legacy) {
		const old = envs[legacy];
		if (old !== undefined && old !== "") return old;
	}
	return undefined;
}

function parseVersion(text: string): [number, number] {
	const [major, minor = "0"] = text.split(".");
	return [Number(major) || 0, Number(minor) || 0];
}

/** 从环境变量解析配置。每次请求重新求值，方便运行中调整而不用改代码。 */
export function resolveConfig(envs: Record<string, string | undefined> = process.env): GuardConfig {
	const providerList = env(envs, "PICG_FILL_PROVIDERS", "PI_TCUNI_FILL_PROVIDERS") ?? DEFAULT_PROVIDERS;
	const providers =
		providerList.trim() === "none"
			? new Set<string>()
			: new Set(
					providerList
						.split(",")
						.map((item) => item.trim())
						.filter((item) => item !== ""),
				);
	const logSetting = env(envs, "PICG_LOG", "PI_TCUNI_FILL_DEBUG") ?? DEFAULT_LOG;
	const rawDisplay = env(envs, "PICG_DISPLAY");
	const display: Display = (env(envs, "PICG_STATUS") ?? "on") === "off"
		? "off"
		: DISPLAYS.includes(rawDisplay as Display)
			? (rawDisplay as Display)
			: DEFAULT_DISPLAY;
	return {
		providers,
		fill: env(envs, "PICG_FILL", "PI_TCUNI_FILL") ?? DEFAULT_FILL,
		modelPattern: new RegExp(env(envs, "PICG_MODELS", "PI_TCUNI_FILL_MODELS") ?? DEFAULT_MODELS),
		minVersion: parseVersion(env(envs, "PICG_MIN_VERSION") ?? DEFAULT_MIN_VERSION),
		logPath: logSetting,
		display,
		widgetTtl: Math.max(0, Number(env(envs, "PICG_WIDGET_TTL") ?? DEFAULT_WIDGET_TTL) || 0),
		status: display !== "off",
		debug: (env(envs, "PICG_DEBUG") ?? "") === "1",
	};
}

/** 模型版本是否达到需要拦截的最低版本（如 gpt-6.2-sol / gpt-6.2-astra）。 */
export function needsFill(modelId: string | undefined, minVersion: [number, number], pattern?: RegExp): boolean {
	const match = (pattern ?? new RegExp(DEFAULT_MODELS)).exec(modelId ?? "");
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2] ?? 0);
	if (major !== minVersion[0]) return major > minVersion[0];
	return minor >= minVersion[1];
}

/** 与 sub2api 一致：undefined / null / 纯空白都算“未提供”。 */
export function hasBlankInstructions(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	return String(value).trim() === "";
}

function fmt(value: number): string {
	if (!Number.isFinite(value)) return "-";
	return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
}

function pct(part: number, total: number): string {
	if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return "-";
	return `${Math.round((100 * part) / total)}%`;
}

interface LogRow {
	kind?: string;
	action?: string;
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
	output?: number;
}

/** 把 JSONL 日志汇总成命令输出：按动作分组统计请求数与平均输入/缓存。 */
export function summarizeLog(rows: LogRow[], logPath?: string): string {
	interface Group {
		requests: number;
		samples: number;
		input: number;
		cache: number;
		/** 有缓存可读的样本，单独统计命中率，避免单轮请求把平均值拉到失真。 */
		warm: number;
		warmInput: number;
		warmCache: number;
	}
	const empty = (): Group => ({ requests: 0, samples: 0, input: 0, cache: 0, warm: 0, warmInput: 0, warmCache: 0 });
	const groups = new Map<string, Group>();
	for (const row of rows) {
		if (row.kind !== "usage" || !row.action) continue;
		const group = groups.get(row.action) ?? empty();
		group.samples += 1;
		group.input += row.input ?? 0;
		group.cache += row.cacheRead ?? 0;
		if ((row.cacheRead ?? 0) > 0) {
			group.warm += 1;
			group.warmInput += row.input ?? 0;
			group.warmCache += row.cacheRead ?? 0;
		}
		groups.set(row.action, group);
	}
	for (const row of rows) {
		if (row.kind !== "request" || !row.action) continue;
		const group = groups.get(row.action) ?? empty();
		group.requests += 1;
		groups.set(row.action, group);
	}
	if (groups.size === 0) {
		return "instructions-cache-guard：日志里还没有请求记录。发起一次请求后再看，或确认 PICG_LOG 没被设为 off。";
	}
	const total = [...groups.values()].reduce((sum, group) => sum + group.requests, 0);
	const lines = [`instructions-cache-guard：共 ${total} 次请求`];
	for (const action of ["fill", "skip-filled", "skip-version"]) {
		const group = groups.get(action);
		if (!group) continue;
		const avgInput = group.samples > 0 ? group.input / group.samples : Number.NaN;
		const label =
			action === "fill" ? "已拦截注入" : action === "skip-filled" ? "字段本已非空" : "版本未达阈值";
		lines.push(`  ${label}（${action}）：${group.requests} 次，输入均值 ${fmt(avgInput)}`);
		const cold = group.samples - group.warm;
		if (group.warm > 0) {
			const rate = pct(group.warmCache, group.warmCache + group.warmInput);
			lines.push(`    有缓存可读：${group.warm} 次，命中率 ${rate}（缓存 ${fmt(group.warmCache)} / 输入 ${fmt(group.warmInput)}）`);
		}
		if (cold > 0) {
			lines.push(`    首轮无缓存：${cold} 次（无缓存可读，命中率按 0 计，故不计入上面的命中率）`);
		}
	}
	if (logPath) lines.push(`  日志：${logPath}`);
	return lines.join("\n");
}

function readRows(logPath: string): LogRow[] {
	try {
		return readFileSync(logPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.slice(-500)
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as LogRow];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

interface Pending {
	provider: string;
	model: string;
	action: string;
}

export default function instructionsCacheGuard(pi: ExtensionAPI): void {
	const preparedDirs = new Set<string>();
	let pending: Pending | null = null;

	const write = (logPath: string, row: Record<string, unknown>): void => {
		const dir = dirname(logPath);
		if (!preparedDirs.has(dir)) {
			mkdirSync(dir, { recursive: true });
			preparedDirs.add(dir);
		}
		appendFileSync(logPath, `${JSON.stringify(row)}\n`, "utf8");
	};

	pi.on("before_provider_request", (event, ctx) => {
		const config = resolveConfig();
		const provider = ctx.model?.provider;
		const model = ctx.model?.id;
		if (!provider || !config.providers.has(provider)) return;
		const payload = event.payload as { input?: unknown[]; instructions?: unknown } | undefined;
		if (!payload || !Array.isArray(payload.input)) return;

		const blank = hasBlankInstructions(payload.instructions);
		const versionOk = needsFill(model, config.minVersion, config.modelPattern);
		const action = !versionOk ? "skip-version" : blank ? "fill" : "skip-filled";
		pending = { provider, model, action };

		if (config.logPath && config.logPath !== "off") {
			try {
				write(config.logPath, {
					ts: new Date().toISOString(),
					kind: "request",
					provider,
					model,
					action,
					instructionsBefore: payload.instructions ?? null,
					fill: action === "fill" ? config.fill : undefined,
					inputItems: payload.input.length,
				});
			} catch {
				// 日志失败不影响请求
			}
		}
		if (action !== "fill") return;
		return { ...payload, instructions: config.fill };
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message as
			| { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }
			| undefined;
		if (!message || message.role !== "assistant" || !message.usage) return;
		const current = pending;
		if (!current) return;
		pending = null;
		const config = resolveConfig();
		const usage = message.usage;
		const input = usage.input ?? 0;
		const cacheRead = usage.cacheRead ?? 0;
		if (config.logPath && config.logPath !== "off") {
			try {
				write(config.logPath, {
					ts: new Date().toISOString(),
					kind: "usage",
					provider: current.provider,
					model: current.model,
					action: current.action,
					input,
					output: usage.output ?? 0,
					cacheRead,
					cacheWrite: usage.cacheWrite ?? 0,
					cacheHitRate: pct(cacheRead, cacheRead + input),
				});
			} catch {
				// 日志失败不影响会话
			}
		}
		if (config.display === "off") return;
		const label = current.action === "fill" ? "fill" : current.action === "skip-version" ? "skip" : "kept";
		const text = `guard ${label} · in ${fmt(input)} · cache ${fmt(cacheRead)} (${pct(cacheRead, cacheRead + input)})`;
		// 自定义 footer 扩展（如 pi-grok-theme）会按优先级丢弃第三方状态，窄终端下 footer 可能看不到，
		// 因此默认同时写一份 widget；widget 在编辑器上方，不受 footer 挤占影响。
		const uiResult: Record<string, string> = { display: config.display };
		if (config.display === "notify") {
			try {
				ctx.ui.notify(text, "info");
				uiResult.notify = "ok";
			} catch (error) {
				uiResult.notify = `error:${String(error)}`;
			}
		}
		if (config.display === "status" || config.display === "both") {
			try {
				ctx.ui.setStatus(STATUS_KEY, text);
				uiResult.status = "ok";
			} catch (error) {
				uiResult.status = `error:${String(error)}`;
			}
		}
		if (config.display === "widget" || config.display === "both") {
			try {
				ctx.ui.setWidget(STATUS_KEY, [text]);
				uiResult.widget = "ok";
				if (config.widgetTtl > 0) {
					const timer = setTimeout(() => {
						try {
							ctx.ui.setWidget(STATUS_KEY, undefined);
						} catch {
							// 会话已结束
						}
					}, config.widgetTtl);
					timer.unref?.();
				}
			} catch (error) {
				uiResult.widget = `error:${String(error)}`;
			}
		}
		if (config.debug && config.logPath && config.logPath !== "off") {
			try {
				write(config.logPath, { ts: new Date().toISOString(), kind: "ui", ...uiResult });
			} catch {
				// 调试输出失败不影响会话
			}
		}
	});

	pi.registerCommand("instructions-guard", {
		description: "查看 instructions 注入拦截的统计；/instructions-guard clear 清空日志",
		handler: async (args, ctx) => {
			const config = resolveConfig();
			if (!config.logPath || config.logPath === "off") {
				ctx.ui.notify("instructions-cache-guard：日志已关闭（PICG_LOG=off）。", "info");
				return;
			}
			if ((args ?? "").trim() === "clear") {
				try {
					truncateSync(config.logPath, 0);
				} catch {
					// 文件不存在时无需处理
				}
				ctx.ui.notify(`instructions-cache-guard：已清空 ${config.logPath}`, "info");
				return;
			}
			ctx.ui.notify(summarizeLog(readRows(config.logPath), config.logPath), "info");
		},
	});
}
