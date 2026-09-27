import { configManager } from "./config";
import type { AppProfile } from "../common/types";
import { DEFAULT_CONFIG } from "./config";

/**
 * 目标软件档案（项目书 §2.2/P1）。
 * 档案保存在 config.appProfiles，用户可在面板设置中编辑自己的 Agent 窗口规则；
 * 本模块只提供读写与查询辅助，不硬编码任何 Agent 产品。
 */

export function getProfiles(): AppProfile[] {
  const list = configManager.get().appProfiles;
  if (Array.isArray(list) && list.length) return list;
  return DEFAULT_CONFIG.appProfiles ?? [];
}

export function getProfile(id: string): AppProfile | null {
  return getProfiles().find((p) => p.id === id) ?? null;
}

export function saveProfiles(profiles: AppProfile[]): AppProfile[] {
  // 基础校验：id/displayName 必填且唯一
  const seen = new Set<string>();
  const clean = profiles
    .filter((p) => p && typeof p.id === "string" && p.id.trim() && typeof p.displayName === "string")
    .map((p) => ({
      ...p,
      id: p.id.trim(),
      processNames: (p.processNames || []).map((s) => String(s).trim()).filter(Boolean),
      titleIncludes: (p.titleIncludes || []).map((s) => String(s).trim()).filter(Boolean),
      runningMarkers: (p.runningMarkers || []).map((s) => String(s).trim()).filter(Boolean),
      doneMarkers: (p.doneMarkers || []).map((s) => String(s).trim()).filter(Boolean),
      submitKeys: (p.submitKeys || "enter").trim(),
    }))
    .filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  configManager.set({ appProfiles: clean });
  return clean;
}

/**
 * 选择编码 Agent 档案：优先显式指定；否则取第一个已启用且配置了窗口规则的
 * 非微信档案。找不到返回 null（任务会进入 waiting_user 引导用户配置）。
 */
export function pickAgentProfile(profileId?: string): AppProfile | null {
  const all = getProfiles();
  if (profileId) {
    const p = all.find((x) => x.id === profileId && x.enabled);
    return p ?? null;
  }
  return all.find((p) => p.enabled && p.id !== "wechat" && (p.processNames.length || p.titleIncludes.length)) ?? null;
}

export function profileConfigured(p: AppProfile | null): p is AppProfile {
  return Boolean(p && p.enabled && ((p.processNames && p.processNames.length) || (p.titleIncludes && p.titleIncludes.length)));
}
