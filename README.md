# dsh-answer-timing

[![test](https://github.com/liuzhihao-min/dsh-answer-timing/actions/workflows/test.yml/badge.svg)](https://github.com/liuzhihao-min/dsh-answer-timing/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 把「这次回答到底花了多少时间、花在哪」变成可查的数据。

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）用的耗时统计插件。
**纯 host 端**：不注入任何 client 代码、不改 UI，只旁听会话事件流。

## 输出长什么样

每次回答结束，末尾一行：

```
⚡ 本次 1m23s ＝ 模型 58s（首字 1.2s · 生成 41s）＋ 工具 19s（pwsh 12s · read 4s · grep 3s）＋ 其它 6s
```

需要明细时（`detail: true`），给三张表：阶段构成 / 工具累计 / 逐步骤。

## 它算什么

对每一次回答（turn），拆成三段：

| 段 | 含义 | 来源 |
| --- | --- | --- |
| **模型** | 思考 + 生成的总时间；内部再分「首字」和「生成」 | `step/start` → `assistant/message` |
| **工具** | 每个工具的实际执行时间，按工具名累加 | `tool/call` → `tool/result`（按 `callId` 配对） |
| **其它** | 总时长减去上面两项：调度、审批等待、排队 | `turn` 起止差 − 模型 − 工具 |

- **首字（ttft）**：从 `step/start` 到这个 step 第一个推理/文本 chunk 的时间（读 `stream` 里的 `time0`）。
- **生成（decode）**：首个 chunk 到 `assistant/message` 落定的时间。
- **总时长**：这一轮第一个带 `data.turn` 的事件到最后一个事件的时间差。

## 安装

### 前置

- DSH `>=0.2.1-rc.2 <0.3.0`
- Node.js `>=24`

### 一条命令

```bash
git clone https://github.com/liuzhihao-min/dsh-answer-timing
cd dsh-answer-timing
node install.mjs
```

脚本会做四件事（全部可重复执行，幂等）：

1. `<profile>/.dsh-answer-timing-source` → 本仓库（Windows 用 junction，macOS/Linux 用 symlink）
2. `<profile>/node_modules/dsh-answer-timing` → 本仓库
3. `dependencies["dsh-answer-timing"] = "link:.dsh-answer-timing-source"`
4. `dsh.profile.bundles` 末尾追加 `dsh-answer-timing`

写 `package.json` 前会自动备份成 `package.json.bak-<时间戳>`。然后**完全退出 DSH 再启动**（改 profile 不热加载）。

常用参数：

| 参数 | 作用 |
| --- | --- |
| `--dry-run` | 只打印将要做什么，不写文件 |
| `--profile web` | 指定其它 profile（默认 `desktop`） |
| `--dsh-home D:\x` | 指定 DSH 目录（默认 `~/.dsh` 或 `$DSH_HOME`） |
| `--force` | 目标位置是真实目录时，改名备份后继续 |
| `--uninstall` | 卸载：摘掉 bundles / 依赖 / 两个链接 |

> **卸载时 DSH 必须先退出。** 否则 `node_modules` 里的链接被占用删不掉（脚本会警告并跳过，注册信息仍会清干净，退出后再跑一次即可）。

### 手动注册（不想跑脚本时）

```powershell
# 1. 目录联接（换成你自己的实际路径）
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\desktop\.dsh-answer-timing-source" "D:\plugins\dsh-answer-timing"
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-answer-timing" "D:\plugins\dsh-answer-timing"
```

```jsonc
// 2. package.json → dependencies 里加一行
"dsh-answer-timing": "link:.dsh-answer-timing-source"
```

```jsonc
// 3. package.json → dsh.profile.bundles 末尾追加
"dsh-answer-timing"
```

然后**完全退出 DSH 再启动**（改 profile 不会热加载）。

### 验证

对话里问一句「刚才那轮花了多久」，或直接调用 `timing_report`。
工具存在即安装成功；`~/.dsh/timing/turns.jsonl` 会在第一轮结束后出现。

## 使用

工具：`timing_report`

| 参数 | 说明 |
| --- | --- |
| `scope` | `last`（默认）/ `turn` / `session` / `turns` |
| `turn` | 指定轮次（配合 `scope: "turn"`） |
| `limit` | `scope: "turns"` 取最近几条，默认 10 |
| `detail` | `true` 时给「阶段构成 / 工具累计 / 逐步骤」三张表 |

配套技能 `answer-timing` 会让 agent 在每次回答末尾自动附上那一行。

## 落盘与隐私

- 路径：`$DSH_HOME/timing/turns.jsonl`（未设 `DSH_HOME` 时用 `~/.dsh/timing/turns.jsonl`）
- 一行一个 turn，按 `sessionId + turn` 去重
- **只存**：时间戳、各段毫秒数、输出 tokens、工具名、模型名
- **不存**：提示词、回答正文、工具参数、任何对话内容
- 默认保留 30 天（读取时按 `retentionDays` 过滤，不改写文件）

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | 空 | 自定义落盘目录 |
| `retentionDays` | 30 | 历史保留天数 |
| `maxTurnsInMemory` | 200 | 每会话内存里保留多少轮 |

## 口径与限制

- 一个 step 若产生多条 `assistant/message`（重试/多次 attempt），只记最后一次，其余不累加。
- 没有 `step/start` 锚点的 step 不臆造耗时，只计入 `untimedSteps`，这样能和官方 `sessionStats` 的口径对上。
- 工具**审批等待**发生在 `tool/call` 与 `tool/result` 之间，因此算进「工具」而不是「其它」。
- 子代理是独立 session，各自统计；主会话里 subagent 调用的等待算在主会话的「工具」。
- 宿主重启后，内存里的逐轮状态从零开始；历史请用 `scope: "turns"` 读落盘账本。
- 这是**观测**插件：不改变任何调度、超时或重试行为。

## 目录结构

```
.
├── index.js            # 插件入口：订阅事件 + 注册工具
├── install.mjs         # 安装/卸载脚本（幂等，自动备份 package.json）
├── cordis.patch.yml    # bundle 插入声明
├── lib/
│   ├── fold.mjs        # 纯函数：事件流 → 逐轮耗时
│   ├── format.mjs      # 单行摘要 + 三张明细表
│   └── store.mjs       # JSONL 账本（去重、保留期）
├── test/
│   └── fold.test.mjs   # node:test，9 个用例
└── .github/workflows/
    └── test.yml        # CI：ubuntu + windows × node 24
```

## 开发与测试

```bash
node test/fold.test.mjs
```

> 用 `node --test` 在某些受限沙箱里会因子进程 `spawn EPERM` 失败，直接执行测试文件即可（`node:test` 在进程内跑）。
> 调试插件加载：设 `DSH_ANSWER_TIMING_DEBUG=1`，启动时会往 stderr 打一行 `[answer-timing] loaded`。

## 兼容性

依赖 DSH 的会话事件字段（`step/start`、`assistant/message`、`tool/call`、`tool/result`、`turn/end`）。
这些是 DSH 的内部接口，**随版本可能变动**；升级 DSH 后若数字异常，先在这里排查字段名。

## 许可

MIT
