/**
 * ActionPolicy —— 按「动作语义与目标范围」分类的权限策略（项目书 P0）。
 *
 * 设计约束：
 * - 本模块是纯逻辑（不 import electron / fs），可在 CI 中直接单测。
 * - 外部 MCP 工具必须映射到能力清单；无法分类的写入类工具默认请求确认。
 * - external_send / account_or_payment 类动作**不受** confirmHighRisk 全局开关豁免，
 *   一律需要独立确认 —— 不能仅凭一个布尔值略过关键检查（项目书 §1 结论表）。
 *
 * 分类依据三要素：来源（内置/哪个外部服务器）、能力（工具名目录）、动作参数。
 */

/** 动作语义分类（项目书 §3 P0） */
export type ActionCategory =
  | "observe" // 只读观察：截图、UIA 快照、读文件、列表
  | "local_input" // 本地键鼠输入：点击、打字、按键（不产生外部通信）
  | "file_change" // 文件/配置变更：写文件、移动、注册表
  | "process_or_shell" // 启动进程 / 执行命令 / 查杀进程
  | "external_send" // 对外发送：消息、图片、邮件（需独立确认）
  | "account_or_payment" // 账号、支付、提交订单类
  | "unknown"; // 无法分类（写入语义未知）

export interface ActionClassification {
  category: ActionCategory;
  risk: "low" | "medium" | "high" | "critical";
  /** 是否强制独立确认（不受 confirmHighRisk 开关影响） */
  needsConfirm: boolean;
  /** 面板展示用标签 */
  label: string;
}

/** Windows-MCP 工具能力目录（docs/Windows-MCP.md §一，19 个工具） */
const WINDOWS_MCP_CATALOG: Record<string, { category: ActionCategory; risk: "low" | "medium" | "high" | "critical"; label: string }> = {
  Snapshot: { category: "observe", risk: "low", label: "读取 UIA 控件树快照" },
  DisplayInventory: { category: "observe", risk: "low", label: "枚举显示器" },
  Wait: { category: "observe", risk: "low", label: "等待" },
  WaitFor: { category: "observe", risk: "low", label: "条件等待" },
  Click: { category: "local_input", risk: "medium", label: "鼠标点击" },
  Type: { category: "local_input", risk: "medium", label: "键盘输入" },
  Scroll: { category: "local_input", risk: "low", label: "滚轮滚动" },
  Move: { category: "local_input", risk: "medium", label: "鼠标拖拽" },
  Shortcut: { category: "local_input", risk: "medium", label: "发送组合键" },
  Clipboard: { category: "local_input", risk: "medium", label: "读写剪贴板" },
  App: { category: "process_or_shell", risk: "medium", label: "启动/切换/缩放窗口" },
  Notification: { category: "local_input", risk: "low", label: "系统通知" },
  Registry: { category: "file_change", risk: "high", label: "注册表读写（系统配置）" },
  Process: { category: "process_or_shell", risk: "high", label: "进程列出/查杀" },
  PowerShell: { category: "process_or_shell", risk: "high", label: "执行 PowerShell 命令" },
  FileSystem: { category: "file_change", risk: "medium", label: "文件系统操作" },
  Scrape: { category: "observe", risk: "low", label: "网页抓取" },
  MultiSelect: { category: "file_change", risk: "medium", label: "批量选择操作" },
  MultiEdit: { category: "file_change", risk: "medium", label: "批量编辑" },
};

/** 内置 DesktopCommander 工具目录（mcp.ts EXPOSED_TOOLS 白名单） */
const BUILTIN_MCP_CATALOG: Record<string, { category: ActionCategory; risk: "low" | "medium" | "high" | "critical"; label: string }> = {
  read_file: { category: "observe", risk: "low", label: "读取文件" },
  read_process_output: { category: "observe", risk: "low", label: "读取进程输出" },
  list_processes: { category: "observe", risk: "low", label: "列出进程" },
  list_directory: { category: "observe", risk: "low", label: "列出目录" },
  get_file_info: { category: "observe", risk: "low", label: "查看文件信息" },
  start_search: { category: "observe", risk: "low", label: "全文搜索" },
  write_file: { category: "file_change", risk: "medium", label: "写入文件" },
  write_pdf: { category: "file_change", risk: "medium", label: "生成 PDF" },
  move_file: { category: "file_change", risk: "medium", label: "移动文件" },
  edit_block: { category: "file_change", risk: "medium", label: "定向编辑文件" },
  create_directory: { category: "file_change", risk: "low", label: "创建目录" },
  set_config_value: { category: "file_change", risk: "high", label: "修改工具配置（可能被用来放宽限制）" },
  start_process: { category: "process_or_shell", risk: "high", label: "启动进程/执行命令" },
  interact_with_process: { category: "process_or_shell", risk: "high", label: "向进程发送输入" },
  force_terminate: { category: "process_or_shell", risk: "high", label: "强制结束进程" },
  kill_process: { category: "process_or_shell", risk: "high", label: "查杀进程" },
};

