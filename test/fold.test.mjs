import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TimingFold, argsFingerprint, firstTokenTime } from "../lib/fold.mjs";
import { TimingStore } from "../lib/store.mjs";
import { formatSlowLines, formatTurnDetail, formatTurnLine, formatTurnsTable } from "../lib/format.mjs";

const BASE = 1792680000000;
const ev = (type, data, offset) => ({ type, seq: 0, time: BASE + offset, data });

test("firstTokenTime 取第一个 reasoning/text 块的 time0", () => {
  assert.equal(
    firstTokenTime([
      { type: "chunk", time: BASE + 10, chunk: { type: "block-start", index: 0 } },
      { type: "reasoning-chunks", time0: BASE + 500, dt: [], texts: [] },
      { type: "text-chunks", time0: BASE + 900, dt: [], texts: [] },
    ]),
    BASE + 500,
  );
  assert.equal(firstTokenTime(undefined), undefined);
  assert.equal(firstTokenTime([]), undefined);
});

test("单步：模型 + 一次工具", () => {
  const fold = new TimingFold();
  fold.apply(ev("step/start", { turn: 1, step: 1 }, 0));
  fold.apply(
    ev(
      "assistant/message",
      {
        turn: 1,
        step: 1,
        usage: { outputTokens: 40 },
        message: { source: { model: "deepseek-flash" } },
        stream: [{ type: "reasoning-chunks", time0: BASE + 500, dt: [], texts: [] }],
      },
      2000,
    ),
  );
  fold.apply(ev("tool/call", { turn: 1, step: 1, callId: "c1", name: "pwsh" }, 2010));
  fold.apply(
    ev("tool/result", { turn: 1, step: 1, message: { source: { callId: "c1" }, isError: false } }, 5010),
  );
  fold.apply(ev("step/end", { turn: 1, step: 1 }, 5010));

  const s = fold.summary(1);
  assert.equal(s.llmMs, 2000);
  assert.equal(s.ttftMs, 500);
  assert.equal(s.decodeMs, 1500);
  assert.equal(s.toolMs, 3000);
  assert.deepEqual(s.toolBreakdown, { pwsh: 3000 });
  assert.equal(s.tokens, 40);
  assert.equal(s.model, "deepseek-flash");
  assert.equal(s.elapsedMs, 5010);
  assert.equal(s.otherMs, 10);
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].tools.length, 1);
  assert.equal(s.tools[0].ok, true);
});

test("工具失败标记 isError，并按名字累加", () => {
  const fold = new TimingFold();
  fold.apply(ev("step/start", { turn: 1, step: 1 }, 0));
  fold.apply(ev("tool/call", { turn: 1, step: 1, callId: "a", name: "read" }, 100));
  fold.apply(
    ev("tool/result", { turn: 1, step: 1, message: { source: { callId: "a" }, isError: true } }, 400),
  );
  fold.apply(ev("tool/call", { turn: 1, step: 1, callId: "b", name: "read" }, 500));
  fold.apply(
    ev("tool/result", { turn: 1, step: 1, message: { source: { callId: "b" }, isError: false } }, 800),
  );
  const s = fold.summary(1);
  assert.deepEqual(s.toolBreakdown, { read: 600 });
  assert.equal(s.tools[0].ok, false);
  assert.equal(s.tools[1].ok, true);
});

test("未配对的 tool/result 记 missingTools，不污染总时长", () => {
  const fold = new TimingFold();
  fold.apply(ev("step/start", { turn: 1, step: 1 }, 0));
  fold.apply(ev("tool/result", { turn: 1, step: 1, message: { source: { callId: "ghost" } } }, 500));
  const s = fold.summary(1);
  assert.equal(s.missingTools, 1);
  assert.equal(s.toolMs, 0);
});

test("缺少 step/start 锚点的 assistant/message 记 untimedSteps，llmMs 保持 0", () => {
  const fold = new TimingFold();
  fold.apply(ev("assistant/message", { turn: 3, step: 1, usage: { outputTokens: 12 } }, 1000));
  const s = fold.summary(3);
  assert.equal(s.untimedSteps, 1);
  assert.equal(s.llmMs, 0);
});

test("turn/end 后 takeCompleted 吐出该轮，且只吐一次", () => {
  const fold = new TimingFold();
  fold.apply(ev("step/start", { turn: 1, step: 1 }, 0));
  fold.apply(ev("turn/end", { turn: 1 }, 1000));
  const first = fold.takeCompleted();
  assert.equal(first.length, 1);
  assert.equal(first[0].turn, 1);
  assert.equal(first[0].closed, true);
  assert.equal(fold.takeCompleted().length, 0);
});

test("新 turn 开始时，上一轮自动收尾", () => {
  const fold = new TimingFold();
  fold.apply(ev("step/start", { turn: 1, step: 1 }, 0));
  fold.apply(ev("step/start", { turn: 2, step: 1 }, 1000));
  const done = fold.takeCompleted();
  assert.deepEqual(
    done.map((x) => x.turn),
    [1],
  );
});

test("没有 data.turn 的事件被忽略（如 delivery-accepted）", () => {
  const fold = new TimingFold();
  const changed = fold.apply({
    type: "session-log-deepseek/delivery-accepted",
    time: BASE,
    data: { sessionId: "s1", throughSeq: 9 },
  });
  assert.equal(changed, false);
  assert.equal(fold.lastTurn, 0);
});

