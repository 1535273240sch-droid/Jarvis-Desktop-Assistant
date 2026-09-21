import * as React from "react";
import { Button } from "@/toolcraft/ui/components/primitives/button";
import { PanelSection } from "@/toolcraft/ui/components/panel/panel-section";
import { audioStyleStrengths, type OrbAudioInput } from "./orb-audio";
import type { StyleName } from "./presets";

export function AudioControls({ input, style, locale }: { input: OrbAudioInput; style: StyleName; locale: "zh" | "en" }) {
  const zh = locale === "zh";
  const supported = audioStyleStrengths[style] !== undefined;
  const [source, setSource] = React.useState<"off" | "pending" | "mic" | "file">("off");
  const [error, setError] = React.useState(false);
  const [gain, setGain] = React.useState(70);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const playerRef = React.useRef<HTMLDivElement>(null);
  const meterRef = React.useRef<HTMLMeterElement>(null);
  const request = React.useRef(0);

  const stop = React.useCallback(() => {
    request.current++;
    input.stop();
    playerRef.current?.replaceChildren();
    setSource("off");
    setError(false);
  }, [input]);

  React.useEffect(() => {
    if (!supported) stop();
  }, [supported, stop]);
  React.useEffect(() => {
    let raf = 0;
    input.gain = 0.7;
    const paint = () => {
      if (meterRef.current) meterRef.current.value = input.level;
      raf = requestAnimationFrame(paint);
    };
    paint();
    const pagehide = () => stop();
    window.addEventListener("pagehide", pagehide);
    return () => {
      request.current++;
      cancelAnimationFrame(raf);
      input.stop();
      window.removeEventListener("pagehide", pagehide);
    };
  }, [input, stop]);

  const start = async (file?: File) => {
    stop();
    const id = request.current;
    setSource("pending");
    try {
      const active = file
        ? await input.file(file, playerRef.current!)
        : await input.microphone(stop);
      if (id === request.current && active) setSource(file ? "file" : "mic");
    } catch {
      if (id !== request.current) return;
      input.stop();
      playerRef.current?.replaceChildren();
      setSource("off");
      setError(true);
    }
  };

  return <PanelSection title={zh ? "声音响应" : "Audio response"}>
    <div className="orb-audio-controls">
      <p className="orb-audio-hint">{supported
        ? (zh ? "声音驱动流动、形变与高光" : "Sound drives motion, shape and highlights")
        : (zh ? "此预设暂不支持声音响应" : "Audio response is unavailable for this preset")}</p>
      {supported && <>
        <div className="orb-audio-actions">
          <Button variant="outline" aria-pressed={source === "mic"} disabled={source === "pending"} onClick={() => void start()}>{zh ? "麦克风" : "Microphone"}</Button>
          <Button variant="outline" disabled={source === "pending"} onClick={() => fileRef.current?.click()}>{zh ? "音频文件" : "Audio file"}</Button>
          {source !== "off" && <Button variant="outline" onClick={stop}>{zh ? "关闭" : "Stop"}</Button>}
        </div>
        <input ref={fileRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac" hidden onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void start(file);
        }} />
        <label className="orb-audio-gain">{zh ? "响应强度" : "Sensitivity"}<output>{gain}%</output>
          <input aria-label={zh ? "响应强度" : "Sensitivity"} type="range" min="0" max="100" value={gain} onChange={(event) => {
            const value = +event.target.value;
            setGain(value);
            input.gain = value / 100;
          }} />
        </label>
        <meter ref={meterRef} min="0" max="1" value="0" aria-label={zh ? "输入音量" : "Input level"} />
      </>}
      <div ref={playerRef} className="orb-audio-player" hidden={!supported || (source !== "file" && source !== "pending")} />
      <p className="orb-audio-hint" role="status">{error
        ? (zh ? "无法打开声音，请检查麦克风权限或更换音频文件。" : "Unable to open audio. Check microphone permission or try another file.")
        : source === "pending" ? (zh ? "正在打开声音…" : "Opening audio…") : source === "mic" ? (zh ? "正在使用麦克风" : "Microphone is active") : ""}</p>
    </div>
  </PanelSection>;
}
