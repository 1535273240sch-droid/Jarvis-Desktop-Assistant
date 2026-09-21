import { styleFlowIndexes, type StyleName } from "./presets";

export type AudioBands = { low: number; mid: number; high: number; all: number };
export const silentBands = (): AudioBands => ({ low: 0, mid: 0, high: 0, all: 0 });

// index, frequency band, additive amount, proportional amount, ceiling.
// Apply after the state transition, never back into saved preset parameters.
export const audioRules = [
  [3, "all", 0, 0.7, 5],
  [6, "mid", 0.85, 0, 7],
  [21, "low", 0.075, 0, 1],
  [10, "high", 0.16, 0, 2],
  [14, "all", 0, 0.12, 4],
] as const;

export const audioStyleStrengths: Partial<Record<StyleName, number>> = {
  siri: 0.8, voiceWave: 1, aurora: 0.65,
  plasma: 0.65, spectrum: 0.75, violetEmber: 0.7,
};
export const audioFlowStrengths: Record<number, number> = Object.fromEntries(
  Object.entries(audioStyleStrengths).map(([style, strength]) => [styleFlowIndexes[style as StyleName], strength]),
);

export function applyAudioUniforms(values: Float32Array, bands: AudioBands): void {
  const strength = audioFlowStrengths[Math.round(values[15])] ?? 0;
  if (!strength) return;
  for (const [index, band, additive, proportional, ceiling] of audioRules) {
    const input = bands[band];
    const level = (Number.isFinite(input) ? Math.max(0, Math.min(1, input)) : 0) * strength;
    if (!level) continue;
    values[index] = Math.min(Math.max(ceiling, values[index]), values[index] * (1 + proportional * level) + additive * level);
  }
}

/** Independent, local-only input. No microphone monitoring or network upload. */
export class OrbAudioInput {
  gain = 0.7;
  level = 0;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: AudioNode | null = null;
  private stream: MediaStream | null = null;
  private player: HTMLAudioElement | null = null;
  private url: string | null = null;
  private generation = 0;
  private spectrum = new Uint8Array(0);
  private waveform = new Float32Array(0);
  private smoothed = silentBands();

  stop(): void {
    this.generation++;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.source?.disconnect();
    if (this.player) {
      this.player.pause();
      this.player.removeAttribute("src");
      this.player.load();
    }
    if (this.url) URL.revokeObjectURL(this.url);
    void this.context?.close().catch(() => {});
    this.context = this.analyser = this.source = this.stream = this.player = this.url = null;
    this.smoothed = silentBands();
    this.level = 0;
  }

  private async setup(): Promise<number> {
    this.stop();
    const generation = this.generation;
    const context = new AudioContext();
    this.context = context;
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.65;
    this.spectrum = new Uint8Array(this.analyser.frequencyBinCount);
    this.waveform = new Float32Array(this.analyser.fftSize);
    await context.resume();
    return generation;
  }

  async microphone(onEnded: () => void): Promise<boolean> {
    const generation = await this.setup();
    if (generation !== this.generation) return false;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone unavailable");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }
    this.stream = stream;
    this.source = this.context!.createMediaStreamSource(stream);
    this.source.connect(this.analyser!);
    stream.getAudioTracks()[0].onended = () => {
      if (this.stream === stream) { this.stop(); onEnded(); }
    };
    return true;
  }

  async file(file: File, host: HTMLElement): Promise<boolean> {
    const generation = await this.setup();
    if (generation !== this.generation) return false;
    // A fresh media element avoids rebinding an element already attached to a closed context.
    const player = document.createElement("audio");
    player.controls = true;
    player.setAttribute("aria-label", file.name);
    host.replaceChildren(player);
    this.player = player;
    this.url = URL.createObjectURL(file);
    player.src = this.url;
    this.source = this.context!.createMediaElementSource(player);
    this.source.connect(this.analyser!);
    this.source.connect(this.context!.destination);
    await player.play();
    return generation === this.generation;
  }

  read(dt: number): AudioBands {
    const target = silentBands();
    const analyser = this.analyser;
    if (analyser && this.context?.state === "running" && (this.stream?.active || (this.player && !this.player.paused && !this.player.ended))) {
      analyser.getByteFrequencyData(this.spectrum);
      analyser.getFloatTimeDomainData(this.waveform);
      const rms = Math.sqrt(this.waveform.reduce((sum, value) => sum + value * value, 0) / this.waveform.length);
      target.all = Math.min(1, Math.max(0, rms - 0.004) * 5.5);
      const average = (from: number, to: number) => {
        const bin = (hz: number) => Math.max(0, Math.min(this.spectrum.length - 1, Math.round(hz / (this.context!.sampleRate / 2) * this.spectrum.length)));
        const start = bin(from), end = bin(to);
        let sum = 0;
        for (let i = start; i <= end; i++) sum += this.spectrum[i];
        return target.all === 0 ? 0 : Math.min(1, sum / (end - start + 1) / 255 * 2);
      };
      target.low = average(30, 200);
      target.mid = average(200, 2000);
      target.high = average(2000, 16000);
    }
    for (const band of ["low", "mid", "high", "all"] as const) {
      const tau = target[band] > this.smoothed[band] ? 0.07 : 0.24;
      this.smoothed[band] += (target[band] - this.smoothed[band]) * (1 - Math.exp(-dt / tau));
      if (this.smoothed[band] < 0.0001) this.smoothed[band] = 0;
    }
    this.level = this.smoothed.all;
    return Object.fromEntries(Object.entries(this.smoothed).map(([key, value]) => [key, Math.min(1, value * this.gain / 0.7)])) as AudioBands;
  }
}
