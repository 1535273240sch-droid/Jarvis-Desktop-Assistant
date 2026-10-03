/**
 * 「打开某个东西」的安全封装：文件/文件夹、Windows 设置页。
 *
 * 设计要点：
 * - open_path 只能打开「工具执行白名单目录」内的路径（realpath 后比较，防 .. 与符号链接/联接点绕过）；
 * - 程序/脚本类扩展名一律拒绝（要启动程序请走 open_app，那条路径有自己的匹配与审计）；
 * - open_settings 只接受固定白名单里的 ms-settings: 页面，绝不接受模型传来的任意 URI。
 * 判断逻辑是纯函数，可直接单测；真正调用 shell 的只有两处，且都是惰性使用。
 */
import { shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

export const BLOCKED_EXT = new Set([
  ".exe", ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh",
  ".msi", ".msp", ".scr", ".com", ".pif", ".lnk", ".url", ".hta", ".reg", ".dll", ".jar", ".appx", ".msix",
]);

export const SETTINGS_PAGES: Record<string, { uri: string; label: string }> = {
  wifi: { uri: "ms-settings:network-wifi", label: "WLAN" },
  bluetooth: { uri: "ms-settings:bluetooth", label: "蓝牙" },
  display: { uri: "ms-settings:display", label: "显示" },
  sound: { uri: "ms-settings:sound", label: "声音" },
  apps: { uri: "ms-settings:appsfeatures", label: "应用和功能" },
  default_apps: { uri: "ms-settings:defaultapps", label: "默认应用" },
  update: { uri: "ms-settings:windowsupdate", label: "Windows 更新" },
  battery: { uri: "ms-settings:batterysaver", label: "电池" },
  notifications: { uri: "ms-settings:notifications", label: "通知" },
  storage: { uri: "ms-settings:storagesense", label: "存储" },
  privacy_microphone: { uri: "ms-settings:privacy-microphone", label: "麦克风隐私" },
  vpn: { uri: "ms-settings:network-vpn", label: "VPN" },
  proxy: { uri: "ms-settings:network-proxy", label: "代理" },
};

export function isBlockedExt(p: string): boolean {
  return BLOCKED_EXT.has(path.extname(p).toLowerCase());
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** target 是否位于 allowed 中任一目录之内（含目录本身）。Windows 下大小写不敏感。 */
export function isInsideAllowed(target: string, allowed: string[]): boolean {
  const f = real(target).toLowerCase();
  return allowed.some((d) => {
    if (!d || !d.trim()) return false;
    const base = real(d).toLowerCase().replace(/[\\/]+$/, "");
    return f === base || f.startsWith(base + path.sep);
  });
}

export async function openPathSafe(raw: string, allowed: string[]): Promise<{ ok: boolean; output: string }> {
  const t = (raw || "").trim().replace(/^"(.*)"$/, "$1");
  if (!t) return { ok: false, output: "没有提供路径。" };
  if (!path.isAbsolute(t)) return { ok: false, output: "需要绝对路径。请先用 list_directory 找到真实路径，不要猜测。" };
  if (!fs.existsSync(t)) return { ok: false, output: `路径不存在：${t}。请如实告诉用户。` };
  if (!isInsideAllowed(t, allowed)) {
    return { ok: false, output: "该路径不在「工具执行白名单目录」内，已拒绝。请让用户在设置里把它所在目录加入白名单。" };
  }
  const isDir = fs.statSync(t).isDirectory();
  if (!isDir && (isBlockedExt(t) || isBlockedExt(real(t)))) {
    return { ok: false, output: "出于安全，不通过本工具直接打开程序/脚本类文件；要启动软件请用 open_app。" };
  }
  const err = await shell.openPath(t); // 成功返回空字符串
  return err ? { ok: false, output: `打开失败：${err}` } : { ok: true, output: "已打开。请用一句话确认，不要复述路径。" };
}

export async function openSettingsPage(key: string): Promise<{ ok: boolean; output: string }> {
  const page = SETTINGS_PAGES[String(key || "").trim().toLowerCase()];
  if (!page) return { ok: false, output: `不支持的设置页。可用：${Object.keys(SETTINGS_PAGES).join("、")}` };
  try {
    await shell.openExternal(page.uri);
    return { ok: true, output: `已打开「${page.label}」设置。请用一句话确认。` };
  } catch (e) {
    return { ok: false, output: `打开失败：${(e as Error).message}` };
  }
}
