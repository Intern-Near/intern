/**
 * The Intern's real voice on the stream page. The website's server (web/server/server.mjs) turns a line
 * into speech with ElevenLabs and keeps the key; this file plays the sound and reports how loud it is
 * right now, so the Live2D mouth can follow the actual voice.
 */

let enabled: Promise<boolean> | undefined;

/** Whether this copy of the site has a voice server behind it. Asked once. */
export function voiceAvailable(): Promise<boolean> {
  enabled ??= fetch("/say/status")
    .then((r) => (r.ok && (r.headers.get("content-type") ?? "").includes("json") ? r.json() : null))
    .then((d: { enabled?: boolean } | null) => d?.enabled === true)
    .catch(() => false);
  return enabled;
}

let ctx: AudioContext | undefined;
let analyser: AnalyserNode | undefined;
let playing: AudioBufferSourceNode | null = null;
let samples: Uint8Array<ArrayBuffer> | undefined;

/** How loud the voice is this instant, 0 to 1, or null when nothing is being said. */
export function voiceLevel(): number | null {
  if (!playing || !analyser || !samples) return null;
  analyser.getByteTimeDomainData(samples);
  let sum = 0;
  for (const v of samples) sum += ((v - 128) / 128) ** 2;
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}

export function stopVoice(): void {
  try {
    playing?.stop();
  } catch {
    /* it had already ended */
  }
  playing = null;
}

/** Says a line. Resolves to true when the sound started, false if the server could not say it. */
export async function sayLine(text: string): Promise<boolean> {
  try {
    const res = await fetch("/say", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!res.ok) return false;
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    if (!analyser) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.connect(ctx.destination);
      samples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    }
    const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
    stopVoice();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    source.onended = () => {
      if (playing === source) playing = null;
    };
    playing = source;
    source.start();
    return true;
  } catch {
    return false;
  }
}
