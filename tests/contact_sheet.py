"""Builds a labelled contact sheet: one row per task, 'filled form before confirm' next to 'final page'."""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

def font(size):
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"):
        if Path(f).exists():
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()

def build(title, rows, out, col_w=640, max_h=520):
    """rows: [(label, verdict, [image paths])]"""
    head, label_h, pad = 70, 34, 16
    cells = []
    for label, verdict, paths in rows:
        imgs = []
        for p in paths:
            im = Image.open(p).convert("RGB")
            im = im.resize((col_w, int(im.height * col_w / im.width)))
            imgs.append(im.crop((0, 0, col_w, min(im.height, max_h))))
        cells.append((label, verdict, imgs, max([i.height for i in imgs] or [100])))
    ncol = max(len(c[2]) for c in cells)
    W = pad + ncol * (col_w + pad)
    H = head + sum(label_h + h + pad for *_, h in cells)
    sheet = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(sheet)
    d.text((pad, 18), title, fill="#111", font=font(26))
    y = head
    for label, verdict, imgs, h in cells:
        color = "#15803d" if verdict.startswith("✓") else "#b45309" if verdict.startswith("◐") else "#b91c1c"
        d.text((pad, y + 6), label, fill="#111", font=font(18))
        d.text((pad + col_w + pad, y + 6), verdict.replace("✓", "PASS").replace("◐", "PARTIAL").replace("✗", "FAIL"), fill=color, font=font(18))
        for i, im in enumerate(imgs):
            x = pad + i * (col_w + pad)
            sheet.paste(im, (x, y + label_h))
            d.rectangle([x, y + label_h, x + im.width - 1, y + label_h + im.height - 1], outline="#bbb")
        y += label_h + h + pad
    sheet.save(out, optimize=True)
    print(out, sheet.size)

if __name__ == "__main__":
    title, out, *dirs = sys.argv[1:]
    results = {}
    for d in dirs:  # later dirs override earlier ones (follow-up reruns)
        for r in json.loads((Path(d) / "results.json").read_text())["results"]:
            if "task" in r:
                results[r["task"]] = (r, Path(d))
    rows = []
    for task, (r, d) in results.items():
        shots = sorted(d.glob(f"{task}-before-confirm-*.png"))[-1:] + [d / f"{task}-end.png"]
        verdict = ("✓ " if r["success"] else "◐ " if r["submitted"] else "✗ ") + r["field_score"] + " fields"
        rows.append((f"{task} — {r['site']}", verdict, [p for p in shots if p.exists()]))
    build(title, rows, out)
