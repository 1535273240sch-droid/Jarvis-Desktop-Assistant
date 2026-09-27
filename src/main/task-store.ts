import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "./logger";
import { userDataDir } from "./user-path";
import type { DesktopTask, TaskStatus } from "../common/types";

/**
 * 桌面任务持久化（项目书 P1）。
 *
 * - 每次状态/步骤变化即落盘（tasks.json），崩溃后可恢复；
 * - 重启后未完成任务一律置为 waiting_user（已暂停），由用户决定继续或取消，
 *   **绝不自动重放可能产生副作用的步骤**（项目书 §2.1/A8）；
 * - 文件写入为原子替换（tmp + rename），避免半截 JSON。
 */

function tasksDir(): string {
  try {
    return path.join(userDataDir(), "tasks");
  } catch {
    return path.join(process.cwd(), "tasks");
  }
}

class TaskStore {
  private filePath: string;

  constructor() {
    this.filePath = path.join(tasksDir(), "tasks.json");
  }

  getPath(): string {
    return this.filePath;
  }

  loadAll(): DesktopTask[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const arr = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as DesktopTask[];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      logger.warn("[TaskStore] 任务持久化读取失败:", e);
      return [];
    }
  }

  saveAll(tasks: DesktopTask[]): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this.filePath + ".tmp";
      // 只保留最近 50 个任务，避免无限增长
      const trimmed = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
      fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), "utf-8");
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      logger.warn("[TaskStore] 任务持久化写入失败:", e);
    }
  }

  /** 启动恢复：未完成任务置为 waiting_user（已暂停），等待用户决定 */
  restoreOnStartup(): DesktopTask[] {
    const all = this.loadAll();
    const active: TaskStatus[] = ["queued", "running", "waiting_user"];
    let changed = false;
    for (const t of all) {
      if (active.includes(t.status)) {
        t.status = "waiting_user";
        t.progressNote = "应用重启，任务已暂停。请检查桌面状态后选择「继续」或「取消」。";
        t.confirm = t.confirm ?? null;
        changed = true;
      }
    }
    if (changed) this.saveAll(all);
    return all;
  }
}

export const taskStore = new TaskStore();
