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

  // audioFlowStrengths（音频强度表）在下面「多主题」之后注入：它需要按每个主题的
  // 基准值做归一化，而主题表要到那一步才构建完成。

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
  // HSL 互转：用于「色相/饱和度取主题、亮度取该状态原本设计」的颜色迁移
  const hexToHsl = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return { h: 0, s: 0, l: 0.5 };
    const int = parseInt(m[1], 16);
    const r = ((int >> 16) & 255) / 255;
    const g = ((int >> 8) & 255) / 255;
    const b = (int & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0;
    let s = 0;
    if (d > 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return { h, s: Math.max(0, Math.min(1, s)), l: Math.max(0, Math.min(1, l)) };
  };
  const hslToHex = (h, s, l) => {
    const hh = ((h % 360) + 360) % 360;
    const ss = Math.max(0, Math.min(1, s));
    const ll = Math.max(0, Math.min(1, l));
    const c = (1 - Math.abs(2 * ll - 1)) * ss;
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const m = ll - c / 2;
    const seg = Math.floor(hh / 60) % 6;
    const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
    const to = (v) => Math.max(0, Math.min(255, Math.round((v + m) * 255))).toString(16).padStart(2, "0");
    return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`.toUpperCase();
  };
  /**
   * 求一组颜色的「代表色相」与「平均彩度」，用于把 vendor 的状态配色迁移到主题色系。
   *
   * 为什么不能直接对单个颜色取 HSL 再套主题色相：近白色（例如 frost 的 #F7FBFF，或
   * 导出的 0.97/0.98/1.0）算出来的 saturation 会因为分母 (1-|2l-1|) 趋零而**失真成 1.0**，
   * 于是「接近白色」被读成「饱和的某个随机色相」。所以这里用彩度加权的圆均值求整体色相，
   * 并用「平均彩度」表达这组颜色到底有多"上色"（近白/近灰 ≈ 0）。
   */
  const paletteHueAndChroma = (hexList) => {
    const cols = hexList.map(hexToHsl);
    let x = 0, y = 0, chromaSum = 0;
    for (const c of cols) {
      const chroma = c.s * (1 - Math.abs(2 * c.l - 1)); // ≈ max-min，真正的"彩度"
      chromaSum += chroma;
      const rad = (c.h * Math.PI) / 180;
      x += Math.cos(rad) * chroma;
      y += Math.sin(rad) * chroma;
    }
    const n = cols.length || 1;
    const hue = x === 0 && y === 0 ? 0 : ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    return { hue, chroma: chromaSum / n };
  };
  const rgbOfHex = (hex) => {
    const i = parseInt(String(hex).replace("#", ""), 16);
    return [((i >> 16) & 255) / 255, ((i >> 8) & 255) / 255, (i & 255) / 255];
  };
  const lumOfRgb = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  /**
   * 把主题的某个颜色**缩放到目标亮度**，保留它的色相与色彩比例。
   *
   * 这是「主题色进状态」的稳妥做法：主题的配色是给 idle/thinking 设计的，直接搬进
   * speaking 这类**额外加强辉光/曝光**的状态会顶到纯白（真机实测 frost 说话态 100% 像素
   * 纯白、整颗糊成白盘）。改用「亮度对齐」后：颜色仍是主题的（逐键保留其色相与色彩关系），
   * 亮度则换成该状态原本设计好的亮度，因此既不会爆白，也不会灰成一片。
   * 近黑颜色（blueDrop 的 #020B1D）按色相 + 目标亮度重建，避免大倍数放大造成通道截断。
   */
  const scaleColorToLum = (hex, targetLum) => {
    const c = rgbOfHex(hex);
    const l = lumOfRgb(c);
    if (l < 0.02) {
      const hsl = hexToHsl(hex);
      return hslToHex(hsl.h, Math.max(hsl.s, 0.55), Math.min(0.95, Math.max(0.25, targetLum)));
    }
    const k = targetLum / l;
    const out = c.map((v) => Math.max(0, Math.min(1, v * k)));
    return "#" + out.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
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

    // 让主题的调色板贯穿「全部」状态。
    //
    // 背景：vendor 的 listening / executing / speaking / error 四个 profile 里**硬编码了
    // 固定语义色**（speaking = #00E5FF 青、listening = 绿、executing = 琥珀、error = 红），
    // 于是换上任何主题，一进入说话状态球体就变回青色，主题身份丢失
    //（用户反馈：「主题是什么颜色，它现在是什么颜色」不一致）。
    // 这里在构建期把这四个状态的颜色也覆盖成主题自己的调色板 —— **只覆盖颜色**，
    // 各状态的运动特征（speed / warp / contourDeform / edgeGlow …）保持原样，
    // 状态之间的区分改由「动感强弱 + 亮度」承载。vendored 运行时不改，
    // 覆盖只发生在宿主构建期（与音频放大参数的注入方式一致）。
    // 状态配色：颜色用**主题自己的**（逐键保留色相与色彩关系），亮度对齐到该状态原本
    // 设计好的亮度。于是任何状态都呈现主题的配色，同时不会因为 speaking 等状态额外加强
    // 辉光/曝光而顶到纯白（真机实测：直接沿用主题色的绝对亮度，frost 说话态 100% 像素纯白）。
    const themeCols = {};
    for (const [key, off] of Object.entries(PROFILE_COLOR_OFFSET)) {
      themeCols[key] = floatsToHex(t.thinking, off);
    }
    for (const n of orbStates.orbStateNames) {
      if (n === "idle" || n === "thinking") continue;
      const vendorParams = orbStates.resolveOrbStateParams(baseCfg, n);
      const patch = {};
      for (const [key] of Object.entries(PROFILE_COLOR_OFFSET)) {
        patch[key] = scaleColorToLum(themeCols[key], lumOfRgb(rgbOfHex(vendorParams[key])));
      }
      cfg.profiles[n] = { ...cfg.profiles[n], ...patch };
    }
    console.log(`[Generate Orb] ${t.style} 状态配色：使用主题配色并把亮度对齐到各状态原设计`);
    themeTable[t.style] = Object.fromEntries(
      orbStates.orbStateNames.map((n) => [n, orbUniforms.createOrbUniformSnapshot(orbStates.resolveOrbStateParams(cfg, n))])
    );
    console.log(`[Generate Orb] theme injected: ${t.style} (${t.name})`);
  }

  // 默认主题（siri）同样处理：它的 6 态种子自带 vendor 的固定语义色。规则与导入主题一致
  // —— 颜色用 siri 自己的调色板，亮度对齐到各状态原本的设计。若只改导入主题，就会出现
  // 「默认主题随状态变色、其它主题反而不变」的新不一致。
  const siriSeedTable = themeTable.siri;
  if (siriSeedTable && siriSeedTable.thinking) {
    const siriCols = {};
    for (const [key, off] of Object.entries(PROFILE_COLOR_OFFSET)) {
      siriCols[key] = floatsToHex(siriSeedTable.thinking, off);
    }
    for (const n of ["listening", "executing", "speaking", "error"]) {
      const seed = siriSeedTable[n];
      if (!seed) continue;
      for (const [key, off] of Object.entries(PROFILE_COLOR_OFFSET)) {
        const targetLum = lumOfRgb(rgbOfHex(floatsToHex(seed, off)));
        const hex = scaleColorToLum(siriCols[key], targetLum);
        const int = parseInt(hex.slice(1), 16);
        seed[off] = ((int >> 16) & 255) / 255;
        seed[off + 1] = ((int >> 8) & 255) / 255;
        seed[off + 2] = (int & 255) / 255;
      }
    }
    console.log("[Generate Orb] 默认主题 siri 的 4 个状态配色：主题配色 + 亮度对齐到状态原设计");
  }

  html = html.replace(
    seedMatch[0],
    `${seedMatch[1]}const __ORB_THEMES = ${JSON.stringify(themeTable)};\n` +
      `${seedMatch[1]}const stateSeeds = (() => { try { const t = new URLSearchParams(location.search).get("theme"); ` +
      `if (t && Object.prototype.hasOwnProperty.call(__ORB_THEMES, t)) return __ORB_THEMES[t]; } catch {} ` +
      `return __ORB_THEMES.siri; })();`
  );
  console.log(`[Generate Orb] themes embedded: ${Object.keys(themeTable).join(", ")}`);

  // —— 音频强度表 ——
  //
  // 这里**故意不做按主题分档**：需求是「所有主题的声音动态与默认主题一致」，而运行时
  // 对未登记风格的回退值恰好就是默认主题的强度（产物里 defaultAudioStrength =
  // audioFlowStrengths[siri]）。所以只要不把主题风格写进表里，它们就自动与默认主题同档。
  //
  // 曾经做过「逐索引上限 + 高光收敛 + 风格收敛」的一套压制，起因是在浏览器里看到
  // 非默认主题过曝。后来查明那是**观测工具失真**：同一主题、同一强度、同一音量，
  // 浏览器里渲染成斑驳状，而真机（Electron）里是光滑干净的。在已安装应用里注入强音频
  // 逐状态截图分析像素后确认：默认强度下各主题的过曝量与默认主题同级
  // （frost 近白像素 5.8% / 饱和度 0.855，siri 7.1% / 0.841），**并不存在过驱问题**。
  // 因此压制逻辑已全部移除，保持与默认主题一致（用户明确选择）。
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
  console.log(
    `[Generate Orb] audioFlowStrengths: ${JSON.stringify(audioTuning.amplifiedAudioFlowStrengths)}` +
      "（主题风格不登记，运行时回退到默认主题强度 = 与默认主题同档）"
  );


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
