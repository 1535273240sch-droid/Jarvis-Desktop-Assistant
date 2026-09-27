import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "./logger";
import { userDataDir } from "./user-path";
import { redactText } from "./log-redact";

/**
 * 任务产物存储（项目书 P1：长任务结果不依赖一次 MCP 调用、不因 8000 字符截断丢失）。
 *
 * - 落盘位置：userData/tasks/artifacts/<taskId>/；
 * - 每个文件有元信息（来源、抓取时间、字节数），支持分页读取；
 * - 面板与模型都通过 readPage(taskId, fileName, page, pageSize) 分页取内容。
 */

export interface ArtifactInfo {
  file: string;
  title: string;
  source?: string;
  bytes: number;
  createdAt: number;
}

function artifactsRoot(): string {
  try {
    return path.join(userDataDir(), "tasks", "artifacts");
  } catch {
    return path.join(process.cwd(), "tasks", "artifacts");
  }
}

function taskDir(taskId: string): string {
  const dir = path.join(artifactsRoot(), taskId.replace(/[^A-Za-z0-9_-]/g, "_"));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 安全化文件名 */
function safeName(name: string): string {
  const n = name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  return n || "artifact.txt";
}

export const taskArtifacts = {
  /** 保存一份文本产物（自动加元信息头），返回相对文件名 */
  saveText(taskId: string, fileName: string, title: string, content: string, source?: string): string {
    const dir = taskDir(taskId);
    const file = safeName(fileName);
    const header = [
      `# ${title}`,
      source ? `# 来源: ${source}` : "",
      `# 保存时间: ${new Date().toISOString()}`,
      `# 字符数: ${content.length}`,
      "",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      fs.writeFileSync(path.join(dir, file), header + content, "utf-8");
    } catch (e) {
      logger.warn("[Artifacts] 产物写入失败:", e);
    }
    return file;
  },

  /** 保存 JSON 产物 */
  saveJson(taskId: string, fileName: string, title: string, data: unknown): string {
    return this.saveText(taskId, fileName, title, JSON.stringify(data, null, 2));
  },

  list(taskId: string): ArtifactInfo[] {
    const dir = path.join(artifactsRoot(), taskId.replace(/[^A-Za-z0-9_-]/g, "_"));
    if (!fs.existsSync(dir)) return [];
    const out: ArtifactInfo[] = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        const st = fs.statSync(p);
        let title = f;
        let source: string | undefined;
        try {
          const head = fs.readFileSync(p, "utf-8").slice(0, 300);
          const m1 = head.match(/^# (.+)$/m);
          if (m1) title = m1[1];
          const m2 = head.match(/^# 来源: (.+)$/m);
          if (m2) source = redactText(m2[1]);
        } catch {
          /* ignore */
        }
        out.push({ file: f, title, source, bytes: st.size, createdAt: st.mtimeMs });
      }
    } catch {
      /* ignore */
    }
    return out.sort((a, b) => a.file.localeCompare(b.file));
  },

  /** 分页读取（1-based）。供面板与模型的 read_task_result 工具使用 */
  readPage(taskId: string, fileName: string, page = 1, pageSize = 4000): { total: number; page: number; content: string; file: string } | null {
    const dir = path.join(artifactsRoot(), taskId.replace(/[^A-Za-z0-9_-]/g, "_"));
    const p = path.join(dir, safeName(fileName));
    try {
      if (!fs.existsSync(p)) return null;
      const text = fs.readFileSync(p, "utf-8");
      const total = Math.max(1, Math.ceil(text.length / pageSize));
      const pg = Math.min(Math.max(1, page), total);
      const content = text.slice((pg - 1) * pageSize, pg * pageSize);
      return { total, page: pg, content, file: fileName };
    } catch {
      return null;
    }
  },
};