test("会话合计等于各轮相加", () => {
  const fold = new TimingFold();
  fold.apply(ev("step/start", { turn: 1, step: 1 }, 0));
  fold.apply(ev("assistant/message", { turn: 1, step: 1, usage: { outputTokens: 5 } }, 1000));
  fold.apply(ev("turn/end", { turn: 1 }, 1000));
  fold.apply(ev("step/start", { turn: 2, step: 1 }, 2000));
  fold.apply(ev("assistant/message", { turn: 2, step: 1, usage: { outputTokens: 7 } }, 4000));
  fold.apply(ev("turn/end", { turn: 2 }, 4000));
  const a = fold.aggregate();
  assert.equal(a.turns, 2);
  assert.equal(a.llmMs, 3000);
  assert.equal(a.tokens, 12);
  assert.equal(a.elapsedMs, 3000);
});

const slowTurn = (slowOffset = 181000) => {
  const fold = new TimingFold();
  fold.apply(ev("step/start", { turn: 1, step: 1 }, 0));
  fold.apply(ev("tool/call", { turn: 1, step: 1, callId: "fast", name: "read", arguments: { file_path: "D:/a/b.md" } }, 1000));
  fold.apply(ev("tool/result", { turn: 1, step: 1, message: { source: { callId: "fast" } } }, 120000));
  fold.apply(ev("tool/call", { turn: 1, step: 1, callId: "slow", name: "pwsh", arguments: { command: "node build.mjs" } }, 121000));
  fold.apply(ev("tool/result", { turn: 1, step: 1, message: { source: { callId: "slow" } } }, 121000 + slowOffset));
  fold.apply(ev("turn/end", { turn: 1 }, 121000 + slowOffset));
  return fold;
};

test("慢调用：≥ 默认阈值单独进 slowCalls，阈值以下不进", () => {
  const fold = slowTurn(181000);
  const s = fold.summary(1);
  assert.equal(s.tools.length, 2);
  assert.equal(s.slowCalls.length, 1);
  assert.equal(s.slowCalls[0].name, "pwsh");
  assert.equal(s.slowCalls[0].ms, 181000);
  assert.equal(s.slowCalls[0].step, 1);
  assert.equal(s.slowCalls[0].fp, "node build.mjs");
  assert.equal(s.slowCalls[0].ok, true);
});

test("慢调用阈值可配置（slowMs），并按时长降序", () => {
  const fold = new TimingFold({ slowMs: 1000 });
  fold.apply(ev("step/start", { turn: 1, step: 1 }, 0));
  fold.apply(ev("tool/call", { turn: 1, step: 1, callId: "a", name: "job_output", arguments: { job_id: "abc" } }, 100));
  fold.apply(ev("tool/result", { turn: 1, step: 1, message: { source: { callId: "a" } } }, 3100));
  fold.apply(ev("tool/call", { turn: 1, step: 1, callId: "b", name: "grep", arguments: { pattern: "foo" } }, 3200));
  fold.apply(ev("tool/result", { turn: 1, step: 1, message: { source: { callId: "b" } } }, 9200));
  const slow = fold.summary(1).slowCalls;
  assert.deepEqual(
    slow.map((c) => [c.name, c.ms]),
    [
      ["grep", 6000],
      ["job_output", 3000],
    ],
  );
});

test("argsFingerprint：取关键字段、压成一行、截断、脱敏", () => {
  assert.equal(argsFingerprint({ command: "node  test.mjs\n --bail" }), "node test.mjs --bail");
  assert.equal(argsFingerprint(JSON.stringify({ file_path: "D:/x/y.md" })), "D:/x/y.md");
  assert.equal(argsFingerprint({ queries: ["first query", "second"] }), "first query");
  assert.equal(argsFingerprint(undefined), "");
  assert.equal(argsFingerprint({}), "");
  assert.equal(argsFingerprint({ command: "x".repeat(200) }).length, 80);
  const masked = argsFingerprint({
    command: "npm publish --//registry.npmjs.org/:_authToken=npm_abcdefghijklmn",
  });
  assert.ok(!masked.includes("abcdefghijklmn"));
});

test("store 只落盘慢调用，旧行没有 slow 字段也能读", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-timing-"));
  try {
    const summaries = slowTurn().takeCompleted();
    assert.equal(summaries.length, 1);
    const store = new TimingStore({ dataDir: dir });
    assert.equal(store.append("s1", summaries[0]), true);
    assert.equal(store.append("s1", summaries[0]), false);

    const reloaded = new TimingStore({ dataDir: dir });
    const rec = reloaded.list(1)[0];
    assert.equal(rec.slow.length, 1);
    assert.equal(rec.slow[0].name, "pwsh");

    appendFileSync(
      join(dir, "turns.jsonl"),
      JSON.stringify({ sessionId: "old", turn: 3, endedAt: Date.now(), toolMs: 5 }) + "\n",
      "utf8",
    );
    const oldRec = new TimingStore({ dataDir: dir })
      .list(10)
      .find((r) => r.sessionId === "old");
    assert.equal(oldRec.slow, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("格式化：慢调用单独成行/成表，普通一行保持不变", () => {
  const s = slowTurn().summary(1);
  const line = formatTurnLine(s);
  assert.ok(!line.includes("慢调用"));
  assert.equal(formatSlowLines([]), "");

  const detail = formatTurnDetail(s);
  assert.ok(detail.includes("| 慢调用 |"));
  assert.ok(detail.includes("node build.mjs"));

  const table = formatTurnsTable([
    {
      turn: 2,
      endedAt: Date.now(),
      elapsedMs: 1000,
      llmMs: 500,
      toolMs: 400,
      otherMs: 100,
      tokens: 3,
      slow: [{ name: "pwsh", ms: 181000, step: 1, fp: "dotnet build" }],
    },
  ]);
  assert.ok(table.includes("🐢 慢调用"));
  assert.ok(table.includes("dotnet build"));
});
