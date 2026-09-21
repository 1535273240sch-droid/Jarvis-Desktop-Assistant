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

  // 强化音频波纹动感与涟漪算法：
  // 提升 mid/low 频段对 warp (6)、ridgeAmt (7) 与 contourDeform (21) 的形变敏感度，
  // 使语音无论上行（人说话）还是下行（AI播报）时，球体表面与外轮廓均呈现强烈的波浪与涟漪律动
  html = html.replace(
    /const audioRules = \[\[3,"all",0,0\.7,5\],\[6,"mid",0\.85,0,7\],\[21,"low",0\.075,0,1\],\[10,"high",0\.16,0,2\],\[14,"all",0,0\.12,4\]\];/,
    'const audioRules = [[3,"all",0,1.2,8],[6,"mid",2.2,0.4,12],[7,"low",0.4,0.8,6],[21,"low",0.38,0.6,1.8],[10,"high",0.35,0.2,3],[14,"all",0,0.25,5]];'
  );
  html = html.replace(
    /const audioFlowStrengths = \{"9":0\.8,"10":0\.65,"11":0\.65,"14":0\.75,"19":1,"21":0\.7\};/,
    'const audioFlowStrengths = {"9":1.6,"10":1.2,"11":1.2,"14":1.4,"19":1.8,"21":1.3};'
  );

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
