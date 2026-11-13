import { useEffect, useRef } from "react";
import { voiceLevel } from "./voice";

/**
 * The Live2D loader: puts a rigged Live2D model on the stream page and moves it.
 *
 *  - the mouth opens while the Intern is talking (from the voice's loudness when a voice file plays,
 *    otherwise a talking rhythm for as long as the line is on screen);
 *  - blinking, breathing and the idle motion come from the model itself;
 *  - the head looks somewhere new every few seconds;
 *  - the expression follows the pose of the current event (idle, thinking, refused, happy…).
 *
 * The model is a folder exported from the Live2D editor (…/NAME.model3.json and the files it names).
 * Two outside pieces are fetched only when a model is shown: Live2D's own runtime (Cubism Core, from
 * Live2D's server, under Live2D's licence) and the MIT library pixi-live2d-display-lipsyncpatch on pixi.js 7.
 */

const CORE_URL = "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js";

/** If a model has no expression named after our pose, the nearest one by these names is used. */
const ALIASES: Record<string, string[]> = {
  idle: ["normal", "neutral", "default"],
  thinking: ["normal", "neutral"],
  proposing: ["relaxed_happy", "happy", "smile"],
  waiting: ["surprised", "nervous", "worried"],
  happy: ["very_happy", "happy", "smile"],
  refused: ["sad", "annoyed", "worried"],
  promoted: ["enthusiactic_joyfull", "very_happy", "happy"],
  fired: ["sad", "cry"],
};

/**
 * The Intern's own rig has no expression files; its face is set from these control values instead.
 * form: -1 worried mouth, 0 smile, 1 big happy mouth. brow: -1 lowered, 1 raised. sweat: the drop.
 * arm: -30 tucked in, 0 resting, 30 raised. wave: the raised arms keep waving.
 */
const FACES: Record<string, { form: number; browL: number; browR: number; sweat: number; armL: number; armR: number; wave?: boolean }> = {
  idle: { form: 0, browL: 0, browR: 0, sweat: 0, armL: 0, armR: 0 },
  thinking: { form: 0, browL: 1, browR: -0.4, sweat: 0, armL: 14, armR: 0 },
  proposing: { form: 1, browL: 0.6, browR: 0.6, sweat: 0, armL: 0, armR: 28 },
  waiting: { form: 0, browL: -0.7, browR: -0.7, sweat: 1, armL: -7, armR: -7 },
  happy: { form: 1, browL: 1, browR: 1, sweat: 0, armL: 22, armR: 22 },
  refused: { form: -1, browL: -1, browR: -1, sweat: 1, armL: -10, armR: -10 },
  promoted: { form: 1, browL: 1, browR: 1, sweat: 0, armL: 27, armR: 27, wave: true },
  fired: { form: -1, browL: -1, browR: -1, sweat: 0, armL: -12, armR: -12 },
};

let core: Promise<void> | undefined;
function loadCore(): Promise<void> {
  core ??= new Promise((resolve, reject) => {
    if ((window as { Live2DCubismCore?: unknown }).Live2DCubismCore) return resolve();
    const s = document.createElement("script");
    s.src = CORE_URL;
    s.onload = () => resolve();
    s.onerror = () => {
      core = undefined;
      reject(new Error("Live2D's runtime could not be downloaded."));
    };
    document.head.appendChild(s);
  });
  return core;
}

type Props = {
  /** Address of the .model3.json file. */
  url: string;
  /** One of the Intern's eight poses; picks the expression. */
  mood: string;
  /** True while a line is being said. */
  talking: boolean;
  /** Called once: true when the model is on screen, false if it could not be shown. */
  onReady: (ok: boolean, why?: string) => void;
};

// The library's own types are large; these are the few calls used here.
type Model = {
  width: number;
  height: number;
  scale: { set(v: number): void };
  x: number;
  y: number;
  anchor: { set(x: number, y: number): void };
  expression(id?: string): Promise<boolean>;
  focus(x: number, y: number, instant?: boolean): void;
  destroy(): void;
  internalModel: {
    settings: { expressions?: { Name: string }[]; groups?: { Name: string; Ids: string[] }[] };
    coreModel: { setParameterValueById(id: string, value: number, weight?: number): void };
    on(event: "beforeModelUpdate", fn: () => void): void;
  };
};

function express(m: Model, mood: string) {
  const have = (m.internalModel.settings.expressions ?? []).map((e) => e.Name);
  const pick = have.includes(mood) ? mood : (ALIASES[mood] ?? []).find((n) => have.includes(n));
  if (pick) void m.expression(pick);
}

