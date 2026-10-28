import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { TimingFold } from "./lib/fold.mjs";
import { TimingStore } from "./lib/store.mjs";
import {
  formatAggregateLine,
  formatSlowLines,
  formatTurnDetail,
  formatTurnLine,
  formatTurnsTable,
} from "./lib/format.mjs";

export const name = "answer-timing";

// 只用 tools：会话事件通过 ctx.on 直接收听，不依赖额外服务名。
export const inject = ["tools"];

export const Config = z.object({
  dataDir: z
    .string()
    .default("")
    .description(
      "Human-configured absolute directory for the timing ledger. Empty uses $DSH_HOME/timing (fallback ~/.dsh/timing).",
    ),
  retentionDays: z
    .natural()
    .min(1)
    .default(30)
    .description("Human-configured retention in days for the on-disk ledger. Default 30."),
  maxTurnsInMemory: z
    .natural()
    .min(8)
    .default(200)
    .description("Human-configured cap on turns kept in memory per session. Default 200."),
  slowMs: z
    .natural()
    .min(1000)
    .default(180000)
    .description(
      "Human-configured millisecond threshold above which a single tool call is listed separately. Default 180000 (3 minutes).",
    ),
});

const sessionIdOf = (session) =>
  String(session?.id ?? session?.sessionId ?? session?.key ?? "unknown");

const renderText = (_args, value) => [{ type: "text", text: String(value) }];

/** 追加慢调用行：没有慢调用时输出与原来完全一致。 */
const withSlowCalls = (text, slowCalls) => {
  const slow = formatSlowLines(slowCalls);
  return slow ? text + "\n" + slow : text;
};

export function apply(ctx, config = {}) {
  if (process.env.DSH_ANSWER_TIMING_DEBUG === "1") {
    console.error("[answer-timing] loaded");
  }
  const store = new TimingStore(config);
  const folds = new Map();
  let lastSessionId = "";

  const foldFor = (session) => {
    const id = sessionIdOf(session);
    let fold = folds.get(id);
    if (!fold) {
      fold = new TimingFold({ maxTurns: config.maxTurnsInMemory, slowMs: config.slowMs });
      folds.set(id, fold);
    }
    lastSessionId = id;
    return { id, fold };
  };

  const persist = (id, fold) => {
    for (const summary of fold.takeCompleted()) store.append(id, summary);
  };

  ctx.on("session/created", (session) => {
    if (!session) return;
    const { id, fold } = foldFor(session);
    const events = session?.events ?? session?.snapshotEvents ?? session?.snapshot?.events;
    if (Array.isArray(events)) {
      for (const event of events) fold.apply(event);
      persist(id, fold);
    }
  });

  ctx.on("session/event", (session, event) => {
    if (!session || !event) return;
    const { id, fold } = foldFor(session);
    fold.apply(event);
    persist(id, fold);
  });

  ctx.tools.register(
    defineTool({
      name: "timing_report",
      description:
        "Report how long the last answer (or a chosen turn / whole session / recent history) actually took, broken down into model time (first token + decode), per-tool execution time, and everything else. Individual tool calls at or above the slow threshold (default 3 minutes) are listed separately with a short parameter fingerprint. Reads a local ledger; no network, no message content.",
      parameters: {
        scope: {
          type: "string",
          description: "One of: last (default), turn, session, turns.",
        },
        turn: {
          type: "integer",
          description: "Turn number for scope=turn (and an override for scope=last).",
        },
        limit: {
          type: "integer",
          description: "How many recent records for scope=turns; default 10.",
        },
        detail: {
          type: "boolean",
          description: "Include per-stage, per-tool and per-step tables; default false.",
        },
      },
      output: { schema: { type: "string" }, render: renderText },
      async execute(args = {}, exec = {}) {
        const scope = typeof args.scope === "string" && args.scope ? args.scope : "last";
        const detail = args.detail === true;
        const limit =
          Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 10;

        if (scope === "turns") return formatTurnsTable(store.list(limit));

        // 选会话：优先工具调用所在会话，否则取最近活动的那个。
        let id = exec?.session ? sessionIdOf(exec.session) : "";
        let fold = id ? folds.get(id) : undefined;
        if (!fold) {
          let bestId = "";
          let best = undefined;
          for (const [key, candidate] of folds) {
            if (!best || candidate.lastActivity > best.lastActivity) {
              best = candidate;
              bestId = key;
            }
          }
          if (best) {
            id = bestId;
            fold = best;
          }
        }
        if (!fold) {
          return "还没有任何耗时数据：这个会话还没有跑过一轮。";
        }

        if (scope === "session") {
          const aggregate = fold.aggregate();
          if (!detail) {
            const slow = [];
            for (const turnNo of [...fold.turns.keys()].sort((a, b) => a - b)) {
              const s = fold.summary(turnNo);
              if (s) slow.push(...s.slowCalls);
            }
            return withSlowCalls(formatAggregateLine(aggregate), slow);
          }
          const lines = [formatAggregateLine(aggregate)];
          const recent = [...fold.turns.keys()].sort((a, b) => a - b).slice(-10);
          for (const turnNo of recent) {
            lines.push("");
            lines.push("**turn " + turnNo + "**");
            lines.push(formatTurnDetail(fold.summary(turnNo)));
          }
          return lines.join("\n");
        }

        const turnNo = Number.isInteger(args.turn)
          ? args.turn
          : scope === "turn"
            ? fold.lastTurn
            : fold.lastTurn;
        const summary = fold.summary(turnNo);
        if (!summary) return "没有 turn " + turnNo + " 的记录（可用 scope=session 看整体）。";
        return detail
          ? formatTurnDetail(summary)
          : withSlowCalls(formatTurnLine(summary), summary.slowCalls);
      },
    }),
  );
}
