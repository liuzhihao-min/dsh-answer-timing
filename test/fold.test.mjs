import test from "node:test";
import assert from "node:assert/strict";
import { TimingFold, firstTokenTime } from "../lib/fold.mjs";

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
