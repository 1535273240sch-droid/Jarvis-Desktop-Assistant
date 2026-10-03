import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { app } from "electron";
import { logger } from "./logger";
import type { JarvisConfig } from "../common/types";

/** 悬浮球尺寸允许范围（像素）。窗口 resizable:false，尺寸只由代码设置，此处钳制非法值。 */
export const ORB_SIZE_MIN = 80;
export const ORB_SIZE_MAX = 400;
export const ORB_SIZE_DEFAULT = 260;

/** 把任意输入钳制到合法的球体尺寸区间；非数字回落默认值 */
export function clampOrbSize(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return ORB_SIZE_DEFAULT;
  return Math.min(ORB_SIZE_MAX, Math.max(ORB_SIZE_MIN, n));
}

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
  "【桌面任务（重要）】",
  "8. 复合目标必须用 create_desktop_task 交给任务引擎逐步执行并验收，不要用单次工具调用硬凑，也不要把中间态说成完成：",
  "   - 「搜索X并整理几种方案」→ kind=browser_research；",
  "   - 「打开我的 Agent，让它分析这个仓库/做规划」→ kind=coding_agent（repoUrl 必须是完整 URL；没说清就先问用户）；",
  "   - 「给某人发文字/图片」→ kind=wechat_draft（生成草稿；发送永远由用户在微信里手动完成，Jarvis 不会自动发送）。",
  "9. 任务进度用 get_task_status 查询；完整结果用 read_task_result 分页读取，不要凭记忆复述没读过的内容。",
  "10. 任务面板里的待确认项，只有用户明确表态后才能用 respond_task_confirm 答复；用户没表态就向用户转述待确认内容。",
  "",
  "【信息简报】",
  "11. 用户问新闻、热门项目等资讯时，用 get_briefing；返回的【播报稿】按稿口语播报，不要补充稿外的事实，播报完问一句要不要打开其中某条。",
  "",
  "【一次把话说完】",
  "12. 用户给了包含多步的指令（如「建目录、写文件、再跑一次测试」）时，必须**依次调用工具把每一步都做完**，不要只做第一步就开始汇报。",
  "    每一步都要以工具返回结果为准再决定下一步；全部做完后才给总结。若中途某步失败，如实说明失败在哪一步、已完成什么，不要谎称全部完成。",
  "    用户说「打开前三个」这类复数指令时，要按数量逐个调用，不要只做一次就宣称已全部完成。",
  "",
  "【执行纪律】",
  "- 只有真正调用工具并拿到成功结果后，才能说「已经完成」。工具报错或没执行时，必须如实告知，不要假装成功。",
  "- 同一手法失败不要反复重试；换一种方式（例如改用 open_app）或如实说明失败原因。",
  "- 涉及删除、支付、提交等不可逆操作前，先向用户复述将要做什么。",
].join("\n");

/** 历史默认人设（用于迁移判断：只有仍是这个值的用户才自动升级） */
const LEGACY_DEFAULT_INSTRUCTIONS =
  "你是 Jarvis，运行在 Windows 11 桌面上的智能助理。回答自然、亲切、简练；需要操作电脑时调用工具，执行前简要说明你要做什么。";

