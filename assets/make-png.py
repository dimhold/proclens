"""Draw the same frame as a PNG, for places that will not render SVG.

    node assets/make-screenshot.mjs --json > frame.json
    python assets/make-png.py frame.json assets/screen.png

npmjs.com strips SVG out of a README and X does not accept it at all, so the
picture has to exist as pixels too. It is drawn from the JSON the SVG
generator emits, not redrawn by hand, so the two cannot disagree: one frame,
produced by the program's own rendering code, two outputs.
"""

import json
import sys
from PIL import Image, ImageDraw, ImageFont

FONT = r"C:\Windows\Fonts\consola.ttf"
FONT_BOLD = r"C:\Windows\Fonts\consolab.ttf"
SIZE = 17
SCALE = 2  # drawn at 2x and downsampled, so the text is not fuzzy

BG = (13, 17, 23)
CHROME = (22, 27, 34)
DEFAULT = "#e6edf3"
SELECT = (31, 111, 235, 90)

PAD_X, PAD_TOP, BAR = 22, 52, 36


def main(frame_path: str, out_path: str) -> None:
    with open(frame_path, encoding="utf-8") as fh:
        frame = json.load(fh)
    lines = frame["lines"]

    font = ImageFont.truetype(FONT, SIZE * SCALE)
    bold = ImageFont.truetype(FONT_BOLD, SIZE * SCALE)
    # Consolas is monospaced, so one character's advance is every character's.
    cell_w = font.getlength("M")
    cell_h = int(SIZE * SCALE * 1.35)

    width = int(PAD_X * 2 * SCALE + cell_w * frame["cols"])
    height = int(PAD_TOP * SCALE + cell_h * len(lines) + 18 * SCALE)

    img = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(img, "RGBA")
    draw.rectangle([0, 0, width, BAR * SCALE], fill=CHROME)
    for i, colour in enumerate(((255, 95, 86), (255, 189, 46), (39, 201, 63))):
        cx = (20 + i * 20) * SCALE
        r = 6 * SCALE
        draw.ellipse([cx - r, 18 * SCALE - r, cx + r, 18 * SCALE + r], fill=colour)
    draw.text((width / 2, 12 * SCALE), "dev@laptop: whotop", font=font, fill="#8b949e", anchor="ma")

    for row, runs in enumerate(lines):
        y = PAD_TOP * SCALE + row * cell_h
        if any(run.get("inverse") for run in runs):
            draw.rectangle([PAD_X * SCALE - 6, y - 4, width - PAD_X * SCALE + 6, y + cell_h - 4], fill=SELECT)
        col = 0
        for run in runs:
            text = run["text"]
            x = PAD_X * SCALE + col * cell_w
            col += len(text)
            fill = "#f0f6fc" if run.get("inverse") else run.get("fill") or DEFAULT
            draw.text((x, y), text, font=bold if run.get("bold") else font, fill=fill)

    img.resize((width // SCALE, height // SCALE), Image.LANCZOS).save(out_path)
    print(f"{out_path}: {width // SCALE}x{height // SCALE}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
