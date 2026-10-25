#!/usr/bin/env python3
"""
星图 · 构建脚本
流程：读取 trips.json → 压缩照片（原图不动）→ 全部内容 AES-256-GCM 加密 → 输出 dist/
公开（GitHub Pages）的只有密文，暗号不会出现在任何输出文件里。

用法：
    python3 build.py --passphrase "你们的暗号"
    python3 build.py                # 会交互式询问暗号
    PASSPHRASE="暗号" python3 build.py
"""
import argparse
import getpass
import hashlib
import io
import json
import os
import shutil
import sys
import time
from pathlib import Path

from PIL import Image, ImageOps

try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
    HEIC_OK = True
except ImportError:
    HEIC_OK = False

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = Path(__file__).resolve().parent

# 压缩参数：手机上看完全够清晰，同时保证加载速度
FULL_EDGE, FULL_Q = 1600, 82   # 点开大图
THUMB_EDGE, THUMB_Q = 640, 74  # 网格缩略图
ITERATIONS = 250_000           # PBKDF2 迭代次数，拖慢暴力破解

BASE_EXTS = {'.jpg', '.jpeg', '.png', '.webp'}
IMG_EXTS = BASE_EXTS | ({'.heic', '.heif'} if HEIC_OK else set())


def load_image(src: Path) -> Image.Image:
    im = Image.open(src)
    im = ImageOps.exif_transpose(im)  # 按 EXIF 方向摆正（iPhone 常见）
    if im.mode in ('RGBA', 'LA', 'P'):
        im = im.convert('RGBA')
        bg = Image.new('RGB', im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[-1])
        return bg
    return im.convert('RGB')


def compress(src: Path, long_edge: int, quality: int):
    im = ImageOps.contain(load_image(src), (long_edge, long_edge))
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=quality, optimize=True, progressive=True)
    return buf.getvalue(), im.size


def extract_gps(src: Path):
    """从 EXIF 里读 GPS 坐标（iPhone/多数手机默认会写入），返回 (lat, lng) 或 None"""
    try:
        exif = Image.open(src).getexif()
        gps = exif.get_ifd(0x8825)
        if not gps:
            return None

        def to_deg(v):
            d, m, s = v
            return float(d) + float(m) / 60 + float(s) / 3600

        lat = to_deg(gps[2])
        lng = to_deg(gps[4])
        if gps.get(1) == 'S':
            lat = -lat
        if gps.get(3) == 'W':
            lng = -lng
        if abs(lat) > 90 or abs(lng) > 180 or (lat == 0 and lng == 0):
            return None
        return [round(lat, 5), round(lng, 5)]
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(description='构建星图网站')
    ap.add_argument('--trips', default='trips.json', help='内容清单文件')
    ap.add_argument('--passphrase', help='加密暗号')
    args = ap.parse_args()

    passphrase = args.passphrase or os.environ.get('PASSPHRASE')
    if not passphrase:
        passphrase = getpass.getpass('设置/输入加密暗号（输入不回显）: ')
    if not passphrase or len(passphrase) < 4:
        sys.exit('✗ 暗号太短了，至少 4 个字符')

    cfg_path = ROOT / args.trips
    if not cfg_path.exists():
        sys.exit(f'✗ 找不到 {args.trips}，请先创建内容清单')
    cfg = json.loads(cfg_path.read_text(encoding='utf-8'))

    dist = ROOT / 'dist'
    assets = dist / 'a'
    if dist.exists():
        shutil.rmtree(dist)
    assets.mkdir(parents=True)
    shutil.copytree(ROOT / 'site', dist, dirs_exist_ok=True)

    salt = os.urandom(16)
    key = hashlib.pbkdf2_hmac('sha256', passphrase.encode('utf-8'), salt, ITERATIONS, dklen=32)
    aes = AESGCM(key)

    def encrypt(data: bytes) -> bytes:
        iv = os.urandom(12)
        return iv + aes.encrypt(iv, data, None)

    out_trips, warnings, pid = [], [], 0
    total_full = total_thumb = 0

    for trip in cfg.get('trips', []):
        photos = []
        for ph in trip.get('photos', []):
            src = ROOT / 'photos' / ph['file']
            if not src.exists():
                warnings.append(f'照片不存在，已跳过: photos/{ph["file"]}')
                continue
            if src.suffix.lower() not in IMG_EXTS:
                warnings.append(f'不支持的格式（{src.suffix}），已跳过: photos/{ph["file"]}')
                continue
            pid += 1
            full_b, (w, h) = compress(src, FULL_EDGE, FULL_Q)
            thumb_b, _ = compress(src, THUMB_EDGE, THUMB_Q)
            (assets / f'f{pid:04d}.bin').write_bytes(encrypt(full_b))
            (assets / f't{pid:04d}.bin').write_bytes(encrypt(thumb_b))
            total_full += len(full_b)
            total_thumb += len(thumb_b)
            coords = ph.get('coords') or extract_gps(src)
            photos.append({
                'id': pid,
                'caption': ph.get('caption', ''),
                'coords': coords,
                'w': w, 'h': h,
            })

        story = trip.get('story', [])
        if isinstance(story, str):  # 允许直接给一段长文，按空行分段
            story = [s.strip() for s in story.replace('\r\n', '\n').split('\n\n') if s.strip()]
        story = [str(s).strip() for s in story if str(s).strip()]

        has_map = bool(trip.get('coords')) or any(p['coords'] for p in photos)
        out_trips.append({
            'id': trip.get('id', f'trip-{len(out_trips) + 1}'),
            'title': trip['title'],
            'date': trip.get('date', ''),
            'end': trip.get('end', ''),
            'location': trip.get('location', ''),
            'coords': trip.get('coords'),
            'description': trip.get('description', ''),
            'story': story,
            'photos': photos,
            'has_map': has_map,
        })

    site = cfg.get('site', {})
    payload = {
        'site': {
            'title': site.get('title', '我们的星图'),
            'subtitle': site.get('subtitle', '把一起走过的世界，一颗颗点亮'),
            'anniversary': site.get('anniversary', ''),
            'footer': site.get('footer', '✦ 由爱生成 ✦'),
        },
        'trips': out_trips,
        'builtAt': int(time.time() * 1000),
    }
    (assets / 'data.bin').write_bytes(encrypt(json.dumps(payload, ensure_ascii=False).encode('utf-8')))

    (dist / 'config.js').write_text(
        "window.STARMAP = {salt:'%s', iterations:%d, builtAt:%d};\n"
        % (salt.hex(), ITERATIONS, payload['builtAt']),
        encoding='utf-8',
    )

    n_photos = sum(len(t['photos']) for t in out_trips)
    print(f'✦ 构建完成：{len(out_trips)} 次旅行，{n_photos} 张照片')
    print(f'  大图 {total_full / 1e6:.1f} MB + 缩略图 {total_thumb / 1e6:.1f} MB（加密后）')
    print(f'  输出目录: {dist}')
    if warnings:
        print('\n⚠ 提示:')
        for w in warnings:
            print('  -', w)
        if any('.heic' in w or '.heif' in w for w in warnings) and not HEIC_OK:
            print('  - 想支持 iPhone 的 HEIC 格式: pip3 install pillow-heif')
    print('\n本地预览:  python3 -m http.server 8123 -d dist')
    print(f'提醒: 暗号「{passphrase}」不会存进网站，丢了内容就无法恢复，请牢记。')


if __name__ == '__main__':
    main()
