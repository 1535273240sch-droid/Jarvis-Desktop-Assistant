/**
 * 日志脱敏与留存（项目书 P0）。
 *
 * 要求：audit.jsonl、错误日志、长期记忆和工具结果默认不记录
 *   消息正文、图片内容、密码、验证码、API Key；
 * 仅保留任务 ID、动作类别、目标标识的必要摘要、结果和时间。
 * 本模块为纯函数（零依赖），可在 CI 直接单测。
 */

/** 键名命中即视为敏感字段（其值整体掩码） */
const SENSITIVE_KEY_RE = /(password|passwd|pwd|secret|token|api[-_]?key|apikey|authorization|credential|验证码|密码|口令|授权码)/i;

/** 消息正文类字段：默认不记录（只留长度摘要） */
const CONTENT_KEY_RE = /^(message|content|text|body|draft|正文|消息内容)$/i;

/** 常见密钥格式（在自由文本中出现时掩码） */
const SECRET_VALUE_RE =
  /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;

/** 独立的 6-11 位数字串：验证码/手机号/银行卡形态（保留前后各 1 位便于核对） */
const OTP_PHONE_RE = /(?<![\dA-Za-z])(\d{6,11})(?![\dA-Za-z])/g;

function maskValue(v: string, keep = 0): string {
  if (keep > 0 && v.length > keep) return `${v.slice(0, keep)}***【已脱敏】`;
  return "***【已脱敏】";
}

/** 对自由文本做脱敏：密钥整段掩码；疑似验证码/手机号掩码 */
export function redactText(text: string): string {
  if (!text) return text;
  let out = String(text);
  out = out.replace(SECRET_VALUE_RE, (m) => maskValue(m, 4));
  out = out.replace(OTP_PHONE_RE, (m) => maskValue(m, 2));
  return out;
}

/** 对工具参数对象做深度脱敏：敏感键掩码、正文类键只留长度 */
export function redactArgs(args: unknown, depth = 0): unknown {
  if (depth > 6) return "***【已脱敏】";
  if (args === null || args === undefined) return args;
  if (typeof args === "string") return redactText(args);
  if (typeof args === "number" || typeof args === "boolean") return args;
  if (Array.isArray(args)) return args.map((a) => redactArgs(a, depth + 1));
  if (typeof args === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = maskValue(typeof v === "string" ? v : JSON.stringify(v ?? ""));
      } else if (CONTENT_KEY_RE.test(k)) {
        const len = typeof v === "string" ? v.length : JSON.stringify(v ?? "").length;
        out[k] = `[正文不记录，长度 ${len}]`;
      } else {
        out[k] = redactArgs(v, depth + 1);
      }
    }
    return out;
  }
  return "***【已脱敏】";
}

/**
 * 审计日志留存：按保留天数裁剪 JSONL 文件（只保留最近 N 天 + 最多 maxLines 行）。
 * 启动时与每日各执行一次即可；失败静默（审计写不进也比把主进程搞挂强）。
 */
export function pruneJsonlFile(
  filePath: string,
  opts: { retentionDays: number; maxLines?: number; now?: Date }
): { removed: number; kept: number } {
  const fs = require("node:fs") as typeof import("node:fs");
  const maxLines = opts.maxLines ?? 200_000;
  const now = opts.now ?? new Date();
  if (!fs.existsSync(filePath)) return { removed: 0, kept: 0 };
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { removed: 0, kept: 0 };
  }
  const lines = raw.split("\n");
  const cutoff = now.getTime() - opts.retentionDays * 24 * 3600 * 1000;
  const keptLines: string[] = [];
  let removed = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let ts = 0;
    try {
      const obj = JSON.parse(t);
      ts = obj.ts ? Date.parse(obj.ts) : 0;
    } catch {
      ts = 0;
    }
    // 无时间戳的行保留（无法判定，宁多勿丢）
    if (ts && ts < cutoff) {
      removed += 1;
      continue;
    }
    keptLines.push(t);
  }
  let kept = keptLines.length;
  let finalLines = keptLines;
  if (kept > maxLines) {
    removed += kept - maxLines;
    finalLines = keptLines.slice(kept - maxLines);
    kept = maxLines;
  }
  if (removed > 0) {
    try {
      fs.writeFileSync(filePath, finalLines.join("\n") + "\n", "utf-8");
    } catch {
      return { removed: 0, kept };
    }
  }
  return { removed, kept };
}
