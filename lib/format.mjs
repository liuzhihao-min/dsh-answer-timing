// 纯展示层：把汇总对象渲染成一行摘要或明细表格。

export function formatDuration(ms) {
  const v = Math.max(0, Math.round(Number(ms) || 0));
  if (v < 1000) return v + "ms";
  if (v < 60000) return (v / 1000).toFixed(v < 10000 ? 1 : 0) + "s";
  const minutes = Math.floor(v / 60000);
  const seconds = Math.round((v % 60000) / 1000);
  if (seconds === 0) return minutes + "m";
  return minutes + "m" + (seconds < 10 ? "0" + seconds : String(seconds)) + "s";
}

/** 把超阈值的慢调用渲染成若干行（一次调用一行，按耗时降序由调用方保证）。 */
export function formatSlowLines(calls, { max = 8 } = {}) {
  const list = Array.isArray(calls) ? calls : [];
  if (list.length === 0) return "";
  const shown = list.slice(0, max);
  const lines = shown.map(
    (c) =>
      "🐢 慢调用 " +
      c.name +
      " " +
      formatDuration(c.ms) +
      "（step " +
      c.step +
      (c.fp ? " · " + c.fp : "") +
      "）",
  );
  if (list.length > max) lines.push("🐢 另有 " + (list.length - max) + " 条慢调用未列出");
  return lines.join("\n");
}


