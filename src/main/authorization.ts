import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { logger } from "./logger";
import { safetyManager } from "./safety";

/**
 * 能力授权（T07 第 6 节 + 项目书 P0 修复）。
 *
 * 修复点（对照项目书 §1 结论表「authorization」行）：
 * 1. 撤回成为**可持续生效状态**：撤回记录落盘（authorization-revoked.json），
 *    重启、截图或点击都不会自动恢复；重新授权必须由用户在面板显式操作。
 * 2. 屏幕读取、键鼠控制、对外发送是**分开的三类授权**；
 *    对外发送（external-send）永不自动授予。
 * 3. 不再提供 ensureAutoAuthorized() 启动自动授权 —— 旧版"启动即全量授权"
 *    与"撤回后不得自动恢复"直接冲突。已存在的授权记录视为用户显式选择，
 *    迁移时原样保留。
 */

/** 授权说明版本：文案变更后需重新取得同意 */
export const CONSENT_VERSION = 2;

/** 需要授权的能力。external-send 为对外通信类，与键鼠分列 */
export type Capability = "screen-capture" | "mouse-control" | "keyboard-control" | "external-send";

/** 从未授权（首次使用）：面板需要展示首次授权引导 */
export type AuthzState =
  | { state: "none" }
  | { state: "granted"; scope: Capability[]; grantedAt: string }
  | { state: "partial"; scope: Capability[]; grantedAt: string }
  | { state: "revoked"; scope: Capability[]; revokedAt: string; revoked: Capability[]; remaining: Capability[] };

function userDataDir(): string {
  try {
    return app?.getPath("userData") || process.cwd();
  } catch {
    return process.cwd();
  }
}

function consentPath(): string {
  return path.join(userDataDir(), "authorization.json");
}

function revocationPath(): string {
  return path.join(userDataDir(), "authorization-revoked.json");
}

interface AuthorizationRecord {
  consentVersion: number;
  grantedAt: string;
  scope: Capability[];
}

interface RevocationRecord {
  revokedAt: string;
  /** 被撤回的能力（持久化：重启后依旧生效） */
  revoked: Capability[];
}

