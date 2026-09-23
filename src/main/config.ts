import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { app } from "electron";
import { logger } from "./logger";
import type { JarvisConfig } from "../common/types";

/**
 * 获取系统推荐的安全工作目录作为默认白名单
 *
 * Win11 上「桌面/文档/下载」经常被 OneDrive 重定向到
 *   C:\Users\X\OneDrive\Desktop
 * 此时 os.homedir()\Desktop 并不存在。原实现只探测常规路径，
 * 会把白名单缩到只剩 process.cwd()，助手因此访问不到用户真正的桌面与文档。
 * 这里补上 OneDrive 候选，并在全部落空时退回家目录。
 */
function getDefaultAllowedDirs(): string[] {
  const dirs: string[] = [];
  const push = (p: string): void => {
    try {
      if (p && fs.existsSync(p) && !dirs.includes(p)) dirs.push(p);
    } catch {
      /* ignore */
    }
  };

  try {
    const home = os.homedir();
    const sub = ["Desktop", "Downloads", "Documents"];

    // 常规位置
    for (const s of sub) push(path.join(home, s));

    // OneDrive 重定向位置（名称随语言/账户而异）
    for (const od of ["OneDrive", "OneDrive - Personal", "OneDrive - 个人", "OneDrive - 公司"]) {
      for (const s of sub) push(path.join(home, od, s));
    }

    // 兜底：常规与 OneDrive 都没命中时退回家目录，避免白名单过窄导致文件能力不可用
    if (!dirs.length) push(home);
  } catch {
    /* ignore */
  }

  const cwd = process.cwd();
  if (cwd && !dirs.includes(cwd)) dirs.push(cwd);
  return dirs;
}

/**
 * 默认人设与行为准则。
 *
 * 这里针对实测中暴露的「工具选错」问题做了显式规定：
 * 用户说「打开浏览器/打开计算器」时，模型原先会去点击桌面图标
 * （而且是单击，图标不会启动），失败后再反复看屏幕重试。
 * 正确做法是直接用 start_process 启动程序，不要靠点图标。
 */
export const DEFAULT_INSTRUCTIONS = [
  "你是 Jarvis，运行在 Windows 11 桌面上的智能助理。",
  "",
  "【说话风格：分两种场合】",
  "A. 执行工具/操作电脑时 —— 干脆利落。",
  "   - 不要先长篇解释「我准备怎么做」，直接调用工具。",
  "   - 工具执行完，只用**一句话**确认结果（如「浏览器已打开」），不要复述过程、不要重复工具返回的说明文字。",
  "   - 严禁把工具返回里的提示（例如“请简短告知用户”）念给用户听。",
  "   - 失败时也只用一句话说明原因，不要罗列排查过程。",
  "B. 普通聊天/问答时 —— 可以自然、详细、亲切，正常发挥。",
  "",
  "【工具选用准则（重要）】",
  "1. 打开软件：一律用 open_app（按名称启动，会自动匹配本机真实安装的程序），**不要点击桌面图标**。",
  "2. 打开网址 / 搜索：用 open_url 或 search_web，**不要**先点浏览器再手动打字。",
  "3. 只有用户明确说「点击那个按钮/图标」时才用 click_on_screen；点桌面图标必须用双击（button=double）。",
  "4. 需要「输入文字后搜索/发送」时，type_text 要带 submit=true（会自动按回车）。",
  "5. 问时间用 get_current_time，问天气用 get_weather，要求「记住」用 remember_fact。",
  "6. 文件读写、目录操作、跑命令、全文搜索用 MCP 工具（read_file/write_file/list_directory/start_search 等）。",
  "7. 不要凭空猜测文件路径或用户名。不确定用户目录时，先用 list_directory 查看，或使用工具返回里给出的真实路径。",
  "",
  "【执行纪律】",
  "- 只有真正调用工具并拿到成功结果后，才能说「已经完成」。工具报错或没执行时，必须如实告知，不要假装成功。",
  "- 同一手法失败不要反复重试；换一种方式（例如改用 open_app）或如实说明失败原因。",
  "- 涉及删除、支付、提交等不可逆操作前，先向用户复述将要做什么。",
].join("\n");

/** 历史默认人设（用于迁移判断：只有仍是这个值的用户才自动升级） */
const LEGACY_DEFAULT_INSTRUCTIONS =
  "你是 Jarvis，运行在 Windows 11 桌面上的智能助理。回答自然、亲切、简练；需要操作电脑时调用工具，执行前简要说明你要做什么。";

