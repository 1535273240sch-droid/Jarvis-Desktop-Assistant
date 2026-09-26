import type { McpServerConfig } from "../common/types";

/**
 * 外部 MCP 服务器预设。
 *
 * 目的：让「接上别的工具」这件事不用手写 JSON —— 面板里点一下就能配上。
 * 这些都是社区常见的 MCP server（多数通过 npx 直接运行，无需手动安装）。
 * 用户也可以在面板里完全自定义 command/args。
 */
export interface McpPreset {
  id: string;
  /** 面板显示名 */
  label: string;
  /** 说明这个 server 能干什么 */
  description: string;
  config: McpServerConfig;
  /** 需要用户额外填写的信息（如 API Token、目录） */
  requires?: Array<{ key: "env" | "args"; name: string; label: string; placeholder?: string }>;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: "filesystem",
    label: "文件系统（官方）",
    description: "读写指定目录下的文件。比内置工具更严格地限制在指定目录内。",
    config: {
      name: "filesystem",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "REPLACE_WITH_DIR"],
      enabled: true,
    },
    requires: [{ key: "args", name: "dir", label: "允许访问的目录", placeholder: "C:\\Users\\你的用户名\\Documents" }],
  },
  {
    id: "memory",
    label: "知识图谱记忆（官方）",
    description: "基于知识图谱的长期记忆，可存实体与关系。与内置 remember_fact 互补。",
    config: {
      name: "memory",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
      enabled: true,
    },
  },
  {
    id: "github",
    label: "GitHub（官方）",
    description: "读写 GitHub 仓库、Issue、PR。需要 Personal Access Token。",
    config: {
      name: "github",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "REPLACE_WITH_TOKEN" },
      enabled: true,
    },
    requires: [
      { key: "env", name: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "GitHub Token", placeholder: "ghp_..." },
    ],
  },
  {
    id: "fetch",
    label: "网页抓取（官方）",
    description: "抓取网页并转成 Markdown，适合读文章/文档。",
    config: {
      name: "fetch",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-fetch"],
      enabled: true,
    },
  },
  {
    id: "sqlite",
    label: "SQLite 数据库（官方）",
    description: "查询与修改本地 SQLite 数据库文件。",
    config: {
      name: "sqlite",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sqlite", "REPLACE_WITH_DB"],
      enabled: true,
    },
    requires: [{ key: "args", name: "db", label: "数据库文件路径", placeholder: "C:\\data\\test.db" }],
  },
  {
    id: "puppeteer",
    label: "浏览器自动化（官方）",
    description: "用无头浏览器打开网页、点击、截图、抓取动态内容。注意首次使用会下载 Chromium。",
    config: {
      name: "puppeteer",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-puppeteer"],
      enabled: true,
    },
  },
  {
    id: "sequential-thinking",
    label: "顺序思维（官方）",
    description: "把复杂问题拆成多步推理链，提升多步任务的成功率。",
    config: {
      name: "sequential-thinking",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      enabled: true,
    },
  },
  {
    id: "everything",
    label: "示例服务器（官方）",
    description: "官方示例 server，包含若干演示工具，适合验证外部 MCP 通道是否打通。",
    config: {
      name: "everything",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
      enabled: true,
    },
  },
  {
    id: "windows-mcp",
    label: "Windows 桌面控制（Windows-MCP）",
    description:
      "基于 UIA 无障碍树的桌面自动化，共 19 个工具：窗口管理（启动/缩放/切换）、UIA 快照与点击输入、剪贴板、注册表、系统通知、进程查杀、网页抓取。" +
      "与内置视觉点击互补：UIA 直接读控件树，比截图猜坐标更准也更省 token。" +
      "需先安装：uv tool install windows-mcp（详见 docs/Windows-MCP.md）。",
    config: {
      name: "windows-mcp",
      command: "windows-mcp",
      args: ["serve", "--transport", "stdio", "--exclude-tools", "Screenshot"],
      enabled: true,
    },
  },
];

/** 把预设实例化成可用配置，填入用户提供的参数 */
export function instantiatePreset(
  presetId: string,
  values: Record<string, string>
): McpServerConfig | null {
  const p = MCP_PRESETS.find((x) => x.id === presetId);
  if (!p) return null;
  const cfg: McpServerConfig = JSON.parse(JSON.stringify(p.config));
  for (const req of p.requires || []) {
    const v = values[req.name];
    if (!v) continue;
    if (req.key === "env") {
      cfg.env = { ...(cfg.env || {}), [req.name]: v };
    } else {
      cfg.args = (cfg.args || []).map((a) => (a === `REPLACE_WITH_${req.name.toUpperCase()}` ? v : a));
    }
  }
  return cfg;
}
