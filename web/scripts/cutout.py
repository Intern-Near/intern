# Cut the flat cream background off a generated character image.
# Method: grow the background inward from the image border through pixels that are
# (a) close to the border's cream colour and (b) smooth (no edge). Growth stops at
# the character's edges. Output: RGBA PNG with a slightly feathered alpha.
import sys, numpy as np
from PIL import Image, ImageDraw, ImageFilter

def cutout(src, dst, color_tol=78, grad_tol=7.0):
    im = Image.open(src).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    h, w, _ = a.shape
    b = 12
    border = np.concatenate([a[:b].reshape(-1,3), a[-b:].reshape(-1,3), a[:, :b].reshape(-1,3), a[:, -b:].reshape(-1,3)])
    bg = np.median(border, axis=0)
    dist = np.sqrt(((a - bg) ** 2).sum(axis=2))
    lum = a.mean(axis=2)
    gx = np.zeros_like(lum); gy = np.zeros_like(lum)
    gx[:, 1:-1] = np.abs(lum[:, 2:] - lum[:, :-2]); gy[1:-1] = np.abs(lum[2:] - lum[:-2])
    sat = a.max(axis=2) - a.min(axis=2)
    sx = np.zeros_like(sat); sy = np.zeros_like(sat)
    sx[:, 1:-1] = np.abs(sat[:, 2:] - sat[:, :-2]); sy[1:-1] = np.abs(sat[2:] - sat[:-2])
    grad = np.maximum(gx + gy, sx + sy)
    cand = (dist < color_tol) & (grad < grad_tol)
    m = Image.fromarray((cand * 255).astype(np.uint8), "L").copy()
    px = m.load()
    seeds = [(x, y) for x in range(0, w, 16) for y in (0, h - 1)] + [(x, y) for y in range(0, h, 16) for x in (0, w - 1)]
    for s in seeds:
        if px[s] == 255:
            ImageDraw.floodfill(m, s, 128)
    # Enclosed pockets of pure background (between the legs, inside a handle): start a
    # second fill from any pixel that is almost exactly the background colour.
    arr = np.asarray(m)
    pure = (dist < 2.6) & (arr == 255)
    ys, xs = np.nonzero(pure)
    for i in range(0, len(ys), 97):
        s2 = (int(xs[i]), int(ys[i]))
        if px[s2] == 255:
            ImageDraw.floodfill(m, s2, 128)
    bgmask = np.asarray(m) == 128
    alpha = Image.fromarray(((~bgmask) * 255).astype(np.uint8), "L")
    alpha = alpha.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(9))   # close small gaps, then pull the edge in
    alpha = alpha.filter(ImageFilter.GaussianBlur(1.2))
    out = im.convert("RGBA"); out.putalpha(alpha)
    bbox = alpha.point(lambda v: 255 if v > 8 else 0).getbbox()
    out.crop(bbox).save(dst)
    return bbox, float(bgmask.mean())

if __name__ == "__main__":
    for src, dst in zip(sys.argv[1::2], sys.argv[2::2]):
        print(dst, *cutout(src, dst))