export const DEFAULT_CONFIG: JarvisConfig = {
  configVersion: 3,
  apiKey: "",
  // 模型 ID 必须可配置：preview 版存在下线风险，切换不应改代码
  realtimeModel: "stepaudio-3-realtime-preview",
  realtimeBaseUrl: "wss://api.stepfun.com/v1/realtime",
  // 音色 ID：实测可用值为 cixingnansheng（磁性男声）、zhengpaiqingnian（正派青年）、wenrounvsheng（温柔女声）等。
  voice: "cixingnansheng",
  instructions: DEFAULT_INSTRUCTIONS,
  // 视觉模型：实测 step-5-preview 与 step-3.7-flash 均支持图像输入，也可自定义为第三方模型。
  visionModel: "step-5-preview",
  visionBaseUrl: "https://api.stepfun.com/step_plan/v1/chat/completions",
  visionApiKey: "",
  allowedDirectories: getDefaultAllowedDirs(),
  mcpEnabled: true,
  confirmHighRisk: false,
  previewDelayMs: 700,
  allowSensitiveInput: true,
  emergencyStopAccelerator: "Control+Alt+X",
  // 自动更新默认关闭：见 types.ts 中 autoUpdate 的说明
  autoUpdate: false,
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

    // 配置版本迁移：旧版本（无 configVersion 字段）默认开启逐次人工确认，
    // 会覆盖新的「全自动」默认值，表现为"明明设了全自动还弹窗/被拒"。
    // 这里对旧配置做一次性升级，之后用户可在设置面板里自行改回。
    const storedVersion = (stored as any).configVersion;
    if (storedVersion === undefined || storedVersion < 2) {
      merged.confirmHighRisk = DEFAULT_CONFIG.confirmHighRisk;
      merged.allowSensitiveInput = DEFAULT_CONFIG.allowSensitiveInput;
      logger.info(`[Config] 配置迁移：旧版本(${storedVersion ?? "无"}) -> 2，已切换为全自动执行模式`);
    }

    // v3 迁移：早期版本会在启动后自动检查更新，把本地源码修复覆盖成上游版本。
    // 这里显式关闭，之后由用户在设置面板按需打开。
    let migrated = false;
    if (storedVersion === undefined || storedVersion < 3) {
      merged.autoUpdate = false;
      // 同步升级「仍是旧默认值」的人设。旧默认提示词没有工具选用准则，
      // 实测会导致「打开浏览器」时去单击桌面图标（图标不会启动）而不是用
      // start_process，失败后反复看屏幕重试。用户自定义过的提示词保持不动。
      const storedInstr = typeof stored.instructions === "string" ? stored.instructions.trim() : "";
      if (!storedInstr || storedInstr === LEGACY_DEFAULT_INSTRUCTIONS) {
        merged.instructions = DEFAULT_INSTRUCTIONS;
        logger.info("[Config] 配置迁移：人设已升级为带工具选用准则的新版本");
      }
      logger.info("[Config] 配置迁移：已关闭自动更新（避免本地修复被上游版本覆盖）");
      migrated = true;
    }

    if (migrated) {
      // 迁移结果必须落盘，否则 configVersion 一直是旧值，
      // 每次启动都重复迁移，且人设升级在下次启动时会被旧文件覆盖回去。
      // 这里只打标记，等下面白名单规范化完成后再统一写盘，
      // 避免把未规范化的目录持久化。
      merged.configVersion = DEFAULT_CONFIG.configVersion;
    }

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

    // 迁移结果在白名单规范化之后统一落盘
    if (migrated) {
      try {
        fs.writeFileSync(this.filePath, JSON.stringify(merged, null, 2), "utf-8");
        logger.info(`[Config] 配置迁移已落盘（configVersion -> ${merged.configVersion}）`);
      } catch (e) {
        logger.warn("[Config] 迁移结果写盘失败（本次仍以迁移后配置运行）:", e);
      }
    }

    return merged;
  }

  /** 获取完整配置（内部使用，含明文 Key） */
  get(): JarvisConfig {
    return { ...this.config, allowedDirectories: [...this.config.allowedDirectories] };
  }

  /** 保存部分配置 */
  set(patch: Partial<JarvisConfig>): JarvisConfig {
    // 传空的 instructions 表示「恢复默认人设」，避免前端硬编码默认文案
    if (patch.instructions !== undefined && !String(patch.instructions).trim()) {
      patch = { ...patch, instructions: DEFAULT_INSTRUCTIONS };
    }
    // 用户显式保存时，一律带上最新版本号，避免下次启动被再次迁移覆盖
    this.config = { ...this.config, ...patch, configVersion: DEFAULT_CONFIG.configVersion };
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
