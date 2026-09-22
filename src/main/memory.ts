import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { logger } from "./logger";

/**
 * 长期记忆（跨会话持久化）。
 *
 * 解决的问题：此前 sessionStore 全部是内存数组，进程退出即全部丢失，
 * 表现为「关掉重开就忘了刚才说过什么」。
 *
 * 存储位置：userData/memory.json（与 config.json 同目录）
 * 内容：
 *   - facts：用户明确要求记住的事实 / 偏好（长期有效）
 *   - turns：最近若干轮对话原文（用于新会话延续上下文，可能过时）
 *
 * 设计取舍：
 *   1. 落盘用「防抖 + 原子替换（tmp -> rename）」，避免频繁 IO 与半截文件。
 *   2. 退出前强制 flush，确保最后一轮对话不丢。
 *   3. 注入模型时只带最近 N 轮，防止 instructions 无限膨胀。
 */

const MEMORY_VERSION = 1;
const MAX_FACTS = 200;
const MAX_TURNS = 400;
/** 注入 instructions 时携带的最近轮数 */
const PROMPT_TURNS = 16;
/** 落盘防抖间隔 */
const WRITE_DEBOUNCE_MS = 300;

export interface MemoryFact {
  text: string;
  ts: number;
}

export interface MemoryTurn {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

interface MemoryFile {
  version: number;
  facts: MemoryFact[];
  turns: MemoryTurn[];
  updatedAt: number;
}

function emptyData(): MemoryFile {
  return { version: MEMORY_VERSION, facts: [], turns: [], updatedAt: 0 };
}

class MemoryStore {
  private filePath: string;
  private data: MemoryFile;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor() {
    let dir: string;
    try {
      dir = app?.getPath("userData") || process.cwd();
    } catch {
      dir = process.cwd();
    }
    this.filePath = path.join(dir, "memory.json");
    this.data = this.load();

    // 退出前强制落盘，避免防抖窗口内的最后一轮对话丢失
    try {
      app?.on?.("will-quit", () => this.flush());
    } catch {
      /* app 不可用时忽略 */
    }
  }

  private load(): MemoryFile {
    try {
      if (!fs.existsSync(this.filePath)) return emptyData();
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as Partial<MemoryFile>;
      const facts = Array.isArray(raw.facts)
        ? raw.facts.filter((f) => f && typeof f.text === "string" && f.text.trim().length > 0)
        : [];
      const turns = Array.isArray(raw.turns)
        ? raw.turns.filter(
            (t) =>
              t &&
              (t.role === "user" || t.role === "assistant") &&
              typeof t.text === "string" &&
              t.text.trim().length > 0
          )
        : [];
      logger.info(`[Memory] 已载入长期记忆：${facts.length} 条事实 / ${turns.length} 轮对话`);
      return {
        version: MEMORY_VERSION,
        facts: facts.slice(-MAX_FACTS),
        turns: turns.slice(-MAX_TURNS),
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
      };
    } catch (e) {
      logger.warn("[Memory] memory.json 读取失败，按空记忆启动:", e);
      return emptyData();
    }
  }

  /** 防抖落盘 */
  private schedule(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, WRITE_DEBOUNCE_MS);
  }

  /** 立即落盘（原子替换） */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    try {
      this.data.updatedAt = Date.now();
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf-8");
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      logger.error("[Memory] 长期记忆写入失败:", e);
    }
  }

  getPath(): string {
    return this.filePath;
  }

  /* ---------------- 事实（长期） ---------------- */

  getFacts(): MemoryFact[] {
    return this.data.facts.map((f) => ({ ...f }));
  }

  /**
   * 记录一条长期事实。重复内容（忽略大小写与首尾空白）不会重复写入。
   * @returns true 表示新增，false 表示已存在
   */
  addFact(text: string): boolean {
    const t = (text || "").trim();
    if (!t) return false;
    const key = t.toLowerCase();
    if (this.data.facts.some((f) => f.text.trim().toLowerCase() === key)) {
      logger.info("[Memory] 该事实已存在，跳过重复写入");
      return false;
    }
    this.data.facts.push({ text: t, ts: Date.now() });
    if (this.data.facts.length > MAX_FACTS) {
      this.data.facts.splice(0, this.data.facts.length - MAX_FACTS);
    }
    this.flush(); // 事实是显式指令，立即落盘
    logger.info(`[Memory] 已记住：${t}`);
    return true;
  }

  removeFact(text: string): boolean {
    const key = (text || "").trim().toLowerCase();
    const before = this.data.facts.length;
    this.data.facts = this.data.facts.filter((f) => f.text.trim().toLowerCase() !== key);
    if (this.data.facts.length !== before) {
      this.flush();
      return true;
    }
    return false;
  }

  /* ---------------- 对话轮次（短期，跨会话保留） ---------------- */

  appendTurn(role: "user" | "assistant", text: string): void {
    const t = (text || "").trim();
    if (!t) return;
    this.data.turns.push({ role, text: t, ts: Date.now() });
    if (this.data.turns.length > MAX_TURNS) {
      this.data.turns.splice(0, this.data.turns.length - MAX_TURNS);
    }
    this.schedule();
  }

  getTurns(limit = MAX_TURNS): MemoryTurn[] {
    const n = Math.max(0, limit);
    return this.data.turns.slice(-n).map((t) => ({ ...t }));
  }

  clear(): void {
    this.data = emptyData();
    this.flush();
    logger.info("[Memory] 长期记忆已清空");
  }

  /* ---------------- 注入模型 ---------------- */

  /**
   * 生成追加到 instructions 后面的记忆块。
   * 没有记忆时返回空串，避免污染系统提示。
   */
  buildPromptBlock(): string {
    const facts = this.data.facts;
    const turns = this.data.turns.slice(-PROMPT_TURNS);
    if (!facts.length && !turns.length) return "";

    const parts: string[] = ["【跨会话记忆】以下内容来自本机保存的历史记录，仅作为背景参考；如与用户当前说法冲突，一律以用户当前说法为准。"];

    if (facts.length) {
      parts.push("用户明确要求记住的事实与偏好：");
      for (const f of facts.slice(-60)) parts.push(`- ${f.text}`);
    }

    if (turns.length) {
      parts.push("最近对话（可能已过时，不要主动复述）：");
      for (const t of turns) {
        parts.push(`${t.role === "user" ? "用户" : "Jarvis"}：${t.text}`);
      }
    }

    return parts.join("\n");
  }
}

export const memoryStore = new MemoryStore();