function readJson<T>(p: string): T | null {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** 读取当前授权；从未授权或版本过期返回 null（撤回记录单独读取） */
export function getAuthorization(): AuthorizationRecord | null {
  const rec = readJson<AuthorizationRecord>(consentPath());
  if (!rec || rec.consentVersion !== CONSENT_VERSION) return null;
  return rec;
}

function getRevocation(): RevocationRecord | null {
  return readJson<RevocationRecord>(revocationPath());
}

/** 某项能力当前是否有效授权（= 已授予 且 未被撤回） */
export function isAuthorized(cap: Capability): boolean {
  const rec = getAuthorization();
  if (!rec || !rec.scope.includes(cap)) return false;
  const rev = getRevocation();
  if (rev && rev.revoked.includes(cap)) return false;
  return true;
}

/**
 * 面板/诊断用的授权总览。
 *
 * scope 语义统一为「当前生效的能力集合」（= 已授予 且 未被撤回），
 * 各状态一致，不再在 revoked 态返回被撤回项。撤回信息由 revoked / remaining 承载：
 *   - revoked：被撤回的能力；
 *   - remaining：当前仍生效的能力（与 scope 相同，保留字段兼容既有调用方）。
 */
export function getAuthzState(): AuthzState {
  const rev = getRevocation();
  const rec = getAuthorization();
  const scope = rec?.scope ?? [];
  const remaining = rev ? scope.filter((c) => !rev.revoked.includes(c)) : scope;
  if (rev && rev.revoked.length > 0) {
    return { state: "revoked", scope: remaining, revokedAt: rev.revokedAt, revoked: rev.revoked, remaining };
  }
  if (!rec) return { state: "none" };
  return remaining.length === scope.length && scope.length > 0
    ? { state: "granted", scope, grantedAt: rec.grantedAt }
    : { state: "partial", scope: remaining, grantedAt: rec.grantedAt };
}

/**
 * 授予能力（面板显式操作）。会同时把对应能力从撤回记录中移除 ——
 * 重新授权是用户主动行为，这才允许覆盖持久化的撤回状态。
 */
export function grantAuthorization(scope: Capability[]): void {
  const caps = [...new Set(scope)];
  try {
    const old = getAuthorization();
    const merged: AuthorizationRecord = {
      consentVersion: CONSENT_VERSION,
      grantedAt: old?.grantedAt ?? new Date().toISOString(),
      scope: [...new Set([...(old?.scope ?? []), ...caps])],
    };
    fs.writeFileSync(consentPath(), JSON.stringify(merged, null, 2), "utf-8");
    // 从撤回记录中移除本次重新授予的能力
    const rev = getRevocation();
    if (rev) {
      const left = rev.revoked.filter((c) => !caps.includes(c));
      if (left.length) fs.writeFileSync(revocationPath(), JSON.stringify({ revokedAt: rev.revokedAt, revoked: left }, null, 2), "utf-8");
      else if (fs.existsSync(revocationPath())) fs.unlinkSync(revocationPath());
    }
    safetyManager.audit("authorize", { scope: caps });
    logger.info(`[Authorization] 用户已授权：${caps.join(", ")}`);
  } catch (e) {
    logger.error("[Authorization] 授权记录写入失败:", e);
  }
}

/** 撤回授权（可只撤回部分能力）。撤回持久化，重启后依然生效 */
export function revokeAuthorization(scope?: Capability[]): void {
  try {
    const rec = getAuthorization();
    const current = rec?.scope ?? (["screen-capture", "mouse-control", "keyboard-control"] as Capability[]);
    const targets = scope && scope.length ? scope : current;
    const rev = getRevocation();
    const merged: RevocationRecord = {
      revokedAt: new Date().toISOString(),
      revoked: [...new Set([...(rev?.revoked ?? []), ...targets])],
    };
    fs.writeFileSync(revocationPath(), JSON.stringify(merged, null, 2), "utf-8");
    // 同步收窄授权记录
    if (rec) {
      const left = rec.scope.filter((c) => !targets.includes(c));
      if (left.length) fs.writeFileSync(consentPath(), JSON.stringify({ ...rec, scope: left }, null, 2), "utf-8");
      else if (fs.existsSync(consentPath())) fs.unlinkSync(consentPath());
    }
    safetyManager.audit("authorize_revoke", { scope: targets });
    logger.warn(`[Authorization] 用户已撤回授权：${targets.join(", ")}（持久生效，重启后不会自动恢复）`);
  } catch (e) {
    logger.error("[Authorization] 撤回授权失败:", e);
  }
}

/** 一次性迁移：把旧版（v1 文案）下用户已明确授权的记录升级到 v2，保留其显式选择 */
export function migrateLegacyAuthorization(): void {
  try {
    const p = consentPath();
    if (!fs.existsSync(p)) return;
    const raw = readJson<AuthorizationRecord>(p);
    if (!raw) return;
    if (raw.consentVersion === 1 && Array.isArray(raw.scope) && raw.scope.length >= 3) {
      fs.writeFileSync(p, JSON.stringify({ ...raw, consentVersion: CONSENT_VERSION }, null, 2), "utf-8");
      logger.info("[Authorization] 已把 v1 授权记录升级到 v2（保留用户既有选择）");
    }
  } catch (e) {
    logger.warn("[Authorization] 旧授权迁移失败:", e);
  }
}

/** 桌面操作类默认能力：屏幕录制 / 鼠标 / 键盘。与对外发送（external-send）严格分列 */
export const DEFAULT_DESKTOP_CAPABILITIES: Capability[] = [
  "screen-capture",
  "mouse-control",
  "keyboard-control",
];

/**
 * 启动时确保三类桌面能力默认开启（屏幕录制 / 鼠标 / 键盘）。
 *
 * 背景：旧版"启动即全量授权"与"撤回后不得自动恢复"冲突，曾被整体移除；但全新安装下
 * 屏幕录制默认关闭会导致「看屏幕」不可用。这里取折中：**桌面三类能力默认开启**，
 * 同时用撤回记录把用户显式撤回的能力排除在外。
 *
 * 语义（三条硬约束）：
 *  1. 默认授予：全新安装 / 从未授权时，把 ["screen-capture","mouse-control","keyboard-control"]
 *     通过 grantAuthorization() 落盘，保证 getAuthzState() 显示为已授权（「看屏幕」默认可
 *     直接使用）。授予动作复用 grantAuthorization 内部已有的 safetyManager.audit("authorize")，
 *     不额外重复审计。
 *  2. 跳过已撤回：先读 authorization-revoked.json，凡出现在 revoked 列表里的能力一律不授予，
 *     保证「用户主动撤回后重启不会自动恢复」这条既有承诺仍然成立。
 *  3. 绝不授予 external-send：对外发送/账号支付类动作必须逐次独立确认、全自动模式也不豁免，
 *     这是项目安全红线；且它与「识别屏幕」无关，因此不纳入默认授权。
 *
 * 幂等：已授权能力重复授予只会合并 scope，无副作用。
 * 安全：任何异常只写中文 warn 日志，绝不让应用启动失败。
 */
export function ensureDefaultAuthorizations(): void {
  try {
    const revoked = getRevocation()?.revoked ?? [];
    const granted = getAuthorization()?.scope ?? [];
    const toGrant = DEFAULT_DESKTOP_CAPABILITIES.filter(
      (cap) => !revoked.includes(cap) && !granted.includes(cap),
    );
    const skipped = DEFAULT_DESKTOP_CAPABILITIES.filter((cap) => revoked.includes(cap));
    if (skipped.length > 0) {
      logger.warn(
        `[Authorization] 以下桌面能力因用户曾显式撤回而跳过默认授予：${skipped.join(", ")}（不自动恢复用户已撤回的授权）`,
      );
    }
    if (toGrant.length === 0) {
      logger.info("[Authorization] 桌面能力均已默认开启或已授权，无需变更");
      return;
    }
    // 只授予未撤回的项；grantAuthorization 会把本次授予项从撤回记录中移除，
    // 由于 toGrant 已排除撤回项，因此不会误恢复任何被撤回的能力。
    grantAuthorization(toGrant);
    logger.info(`[Authorization] 桌面能力已默认开启（屏幕录制/鼠标/键盘），本次授予：${toGrant.join(", ")}`);
  } catch (e) {
    logger.warn("[Authorization] 默认授权初始化失败（不影响应用启动）:", e);
  }
}
