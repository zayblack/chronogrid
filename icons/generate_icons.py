#!/usr/bin/env python3
"""Regenerate the ChronoGrid PWA icons (requires Pillow).

Run from this folder: python3 generate_icons.py
The design is drawn large and downsampled so the 192px and 512px PNGs stay crisp.
The clock sits inside the maskable-icon safe zone, and the background fills the
whole canvas, so the icons also work when Android masks them to a circle.
"""
from pathlib import Path
import math

from PIL import Image, ImageDraw

SIZE = 2048  # design space is 1024; render at 2x for anti-aliasing


def px(value):
    return round(value * SIZE / 1024)


def draw_hand(draw, angle_deg, length, width, color):
    center = SIZE // 2
    radians = math.radians(angle_deg)
    x = center + math.sin(radians) * px(length)
    y = center - math.cos(radians) * px(length)
    draw.line([(center, center), (x, y)], fill=color, width=px(width))
    cap = px(width) / 2
    draw.ellipse([x - cap, y - cap, x + cap, y + cap], fill=color)


def build():
    image = Image.new("RGBA", (SIZE, SIZE), (14, 17, 23, 255))
    draw = ImageDraw.Draw(image)
    center = SIZE // 2

    pad = px(112)
    draw.rounded_rectangle(
        [pad, pad, SIZE - pad, SIZE - pad],
        radius=px(150),
        fill=(22, 27, 34, 255),
        outline=(48, 54, 61, 255),
        width=px(10),
    )

    # Hour ticks, with the quarter marks brighter.
    for index in range(12):
        radians = math.radians(index * 30)
        inner, outer = px(286), px(316)
        x1 = center + math.sin(radians) * inner
        y1 = center - math.cos(radians) * inner
        x2 = center + math.sin(radians) * outer
        y2 = center - math.cos(radians) * outer
        major = index % 3 == 0
        draw.line(
            [(x1, y1), (x2, y2)],
            fill=(230, 237, 243, 255) if major else (139, 148, 158, 255),
            width=px(12 if major else 8),
        )

    radius = px(252)
    draw.ellipse(
        [center - radius, center - radius, center + radius, center + radius],
        outline=(91, 140, 255, 255),
        width=px(24),
    )

    # Small grid dots — a nod to the ChronoGrid name.
    dot_radius = px(10)
    for x in (300, 724):
        for y in (300, 724):
            dot_x, dot_y = px(x), px(y)
            draw.ellipse(
                [dot_x - dot_radius, dot_y - dot_radius, dot_x + dot_radius, dot_y + dot_radius],
                fill=(91, 140, 255, 120),
            )

    # 10:10 hands plus a red seconds hand.
    draw_hand(draw, 305, 145, 20, (230, 237, 243, 255))
    draw_hand(draw, 60, 205, 14, (230, 237, 243, 255))
    draw_hand(draw, 240, 225, 6, (248, 81, 73, 255))

    pin_radius = px(24)
    draw.ellipse(
        [center - pin_radius, center - pin_radius, center + pin_radius, center + pin_radius],
        fill=(91, 140, 255, 255),
        outline=(230, 237, 243, 255),
        width=px(6),
    )

    output = Path(__file__).resolve().parent
    for size in (192, 512):
        image.resize((size, size), Image.LANCZOS).save(output / f"icon-{size}.png", optimize=True)


if __name__ == "__main__":
    build()
