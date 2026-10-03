import * as fs from "node:fs";
import * as path from "node:path";
import { userDataDir } from "./user-path";
import { pruneJsonlFile } from "./log-redact";

/**
 * 日志系统。
 *
 * 本次增强（针对实测问题）：
 * 1. **分类错误日志**：所有 ERROR 额外写入 errors.jsonl，带上「分类 + 子系统 +
 *    是否已处理 + 上下文」。原先只有人类可读的一行文本，排查时要在上万行里翻，
 *    且工具执行失败与网络错误混在一起，无法快速定位「哪些事它没做/做错了」。
 * 2. **写盘限流**：同类消息在窗口期内只落盘一次（计数累加）。
 *    实测服务端高频事件会让单文件涨到近 2MB、WARN 逾 1.5 万条，
 *    而这里是同步写盘，会阻塞主进程。
 * 3. **日志轮转**：单文件超过 MAX_BYTES 自动滚动，保留有限份数。
 */

/** 错误分类：便于按「哪一类没做成」聚合查看 */
export type ErrorCategory =
  | "tool_execution" // 工具调用失败/被拒/超时（用户最关心的"指令没执行"）
  | "tool_unavailable" // 工具能力不可用（MCP 未就绪、未匹配到窗口等）
  | "realtime" // 实时语音链路
  | "vision" // 屏幕视觉链路
  | "desktop_control" // 鼠标键盘控制
  | "network" // 网络请求
  | "config" // 配置
  | "updater" // 自动更新
  | "renderer" // 渲染进程
  | "internal"; // 其他未归类

export interface ErrorRecord {
  ts: string;
  category: ErrorCategory;
  /** 子系统/来源模块，例如 "Orchestrator"、"MCP"、"Vision" */
  source: string;
  message: string;
  /** 是否已被应用自动处理（可自动恢复的标记为 true，避免误导为致命错误） */
  handled: boolean;
  /** 关联的工具名（工具类错误时填写） */
  tool?: string;
  /** 结构化上下文，便于复现 */
  context?: Record<string, unknown>;
}

const MAX_BYTES = 2 * 1024 * 1024; // 单文件 2MB
const MAX_FILES = 3; // 滚动保留份数
const THROTTLE_WINDOW_MS = 5000; // 同类消息限流窗口
/** 限流表条目上限：超过即按 LRU 淘汰，避免高频唯一 key 让 Map 无限增长 */
const MAX_THROTTLE_ENTRIES = 500;
/** errors.jsonl 留存清理时保留的最大行数（大小轮转已限制文件体积，这里再兜底） */
const MAX_ERROR_LINES = 100_000;
/** 错误日志默认留存天数（未由配置注入时使用） */
const DEFAULT_RETENTION_DAYS = 30;
/** 高频噪音：这些子串命中时不写 errors.jsonl（它们是正常/可预期的回执） */
const NOISE_PATTERNS = [/no ongoing response to cancel/i, /commit when server vad/i, /ongoing response already exists/i];

/**
 * 归一化限流 key：把消息中每次都会变化的部分替换为占位符，
 * 让「同类消息」稳定命中同一个 key。
 *
 * 顺序很重要：先处理含数字/分隔符的时间戳、UUID、路径，再处理十六进制 ID，
 * 最后才把裸数字替换掉，避免前一步的占位符被后续规则破坏。
 */
