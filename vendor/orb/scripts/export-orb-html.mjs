import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const outputPath = process.argv[2] 
  ? resolve(process.cwd(), process.argv[2])
  : resolve(rootDir, "output/orb-export.html");

const server = await createServer({
  root: rootDir,
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
  const html = codeExport.createWebExport(config, "idle");

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf-8");

  console.log(`[Orb Export] Successfully generated self-contained Orb HTML with 6 states to: ${outputPath}`);
} finally {
  await server.close();
}
