"""Build the room background, the sixteen stickers and the small face icons.

Run from intern/web after build_cast.py:  python3 scripts/build_room.py
Source art (AI-generated, see README): ../../sketches/chatgpt/
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, "..", "..", "..", "sketches", "chatgpt"))
PUB = os.path.normpath(os.path.join(HERE, "..", "public"))
TMP = os.path.join(HERE, ".tmp")

CODES = ["outside_window", "fired", "bad_model_signature", "wrong_rulebook", "malformed_decision",
         "not_on_list", "short_not_unlocked", "zero_margin", "over_leverage", "too_many_trades",
         "over_trade_limit", "over_round_limit", "bad_quote_signature", "stale_quote",
         "quote_mismatch", "too_expensive"]

def save(im, path, **kw):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, "WEBP", method=6, **kw)
    print(f"{os.path.relpath(path, PUB):36s} {im.size}  {os.path.getsize(path)/1024:.0f} kB")

def main():
    desk = Image.open(os.path.join(SRC, "room", "desk-strip.png")).convert("RGB")
    save(desk.resize((1752, 897), Image.LANCZOS), os.path.join(PUB, "room", "desk-strip.webp"), quality=80)
    save(desk.resize((876, 448), Image.LANCZOS), os.path.join(PUB, "room", "desk-strip-s.webp"), quality=78)
    for code in CODES:
        im = Image.open(os.path.join(SRC, "stickers", code + ".png")).convert("RGB")
        w, h = im.size; s = min(w, h)
        im = im.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2)).resize((256, 256), Image.LANCZOS)
        save(im, os.path.join(PUB, "stickers", code + ".webp"), quality=82)
    # Face icons: the top square of each cut-out, so a 40px tile shows a face, not a whole body
    for name, cut, frac in [("intern", "intern-idle", 0.62), ("stamp", "stamp-watching", 0.80),
                            ("tin", "tin-resting", 1.0), ("mug", "mug-mug", 0.86), ("shredder", "shredder-asleep", 0.9)]:
        im = Image.open(os.path.join(TMP, cut + ".png"))
        w, h = im.size
        side = int(max(w, h * frac))
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        crop = im.crop((0, 0 if frac < 1 else 0, w, int(h * frac))) if name in ("intern",) else im.crop((0, h - int(h * frac), w, h))
        canvas.paste(crop, ((side - crop.width) // 2, (side - crop.height) // 2), crop)
        save(canvas.resize((112, 112), Image.LANCZOS), os.path.join(PUB, "cast", f"face-{name}.webp"), quality=86)

if __name__ == "__main__":
    main()