function normalizeThrottleKey(raw: string): string {
  return raw
    // ISO 时间戳（含毫秒与可选时区）
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    // UUID
    .replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, "<id>")
    // 绝对路径：Windows 盘符 / UNC / POSIX
    .replace(/[A-Za-z]:\\[^\s"']*/g, "<path>")
    .replace(/\\\\[^\s"']*/g, "<path>")
    .replace(/\/(?:[\w.-]+\/)+[\w.-]*/g, "<path>")
    // 十六进制 ID（0x 前缀或 8 位以上纯 hex）
    .replace(/\b0x[0-9a-fA-F]+\b/g, "<id>")
    .replace(/\b[0-9a-fA-F]{8,}\b/g, "<id>")
    // 其余数字串（计数、端口、耗时、递增序号等）
    .replace(/\d+/g, "<n>");
}

class Logger {
  private logFilePath: string;
  private errorFilePath: string;
  private logDir: string;
  /** 限流表：key -> {count, lastTs, suppressed}；按 LRU 淘汰，容量上限见 MAX_THROTTLE_ENTRIES */
  private throttle = new Map<string, { count: number; lastTs: number; suppressed: number }>();
  /** 当前文件已写字节数（避免每次 stat） */
  private writtenBytes = 0;
  /** errors.jsonl 已写字节数（用于同样的按大小轮转） */
  private errorWrittenBytes = 0;
  /** 错误日志留存天数，由 ConfigManager 在加载配置后注入 */
  private retentionDays = DEFAULT_RETENTION_DAYS;
  /** errors.jsonl 行缓存：按 mtime+size 失效，避免面板轮询时反复全量同步读取 */
  private errorCache: { mtimeMs: number; size: number; lines: string[] } | null = null;

  constructor() {
    let dir: string;
    try {
      dir = path.join(userDataDir(), "logs");
    } catch {
      dir = path.join(process.cwd(), "logs");
    }
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.logDir = dir;
    this.logFilePath = path.join(dir, "jarvis-orb.log");
    this.errorFilePath = path.join(dir, "errors.jsonl");
    try {
      this.writtenBytes = fs.existsSync(this.logFilePath) ? fs.statSync(this.logFilePath).size : 0;
    } catch {
      this.writtenBytes = 0;
    }
    try {
      this.errorWrittenBytes = fs.existsSync(this.errorFilePath) ? fs.statSync(this.errorFilePath).size : 0;
    } catch {
      this.errorWrittenBytes = 0;
    }
  }

  /**
   * 通用按大小轮转：filePath -> .1 -> .2 ...，返回轮转后应作为起点的已写字节数。
   * 主日志与 errors.jsonl 共用同一套轮转策略。
   */
  private rotateFileIfNeeded(filePath: string, written: number, nextLen: number): number {
    if (written + nextLen <= MAX_BYTES) return written;
    try {
      for (let i = MAX_FILES - 1; i >= 1; i--) {
        const from = i === 1 ? filePath : `${filePath}.${i - 1}`;
        const to = `${filePath}.${i}`;
        if (fs.existsSync(from)) {
          if (fs.existsSync(to)) fs.unlinkSync(to);
          fs.renameSync(from, to);
        }
      }
    } catch {
      /* 轮转失败也不能影响写日志本身 */
    }
    return 0;
  }

  /** 超限则滚动：jarvis-orb.log -> .1 -> .2 ... */
  private rotateIfNeeded(nextLen: number): void {
    this.writtenBytes = this.rotateFileIfNeeded(this.logFilePath, this.writtenBytes, nextLen);
  }

  private write(level: string, message: string, ...args: any[]) {
    const timestamp = new Date().toISOString();
    const formattedArgs = args.length
      ? " " + args.map((a) => (typeof a === "object" ? safeStringify(a) : String(a))).join(" ")
      : "";
    const logLine = `[${timestamp}] [${level}] ${message}${formattedArgs}\n`;

    // 控制台输出
    if (level === "ERROR") console.error(logLine.trimEnd());
    else if (level === "WARN") console.warn(logLine.trimEnd());
    else console.log(logLine.trimEnd());

    // 限流：同类消息在窗口期内只落盘一次。
    // key 先做归一化（时间戳/路径/数字/十六进制 ID 等替换为占位符），否则含时间戳或
    // ID 的高频消息每次 key 都不同，限流形同失效且限流表会无限增长。
    const key = normalizeThrottleKey(`${level}|${message}`).slice(0, 200);
    const now = Date.now();
    const rec = this.throttle.get(key);
    if (rec) {
      // LRU：命中即移到 Map 末尾，保证淘汰的是最久未使用的条目
      this.throttle.delete(key);
      this.throttle.set(key, rec);
      if (now - rec.lastTs < THROTTLE_WINDOW_MS) {
        rec.count += 1;
        rec.lastTs = now;
        return; // 抑制写盘
      }
    }
    let suffix = "";
    if (rec) {
      suffix = `  （本窗口内同类消息出现 ${rec.count} 次，已合并）\n`;
      rec.count = 1;
      rec.lastTs = now;
    } else {
      this.throttle.set(key, { count: 1, lastTs: now, suppressed: 0 });
      // 上限 + LRU 淘汰：超过容量时移除最久未使用的条目
      if (this.throttle.size > MAX_THROTTLE_ENTRIES) {
        const oldest = this.throttle.keys().next().value;
        if (oldest !== undefined) this.throttle.delete(oldest);
      }
    }

    const payload = logLine + suffix;
    try {
      this.rotateIfNeeded(Buffer.byteLength(payload));
      fs.appendFileSync(this.logFilePath, payload, "utf-8");
      this.writtenBytes += Buffer.byteLength(payload);
    } catch (e) {
      console.error("Failed to write to log file:", e);
    }
  }

  info(message: string, ...args: any[]) {
    this.write("INFO", message, ...args);
  }

  warn(message: string, ...args: any[]) {
    this.write("WARN", message, ...args);
  }

  /**
   * 写一条普通错误（不分类）。
   * 需要归类统计时请用 errorCategorized()。
   */
  error(message: string, ...args: any[]) {
    this.write("ERROR", message, ...args);
  }

  /**
   * 写一条**分类错误**：既写人类可读日志，也追加到 errors.jsonl。
   * 这样排查「哪类指令没执行成功」时可以直接按 category / tool 过滤。
   */
  errorCategorized(
    category: ErrorCategory,
    source: string,
    message: string,
    opts: { handled?: boolean; tool?: string; context?: Record<string, unknown> } = {}
  ): void {
    this.write("ERROR", `[${category}] [${source}] ${message}`, opts.context ?? "");
    if (NOISE_PATTERNS.some((re) => re.test(message))) return;

    const rec: ErrorRecord = {
      ts: new Date().toISOString(),
      category,
      source,
      message: String(message).slice(0, 2000),
      handled: opts.handled ?? false,
      tool: opts.tool,
      context: opts.context,
    };
    const payload = safeStringify(rec) + "\n";
    try {
      const len = Buffer.byteLength(payload);
      // 与主日志同一套按大小轮转，避免 errors.jsonl 无限增长
      this.errorWrittenBytes = this.rotateFileIfNeeded(this.errorFilePath, this.errorWrittenBytes, len);
      fs.appendFileSync(this.errorFilePath, payload, "utf-8");
      this.errorWrittenBytes += len;
    } catch (e) {
      console.error("Failed to write error log:", e);
    }
  }

  /** 设置日志留存天数（由 ConfigManager 加载配置后注入，避免 logger 反向依赖 config） */
  setRetentionDays(days: number): void {
    const n = Math.floor(Number(days));
    this.retentionDays = Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
  }

  /** 按留存策略清理 errors.jsonl（启动时调用一次即可） */
  pruneErrorLog(): { removed: number; kept: number } {
    try {
      const r = pruneJsonlFile(this.errorFilePath, { retentionDays: this.retentionDays, maxLines: MAX_ERROR_LINES });
      this.errorWrittenBytes = fs.existsSync(this.errorFilePath) ? fs.statSync(this.errorFilePath).size : 0;
      this.errorCache = null;
      return r;
    } catch {
      return { removed: 0, kept: 0 };
    }
  }

  getLogPath(): string {
    return this.logFilePath;
  }

  getErrorPath(): string {
    return this.errorFilePath;
  }

  getLogDir(): string {
    return this.logDir;
  }

  /**
   * 读取 errors.jsonl 的非空行（带内存缓存）。
   * 缓存按文件 mtime+size 失效，避免 DIAG_ERRORS 被面板轮询时反复做全量同步 IO。
   */
  private readErrorLines(): string[] {
    try {
      if (!fs.existsSync(this.errorFilePath)) {
        this.errorCache = null;
        return [];
      }
      const st = fs.statSync(this.errorFilePath);
      const cached = this.errorCache;
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.lines;
      const lines = fs.readFileSync(this.errorFilePath, "utf-8").split("\n").filter((l) => l.trim().length > 0);
      this.errorCache = { mtimeMs: st.mtimeMs, size: st.size, lines };
      return lines;
    } catch {
      return [];
    }
  }

  /** 读取分类错误的聚合统计（供设置面板展示"最近哪类问题最多"） */
  summarizeErrors(limit = 200): Array<{ category: string; source: string; count: number; lastMessage: string; lastTs: string }> {
    const out = new Map<string, { category: string; source: string; count: number; lastMessage: string; lastTs: string }>();
    for (const line of this.readErrorLines().slice(-limit)) {
      let r: ErrorRecord;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      const key = `${r.category}|${r.source}`;
      const cur = out.get(key);
      if (cur) {
        cur.count += 1;
        cur.lastMessage = r.message;
        cur.lastTs = r.ts;
      } else {
        out.set(key, { category: r.category, source: r.source, count: 1, lastMessage: r.message, lastTs: r.ts });
      }
    }
    return [...out.values()].sort((a, b) => b.count - a.count);
  }

  /** 读取最近的分类错误明细 */
  recentErrors(limit = 50): ErrorRecord[] {
    return this.readErrorLines()
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as ErrorRecord;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as ErrorRecord[];
  }

  clearErrors(): void {
    try {
      if (fs.existsSync(this.errorFilePath)) fs.unlinkSync(this.errorFilePath);
    } catch {
      /* ignore */
    }
    this.errorWrittenBytes = 0;
    this.errorCache = null;
  }
}

/** 安全序列化：循环引用/Error 对象不抛错 */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => {
      if (val instanceof Error) return { name: val.name, message: val.message };
      if (typeof val === "bigint") return String(val);
      return val;
    });
  } catch {
    return String(v);
  }
}

export const logger = new Logger();
