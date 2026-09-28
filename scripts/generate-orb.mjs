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
  const [orbStates, orbUniforms, codeExport, audioTuning] = await Promise.all([
    server.ssrLoadModule("/src/orb-states.ts"),
    server.ssrLoadModule("/src/orb-uniforms.ts"),
    server.ssrLoadModule("/src/code-export.ts"),
    server.ssrLoadModule("/src/orb-audio-tuning.ts"),
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
  // 放大值集中声明在 vendor/orb/src/orb-audio-tuning.ts（宿主侧构建期参数），
  // 本脚本不再硬编码字面量：导出模板会把 audioRules / audioFlowStrengths
  // 序列化成 `const audioRules = [...];` / `const audioFlowStrengths = {...};`
  // 形式的文本，用正则整段定位并替换即可（结构化替换，不依赖上游具体数值），
  // 因此上游改模板数值也不会让构建失败。
  //
  // 各索引含义见 vendor/orb/src/orb-audio.ts 的 audioRules 注释：
  //   [uniformIndex, 频段, 加法量, 比例量, 上限]
  //   3  = 全局形变强度     6  = 中频表面撕裂    7  = 低频轮廓涟漪
  //   21 = 低频流场扭曲     10 = 高频细节抖动    14 = 全局流场强度
  const audioRulesPattern = /const audioRules = \[\[[\s\S]*?\]\];/;
  if (!audioRulesPattern.test(html)) {
    throw new Error(
      "未能在导出模板中定位 audioRules 数组字面量，请核对 vendor/orb 的 code-export/orb-audio 输出"
    );
  }
  // 幂等：无论产物是上游原值还是已放大值，正则都能匹配并写入放大值。
  html = html.replace(
    audioRulesPattern,
    `const audioRules = ${JSON.stringify(audioTuning.amplifiedAudioRules)};`
  );

  const audioFlowPattern = /const audioFlowStrengths = \{[^}]*\};/;
  if (!audioFlowPattern.test(html)) {
    throw new Error(
      "未能在导出模板中定位 audioFlowStrengths 对象字面量，请核对 vendor/orb 的 code-export/orb-audio 输出"
    );
  }
  html = html.replace(
    audioFlowPattern,
    `const audioFlowStrengths = ${JSON.stringify(audioTuning.amplifiedAudioFlowStrengths)};`
  );

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
      // 命中半径按窗口尺寸推导（比例 0.42，260px 窗口时约 110px）。
      // 写死 110 会导致窗口放大后点击/拖动区域与球体视觉错位，故随尺寸同步。
      const ORB_RADIUS_RATIO = 0.42;
      let orbRadius = 110;

      function updateOrbRadius() {
        orbRadius = Math.min(window.innerWidth, window.innerHeight) * ORB_RADIUS_RATIO;
      }
      updateOrbRadius();
      window.addEventListener("resize", updateOrbRadius);
      // 主进程改窗口尺寸后会广播新尺寸；即使 resize 事件未触发也能及时刷新
      if (window.electronBridge && typeof window.electronBridge.onOrbSizeChanged === "function") {
        window.electronBridge.onOrbSizeChanged(updateOrbRadius);
      }

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
