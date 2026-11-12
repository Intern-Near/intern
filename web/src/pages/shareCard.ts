/**
 * Draws a NOPE as a 1200×630 image in the browser and downloads it.
 * (Link previews on other sites need an image a server can reach; that is not built yet.)
 */
export type CardData = { id: number; code: string; sentence: string; asked: string; meta: string };

const W = 1200;
const H = 630;
const INK = "#1B1A17";
const CREAM = "#FFF6E5";
const TOMATO = "#FF5A47";
const STICKY = "#FFD23F";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${src}`));
    img.src = src;
  });
}

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > max && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

export async function renderCard(d: CardData): Promise<HTMLCanvasElement> {
  const display = '700 96px "DynaPuff Variable"';
  const text = '600 40px "Bricolage Grotesque Variable"';
  const small = '400 26px "Bricolage Grotesque Variable"';
  const mono = '22px "Departure Mono"';
  await Promise.all([display, text, small, mono].map((f) => document.fonts.load(f)));
  const intern = await loadImage("/cast/intern-refused.webp");

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");

  // Ground and frame
  ctx.fillStyle = TOMATO;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = CREAM;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 8;
  roundRect(ctx, 28, 28, W - 56, H - 56, 40);
  ctx.fill();
  ctx.stroke();

  // The Intern, on a sticky-yellow disc
  ctx.fillStyle = STICKY;
  ctx.beginPath();
  ctx.arc(250, 330, 190, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.drawImage(intern, 40, 90, 430, 430);

  // The stamp mark
  ctx.save();
  ctx.translate(690, 150);
  ctx.rotate((-6 * Math.PI) / 180);
  ctx.fillStyle = TOMATO;
  roundRect(ctx, -190, -70, 380, 140, 18);
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.stroke();
  roundRect(ctx, -176, -56, 352, 112, 10);
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.font = display;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("NOPE", 0, 4);
  ctx.restore();

  // The words
  const x = 500;
  const max = W - x - 70;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = INK;
  ctx.font = text;
  let y = 290;
  for (const line of wrap(ctx, d.sentence, max).slice(0, 3)) {
    ctx.fillText(line, x, y);
    y += 50;
  }
  ctx.font = mono;
  ctx.fillText(d.code, x, y + 8);
  y += 52;
  ctx.font = small;
  ctx.fillStyle = "#6A645A";
  for (const line of wrap(ctx, d.asked, max).slice(0, 2)) {
    ctx.fillText(line, x, y);
    y += 34;
  }

  // Footer
  ctx.font = mono;
  ctx.fillStyle = INK;
  ctx.fillText(d.meta.toUpperCase(), x, H - 104);
  ctx.fillText(`$INTERN · NOPE NO. ${d.id} · TEST NETWORK`, x, H - 70);
  return canvas;
}

export async function saveCard(d: CardData): Promise<void> {
  const canvas = await renderCard(d);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("no image");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `intern-nope-${d.id}.png`;
  a.click();
  URL.revokeObjectURL(url);
}
