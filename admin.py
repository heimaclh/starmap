#!/usr/bin/env python3
"""
星图 · 本地管理台
    python3 admin.py           # 仅本机访问
    python3 admin.py --lan     # 局域网访问（手机传照片用）：0.0.0.0 + 访问码

管理界面  http://localhost:8124
网站预览  http://localhost:8123（自动启动）

--lan 模式会打印手机访问地址和一次性访问码；所有照片仍以明文留在本地 photos/，
发布到 GitHub 的永远是加密后的 dist/。
"""
import argparse
import functools
import hashlib
import json
import math
import mimetypes
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import build as sitebuild  # 复用 extract_gps 等函数；build.py 的 main 有 __main__ 保护，import 安全

ROOT = Path(__file__).resolve().parent
TRIPS = ROOT / 'trips.json'
SECRET = ROOT / 'secret.txt'
ADMIN_PORT, PREVIEW_PORT = 8124, 8123
ALLOWED_EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'}
SAFE_TRIP_ID = re.compile(r'^[a-z0-9][a-z0-9-]{0,40}$')
COOKIE = 'starmap_admin'

LAN_MODE = False
ACCESS_TOKEN = None
_login_fails = 0


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('223.5.5.5', 80))
        return s.getsockname()[0]
    except Exception:
        return '127.0.0.1'
    finally:
        s.close()


AMAP_KEY_FILE = ROOT / 'amap_key.txt'


def get_amap_key():
    if os.environ.get('AMAP_KEY'):
        return os.environ['AMAP_KEY'].strip()
    if AMAP_KEY_FILE.exists():
        return AMAP_KEY_FILE.read_text(encoding='utf-8').strip()
    return ''