function toolPart(toolBreakdown, toolMs, maxItems = 4) {
  const entries = Object.entries(toolBreakdown || {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "工具 " + formatDuration(toolMs) + "（无）";
  const shown = entries.slice(0, maxItems).map(([name, ms]) => name + " " + formatDuration(ms));
  if (entries.length > maxItems) shown.push("另 " + (entries.length - maxItems) + " 项");
  return "工具 " + formatDuration(toolMs) + "（" + shown.join(" · ") + "）";
}

function modelPart(s, withDetail = true) {
  let text = "模型 " + formatDuration(s.llmMs);
  if (!withDetail) return text;
  const inner = [];
  if (s.ttftMs > 0) inner.push("首字 " + formatDuration(s.ttftMs));
  if (s.decodeMs > 0) inner.push("生成 " + formatDuration(s.decodeMs));
  if (inner.length > 0) text += "（" + inner.join(" · ") + "）";
  return text;
}

/** 单次回答的一行摘要。 */
export function formatTurnLine(s) {
  if (!s) return "没有可用的耗时数据。";
  const parts = [modelPart(s), toolPart(s.toolBreakdown, s.toolMs), "其它 " + formatDuration(s.otherMs)];
  return "⚡ 本次 " + formatDuration(s.elapsedMs) + " ＝ " + parts.join(" ＋ ");
}

/** 会话级合计的一行摘要。 */
export function formatAggregateLine(a) {
  if (!a || !a.turns) return "还没有任何耗时数据。";
  const parts = [modelPart(a), toolPart(a.toolBreakdown, a.toolMs), "其它 " + formatDuration(a.otherMs)];
  return (
    "⚡ 本会话 " +
    a.turns +
    " 轮 " +
    formatDuration(a.elapsedMs) +
    " ＝ " +
    parts.join(" ＋ ")
  );
}

/** 单次回答的明细。 */
export function formatTurnDetail(s) {
  if (!s) return "没有可用的耗时数据。";
  const lines = [];
  lines.push(formatTurnLine(s));
  lines.push("");
  lines.push("| 阶段 | 耗时 | 占比 |");
  lines.push("| --- | --- | --- |");
  const total = Math.max(1, s.elapsedMs);
  const pct = (ms) => ((ms / total) * 100).toFixed(0) + "%";
  lines.push("| 模型（思考 + 生成） | " + formatDuration(s.llmMs) + " | " + pct(s.llmMs) + " |");
  lines.push("| 工具执行 | " + formatDuration(s.toolMs) + " | " + pct(s.toolMs) + " |");
  lines.push("| 其它（调度/审批/排队） | " + formatDuration(s.otherMs) + " | " + pct(s.otherMs) + " |");
  lines.push("| 合计 | " + formatDuration(s.elapsedMs) + " | 100% |");
  lines.push("");
  const tools = Object.entries(s.toolBreakdown || {}).sort((a, b) => b[1] - a[1]);
  if (tools.length > 0) {
    lines.push("| 工具 | 累计耗时 | 调用次数 |");
    lines.push("| --- | --- | --- |");
    const counts = new Map();
    for (const t of s.tools || []) counts.set(t.name, (counts.get(t.name) || 0) + 1);
    for (const [name, ms] of tools) {
      lines.push("| " + name + " | " + formatDuration(ms) + " | " + (counts.get(name) || 0) + " |");
    }
    lines.push("");
  }
  const slow = s.slowCalls || [];
  if (slow.length > 0) {
    lines.push("| 慢调用 | 耗时 | step | 参数指纹 |");
    lines.push("| --- | --- | --- | --- |");
    for (const c of slow) {
      lines.push(
        "| " + c.name + " | " + formatDuration(c.ms) + " | " + c.step + " | " + (c.fp || "—") + " |",
      );
    }
    lines.push("");
  }
  const steps = s.steps || [];
  if (steps.length > 0) {
    lines.push("| 步骤 | 模型 | 首字 | 生成 | tokens | 工具数 |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const step of steps) {
      lines.push(
        "| " +
          step.step +
          " | " +
          formatDuration(step.llmMs) +
          " | " +
          formatDuration(step.ttftMs) +
          " | " +
          formatDuration(step.decodeMs) +
          " | " +
          step.tokens +
          " | " +
          (step.tools ? step.tools.length : 0) +
          " |",
      );
    }
    lines.push("");
  }
  const notes = [];
  if (s.tokens > 0) notes.push("输出 tokens：" + s.tokens);
  if (s.model) notes.push("模型：" + s.model);
  if (s.missingTools > 0) notes.push("未配对的工具结果：" + s.missingTools);
  if (s.untimedSteps > 0) notes.push("缺少 step/start 锚点的步骤：" + s.untimedSteps);
  if (notes.length > 0) lines.push(notes.join(" · "));
  return lines.join("\n").trimEnd();
}

/** 历史列表。 */
export function formatTurnsTable(records) {
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) return "还没有落盘的耗时记录。";
  const lines = [];
  lines.push("| 结束时间 | turn | 总 | 模型 | 工具 | 其它 | tokens |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const rec of list) {
    const time = new Date(rec.endedAt || rec.startedAt || 0);
    const stamp =
      String(time.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(time.getDate()).padStart(2, "0") +
      " " +
      String(time.getHours()).padStart(2, "0") +
      ":" +
      String(time.getMinutes()).padStart(2, "0");
    lines.push(
      "| " +
        stamp +
        " | " +
        rec.turn +
        " | " +
        formatDuration(rec.elapsedMs) +
        " | " +
        formatDuration(rec.llmMs) +
        " | " +
        formatDuration(rec.toolMs) +
        " | " +
        formatDuration(rec.otherMs) +
        " | " +
        (rec.tokens || 0) +
        " |",
    );
  }
  const slow = list.flatMap((rec) =>
    (rec.slow || []).map((c) => ({ ...c, turn: rec.turn, at: rec.endedAt })),
  );
  if (slow.length > 0) {
    lines.push("");
    lines.push("🐢 慢调用（最近 " + Math.min(slow.length, 10) + " 条）");
    for (const c of slow.slice(0, 10)) {
      lines.push(
        "· turn " +
          c.turn +
          " · " +
          c.name +
          " " +
          formatDuration(c.ms) +
          "（step " +
          c.step +
          (c.fp ? " · " + c.fp : "") +
          "）",
      );
    }
  }
  return lines.join("\n");
}
