// 落盘：$DSH_HOME/timing/turns.jsonl，一行一个 turn。
// 只存时间数字、工具名、模型名；不存任何消息内容。
// 按 sessionId+turn 去重；启动时按 retentionDays 清理过期行（只在内存过滤，不改写文件）。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function resolveDataDir(config = {}) {
  const configured = typeof config.dataDir === "string" ? config.dataDir.trim() : "";
  if (configured) return configured;
  const home = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
  const root = home || join(homedir(), ".dsh");
  return join(root, "timing");
}

export class TimingStore {
  constructor(config = {}) {
    this.dir = resolveDataDir(config);
    this.file = join(this.dir, "turns.jsonl");
    this.retentionDays =
      Number.isInteger(config.retentionDays) && config.retentionDays > 0 ? config.retentionDays : 30;
    this.records = [];
    this.keys = new Set();
    this.load();
  }

  load() {
    try {
      if (!existsSync(this.file)) return;
      const cutoff = Date.now() - this.retentionDays * 86400000;
      const kept = [];
      for (const line of readFileSync(this.file, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (!rec || typeof rec !== "object") continue;
        if (typeof rec.endedAt === "number" && rec.endedAt < cutoff) continue;
        kept.push(rec);
        this.keys.add(String(rec.sessionId) + "#" + rec.turn);
      }
      this.records = kept;
    } catch {
      // 读失败按空历史处理，不影响宿主启动
    }
  }

  append(sessionId, summary) {
    if (!summary || !Number.isInteger(summary.turn)) return false;
    const key = String(sessionId) + "#" + summary.turn;
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    const rec = {
      sessionId: String(sessionId),
      turn: summary.turn,
      startedAt: summary.startedAt,
      endedAt: summary.endedAt,
      elapsedMs: summary.elapsedMs,
      llmMs: summary.llmMs,
      ttftMs: summary.ttftMs,
      decodeMs: summary.decodeMs,
      tokens: summary.tokens,
      toolMs: summary.toolMs,
      otherMs: summary.otherMs,
      toolBreakdown: summary.toolBreakdown ?? {},
      model: summary.model ?? "",
    };
    this.records.push(rec);
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.file, JSON.stringify(rec) + "\n", "utf8");
    } catch {
      // 落盘失败不阻塞对话
    }
    return true;
  }

  /** 最近的 N 条（新的在前）。 */
  list(limit = 10) {
    const n = Number.isInteger(limit) && limit > 0 ? limit : 10;
    return this.records.slice(-n).reverse();
  }
}
