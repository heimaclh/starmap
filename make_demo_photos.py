#!/usr/bin/env python3
"""生成示例"照片"（渐变+光晕+山影+星空），第一次看效果用。换成真照片后可删除。"""
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent
PHOTOS = ROOT / 'photos'


def gradient(w, h, top, bottom):
    im = Image.new('RGB', (w, h))
    px = im.load()
    for y in range(h):
        t = y / (h - 1)
        c = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = c
    return im


def glow(im, cx, cy, r, color):
    ov = Image.new('RGBA', im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color + (170,))
    ov = ov.filter(ImageFilter.GaussianBlur(r * 0.55))
    im.paste(Image.alpha_composite(im.convert('RGBA'), ov).convert('RGB'), (0, 0))


def stars(im, n, ymax_ratio=1.0, seed=1):
    rnd = random.Random(seed)
    d = ImageDraw.Draw(im)
    w, h = im.size
    for _ in range(n):
        x, y = rnd.randint(0, w - 1), rnd.randint(0, int(h * ymax_ratio) - 1)
        r = rnd.choice([1, 1, 1, 2])
        c = rnd.choice([(255, 255, 240), (200, 220, 255), (255, 230, 190)])
        d.ellipse([x - r, y - r, x + r, y + r], fill=c)


def mountains(im, color, seed=1, layers=2):
    """底部叠两层圆弧山影，做出远近层次"""
    w, h = im.size
    rnd = random.Random(seed)
    ov = Image.new('RGBA', im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for layer in range(layers):
        alpha = 200 + layer * 27
        base = h * (0.86 + layer * 0.05)
        r = int(min(w, h) * (0.34 - layer * 0.08))
        x = -r // 2
        while x < w + r:
            off = rnd.randint(-r // 4, r // 4)
            d.ellipse([x, base - r // 2 + off, x + r, base + r // 2 + off], fill=color + (alpha,))
            x += int(r * 0.7)
    ov = ov.filter(ImageFilter.GaussianBlur(2))
    im.paste(Image.alpha_composite(im.convert('RGBA'), ov).convert('RGB'), (0, 0))


def city_lights(im, seed=1):
    """山脚下零星的城市灯火"""
    rnd = random.Random(seed)
    d = ImageDraw.Draw(im)
    w, h = im.size
    for _ in range(46):
        x, y = rnd.randint(0, w - 1), rnd.randint(int(h * 0.82), int(h * 0.95))
        c = rnd.choice([(255, 210, 130), (255, 180, 110), (180, 220, 255), (255, 150, 160)])
        d.point((x, y), fill=c)
        if rnd.random() < 0.3:
            d.point((x, y - 1), fill=c)


def grain(im, sigma=10):
    noise = Image.effect_noise(im.size, sigma).convert('RGB')
    return Image.blend(im, noise, 0.055)


def make(path, w, h, top, bottom, orbs=(), mountains_cfg=None, lights=False, seed=1):
    im = gradient(w, h, top, bottom)
    stars(im, 90, ymax_ratio=0.5, seed=seed)
    for cx, cy, r, col in orbs:
        glow(im, int(w * cx), int(h * cy), int(min(w, h) * r), col)
    if mountains_cfg:
        mountains(im, mountains_cfg, seed=seed + 7)
    if lights:
        city_lights(im, seed=seed + 13)
    grain(im).save(path, 'JPEG', quality=88)
    print('  +', path.relative_to(ROOT))


INK = (26, 30, 48)
DEEP = (12, 16, 38)

CITIES = {
    # 长沙：橘洲焰火之夜 —— 深蓝夜空 + 暖橙烟火 + 城市灯火
    'demo-changsha': dict(
        colors=[((24, 20, 62), (128, 52, 88)), ((30, 24, 70), (150, 60, 85)), ((18, 16, 52), (110, 45, 80)), ((28, 22, 66), (140, 55, 90))],
        orbs=[(0.5, 0.5, 0.26, (255, 140, 70)), (0.28, 0.34, 0.16, (255, 190, 120)), (0.68, 0.6, 0.2, (255, 120, 90)), (0.4, 0.62, 0.18, (255, 170, 90))],
        mnt=INK, lights=True),
    # 青岛：红瓦绿树碧海 —— 海蓝渐变 + 白金日光
    'demo-qingdao': dict(
        colors=[((28, 86, 136), (150, 200, 205)), ((36, 100, 148), (168, 210, 208)), ((22, 74, 124), (140, 190, 198)), ((40, 110, 155), (178, 215, 205))],
        orbs=[(0.7, 0.3, 0.15, (255, 250, 220)), (0.35, 0.42, 0.12, (255, 245, 215)), (0.6, 0.25, 0.14, (255, 255, 235)), (0.5, 0.38, 0.11, (255, 240, 210))],
        mnt=(30, 60, 92), lights=False),
    # 南京：梧桐烟雨 —— 紫灰烟雨 + 冷白月
    'demo-nanjing': dict(
        colors=[((58, 54, 92), (132, 122, 150)), ((68, 62, 100), (142, 130, 158)), ((50, 48, 84), (120, 112, 142)), ((62, 56, 96), (138, 126, 152))],
        orbs=[(0.62, 0.28, 0.12, (240, 240, 255)), (0.4, 0.34, 0.1, (235, 235, 250)), (0.55, 0.24, 0.11, (245, 245, 255)), (0.68, 0.36, 0.1, (230, 232, 248))],
        mnt=(52, 50, 78), lights=False),
    # 深圳：湾区霓虹 —— 深夜靛蓝 + 青紫霓虹
    'demo-shenzhen': dict(
        colors=[((8, 10, 36), (92, 40, 112)), ((10, 12, 42), (104, 46, 118)), ((6, 8, 30), (82, 36, 104)), ((9, 11, 40), (98, 42, 110))],
        orbs=[(0.3, 0.6, 0.18, (80, 220, 255)), (0.72, 0.55, 0.18, (255, 100, 180)), (0.5, 0.5, 0.14, (140, 120, 255)), (0.62, 0.62, 0.16, (255, 130, 190))],
        mnt=DEEP, lights=True),
    # 郴州：雾漫东江 —— 青雾山岚 + 淡金晨光
    'demo-chenzhou': dict(
        colors=[((88, 128, 138), (206, 216, 206)), ((96, 136, 142), (214, 222, 208)), ((80, 120, 132), (198, 208, 200)), ((90, 132, 140), (210, 218, 204))],
        orbs=[(0.5, 0.42, 0.14, (255, 240, 200)), (0.36, 0.5, 0.11, (255, 244, 210)), (0.56, 0.38, 0.12, (255, 238, 195)), (0.44, 0.46, 0.1, (255, 242, 205))],
        mnt=(66, 100, 104), lights=False),
}


def main():
    PER_CITY = 8  # 每座城市的示例照片数量
    for folder, cfg in CITIES.items():
        d = PHOTOS / folder
        d.mkdir(parents=True, exist_ok=True)
        print(f'{folder}:')
        for i in range(PER_CITY):
            portrait = (i % 4 == 1)
            w, h = (900, 1200) if portrait else (1200, 900)
            (top, bottom) = cfg['colors'][i % len(cfg['colors'])]
            seed = hash(folder) % 1000 + i
            rnd = random.Random(seed + 1)
            orb = (rnd.uniform(0.28, 0.72), rnd.uniform(0.30, 0.62),
                   rnd.uniform(0.10, 0.20), cfg['orbs'][0][3])
            make(d / f'{i + 1:02d}.jpg', w, h, top, bottom,
                 orbs=[orb], mountains_cfg=cfg['mnt'],
                 lights=cfg['lights'], seed=seed)
    print('完成。请在管理台里替换成真实照片与故事。')


if __name__ == '__main__':
    main()