/** v3 默认人设（无桌面任务准则）。v4 迁移时仅当用户未改动过才自动升级 */
const LEGACY_DEFAULT_INSTRUCTIONS_V3 = [
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

export const DEFAULT_CONFIG: JarvisConfig = {
  configVersion: 4,
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
  // 审计日志保留天数（项目书 P0：日志留存规则）
  logRetentionDays: 30,
  // 目标软件档案（项目书 §2.2）：微信为内置示例；编码 Agent 只给空白模板，
  // 必须由用户在设置里填自己的 Agent —— 不硬编码任何 Agent 产品名。
  appProfiles: [
    {
      id: "wechat",
      displayName: "微信",
      processNames: ["wechat", "weixin"],
      titleIncludes: ["微信"],
      runningMarkers: [],
      doneMarkers: [],
      submitKeys: "enter",
      resultExtract: "uia_text",
      enabled: true,
    },
    {
      id: "custom-agent",
      displayName: "我的编码 Agent（需在设置中填写）",
      processNames: [],
      titleIncludes: [],
      runningMarkers: [],
      doneMarkers: [],
      submitKeys: "enter",
      resultExtract: "uia_text",
      enabled: false,
    },
  ],
  // 悬浮球主题：siri=经典默认；其余为用户提供的 5 套主题（generate-orb 注入）
  orbTheme: "siri",
  // AI 唱歌：生成歌曲并播放。模型 ID 可配置，preview 版存在下线风险
  musicEnabled: true,
  musicModel: "stepaudio-3-music-preview",
  musicBaseUrl: "https://api.stepfun.com",
  // 悬浮球基准尺寸与「随状态自适应」开关（默认关闭，避免无预期地改变用户看到的球）
  orbSize: ORB_SIZE_DEFAULT,
  orbAutoScale: false,
  // 信息简报：整理模型留空 = 复用视觉模型（见 briefing-runtime.ts 的 getBriefLlm）
  briefEnabled: true,
  briefModel: "",
  briefBaseUrl: "",
  briefNewsFeeds: [],
  // 工具执行看门狗：长任务不应被 60s 掐断，默认放宽到 10 分钟
  toolWatchdogMs: 600_000,
};

// [secret-guard patch] 外部 MCP 服务器配置的脱敏与还原
const SECRET_SENTINEL = "***";
const SECRET_FLAG_RE = /(^|--|-)[^\s=]*(key|token|secret|passwd|password|auth)/i;

/** 对下发给渲染进程/日志的 mcpServers 做深度脱敏：env 值全掩码，args 中疑似密钥值掩码 */
export function redactServerSecrets(servers: unknown): unknown {
  if (!Array.isArray(servers)) return servers;
  return servers.map((s) => {
    if (!s || typeof s !== "object") return s;
    const out = { ...(s as Record<string, unknown>) };
    if (out.env && typeof out.env === "object") {
      const e: Record<string, string> = {};
      for (const k of Object.keys(out.env as Record<string, string>)) e[k] = SECRET_SENTINEL;
      out.env = e;
    }
    if (Array.isArray(out.args)) {
      const args = out.args as unknown[];
      const flagIdx: number[] = [];
      args.forEach((a, i) => {
        if (typeof a === "string" && SECRET_FLAG_RE.test(a)) flagIdx.push(i);
      });
      out.args = args.map((a, i) => {
        if (typeof a !== "string") return a;
        if (flagIdx.includes(i) && a.includes("=")) return a.replace(/=.*$/, `=${SECRET_SENTINEL}`);
        if (flagIdx.some((fi) => fi < i && !String(args[fi]).includes("=") && i === fi + 1)) return SECRET_SENTINEL;
        return a;
      });
    }
    return out;
  });
}

/** 渲染层回传的配置带 *** 哨兵时，用存储中的真实值还原，避免保存后密钥丢失 */
export function restoreServerSecrets(newServers: unknown, oldServers: unknown): unknown {
  if (!Array.isArray(newServers)) return newServers;
  const oldByName = new Map(
    (Array.isArray(oldServers) ? oldServers : [])
      .filter((s): s is Record<string, any> => Boolean(s) && typeof s === "object" && Boolean((s as any).name))
      .map((s) => [(s as any).name as string, s as Record<string, any>])
  );
  return newServers.map((s) => {
    if (!s || typeof s !== "object") return s;
    const item = s as Record<string, any>;
    if (!item.name) return item;
    const old = oldByName.get(item.name);
    if (!old) return item;
    const out = { ...item };
    if (out.env && typeof out.env === "object" && old.env && typeof old.env === "object") {
      const fixed: Record<string, string> = {};
      for (const [k, v] of Object.entries(out.env as Record<string, string>)) {
        fixed[k] = v === SECRET_SENTINEL && (old.env as Record<string, string>)[k] !== undefined ? (old.env as Record<string, string>)[k] : v;
      }
      out.env = fixed;
    }
    if (Array.isArray(out.args) && Array.isArray(old.args)) {
      out.args = (out.args as unknown[]).map((a, i) =>
        a === SECRET_SENTINEL && typeof old.args[i] === "string" && old.args[i] !== SECRET_SENTINEL ? old.args[i] : a
      );
    }
    return out;
  });
}

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

    // v4 迁移：桌面任务体系（logRetentionDays / appProfiles）。只新增字段，
    // 用户显式保存过的其他选择（执行模式、白名单等）一律保留。
    if (storedVersion === undefined || storedVersion < 4) {
      if (merged.logRetentionDays === undefined) merged.logRetentionDays = DEFAULT_CONFIG.logRetentionDays;
      if (!Array.isArray(merged.appProfiles) || !merged.appProfiles.length) {
        merged.appProfiles = DEFAULT_CONFIG.appProfiles;
      }
      // 未改动过的 v3 默认人设升级为带桌面任务准则的版本；自定义过的不动
      const storedInstr4 = typeof stored.instructions === "string" ? stored.instructions.trim() : "";
      if (storedInstr4 === LEGACY_DEFAULT_INSTRUCTIONS_V3) {
        merged.instructions = DEFAULT_INSTRUCTIONS;
        logger.info("[Config] 配置迁移：人设已升级为带桌面任务准则的版本");
      }
      logger.info("[Config] 配置迁移：已启用桌面任务默认配置（v4）");
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
    // [secret-guard patch] 渲染层回传的 mcpServers 可能带 *** 哨兵，用真实值还原
    if (Array.isArray(patch.mcpServers)) {
      patch = {
        ...patch,
        mcpServers: restoreServerSecrets(patch.mcpServers, this.config.mcpServers) as JarvisConfig["mcpServers"],
      };
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

  /**
   * 判断某个键是否在用户配置文件里显式写过。
   * 用于区分「用户设定过的值」与「代码里的默认值」——例如球体尺寸升级兼容：
   * 配置里没写过 orbSize 时，应沿用 store 里已保存的尺寸，而不是套用默认 260。
   */
  hasExplicitKey(key: string): boolean {
    try {
      if (!fs.existsSync(this.filePath)) return false;
      const stored = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      return Boolean(stored) && Object.prototype.hasOwnProperty.call(stored, key);
    } catch {
      return false;
    }
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
      // 音乐专属 Key 同样只下发脱敏视图，避免经 CONFIG_GET 泄露到渲染进程
      musicApiKey: c.musicApiKey ? `***${c.musicApiKey.slice(-4)}` : "",
      musicApiKeyPresent: Boolean(c.musicApiKey && c.musicApiKey.length > 0),
      // 信息简报与 GitHub 的密钥同样只下发脱敏视图：getMasked 会先展开全部配置，
      // 任何不在这里显式覆盖的新增密钥字段都会原样泄露到渲染进程
      briefApiKey: c.briefApiKey ? `***${c.briefApiKey.slice(-4)}` : "",
      briefApiKeyPresent: Boolean(c.briefApiKey && c.briefApiKey.length > 0),
      githubToken: c.githubToken ? `***${c.githubToken.slice(-4)}` : "",
      githubTokenPresent: Boolean(c.githubToken && c.githubToken.length > 0),
      // [secret-guard patch] 外部 MCP 服务器配置（env 与 args 中的密钥）不下发明文
      mcpServers: redactServerSecrets(c.mcpServers),
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
