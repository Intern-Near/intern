"""Build the cast images for the site.

For every pose: cut the cream background off the generated image, then place the
character on a shared square canvas with its feet on one baseline and its body
centred, so nothing jumps when a pose changes. Output: WebP in public/cast/.

Run from intern/web:  python3 scripts/build_cast.py
Source art (AI-generated, see README): ../../sketches/chatgpt/
"""
import os, sys, json
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from cutout import cutout

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, "..", "..", "..", "sketches", "chatgpt"))
OUT = os.path.normpath(os.path.join(HERE, "..", "public", "cast"))
TMP = os.path.join(HERE, ".tmp")

CANVAS = 1160     # working canvas, source pixels
BASELINE = 1110   # y of the feet line on the working canvas
SIZE = 720        # exported size (2x of the largest on-screen size)

CAST = {
    "intern": {
        "idle": "intern/anchor.png", "thinking": "intern/thinking.png",
        "proposing": "intern/proposing.png", "waiting": "intern/waiting.png",
        "happy": "intern/happy.png", "refused": "intern/refused.png",
        "promoted": "intern/promoted.png", "fired": "intern/fired.png",
        "analyst": "intern/rank-analyst.png", "trader": "intern/rank-trader.png",
    },
    "stamp": {"watching": "stamp/watching.png", "slamming": "stamp/slamming-down.png",
              "landed": "stamp/just-landed.png"},
    "tin": {"resting": "tin/resting.png", "coin": "tin/coin.png"},
    "shredder": {"asleep": "shredder/asleep.png", "awake": "shredder/awake.png"},
    "mug": {"mug": "boss-mug/mug.png"},
}

def main():
    os.makedirs(OUT, exist_ok=True); os.makedirs(TMP, exist_ok=True)
    manifest = {}
    for who, poses in CAST.items():
        for pose, rel in poses.items():
            tmp = os.path.join(TMP, f"{who}-{pose}.png")
            bbox, bg_share = cutout(os.path.join(SRC, rel), tmp)
            cut = Image.open(tmp)
            w, h = cut.size
            canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
            x = (CANVAS - w) // 2
            y = BASELINE - h
            if y < 0:
                raise SystemExit(f"{who}-{pose} is taller than the canvas ({h})")
            canvas.paste(cut, (x, y), cut)
            out = canvas.resize((SIZE, SIZE), Image.LANCZOS)
            name = f"{who}-{pose}.webp"
            out.save(os.path.join(OUT, name), "WEBP", quality=86, method=6)
            kb = os.path.getsize(os.path.join(OUT, name)) / 1024
            manifest[f"{who}-{pose}"] = {"file": name, "w": w, "h": h, "kb": round(kb, 1)}
            print(f"{name:28s} cut {w}x{h}  bg {bg_share:.2f}  {kb:.0f} kB")
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    print("total kB:", round(sum(v["kb"] for v in manifest.values())))

if __name__ == "__main__":
    main()
