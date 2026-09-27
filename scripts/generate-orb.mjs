import { writeFile, mkdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const vendorOrbRoot = resolve(projectRoot, "vendor/orb");
const outputPath = resolve(projectRoot, "src/renderer/orb.html");

const vitePath = resolve(vendorOrbRoot, "node_modules/vite/dist/node/index.js");
const { createServer } = await import(pathToFileURL(vitePath).href);

console.log("[Generate Orb] Initializing Vite SSR context from vendor/orb...");

const server = await createServer({
  root: vendorOrbRoot,
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true, ws: false },
});

try {
  const [orbStates, orbUniforms, codeExport] = await Promise.all([
    server.ssrLoadModule("/src/orb-states.ts"),
    server.ssrLoadModule("/src/orb-uniforms.ts"),
    server.ssrLoadModule("/src/code-export.ts"),
  ]);

  // 选择支持音频响应的 siri 预设
  const config = orbStates.createPresetOrbStateConfiguration("siri");
  // 生成以 idle 为初始态的 6 态导出页
  let html = codeExport.createWebExport(config, "idle");

  // 强化音频波纹动感与涟漪算法。
  //
  // 实测反馈：说话与播报时球体的动态「不够明显、观感不好」。原因是原参数
  // 对频段能量的放大倍数偏保守，正常说话音量下形变很小。这里整体加大
  // 加法项(additive)与比例项(proportional)，并同步抬高 ceiling，
  // 让同样一段语音产生明显得多的表面撕裂、外轮廓涟漪与流场流动。
  //
  // 各索引含义见 vendor/orb/src/orb-audio.ts 的 audioRules 注释：
  //   [uniformIndex, 频段, 加法量, 比例量, 上限]
  //   3  = 全局形变强度     6  = 中频表面撕裂    7  = 低频轮廓涟漪
  //   21 = 低频流场扭曲     10 = 高频细节抖动    14 = 全局流场强度
  const ORIGINAL_RULES = 'const audioRules = [[3,"all",0,0.7,5],[6,"mid",0.85,0,7],[21,"low",0.075,0,1],[10,"high",0.16,0,2],[14,"all",0,0.12,4]];';
  const AMPLIFIED_RULES =
    'const audioRules = [[3,"all",0.35,2.6,14],[6,"mid",4.2,1.1,22],[7,"low",1.1,1.9,13],' +
    '[21,"low",1.05,1.6,5.5],[10,"high",0.95,0.6,7],[14,"all",0.25,0.75,9]];';
  if (!html.includes(ORIGINAL_RULES)) {
    // 兼容「已被上一版本替换过」的情况（幂等：重复构建不会叠加放大）
    const previous =
      'const audioRules = [[3,"all",0,1.2,8],[6,"mid",2.2,0.4,12],[7,"low",0.4,0.8,6],[21,"low",0.38,0.6,1.8],[10,"high",0.35,0.2,3],[14,"all",0,0.25,5]];';
    if (!html.includes(previous)) {
      throw new Error(
        "未能匹配音频规则（audioRules）——上游 orb 导出模板可能已变更，请核对 vendor/orb 的 orb-audio.ts"
      );
    }
    html = html.replace(previous, AMPLIFIED_RULES);
  } else {
    html = html.replace(ORIGINAL_RULES, AMPLIFIED_RULES);
  }

  const ORIGINAL_FLOW = 'const audioFlowStrengths = {"9":0.8,"10":0.65,"11":0.65,"14":0.75,"19":1,"21":0.7};';
  const PREVIOUS_FLOW = 'const audioFlowStrengths = {"9":1.6,"10":1.2,"11":1.2,"14":1.4,"19":1.8,"21":1.3};';
  const AMPLIFIED_FLOW = 'const audioFlowStrengths = {"9":2.6,"10":2.1,"11":2.1,"14":2.4,"19":2.9,"21":2.2};';
  if (html.includes(ORIGINAL_FLOW)) html = html.replace(ORIGINAL_FLOW, AMPLIFIED_FLOW);
  else if (html.includes(PREVIOUS_FLOW)) html = html.replace(PREVIOUS_FLOW, AMPLIFIED_FLOW);
  else throw new Error("未能匹配音频流场强度（audioFlowStrengths）——请核对上游模板");

  // —— 多主题注入 ——
  //
  // 用户提供的 5 套主题快照（scripts/orb-themes.json，来自 orb 编辑器导出，
  // 只含 idle/thinking 两态、136 floats/态）。其余 4 个状态沿用 vendor 的
  // 状态推导规则补齐（listening/executing/speaking/error 的颜色是全局固定
  // 语义色——绿/琥珀/青/红，主题个性由 idle/thinking 承载），数值以用户
  // 导出为准覆盖。
  //
  // 运行时通过 app://orb/orb.html?theme=<styleId> 选择主题；无参数回落 siri。
  const USER_THEMES = JSON.parse(await readFile(resolve(projectRoot, "scripts/orb-themes.json"), "utf-8"));

  // profile 数值键 -> uniform 数组下标（布局见 vendor/orb/src/orb-uniforms.ts writeOrbUniforms）
  const PROFILE_NUMERIC_INDEX = {
    speed: 3, zoom: 5, warp: 6, ridgeAmt: 7, sharp: 8, shade: 9, exposure: 14,
    edgeGlow: 17, contourDeform: 21, bandDensity: 22, chromaticShift: 23,
    metalStretch: 25, metalEvolution: 29, metalRoughness: 30, metalDepth: 31,
    ribbonWidth: 34, ribbonTwist: 35, ribbonFold: 36, ribbonBreath: 37,
  };
  // 颜色键 -> uniform 数组起始下标（每色 4 floats: r,g,b,a）
  const PROFILE_COLOR_OFFSET = {
    colorA: 40, colorB: 44, colorC: 48, colorD: 52, highlightColor: 56, glowColor: 84,
  };
  const floatsToHex = (arr, off) => {
    const h = (v) => Math.max(0, Math.min(255, Math.round(Number(v) * 255))).toString(16).padStart(2, "0");
    return `#${h(arr[off])}${h(arr[off + 1])}${h(arr[off + 2])}`.toUpperCase();
  };

  const seedMatch = html.match(/^([ \t]*)const stateSeeds = (\{.*\});[ \t]*$/m);
  if (!seedMatch) throw new Error("未能定位 stateSeeds 行——上游 orb 导出模板可能已变更");

  const themeTable = { siri: JSON.parse(seedMatch[2]) };
  for (const t of USER_THEMES) {
    const baseCfg = orbStates.createPresetOrbStateConfiguration(t.style);
    const thinkingParams = orbStates.resolveOrbStateParams(baseCfg, "thinking");
    // 用用户导出的 thinking 快照覆盖 profile（保证与导出观感完全一致）
    const overrides = {};
    for (const [key, idx] of Object.entries(PROFILE_NUMERIC_INDEX)) overrides[key] = t.thinking[idx];
    for (const [key, off] of Object.entries(PROFILE_COLOR_OFFSET)) overrides[key] = floatsToHex(t.thinking, off);
    const cfg = orbStates.createOrbStateConfiguration({ ...thinkingParams, ...overrides });
    // idle 同样以用户导出为准（idle 原本由 thinking 推导，这里保用户的数值）
    const idleOverrides = {};
    for (const [key, idx] of Object.entries(PROFILE_NUMERIC_INDEX)) idleOverrides[key] = t.idle[idx];
    for (const [key, off] of Object.entries(PROFILE_COLOR_OFFSET)) idleOverrides[key] = floatsToHex(t.idle, off);
    cfg.profiles.idle = { ...cfg.profiles.idle, ...idleOverrides };
    themeTable[t.style] = Object.fromEntries(
      orbStates.orbStateNames.map((n) => [n, orbUniforms.createOrbUniformSnapshot(orbStates.resolveOrbStateParams(cfg, n))])
    );
    console.log(`[Generate Orb] theme injected: ${t.style} (${t.name})`);
  }

  html = html.replace(
    seedMatch[0],
    `${seedMatch[1]}const __ORB_THEMES = ${JSON.stringify(themeTable)};\n` +
      `${seedMatch[1]}const stateSeeds = (() => { try { const t = new URLSearchParams(location.search).get("theme"); ` +
      `if (t && Object.prototype.hasOwnProperty.call(__ORB_THEMES, t)) return __ORB_THEMES[t]; } catch {} ` +
      `return __ORB_THEMES.siri; })();`
  );
  console.log(`[Generate Orb] themes embedded: ${Object.keys(themeTable).join(", ")}`);


  // 注入宿主桥接脚本（就绪通知、onError 回调捕获、鼠标穿透交互与拖拽支持）
  const bridgeScript = `
  <script>
    // 宿主通信与交互扩展
    (function() {
      let isReadyReported = false;
      let isInsideOrb = false;
      const orbRadius = 110; // 悬浮球交互有效半径（居中）

      function probeReady() {
        if (window.liquidOrb && typeof window.liquidOrb.getState === "function") {
          if (!isReadyReported) {
            isReadyReported = true;
            console.log("[Orb Bridge] window.liquidOrb is ready. Initial state:", window.liquidOrb.getState());
            if (window.electronBridge) {
              window.electronBridge.onOrbReady(window.liquidOrb.getState());
            }
            if (typeof window.liquidOrb.onError === "function") {
              window.liquidOrb.onError((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                console.error("[Orb Bridge Error Caught]", msg);
                if (window.electronBridge) {
                  window.electronBridge.onOrbError(msg);
                }
              });
            }
          }
        } else {
          setTimeout(probeReady, 30);
        }
      }
      probeReady();

      // 监听全局 WebGPU 异常
      window.addEventListener("unhandledrejection", (e) => {
        console.error("[Unhandled Rejection]", e.reason);
        if (window.electronBridge) {
          window.electronBridge.onOrbError(String(e.reason?.message || e.reason));
        }
      });

      // 鼠标区域检测（实现透明区域点击穿透，球体区域捕获鼠标）
      window.addEventListener("mousemove", (e) => {
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;
        const dist = Math.hypot(e.clientX - centerX, e.clientY - centerY);
        const inside = dist <= orbRadius;

        if (inside !== isInsideOrb) {
          isInsideOrb = inside;
          if (window.electronBridge) {
            window.electronBridge.setIgnoreMouseEvents(!inside);
          }
        }
      });

      window.addEventListener("mouseleave", () => {
        if (isInsideOrb) {
          isInsideOrb = false;
          if (window.electronBridge) {
            window.electronBridge.setIgnoreMouseEvents(true);
          }
        }
      });

      // 拖拽支持：在球体区域按住鼠标可拖动窗口
      let isDragging = false;
      let dragStartX = 0;
      let dragStartY = 0;

      window.addEventListener("mousedown", (e) => {
        if (e.button === 0 && isInsideOrb) {
          isDragging = true;
          dragStartX = e.screenX;
          dragStartY = e.screenY;
          if (window.electronBridge) {
            window.electronBridge.startDrag(e.screenX, e.screenY);
          }
        }
      });

      window.addEventListener("mouseup", () => {
        if (isDragging) {
          isDragging = false;
          if (window.electronBridge) {
            window.electronBridge.stopDrag();
          }
        }
      });
    })();
  </script>
`;

  // 在 </body> 标签前插入桥接脚本
  html = html.replace("</body>", `${bridgeScript}\n</body>`);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf-8");

  console.log(`[Generate Orb] Successfully exported Orb HTML to: ${outputPath}`);
} finally {
  await server.close();
}