def http_json(url, timeout=8, headers=None):
    req = urllib.request.Request(url, headers={'User-Agent': 'starmap-admin/1.0', **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


# ---- WGS-84 ↔ GCJ-02（选点器底图为高德，搜索结果需纠偏后存储） ----
def _tlat(x, y):
    r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    r += (20 * math.sin(6 * x * math.pi) + 20 * math.sin(2 * x * math.pi)) * 2 / 3
    r += (20 * math.sin(y * math.pi) + 40 * math.sin(y / 3 * math.pi)) * 2 / 3
    r += (160 * math.sin(y / 12 * math.pi) + 320 * math.sin(y * math.pi / 30)) * 2 / 3
    return r


def _tlng(x, y):
    r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    r += (20 * math.sin(6 * x * math.pi) + 20 * math.sin(2 * x * math.pi)) * 2 / 3
    r += (20 * math.sin(x * math.pi) + 40 * math.sin(x / 3 * math.pi)) * 2 / 3
    r += (150 * math.sin(x / 12 * math.pi) + 300 * math.sin(x / 30 * math.pi)) * 2 / 3
    return r


def _out_of_china(lat, lng):
    return lng < 72.004 or lng > 137.8347 or lat < 0.8293 or lat > 55.8271


def wgs2gcj(lat, lng):
    if _out_of_china(lat, lng):
        return lat, lng
    a, ee = 6378245.0, 0.00669342162296594323
    rad = lat / 180 * math.pi
    magic = 1 - ee * math.sin(rad) ** 2
    sqrt = math.sqrt(magic)
    return (
        lat + (_tlat(lng - 105, lat - 35) * 180) / ((a * (1 - ee)) / (magic * sqrt) * math.pi),
        lng + (_tlng(lng - 105, lat - 35) * 180) / ((a / sqrt) * math.cos(rad) * math.pi),
    )


def gcj2wgs(lat, lng):
    wlat, wlng = lat, lng
    for _ in range(2):
        glat, glng = wgs2gcj(wlat, wlng)
        wlat -= glat - lat
        wlng -= glng - lng
    return wlat, wlng


def load_cfg():
    return json.loads(TRIPS.read_text(encoding='utf-8'))


def save_cfg(cfg):
    TRIPS.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def find_trip(cfg, trip_id):
    for t in cfg['trips']:
        if t['id'] == trip_id:
            return t
    return None


def sanitize_name(name):
    name = os.path.basename(urllib.parse.unquote(name))
    stem, ext = os.path.splitext(name)
    stem = re.sub(r'[^A-Za-z0-9._-]+', '_', stem)[:60] or 'photo'
    return stem, ext.lower()


def exif_date(src: Path):
    try:
        exif = Image.open(src).getexif()
        dt = exif.get(36867) or exif.get(306)  # DateTimeOriginal / DateTime
        if dt:
            return str(dt)[:10].replace(':', '-')
    except Exception:
        pass
    return None


def get_passphrase(given=None, remember=False):
    if given:
        if remember:
            SECRET.write_text(given + '\n', encoding='utf-8')
        return given
    if SECRET.exists():
        return SECRET.read_text(encoding='utf-8').strip()
    raise ValueError('还没有设置暗号：请先在「网站设置」里填写并勾选记住，或本次填写')


def run_build(passphrase):
    r = subprocess.run(
        [sys.executable, str(ROOT / 'build.py'), '--passphrase', passphrase],
        cwd=ROOT, capture_output=True, text=True, timeout=900,
    )
    return (r.returncode == 0), (r.stdout + r.stderr).strip()


def run_publish(passphrase):
    def git(*args):
        return subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, timeout=300)

    log = []
    inside = git('rev-parse', '--is-inside-work-tree')
    if inside.returncode != 0 or inside.stdout.strip() != 'true':
        return False, '✗ 这里还不是 git 仓库。先到 GitHub 建一个空仓库，然后在 starmap 目录执行：\n  git init && git add -A && git commit -m "✦ 初始化星图"\n  git remote add origin git@github.com:<用户名>/<仓库名>.git'
    remote = git('remote', 'get-url', 'origin')
    if remote.returncode != 0:
        return False, '✗ 还没有设置远程仓库：\n  git remote add origin git@github.com:<用户名>/<仓库名>.git'

    ok, out = run_build(passphrase)
    log.append(out)
    if not ok:
        return False, '\n'.join(log)

    for cmd in (['add', '-A'], ['commit', '-m', '✦ 更新内容 ' + time.strftime('%Y-%m-%d %H:%M')]):
        r = git(*cmd)
        log.append(r.stdout.strip() + r.stderr.strip())
    push = git('subtree', 'push', '--prefix', 'dist', 'origin', 'gh-pages')
    log.append(push.stdout.strip() + push.stderr.strip())
    ok = push.returncode == 0
    if ok:
        log.append('✦ 已发布。稍等一两分钟，GitHub Pages 会自动更新。')
    return ok, '\n'.join(log)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass  # 安静一点

    # ---- 基础工具 ----
    def reply(self, data, code=200, ctype='application/json; charset=utf-8'):
        body = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def api_error(self, msg, code=400):
        self.reply({'ok': False, 'error': msg}, code)

    def read_json(self):
        n = int(self.headers.get('Content-Length') or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode('utf-8'))

    def read_bytes(self):
        n = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(n) if n else b''

    # ---- 路由 ----
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if not self.auth_ok(u):
            return self.reply({'ok': False, 'need_login': True, 'error': '需要访问码'}, 401)
        if u.path == '/' or u.path.startswith('/admin'):
            return self.serve_admin_file(u.path or '/')
        if u.path == '/api/state':
            return self.api_state()
        if u.path == '/api/geocode':
            return self.api_geocode(q)
        if u.path in ('/vendor/leaflet.js', '/vendor/leaflet.css'):
            f = ROOT / 'site' / u.path.lstrip('/')
            ctype = 'application/javascript' if u.path.endswith('.js') else 'text/css'
            self.reply(f.read_bytes(), ctype=ctype)
            return
        if u.path.startswith('/media/'):
            return self.serve_media(u.path[len('/media/'):])
        return self.api_error('not found', 404)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path == '/api/login':
            return self.api_login()
        if not self.auth_ok(u):
            return self.reply({'ok': False, 'need_login': True, 'error': '需要访问码'}, 401)
        try:
            if u.path == '/api/site':
                return self.api_site()
            if u.path == '/api/trips':
                return self.api_create_trip()
            if u.path.startswith('/api/upload/'):
                return self.api_upload(u.path.split('/')[-1], q)
            if u.path == '/api/build':
                return self.api_build(q)
            if u.path == '/api/publish':
                return self.api_publish(q)
            if u.path.startswith('/api/photo-geo/'):
                return self.api_photo_geo(u.path.split('/')[-1])
        except Exception as e:
            return self.api_error(f'服务器出错: {e}', 500)
        return self.api_error('not found', 404)

    def do_PUT(self):
        u = urllib.parse.urlparse(self.path)
        try:
            if u.path.startswith('/api/trip/'):
                return self.api_update_trip(u.path.split('/')[-1])
        except Exception as e:
            return self.api_error(f'服务器出错: {e}', 500)
        return self.api_error('not found', 404)

    def do_DELETE(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        try:
            if u.path.startswith('/api/trip/'):
                return self.api_delete_trip(u.path.split('/')[-1])
            if u.path.startswith('/api/photo/'):
                return self.api_delete_photo(u.path.split('/')[-1], q)
        except Exception as e:
            return self.api_error(f'服务器出错: {e}', 500)
        return self.api_error('not found', 404)

    # ---- 静态文件 ----
    def serve_admin_file(self, path):
        name = {'/': 'index.html', '/admin.css': 'admin.css', '/admin.js': 'admin.js'}.get(path)
        if not name:
            return self.api_error('not found', 404)
        f = ROOT / 'admin' / name
        ctype = ('text/css' if name.endswith('.css')
                 else 'application/javascript' if name.endswith('.js')
                 else 'text/html; charset=utf-8')
        self.reply(f.read_bytes(), ctype=ctype)

    def serve_media(self, rel):
        base = (ROOT / 'photos').resolve()
        target = (base / urllib.parse.unquote(rel)).resolve()
        if not str(target).startswith(str(base)) or not target.is_file():
            return self.api_error('not found', 404)
        ctype = mimetypes.guess_type(target.name)[0] or 'application/octet-stream'
        self.reply(target.read_bytes(), ctype=ctype)

    # ---- 访问控制（--lan 模式） ----
    def auth_ok(self, u):
        """静态管理台页面不设防（无秘密），/api 与 /media 需要访问码 Cookie。
        来自本机回环的请求视为机主本人，直接放行（手机的请求经端口转发进来，
        源地址是 Windows 的 vEthernet 网关，不会是 127.0.0.1）。"""
        if not LAN_MODE:
            return True
        if self.client_address[0] in ('127.0.0.1', '::1'):
            return True
        if u.path == '/' or u.path.startswith('/admin') or u.path.startswith('/vendor/'):
            return True
        cookie = self.headers.get('Cookie', '')
        m = re.search(re.escape(COOKIE) + r'=([^;]+)', cookie)
        return bool(m and secrets.compare_digest(m.group(1), ACCESS_TOKEN))

    def api_login(self):
        global _login_fails
        body = self.read_json()
        if _login_fails >= 5:
            time.sleep(1.0)
        if not secrets.compare_digest(str(body.get('token', '')), ACCESS_TOKEN):
            _login_fails += 1
            return self.reply({'ok': False, 'error': '访问码不对'}, 401)
        _login_fails = 0
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Set-Cookie', f'{COOKIE}={ACCESS_TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age={8 * 3600}')
        self.send_header('Content-Length', '2')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(b'{}')

    # ---- API ----
    def api_state(self):
        cfg = load_cfg()
        self.reply({'site': cfg.get('site', {}), 'trips': cfg.get('trips', []),
                    'has_secret': SECRET.exists(), 'has_amap_key': bool(get_amap_key())})

    def api_geocode(self, q):
        """地点搜索：高德 POI（GCJ-02，转 WGS-84 存储）→ OpenStreetMap 兜底 → 坐标直跳"""
        query = (q.get('q') or [''])[0].strip()[:80]
        if not query:
            return self.api_error('请输入搜索词')
        has_key = bool(get_amap_key())

        # 直接粘贴坐标：lat,lng
        m = re.match(r'^(-?\d{1,3}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)$', query)
        if m:
            lat, lng = float(m.group(1)), float(m.group(2))
            if abs(lat) > 90 or abs(lng) > 180:
                return self.api_error('坐标超出范围')
            return self.reply({'ok': True, 'source': 'coord', 'has_key': has_key,
                               'results': [{'name': f'{lat:.5f}, {lng:.5f}', 'address': '粘贴的坐标',
                                            'lat': lat, 'lng': lng}]})

        results, source, error = [], None, None
        if has_key:
            try:
                d = http_json('https://restapi.amap.com/v3/place/text?keywords='
                              + urllib.parse.quote(query) + '&offset=8&page=1&key=' + get_amap_key())
                if str(d.get('status')) == '1' and d.get('pois'):
                    for p in d['pois'][:8]:
                        try:
                            lng, lat = (float(x) for x in p['location'].split(','))
                        except (KeyError, ValueError):
                            continue
                        wlat, wlng = gcj2wgs(lat, lng)
                        region = (p.get('pname') or '') + (p.get('cityname') or '') + (p.get('adname') or '')
                        results.append({'name': p.get('name', ''),
                                        'address': (region + ' ' + (p.get('address') or '')).strip(),
                                        'lat': round(wlat, 6), 'lng': round(wlng, 6)})
                    source = 'amap'
                else:
                    error = f"高德: {d.get('info') or '无结果'}"
            except Exception as e:
                error = f'高德请求失败: {e}'
        if not results:
            try:
                d = http_json('https://nominatim.openstreetmap.org/search?q=' + urllib.parse.quote(query)
                              + '&format=json&limit=6&accept-language=zh-CN',
                              headers={'Accept-Language': 'zh-CN'})
                for p in d:
                    results.append({'name': (p.get('display_name') or '')[:70],
                                    'address': p.get('type') or '',
                                    'lat': float(p['lat']), 'lng': float(p['lon'])})
                source = 'osm'
            except Exception as e:
                if not error:
                    error = f'OpenStreetMap 搜索失败: {e}'
        if not results:
            return self.reply({'ok': False, 'error': error or '没有找到结果', 'has_key': has_key})
        self.reply({'ok': True, 'source': source, 'has_key': has_key, 'results': results})

    def api_site(self):
        body = self.read_json()
        cfg = load_cfg()
        for k in ('title', 'subtitle', 'anniversary', 'footer'):
            if k in body:
                cfg.setdefault('site', {})[k] = str(body[k]).strip()
        save_cfg(cfg)
        self.reply({'ok': True})

    def api_create_trip(self):
        body = self.read_json()
        cfg = load_cfg()
        title = (body.get('title') or '').strip() or '未命名旅行'
        base = re.sub(r'-+', '-', re.sub(r'[^a-z0-9-]', '-', (body.get('id') or title).lower())).strip('-')[:40] or 'trip'
        if not re.search(r'[a-z]', base):  # 纯数字/中文标题 → 用日期当 ID
            base = 'trip-' + time.strftime('%Y%m%d')
        tid, n = base, 2
        while find_trip(cfg, tid):
            tid, n = f'{base}-{n}', n + 1
        (ROOT / 'photos' / tid).mkdir(parents=True, exist_ok=True)
        cfg['trips'].insert(0, {'id': tid, 'title': title, 'date': body.get('date', ''),
                                'location': body.get('location', ''), 'description': body.get('description', ''),
                                'photos': []})
        save_cfg(cfg)
        self.reply({'ok': True, 'id': tid})

    def api_update_trip(self, trip_id):
        body = self.read_json()
        cfg = load_cfg()
        trip = find_trip(cfg, trip_id)
        if not trip:
            return self.api_error('旅行不存在', 404)
        for k in ('title', 'date', 'end', 'location', 'description'):
            if k in body:
                trip[k] = str(body[k]).strip()
        if 'story' in body:  # 长文正文：按空行分段存成数组
            s = body['story']
            if isinstance(s, str):
                s = [p.strip() for p in s.replace('\r\n', '\n').split('\n\n') if p.strip()]
            trip['story'] = [str(p).strip() for p in s if str(p).strip()]
        if 'photos' in body:  # [{file, caption}]，按客户端顺序
            old = {p['file']: p for p in trip['photos']}
            trip['photos'] = [{**old[p['file']], 'caption': str(p.get('caption', ''))}
                              for p in body['photos'] if p['file'] in old]
        if not trip.get('coords'):
            for p in trip['photos']:
                if p.get('coords'):
                    trip['coords'] = p['coords']
                    break
        save_cfg(cfg)
        self.reply({'ok': True})

    def api_delete_trip(self, trip_id):
        cfg = load_cfg()
        cfg['trips'] = [t for t in cfg['trips'] if t['id'] != trip_id]
        save_cfg(cfg)
        self.reply({'ok': True, 'note': '已从网站移除；photos/ 里的原图文件保留在本地，可自行删除'})

    def api_upload(self, trip_id, q):
        if not SAFE_TRIP_ID.match(trip_id):
            return self.api_error('旅行 ID 不合法')
        stem, ext = sanitize_name(q.get('filename', ['photo.jpg'])[0])
        if ext not in ALLOWED_EXTS:
            return self.api_error(f'不支持的格式 {ext}（支持 jpg/png/webp/heic）')
        cfg = load_cfg()
        trip = find_trip(cfg, trip_id)
        if not trip:
            return self.api_error('旅行不存在', 404)
        folder = ROOT / 'photos' / trip_id
        folder.mkdir(parents=True, exist_ok=True)
        name = stem + ext
        if (folder / name).exists():
            name = f'{stem}-{int(time.time())}{ext}'
        (folder / name).write_bytes(self.read_bytes())

        full = str(folder / name)
        coords = sitebuild.extract_gps(Path(full))
        date = exif_date(Path(full))
        trip['photos'].append({'file': f'{trip_id}/{name}', 'caption': '', 'coords': coords})
        if not trip.get('date') and date:
            trip['date'] = date
        if not trip.get('coords') and coords:
            trip['coords'] = coords
        save_cfg(cfg)
        resp = {'ok': True, 'file': f'{trip_id}/{name}', 'coords': coords, 'date': date}
        if ext in {'.heic', '.heif'} and not sitebuild.HEIC_OK:
            resp['warning'] = 'HEIC 已上传，但本机缺 pillow-heif，构建时会跳过它。修复：pip3 install pillow-heif --break-system-packages'
        self.reply(resp)

    def api_delete_photo(self, trip_id, q):
        rel = q.get('file', [''])[0]
        cfg = load_cfg()
        trip = find_trip(cfg, trip_id)
        if not trip:
            return self.api_error('旅行不存在', 404)
        trip['photos'] = [p for p in trip['photos'] if p['file'] != rel]
        save_cfg(cfg)
        self.reply({'ok': True, 'note': '已从网站移除；原图保留在 photos/ 目录'})

    def api_photo_geo(self, trip_id):
        """手动设置/清除某张照片的拍摄坐标（WGS-84）"""
        body = self.read_json()
        cfg = load_cfg()
        trip = find_trip(cfg, trip_id)
        if not trip:
            return self.api_error('旅行不存在', 404)
        p = next((x for x in trip['photos'] if x['file'] == body.get('file')), None)
        if not p:
            return self.api_error('照片不存在', 404)
        coords = body.get('coords')
        if coords:
            try:
                lat, lng = float(coords[0]), float(coords[1])
            except (TypeError, ValueError):
                return self.api_error('坐标不合法')
            if not (-90 <= lat <= 90 and -180 <= lng <= 180):
                return self.api_error('坐标不合法')
            p['coords'] = [round(lat, 6), round(lng, 6)]
        else:
            p.pop('coords', None)
        if not trip.get('coords'):
            for x in trip['photos']:
                if x.get('coords'):
                    trip['coords'] = x['coords']
                    break
        save_cfg(cfg)
        self.reply({'ok': True, 'coords': p.get('coords')})

    def api_build(self, q):
        body = self.read_json()
        try:
            passphrase = get_passphrase(body.get('passphrase'), body.get('remember'))
        except ValueError as e:
            return self.reply({'ok': False, 'need_passphrase': True, 'error': str(e)})
        ok, out = run_build(passphrase)
        self.reply({'ok': ok, 'output': out})

    def api_publish(self, q):
        body = self.read_json()
        try:
            passphrase = get_passphrase(body.get('passphrase'), body.get('remember'))
        except ValueError as e:
            return self.reply({'ok': False, 'need_passphrase': True, 'error': str(e)})
        ok, out = run_publish(passphrase)
        self.reply({'ok': ok, 'output': out})


def start_preview(bind_all=False):
    host = '0.0.0.0' if bind_all else '127.0.0.1'
    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(ROOT / 'dist'))
    try:
        srv = ThreadingHTTPServer((host, PREVIEW_PORT), handler)
    except OSError:
        print(f'预览端口 {PREVIEW_PORT} 已被占用（预览服务应该已在运行）')
        return
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f'✦ 网站预览  http://localhost:{PREVIEW_PORT}')


def main():
    global LAN_MODE, ACCESS_TOKEN
    ap = argparse.ArgumentParser(description='星图管理台')
    ap.add_argument('--lan', action='store_true', help='允许局域网访问（手机传照片）')
    args = ap.parse_args()

    LAN_MODE = args.lan
    if LAN_MODE:
        ACCESS_TOKEN = str(secrets.randbelow(900000) + 100000)  # 6 位数字访问码，每次启动随机

    start_preview(bind_all=LAN_MODE)
    ThreadingHTTPServer.allow_reuse_address = True
    host = '0.0.0.0' if LAN_MODE else '127.0.0.1'
    try:
        srv = ThreadingHTTPServer((host, ADMIN_PORT), Handler)
    except OSError:
        sys.exit(f'✗ 端口 {ADMIN_PORT} 已被占用——多半已经有一个管理台在运行。\n'
                 f'  先关掉旧的（在它的终端按 Ctrl+C，或关闭那个窗口），再运行本命令。')

    print(f'✦ 管理台    http://localhost:{ADMIN_PORT}  （Ctrl+C 退出）')
    if LAN_MODE:
        ip = lan_ip()
        print()
        print(f'  ┌─────────── 手机访问（同一 Wi-Fi） ───────────┐')
        print(f'  │  地址:  http://{ip}:{ADMIN_PORT}')
        print(f'  │  访问码: {ACCESS_TOKEN}')
        print(f'  │  预览:  http://{ip}:{PREVIEW_PORT}')
        print(f'  └──────────────────────────────────────────────┘')
        print('  若手机打不开：Windows 需做一次端口转发，运行 ./mobile.sh 可自动配置')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n再见 ✦')


if __name__ == '__main__':
    main()
