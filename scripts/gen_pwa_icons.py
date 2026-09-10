from PIL import Image, ImageDraw, ImageFont

FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
C1 = (37, 99, 235)   # #2563EB
C2 = (59, 130, 246)  # #3B82F6

def gradient_square(size):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size)  # diagonal 0..1
            r = int(C1[0] + (C2[0] - C1[0]) * t)
            g = int(C1[1] + (C2[1] - C1[1]) * t)
            b = int(C1[2] + (C2[2] - C1[2]) * t)
            px[x, y] = (r, g, b)
    return img

def make_icon(size, out_path, maskable=False):
    img = gradient_square(size)
    draw = ImageDraw.Draw(img)
    # Maskable icons get cropped to a circle/squircle by the OS launcher, so
    # keep the glyph inside the ~80% safe zone. Non-maskable can use more space.
    glyph_ratio = 0.34 if maskable else 0.47
    font = ImageFont.truetype(FONT_PATH, int(size * glyph_ratio))
    text = "$"
    bbox = draw.textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (size - w) / 2 - bbox[0]
    y = (size - h) / 2 - bbox[1]
    draw.text((x, y), text, font=font, fill=(255, 255, 255))
    img.save(out_path, "PNG")
    print(f"wrote {out_path} ({size}x{size}, maskable={maskable})")

make_icon(192, "public/pwa-192x192.png", maskable=False)
make_icon(512, "public/pwa-512x512.png", maskable=True)
