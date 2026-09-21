import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { app } from "electron";
import { logger } from "./logger";
import type { JarvisConfig } from "../common/types";

/**
 * 获取系统推荐的安全工作目录作为默认白名单
 */
function getDefaultAllowedDirs(): string[] {
  const dirs: string[] = [];
  try {
    const home = os.homedir();
    const desktop = path.join(home, "Desktop");
    if (fs.existsSync(desktop)) dirs.push(desktop);
    const downloads = path.join(home, "Downloads");
    if (fs.existsSync(downloads)) dirs.push(downloads);
    const documents = path.join(home, "Documents");
    if (fs.existsSync(documents)) dirs.push(documents);
  } catch {
    /* ignore */
  }
  const cwd = process.cwd();
  if (cwd && !dirs.includes(cwd)) dirs.push(cwd);
  return dirs;
}

/**
 * 配置管理。
 *
 * 红线：API Key 绝不硬编码、绝不写入日志、绝不提交仓库。
 * Key 来源优先级：环境变量 STEPFUN_API_KEY > userData/config.json。
 */

export const DEFAULT_CONFIG: JarvisConfig = {
  apiKey: "",
  // 模型 ID 必须可配置：preview 版存在下线风险，切换不应改代码
  realtimeModel: "stepaudio-3-realtime-preview",
  realtimeBaseUrl: "wss://api.stepfun.com/v1/realtime",
  // 音色 ID：实测可用值为 cixingnansheng（磁性男声）、zhengpaiqingnian（正派青年）、wenrounvsheng（温柔女声）等。
  voice: "cixingnansheng",
  instructions:
    "你是 Jarvis，运行在 Windows 11 桌面上的智能助理。回答自然、亲切、简练；需要操作电脑时调用工具，执行前简要说明你要做什么。",
  // 视觉模型：实测 step-5-preview 与 step-3.7-flash 均支持图像输入，也可自定义为第三方模型。
  visionModel: "step-5-preview",
  visionBaseUrl: "https://api.stepfun.com/step_plan/v1/chat/completions",
  visionApiKey: "",
  allowedDirectories: getDefaultAllowedDirs(),
  mcpEnabled: true,
  confirmHighRisk: true,
  previewDelayMs: 700,
  allowSensitiveInput: false,
  emergencyStopAccelerator: "Control+Alt+X",
};

class ConfigManager {
  private filePath: string;
  private config: JarvisConfig;

  constructor() {
    let dir: string;
    try {
      dir = app?.getPath("userData") || process.cwd();
    } catch {
      dir = process.cwd();
    }
    this.filePath = path.join(dir, "config.json");
    this.config = this.load();
  }

  private load(): JarvisConfig {
    let stored: Partial<JarvisConfig> = {};
    try {
      if (fs.existsSync(this.filePath)) {
        stored = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      }
    } catch (e) {
      logger.warn("config.json 读取失败，使用默认配置:", e);
    }

    const envKey = process.env.STEPFUN_API_KEY || "";
    const merged: JarvisConfig = {
      ...DEFAULT_CONFIG,
      ...stored,
      apiKey: envKey || stored.apiKey || "",
    };

    // 白名单目录做一次规范化与存在性过滤
    let allowed = (merged.allowedDirectories || [])
      .map((d) => {
        try {
          return path.resolve(d);
        } catch {
          return "";
        }
      })
      .filter((d) => d && fs.existsSync(d));

    if (!allowed.length) {
      allowed = getDefaultAllowedDirs();
    }
    merged.allowedDirectories = allowed;

    return merged;
  }

  /** 获取完整配置（内部使用，含明文 Key） */
  get(): JarvisConfig {
    return { ...this.config, allowedDirectories: [...this.config.allowedDirectories] };
  }

  /** 保存部分配置 */
  set(patch: Partial<JarvisConfig>): JarvisConfig {
    this.config = { ...this.config, ...patch };
    this.config.allowedDirectories = (this.config.allowedDirectories || []).filter(
      (d) => typeof d === "string" && d.trim().length > 0
    );
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), "utf-8");
      logger.info("配置已保存:", this.getMasked());
    } catch (e) {
      logger.error("配置保存失败:", e);
    }
    return this.get();
  }

  /** 脱敏视图：可安全下发给渲染进程或写日志 */
  getMasked(): Record<string, unknown> {
    const c = this.get();
    return {
      ...c,
      apiKey: c.apiKey ? `***${c.apiKey.slice(-4)}` : "",
      apiKeyPresent: c.apiKey.length > 0,
      visionApiKey: c.visionApiKey ? `***${c.visionApiKey.slice(-4)}` : "",
      visionApiKeyPresent: Boolean(c.visionApiKey && c.visionApiKey.length > 0),
    };
  }

  hasApiKey(): boolean {
    return this.config.apiKey.trim().length > 0;
  }

  getConfigPath(): string {
    return this.filePath;
  }
}

export const configManager = new ConfigManager();
