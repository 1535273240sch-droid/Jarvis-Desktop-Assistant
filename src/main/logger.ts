import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";

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
/** 高频噪音：这些子串命中时不写 errors.jsonl（它们是正常/可预期的回执） */
const NOISE_PATTERNS = [/no ongoing response to cancel/i, /commit when server vad/i, /ongoing response already exists/i];

class Logger {
  private logFilePath: string;
  private errorFilePath: string;
  private logDir: string;
  /** 限流表：key -> {count, lastTs, suppressed} */
  private throttle = new Map<string, { count: number; lastTs: number; suppressed: number }>();
  /** 当前文件已写字节数（避免每次 stat） */
  private writtenBytes = 0;

  constructor() {
    let dir: string;
    try {
      dir = path.join(app?.getPath("userData") || process.cwd(), "logs");
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
  }

  /** 超限则滚动：jarvis-orb.log -> .1 -> .2 ... */
  private rotateIfNeeded(nextLen: number): void {
    if (this.writtenBytes + nextLen <= MAX_BYTES) return;
    try {
      for (let i = MAX_FILES - 1; i >= 1; i--) {
        const from = i === 1 ? this.logFilePath : `${this.logFilePath}.${i - 1}`;
        const to = `${this.logFilePath}.${i}`;
        if (fs.existsSync(from)) {
          if (fs.existsSync(to)) fs.unlinkSync(to);
          fs.renameSync(from, to);
        }
      }
      this.writtenBytes = 0;
    } catch {
      this.writtenBytes = 0;
    }
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

    // 限流：同类消息在窗口期内只落盘一次
    const key = `${level}|${message.slice(0, 120)}`;
    const now = Date.now();
    const rec = this.throttle.get(key);
    if (rec && now - rec.lastTs < THROTTLE_WINDOW_MS) {
      rec.count += 1;
      rec.lastTs = now;
      return; // 抑制写盘
    }
    let suffix = "";
    if (rec) {
      suffix = `  （本窗口内同类消息出现 ${rec.count} 次，已合并）\n`;
      rec.count = 1;
      rec.lastTs = now;
    } else {
      this.throttle.set(key, { count: 1, lastTs: now, suppressed: 0 });
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
    try {
      fs.appendFileSync(this.errorFilePath, safeStringify(rec) + "\n", "utf-8");
    } catch (e) {
      console.error("Failed to write error log:", e);
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

  /** 读取分类错误的聚合统计（供设置面板展示"最近哪类问题最多"） */
  summarizeErrors(limit = 200): Array<{ category: string; source: string; count: number; lastMessage: string; lastTs: string }> {
    const out = new Map<string, { category: string; source: string; count: number; lastMessage: string; lastTs: string }>();
    try {
      if (!fs.existsSync(this.errorFilePath)) return [];
      const lines = fs.readFileSync(this.errorFilePath, "utf-8").trim().split("\n").filter(Boolean);
      for (const line of lines.slice(-limit)) {
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
    } catch {
      return [];
    }
    return [...out.values()].sort((a, b) => b.count - a.count);
  }

  /** 读取最近的分类错误明细 */
  recentErrors(limit = 50): ErrorRecord[] {
    try {
      if (!fs.existsSync(this.errorFilePath)) return [];
      const lines = fs.readFileSync(this.errorFilePath, "utf-8").trim().split("\n").filter(Boolean);
      return lines
        .slice(-limit)
        .map((l) => {
          try {
            return JSON.parse(l) as ErrorRecord;
          } catch {
            return null;
          }
        })
        .filter(Boolean) as ErrorRecord[];
    } catch {
      return [];
    }
  }

  clearErrors(): void {
    try {
      if (fs.existsSync(this.errorFilePath)) fs.unlinkSync(this.errorFilePath);
    } catch {
      /* ignore */
    }
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
