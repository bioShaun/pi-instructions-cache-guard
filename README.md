# pi-instructions-cache-guard

阻止 OpenAI Responses 网关在 `instructions` 为空时注入自己的默认指令，从而保住 GPT-6.2 及以上的 prompt cache。

## 问题

从 GPT-6.2 起，Responses 请求的顶层 `instructions` **不参与 prompt cache**。Pi 的 `openai-responses` 实现本来就不发这个字段（系统提示词放在 `input` 首条 `developer` 消息里，可正常缓存），于是中间层的网关就能把一份本来可缓存的请求变成不可缓存：

```
  Pi
   │  input[0]  developer 系统提示词  ~4.8k tok   ← 第 2 轮起命中缓存
   │  input[1..] 对话历史 + 工具定义              ← 同上，属于缓存前缀
   │  instructions       （Pi 不发这个字段）
   ▼
  网关（例：sub2api）：instructions 去除空白后为空 → 注入默认 Codex 指令
   │
   │  instructions  默认 Codex 指令  ~5.4k tok    ← GPT-6.2 不缓存，每轮全价
   ▼
  OpenAI Responses
```

于是每一轮请求的账单结构变成这样（数值取自探测脚本）：

```
# 第 2 轮起，单位 tok
启用前   input  4,839（已缓存）+ instructions  5,409（不缓存）= 10,248 新输入
启用后   input  4,839（已缓存）+ instructions      1（不缓存）=  4,840 新输入
```

被注入的内容每轮都按未缓存输入计费。同一个 Pi 会话（`gpt-6.2-sol`，同一句提示词）实测：

| | `usage.input_tokens` |
|---|---|
| 禁用本扩展（网关注入生效） | 10,791 |
| 启用本扩展 | 5,382 |

差值 5,409 token 即被挡掉的默认 Codex 指令；探测脚本里同一组对照为 10,247 → 4,839。

## 做法

在 `before_provider_request` 钩子里改请求体 —— 这是 Pi 序列化完成、即将发出前唯一能碰到 `instructions` 的位置：

```
每次 provider 请求（before_provider_request）
   │
   ▼
三个条件全部满足才动手：
   ├── provider 在白名单里（默认 tcuni、tcuni-luna）
   ├── 模型版本 >= 6.2
   └── instructions 去空白后为空
   │
   ├── 不满足 ──▶ 请求原样发出，一个字节都不改
   └── 满足   ──▶ instructions = "." 后发出
```

请求体上的实际变化只有一行：

```
# 改写前
{ "input": [developer, user, ...], "tools": [...] }  ← 没有 instructions 字段

# 改写后
{ "input": [developer, user, ...], "tools": [...] }  ← 原样，缓存前缀不变
+ "instructions": "."                                ← 新增，仅此一处
```

为什么填 `.`，而不是把系统提示词“顺手续上”：

| 写入 `instructions` 的值 | 网关行为 | GPT-6.2 上的代价 |
|---|---|---|
| 字段缺失 | 注入 5.4k 默认 Codex 指令 | 注入内容每轮按新输入计费 |
| `""` 或 `"   "` | 仍然注入（trim 后为空） | 同上 |
| `"."` | 不注入 | 只有 1 token 不缓存 |
| 完整系统提示词 | 不注入 | 提示词本体永不缓存，比现状更贵 |

所以扩展只做两件事：让字段非空以阻止注入，且保证没有任何真实内容进入这个不缓存的字段。系统提示词继续留在 `input` 里，缓存前缀一个字都不变。

6.2 以前该字段可正常缓存，因此默认只处理 `>= 6.2` 的模型。

## 安装

作为 Pi 包从 GitHub 安装（推荐）：

```bash
pi install git:github.com/bioShaun/pi-instructions-cache-guard
```

升级到最新提交：

```bash
pi update --extensions
```

用 `pi list` 确认已安装，`pi remove git:github.com/bioShaun/pi-instructions-cache-guard` 可移除。安装后无需重启，`/reload` 即可生效。

直接从源码开发时，也可以把本地目录当作包安装（该方式不会自动跟随 GitHub 的更新）：

```bash
git clone git@github.com:bioShaun/pi-instructions-cache-guard.git
pi install ./pi-instructions-cache-guard
```

## 配置

全部通过环境变量，使用默认值即可；每次请求都会重新读取，改完不必重启 Pi。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PICG_FILL_PROVIDERS` | `tcuni,tcuni-luna` | 生效的 provider 白名单；设为 `none` 即完全禁用 |
| `PICG_FILL` | `.` | 写入 `instructions` 的哨兵文本 |
| `PICG_MODELS` | `^gpt-(\d+)(?:\.(\d+))?` | 从模型 id 提取主/次版本号的正则 |
| `PICG_MIN_VERSION` | `6.2` | 生效的最低模型版本 |
| `PICG_LOG` | `~/.pi/agent/logs/instructions-cache-guard.jsonl` | 日志路径；设为 `off` 关闭 |
| `PICG_STATUS` | `on` | 设为 `off` 关闭 footer 状态显示 |

旧名字 `PI_TCUNI_FILL_PROVIDERS` / `PI_TCUNI_FILL` / `PI_TCUNI_FILL_MODELS` / `PI_TCUNI_FILL_DEBUG` 仍被识别，便于从早期单文件版本平滑迁移。

## 看效果

1. **footer 状态**：每次请求结束后显示 `guard fill · in 4.8k · cache 11.0k (69%)`。`fill` 表示拦截生效，`skip` 表示模型版本未达阈值，`kept` 表示字段本来就有内容。
2. **`/instructions-guard`**：汇总日志中各类请求的次数、输入均值与缓存读取均值，并给出日志路径。
3. **`/instructions-guard clear`**：清空日志重新统计。
4. **JSONL 日志**：每行一条记录，`kind: "request"` 记录注入前的字段状态，`kind: "usage"` 记录该次请求的 `input` / `cacheRead` / `cacheWrite`，可直接对比启用前后的差异。

日志示例：

```json
{"ts":"2026-11-19T02:10:00.000Z","kind":"request","provider":"tcuni","model":"gpt-6.2-sol","action":"fill","instructionsBefore":null,"fill":".","inputItems":3}
{"ts":"2026-11-19T02:10:04.000Z","kind":"usage","provider":"tcuni","model":"gpt-6.2-sol","action":"fill","input":4839,"output":120,"cacheRead":11008,"cacheWrite":0,"cacheHitRate":"69%"}
```

## 边界

- 只改请求体里的一个字段，不修改 `node_modules`、不 patch Pi。
- 不解决网关自身行为：若某个网关在 `instructions` 非空时仍注入，本扩展无效。
- 不解决上游缓存不稳定：`gpt-6.2` 出现过同一会话后续轮次 `cached_tokens` 归零的情况，与注入无关。
- 去掉默认 Codex 指令后，模型行为以 Pi 的系统提示词为准；需要对照时用 `PICG_FILL_PROVIDERS=none` 跑同一任务。

## 测试

```bash
node --test
```

8 个用例覆盖版本判定、空白判定（与网关的 trim 语义一致）、配置兼容、注入拦截、日志与 footer、统计汇总、关闭日志、命令输出与清空。
