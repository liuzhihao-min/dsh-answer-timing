// 会话耗时折叠：只吃事件、不读时钟、不碰磁盘，便于单测。
//
// 依据的事件（data 字段均已实测确认）：
//   step/start        {turn, step}
//   assistant/message {turn, step, usage.outputTokens, message.source.model, stream[]}
//   tool/call         {turn, step, callId, name, arguments}
//   tool/result       {turn, step, message.source.callId, message.isError, toolCallId}
//   step/end          {turn, step}
//   turn/end          {turn}
// 其它事件（如 session-log-deepseek/delivery-accepted）没有 data.turn，直接跳过。

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** 取 assistant 流里第一个 token 的时间（reasoning 或 text 块的 time0）。 */
export function firstTokenTime(stream) {
  if (!Array.isArray(stream)) return undefined;
  for (const entry of stream) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "reasoning-chunks" || entry.type === "text-chunks") {
      if (isNum(entry.time0)) return entry.time0;
    }
  }
  return undefined;
}

/** 慢调用阈值：默认 3 分钟（可用 Config.slowMs 覆盖）。 */
export const DEFAULT_SLOW_MS = 180000;

/** 参数里最值得看一眼的字段，按优先级取第一个非空值。 */
const FP_KEYS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "skill",
  "keyword",
  "queries",
  "query",
  "url",
  "video",
  "bvid",
  "description",
  "job_id",
  "id",
  "mode",
  "scope",
  "prompt",
];

const firstText = (value) => {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstText(item);
      if (text) return text;
    }
    return "";
  }
  if (value && typeof value === "object") {
    for (const key of ["text", "value", "name", "query", "description"]) {
      const text = firstText(value[key]);
      if (text) return text;
    }
  }
  return "";
};

/** 抹掉像凭据的片段：token / key / password 的值一律不进账本。 */
export function redact(text) {
  return String(text)
    .replace(/\b(npm|ghp|gho|github_pat)_[A-Za-z0-9]{10,}/g, "$1_***")
    .replace(/\b(token|secret|password|passwd|apikey|api_key|auth)\b\s*[:=]\s*\S+/gi, "$1=***");
}

/** 一次调用的「参数指纹」：一行、≤80 字符、已脱敏，只用来认出是哪一次调用。 */
export function argsFingerprint(args) {
  let source = args;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      const oneLine = redact(source.replace(/\s+/g, " ").trim());
      return oneLine.length > 80 ? oneLine.slice(0, 79) + "…" : oneLine;
    }
  }
  if (!source || typeof source !== "object") return "";
  let text = "";
  for (const key of FP_KEYS) {
    text = firstText(source[key]);
    if (text) break;
  }
  if (!text) {
    for (const value of Object.values(source)) {
      text = firstText(value);
      if (text) break;
    }
  }
  if (!text) return "";
  const oneLine = redact(text.replace(/\s+/g, " ").trim());
  return oneLine.length > 80 ? oneLine.slice(0, 79) + "…" : oneLine;
}

export class TimingFold {
  constructor(options = {}) {
    this.maxTurns = Number.isInteger(options.maxTurns) && options.maxTurns > 0 ? options.maxTurns : 200;
    this.slowMs = Number.isInteger(options.slowMs) && options.slowMs > 0 ? options.slowMs : DEFAULT_SLOW_MS;
    this.turns = new Map();
    this.stepStarts = new Map();
    this.openCalls = new Map();
    this.lastTurn = 0;
    this.lastActivity = 0;
  }

  /** 应用一个会话事件。返回 true 表示状态有变化。 */
  apply(event) {
    if (!event || typeof event !== "object") return false;
    const time = isNum(event.time) ? event.time : undefined;
    if (time === undefined) return false;
    const data = event.data && typeof event.data === "object" ? event.data : {};
    const turnNo = Number.isInteger(data.turn) ? data.turn : undefined;
    if (turnNo === undefined) return false;

    if (time > this.lastActivity) this.lastActivity = time;
    const t = this._turn(turnNo, time);
    if (time > t.endedAt) t.endedAt = time;
    if (turnNo > this.lastTurn) this.lastTurn = turnNo;

    switch (event.type) {
      case "step/start": {
        this.stepStarts.set(turnNo + ":" + data.step, time);
        this._step(t, data.step);
        break;
      }
      case "assistant/message": {
        const startedAt = this.stepStarts.get(turnNo + ":" + data.step);
        const s = this._step(t, data.step);
        if (startedAt === undefined) {
          // 没有 step/start 作锚点：不臆造耗时，只标记，保证与官方 sessionStats 口径可对账。
          t.untimedSteps += 1;
          break;
        }
        const llm = Math.max(0, time - startedAt);
        const tokens = isNum(data.usage?.outputTokens) ? data.usage.outputTokens : 0;
        const first = firstTokenTime(data.stream);
        const ttft = first === undefined ? 0 : Math.max(0, first - startedAt);
        const decode = first === undefined ? 0 : Math.max(0, time - first);
        s.llmMs = llm;
        s.tokens = tokens;
        s.ttftMs = ttft;
        s.decodeMs = decode;
        t.llmMs += llm;
        t.tokens += tokens;
        t.decodeMs += decode;
        if (t.ttftMs === 0 && ttft > 0) t.ttftMs = ttft;
        const model = data.message?.source?.model;
        if (!t.model && typeof model === "string") t.model = model;
        break;
      }
      case "tool/call": {
        const toolName = typeof data.name === "string" && data.name ? data.name : "unknown";
        const s = this._step(t, data.step);
        const rec = { name: toolName, ms: 0, ok: true, startedAt: time, fp: argsFingerprint(data.arguments) };
        s.tools.push(rec);
        if (typeof data.callId === "string") {
          this.openCalls.set(data.callId, { turnNo, name: toolName, startedAt: time, rec });
        }
        break;
      }
      case "tool/result": {
        const callId = data.message?.source?.callId ?? data.toolCallId;
        const open = typeof callId === "string" ? this.openCalls.get(callId) : undefined;
        if (!open) {
          t.missingTools += 1;
          break;
        }
        const ms = Math.max(0, time - open.startedAt);
        open.rec.ms = ms;
        open.rec.ok = data.message?.isError !== true;
        t.toolMs += ms;
        t.toolBreakdown[open.name] = (t.toolBreakdown[open.name] ?? 0) + ms;
        this.openCalls.delete(callId);
        break;
      }
      case "turn/end": {
        t.closed = true;
        break;
      }
      default:
        break;
    }
    return true;
  }