/** 对外发送语义的启发式识别：任何工具的参数里出现「向联系人/群发送内容」迹象时升级 */
const SEND_VERB_RE = /(发送|发消息|发图片|send|reply|回复|转发|群发)/i;
const RECIPIENT_KEY_RE = /^(to|recipient|contact|receiver|phone|chat|会话|联系人|收件人|接收者)$/i;
const ACCOUNT_KEY_RE = /(pay|payment|order|checkout|转账|支付|下单|付款)/i;

function scanArgsForExternalSend(toolName: string, args: Record<string, unknown>): boolean {
  const name = String(toolName || "");
  const keys = Object.keys(args || {});
  const hasRecipient = keys.some((k) => RECIPIENT_KEY_RE.test(k));
  if (hasRecipient && SEND_VERB_RE.test(name)) return true;
  // 剪贴板/输入类工具本身只是本地输入；只有当工具名明确是"发送"语义时才升级
  return false;
}

function scanArgsForPayment(args: Record<string, unknown>): boolean {
  const text = JSON.stringify(args || {}).toLowerCase();
  if (!ACCOUNT_KEY_RE.test(text)) return false;
  // 出现支付语义关键词 + 金额/确认类字段才升级，避免误伤「打开支付页面看一眼」
  return /amount|金额|price|价格|total|应付/.test(text);
}

/** 命令文本风险评估的回调（由 safety.assessCommand 注入，保持本模块零依赖） */
export type CommandAssessor = (command: string) => { level: "low" | "high" | "critical" };
let commandAssessor: CommandAssessor | null = null;
export function setCommandAssessor(fn: CommandAssessor): void {
  commandAssessor = fn;
}

/**
 * 分类一次外部/内置 MCP 工具调用。
 * @param serverName 外部服务器名（内置 DesktopCommander 传 "builtin"）
 */
export function classifyTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>
): ActionClassification {
  const isBuiltin = serverName === "builtin";
  const catalog = isBuiltin ? BUILTIN_MCP_CATALOG : WINDOWS_MCP_CATALOG;
  const known = catalog[toolName];

  // 1) 已知工具：按目录分类，再按参数升级
  if (known) {
    let { category, risk, label } = known;
    if (category !== "observe" && category !== "local_input") {
      if (scanArgsForExternalSend(toolName, args)) {
        return { category: "external_send", risk: "critical", needsConfirm: true, label: `对外发送：${label}` };
      }
      if (scanArgsForPayment(args)) {
        return { category: "account_or_payment", risk: "critical", needsConfirm: true, label: `支付/账号操作：${label}` };
      }
    }
    // 命令类工具进一步用命令文本正则评估
    if (category === "process_or_shell") {
      const cmd = pickCommandText(args);
      if (cmd && commandAssessor) {
        const r = commandAssessor(cmd);
        if (r.level === "critical") risk = "critical";
      }
    }
    // FileSystem/PowerShell 的写入参数里有明确发送语义时同样升级（见上）；未知写入不在此列
    const needsConfirm = category === "external_send" || category === "account_or_payment";
    return { category, risk, needsConfirm, label };
  }

  // 2) 未知工具：无法分类的写入类默认请求确认（项目书 P0：默认拒绝或请求确认）
  return {
    category: "unknown",
    risk: "high",
    needsConfirm: true,
    label: `未收录的外部工具「${toolName}」（能力未知，需人工确认）`,
  };
}

function pickCommandText(args: Record<string, unknown>): string {
  const c = args.command ?? args.cmd;
  if (typeof c === "string") return c;
  if (Array.isArray(args.args)) return (args.args as unknown[]).join(" ");
  return "";
}

/** 这些类别的动作会改变外部世界或系统状态（用于任务 allowedActions 校验） */
export function isMutating(category: ActionCategory): boolean {
  return category === "file_change" || category === "process_or_shell" || category === "external_send" || category === "account_or_payment";
}

/** 任务允许动作范围校验：任务未授权该语义类别时返回 false */
export function isActionAllowed(allowedActions: string[], category: ActionCategory): boolean {
  return allowedActions.includes(category);
}
