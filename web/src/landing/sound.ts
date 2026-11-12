/**
 * Every sound on the landing page, made in the browser. No audio files.
 * On by default; the visitor can switch it off, and the choice is remembered.
 *
 * The characters "talk" in babble: short pitched blips while their words type out.
 * Recorded voice lines can replace `babbleTick` later without touching the callers.
 */
type Voice = "intern" | "stamp";

const KEY = "intern-sound";
let ctx: AudioContext | null = null;
let on = true;
const listeners = new Set<() => void>();

try {
  on = window.localStorage.getItem(KEY) !== "off";
} catch {
  on = true;
}

export const soundOn = () => on;

export function subscribeSound(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Must be called from a click or key press: browsers only allow sound after one. */
export function setSound(next: boolean) {
  on = next;
  try {
    window.localStorage.setItem(KEY, next ? "on" : "off");
  } catch {
    /* private mode: the choice just isn't remembered */
  }
  if (next) {
    audio();
    pop();
  }
  listeners.forEach((l) => l());
}

function audio(): AudioContext | null {
  if (!on) return null;
  try {
    ctx ??= new AudioContext();
    // A browser keeps sound asleep until the visitor clicks or presses a key. Ask it to wake;
    // anything scheduled meanwhile plays the moment it does.
    if (ctx.state !== "running") {
      void ctx.resume();
      // Still asleep: drop this sound rather than queue it, or everything queued
      // would go off at once on the visitor's first click.
      return null;
    }
    return ctx;
  } catch {
    return null;
  }
}

// If sound was left on from an earlier visit, the first click or key press on this visit wakes it.
if (typeof window !== "undefined") {
  const wake = () => {
    if (on) audio();
  };
  window.addEventListener("pointerdown", wake, { passive: true });
  window.addEventListener("keydown", wake);
}

function tone(freq: number, ms: number, type: OscillatorType, gain: number, slideTo?: number) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + ms / 1000);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + ms / 1000 + 0.02);
}

/** One syllable of babble. The Intern is high and quick; Stamp is low and flat. */
export function babbleTick(voice: Voice, seed: number) {
  if (voice === "intern") tone(520 + ((seed * 97) % 7) * 46, 60, "triangle", 0.22);
  else tone(120 + ((seed * 31) % 3) * 12, 90, "square", 0.14);
}

/** Stamp coming down. */
export function thud() {
  tone(150, 220, "sine", 0.9, 38);
  tone(70, 140, "square", 0.2, 40);
}

/** A sticker, a mug, a small yes. */
export function pop() {
  tone(420, 110, "sine", 0.35, 880);
}

/** Something went the Intern's way. */
export function chime() {
  tone(660, 140, "triangle", 0.3);
  window.setTimeout(() => tone(880, 200, "triangle", 0.3), 100);
}