  _turn(turnNo, at) {
    let t = this.turns.get(turnNo);
    if (!t) {
      t = {
        turn: turnNo,
        startedAt: at,
        endedAt: at,
        llmMs: 0,
        ttftMs: 0,
        decodeMs: 0,
        tokens: 0,
        toolMs: 0,
        toolBreakdown: {},
        steps: [],
        missingTools: 0,
        untimedSteps: 0,
        model: "",
        closed: false,
        stored: false,
      };
      this.turns.set(turnNo, t);
      this._trim();
    }
    return t;
  }

  _trim() {
    while (this.turns.size > this.maxTurns) {
      let oldest = undefined;
      for (const key of this.turns.keys()) {
        if (oldest === undefined || key < oldest) oldest = key;
      }
      if (oldest === undefined) break;
      this.turns.delete(oldest);
    }
  }

  _step(t, stepNo) {
    let s = t.steps.find((x) => x.step === stepNo);
    if (!s) {
      s = { step: stepNo, llmMs: 0, ttftMs: 0, decodeMs: 0, tokens: 0, tools: [] };
      t.steps.push(s);
    }
    return s;
  }

  /** 某个 turn 的汇总。 */
  summary(turnNo) {
    const t = this.turns.get(turnNo);
    if (!t) return undefined;
    const elapsedMs = Math.max(0, t.endedAt - t.startedAt);
    const otherMs = Math.max(0, elapsedMs - t.llmMs - t.toolMs);
    const tools = t.steps.flatMap((s) => s.tools.map((r) => ({ ...r, step: s.step })));
    const slowCalls = tools
      .filter((r) => r.ms >= this.slowMs)
      .sort((a, b) => b.ms - a.ms)
      .map((r) => ({ name: r.name, step: r.step, ms: r.ms, ok: r.ok, fp: r.fp, startedAt: r.startedAt }));
    return {
      turn: t.turn,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      elapsedMs,
      llmMs: t.llmMs,
      ttftMs: t.ttftMs,
      decodeMs: t.decodeMs,
      tokens: t.tokens,
      toolMs: t.toolMs,
      otherMs,
      toolBreakdown: { ...t.toolBreakdown },
      tools,
      slowCalls,
      steps: t.steps.map((s) => ({
        step: s.step,
        llmMs: s.llmMs,
        ttftMs: s.ttftMs,
        decodeMs: s.decodeMs,
        tokens: s.tokens,
        tools: s.tools.map((r) => ({ ...r })),
      })),
      model: t.model,
      missingTools: t.missingTools,
      untimedSteps: t.untimedSteps,
      closed: t.closed,
    };
  }

  /** 取出「已经收尾、还没落盘」的 turn，标记为已落盘后返回。 */
  takeCompleted() {
    const out = [];
    const list = [...this.turns.values()].sort((a, b) => a.turn - b.turn);
    for (const t of list) {
      if (t.stored) continue;
      if (!(t.turn < this.lastTurn || t.closed)) continue;
      t.stored = true;
      out.push(this.summary(t.turn));
    }
    return out;
  }

  /** 会话级合计（含未收尾的当前 turn）。 */
  aggregate() {
    const totals = {
      turns: 0,
      elapsedMs: 0,
      llmMs: 0,
      ttftMs: 0,
      decodeMs: 0,
      tokens: 0,
      toolMs: 0,
      otherMs: 0,
      toolBreakdown: {},
      model: "",
    };
    for (const turnNo of [...this.turns.keys()].sort((a, b) => a - b)) {
      const s = this.summary(turnNo);
      if (!s) continue;
      totals.turns += 1;
      totals.elapsedMs += s.elapsedMs;
      totals.llmMs += s.llmMs;
      totals.decodeMs += s.decodeMs;
      totals.tokens += s.tokens;
      totals.toolMs += s.toolMs;
      totals.otherMs += s.otherMs;
      if (totals.ttftMs === 0 && s.ttftMs > 0) totals.ttftMs = s.ttftMs;
      if (!totals.model && s.model) totals.model = s.model;
      for (const [name, ms] of Object.entries(s.toolBreakdown)) {
        totals.toolBreakdown[name] = (totals.toolBreakdown[name] ?? 0) + ms;
      }
    }
    return totals;
  }
}
