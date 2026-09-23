import { writeFile, mkdir } from "node:fs/promises";
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
  const [orbStates, codeExport] = await Promise.all([
    server.ssrLoadModule("/src/orb-states.ts"),
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