export function Puppet({ url, mood, talking, onReady }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const model = useRef<Model | null>(null);
  const talkingRef = useRef(talking);
  talkingRef.current = talking;
  const moodRef = useRef(mood);
  moodRef.current = mood;

  useEffect(() => {
    let alive = true;
    let cleanup = () => {};
    (async () => {
      const box = host.current;
      if (!box) return;
      await loadCore();
      const PIXI = await import("pixi.js");
      const { Live2DModel } = await import("pixi-live2d-display-lipsyncpatch/cubism4");
      if (!alive) return;
      Live2DModel.registerTicker(PIXI.Ticker);
      const app = new PIXI.Application({ backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: Math.min(2, window.devicePixelRatio || 1), resizeTo: box });
      box.appendChild(app.view as HTMLCanvasElement);
      const m = (await Live2DModel.from(url, { autoHitTest: false, autoFocus: false })) as unknown as Model;
      if (!alive) {
        app.destroy(true);
        return;
      }
      app.stage.addChild(m as never);
      const natural = { w: m.width, h: m.height };
      // The exported canvas has empty space around the character; `?zoom=` (default 1.35) fills the stage with it
      const zoom = Number(new URLSearchParams(window.location.search).get("zoom")) || 1.35;
      let base = 1;
      const fit = () => {
        base = Math.min(app.screen.width / natural.w, app.screen.height / natural.h) * zoom;
        m.scale.set(base);
        m.anchor.set(0.5, 0.86);
        m.x = app.screen.width / 2;
        m.y = app.screen.height;
      };
      fit();
      // The drawing area follows its box: it starts hidden (zero height) until the model is ready, then grows
      const watch = new ResizeObserver(() => {
        app.resize();
        fit();
      });
      watch.observe(box);

      // The mouth: a talking rhythm made of two overlapping waves, so it does not look like a metronome
      const lipIds = m.internalModel.settings.groups?.find((g) => g.Name === "LipSync")?.Ids ?? [];
      const mouth = lipIds.length > 0 ? lipIds : ["ParamMouthOpenY"];
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      let open = 0;
      const face = { browL: 0, browR: 0, sweat: 0, armL: 0, armR: 0 };
      m.internalModel.on("beforeModelUpdate", () => {
        const t = performance.now() / 1000;
        const set = (id: string, v: number) => m.internalModel.coreModel.setParameterValueById(id, v);
        // Open or shut, changing quickly: a mouth made of two drawings looks muddy when held half-way
        // With a real voice the mouth follows how loud it is; without one, a talking rhythm for as long as the line shows
        const loud = voiceLevel();
        const wave = Math.sin(t * 15) * Math.sin(t * 4.7 + 1) + 0.25 * Math.sin(t * 29);
        const target = loud !== null ? (loud > 0.12 ? 1 : 0) : talkingRef.current && wave > -0.05 ? 1 : 0;
        open += (target - open) * 0.6;
        for (const id of mouth) set(id, open);
        // The face for the current pose. While the mouth is open for a syllable the mood mouth steps aside,
        // so two mouths are never drawn on top of each other.
        const want = FACES[moodRef.current] ?? FACES.idle!;
        set("ParamMouthForm", open > 0.5 ? 0 : want.form);
        face.browL += (want.browL - face.browL) * 0.2;
        face.browR += (want.browR - face.browR) * 0.2;
        face.sweat += (want.sweat - face.sweat) * 0.25;
        set("ParamBrowLY", face.browL);
        set("ParamBrowRY", face.browR);
        set("ParamSweat", face.sweat);
        // Arms ease to the pose, with a small gesture while talking and a wave when celebrating
        const move = reduced ? 0 : want.wave ? 3 * Math.sin(t * 9) : talkingRef.current ? 2.5 * Math.sin(t * 3.4) : 0;
        face.armL += (want.armL + move - face.armL) * 0.14;
        face.armR += (want.armR - move - face.armR) * 0.14;
        set("ParamArmLA", face.armL);
        set("ParamArmRA", face.armR);
        for (const [id, v] of Object.entries(forced)) m.internalModel.coreModel.setParameterValueById(id, v);
      });
      // While developing: `__puppetForce.SomeParamId = 1` in the browser console pins a control, to check a rig
      const forced: Record<string, number> = {};
      if (import.meta.env.DEV) (window as { __puppetForce?: Record<string, number> }).__puppetForce = forced;

      // Breathing and a little sway while talking, done on the whole figure so it works before the rig has those controls
      const breathe = () => {
        if (reduced) return;
        const t = performance.now() / 1000;
        (m.scale as unknown as { y: number }).y = base * (1 + 0.012 * Math.sin(t * 1.9));
        (m as unknown as { rotation: number }).rotation = (talkingRef.current ? 0.03 : 0.012) * Math.sin(t * (talkingRef.current ? 3.1 : 0.9));
      };
      app.ticker.add(breathe);

      // The head: mostly straight ahead, sometimes off to a side (the same odds the old engine used)
      const look = window.setInterval(() => {
        const r = Math.random();
        const [dx, dy] = r < 0.6 ? [0, 0] : r < 0.7 ? [-1, 0] : r < 0.8 ? [1, 0] : r < 0.9 ? [0, -0.6] : [0, 0.6];
        m.focus(app.screen.width / 2 + dx * app.screen.width, app.screen.height / 2 + dy * app.screen.height);
      }, 5000);

      model.current = m;
      express(m, moodRef.current);
      onReady(true);
      cleanup = () => {
        window.clearInterval(look);
        watch.disconnect();
        model.current = null;
        app.destroy(true, { children: true });
      };
    })().catch((e: unknown) => alive && onReady(false, e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
      cleanup();
    };
    // One model per address. `onReady` is only called once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // The expression follows the pose
  useEffect(() => {
    if (model.current) express(model.current, mood);
  }, [mood]);

  return <div ref={host} className="puppet" role="img" aria-label={`The Intern, ${mood}${talking ? ", talking" : ""}`} />;
}
