/* ===== 星图 · 前端逻辑 =====
 * 所有照片与文字在构建时已用暗号加密（AES-256-GCM），
 * 浏览器输入暗号后在本地解密渲染，明文从不经过网络。
 */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const enc = new TextEncoder();
  const STRIP_COUNT = 3; // 时间线卡片预览张数，想多显示几张就改这里
  /* 底图候选链：先探测后渲染，浏览器挑第一个真正能用的，选择结果缓存到 localStorage。
   * 高德卫星/路网（国内最稳，GCJ-02 坐标，需纠偏）→ GeoQ 暗紫 → OSM（海外兜底）。 */
  const BASEMAPS = [
    { url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', attr: '&copy; 高德地图', subdomains: ['1', '2', '3', '4'], maxNative: 18, gcj: true, cls: 'sat' },
    { url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', attr: '&copy; 高德地图', subdomains: ['1', '2', '3', '4'], maxNative: 18, gcj: true },
    { url: 'https://map.geoq.cn/arcgis/rest/services/ChinaOnlineStreetPurplishDark/MapServer/tile/{z}/{y}/{x}', attr: '&copy; GeoQ', maxNative: 16 },
    { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxNative: 19 },
  ];

  /* WGS-84 → GCJ-02（国标纠偏，让标记对齐高德底图） */
  function outOfChina(lat, lng) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }
  function wgs2gcj(lat, lng) {
    if (outOfChina(lat, lng)) return [lat, lng];
    const a = 6378245, ee = 0.00669342162296594323;
    const tLat = tLatFn(lng - 105, lat - 35), tLng = tLngFn(lng - 105, lat - 35);
    const rad = (lat / 180) * Math.PI;
    let magic = Math.sin(rad);
    magic = 1 - ee * magic * magic;
    const sqrt = Math.sqrt(magic);
    return [
      lat + (tLat * 180) / ((a * (1 - ee)) / (magic * sqrt) * Math.PI),
      lng + (tLng * 180) / ((a / sqrt) * Math.cos(rad) * Math.PI),
    ];
  }
  function tLatFn(x, y) {
    let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
    r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
    return r;
  }
  function tLngFn(x, y) {
    let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
    r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
    return r;
  }

  let activeBase = 0;
  /* 坐标进 Leaflet 前的统一入口：高德底图时转 GCJ-02 */
  const C = (p) => (BASEMAPS[activeBase].gcj ? wgs2gcj(p[0], p[1]) : p);

  function testTile(b) {
    const url = b.url.replace('{s}', b.subdomains ? b.subdomains[0] : '').replace('{z}', 3).replace('{x}', 6).replace('{y}', 2);
    return new Promise((resolve, reject) => {
      const img = new Image();
      const tm = setTimeout(() => { img.src = ''; reject(new Error('timeout')); }, 4500);
      img.onload = () => { clearTimeout(tm); resolve(); };
      img.onerror = () => { clearTimeout(tm); reject(new Error('fail')); };
      img.src = url;
    });
  }

  async function pickBasemap() {
    const saved = +localStorage.getItem('starmap_base_v1');
    const order = saved ? [saved, ...BASEMAPS.keys()].filter((v, i, a) => a.indexOf(v) === i) : [...BASEMAPS.keys()];
    for (const i of order) {
      try { await testTile(BASEMAPS[i]); localStorage.setItem('starmap_base_v1', i); return i; } catch { /* 试下一个 */ }
    }
    return BASEMAPS.length - 1;
  }

  function addBase(map) {
    const b = BASEMAPS[activeBase];
    const layer = L.tileLayer(b.url, {
      attribution: b.attr, subdomains: b.subdomains || 'abc',
      maxZoom: 19, maxNativeZoom: b.maxNative,
    });
    layer.addTo(map);
    if (b.cls) map.getContainer().classList.add(b.cls);
  }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    key: null,
    data: null,
    sorted: [],
    view: 'trail',
    maps: [],
    trailMap: null,
    lb: { list: [], idx: 0 },
  };

  /* ---------- 解密 ---------- */
  const hexToBytes = (hex) => new Uint8Array(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));

  async function deriveKey(passphrase) {
    const salt = hexToBytes(window.STARMAP.salt);
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: window.STARMAP.iterations, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
  }

  async function decryptBin(path) {
    const res = await fetch(`${path}?v=${window.STARMAP.builtAt}`);
    if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buf.slice(0, 12) },
      state.key,
      buf.slice(12)
    );
    return plain;
  }

  const photoURLs = new Map();
  async function photoURL(id, kind) {
    const cacheKey = `${kind}${id}`;
    if (!photoURLs.has(cacheKey)) {
      const file = `${kind}${String(id).padStart(4, '0')}.bin`;
      const blob = new Blob([await decryptBin(`a/${file}`)], { type: kind === 'v' ? 'video/mp4' : 'image/jpeg' });
      photoURLs.set(cacheKey, URL.createObjectURL(blob));
    }
    return photoURLs.get(cacheKey);
  }

  /* ---------- 星空背景（视差 + 流星） ---------- */
  function startSky() {
    const canvas = $('#sky');
    const ctx = canvas.getContext('2d');
    let w, h, stars, meteor = null, scrollY = 0, mouseX = -1, mouseY = -1;

    function resize() {
      w = canvas.width = innerWidth * devicePixelRatio;
      h = canvas.height = innerHeight * devicePixelRatio;
      canvas.style.width = innerWidth + 'px';
      canvas.style.height = innerHeight + 'px';
      stars = Array.from({ length: Math.min(260, (innerWidth * innerHeight) / 5200) }, (_, i) => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: (Math.random() * 1.15 + 0.3) * devicePixelRatio,
        p: Math.random() * Math.PI * 2,
        s: Math.random() * 0.9 + 0.25,
        depth: (i % 3) / 2,           // 0 近 1 远
        hue: Math.random() < 0.18 ? '255,224,180' : '210,224,255',
      }));
    }

    function frame(t) {
      ctx.clearRect(0, 0, w, h);
      for (const st of stars) {
        const par = scrollY * 0.06 * st.depth * devicePixelRatio;
        let x = st.x, y = st.y - par;
        if (mouseX >= 0) {  // 星星轻轻避开鼠标
          const dx = x - mouseX * devicePixelRatio, dy = y - mouseY * devicePixelRatio;
          const d2 = dx * dx + dy * dy, R = 90 * devicePixelRatio;
          if (d2 < R * R) { const f = (1 - Math.sqrt(d2) / R) * 14 * devicePixelRatio; x += dx / (Math.sqrt(d2) + 1) * f; y += dy / (Math.sqrt(d2) + 1) * f; }
        }
        const a = reduced ? 0.7 : 0.32 + 0.58 * Math.abs(Math.sin(t / 1400 * st.s + st.p));
        ctx.fillStyle = `rgba(${st.hue},${a})`;
        ctx.beginPath();
        ctx.arc(x, ((y % h) + h) % h, st.r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!reduced) {
        if (!meteor && Math.random() < 0.004) {
          meteor = { x: Math.random() * w * 0.7 + w * 0.2, y: Math.random() * h * 0.3, vx: -7 * devicePixelRatio, vy: 4 * devicePixelRatio, life: 1 };
        }
        if (meteor) {
          ctx.strokeStyle = `rgba(255,240,210,${meteor.life * 0.85})`;
          ctx.lineWidth = 1.4 * devicePixelRatio;
          ctx.beginPath();
          ctx.moveTo(meteor.x, meteor.y);
          ctx.lineTo(meteor.x - meteor.vx * 9, meteor.y - meteor.vy * 9);
          ctx.stroke();
          meteor.x += meteor.vx; meteor.y += meteor.vy; meteor.life -= 0.022;
          if (meteor.life <= 0 || meteor.x < -60 || meteor.y > h + 60) meteor = null;
        }
      }
      requestAnimationFrame(frame);
    }

    addEventListener('resize', resize);
    if (!reduced) {
      addEventListener('scroll', () => { scrollY = window.scrollY; }, { passive: true });
      addEventListener('pointermove', (e) => { mouseX = e.clientX; mouseY = e.clientY; }, { passive: true });
    }
    resize();
    requestAnimationFrame(frame);
  }

  /* ---------- 全局装饰：进度彗尾 / 鼠标星尘 / 滚动提示 ---------- */
  function bindChrome() {
    const bar = $('#progress');
    const tl = $('#view-timeline');
    const fill = tl.querySelector('.tl-fill');
    const hint = $('#scroll-hint');
    let ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - innerHeight;
        bar.style.transform = `scaleX(${max > 0 ? window.scrollY / max : 0})`;
        const r = tl.getBoundingClientRect();
        const p = Math.min(1, Math.max(0, (innerHeight * 0.62 - r.top) / r.height));
        fill.style.height = `${p * 100}%`;
        hint.classList.toggle('gone', window.scrollY > 60);
        ticking = false;
      });
    }
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    if (!reduced && matchMedia('(pointer: fine)').matches) {
      let lastX = null, lastY = null, lastT = 0;
      addEventListener('pointermove', (e) => {
        const now = performance.now();
        if (now - lastT < 12) return;
        lastT = now;
        if (lastX === null) { lastX = e.clientX; lastY = e.clientY; return; }
        // 沿移动轨迹按距离插值补尘：鼠标甩多快，尘带都连续
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        const steps = Math.max(1, Math.floor(Math.hypot(dx, dy) / 9));
        let alive = document.querySelectorAll('.spark').length;
        let added = 0;
        for (let i = 1; i <= steps; i++) {
          if (alive >= 110 || added >= 14) break;
          spawnSpark(lastX + (dx * i) / steps, lastY + (dy * i) / steps);
          alive++; added++;
        }
        lastX = e.clientX; lastY = e.clientY;
      }, { passive: true });
    }
  }

  /* 一粒星尘：小圆尘或小星，位置/大小/颜色/漂移/寿命都带随机 */
  function spawnSpark(x, y) {
    const COLORS = ['255,217,160', '255,244,214', '210,224,255', '255,255,255'];
    const isStar = Math.random() < 0.32;
    const el = document.createElement('span');
    el.className = 'spark ' + (isStar ? 'star' : 'dot');
    const s = isStar ? 8 + Math.random() * 5 : 3 + Math.random() * 4.5;
    el.style.setProperty('--x', x - s / 2 + (Math.random() * 7 - 3.5) + 'px');
    el.style.setProperty('--y', y - s / 2 + (Math.random() * 7 - 3.5) + 'px');
    el.style.setProperty('--dx', (Math.random() * 30 - 15) + 'px');
    el.style.setProperty('--dy', (Math.random() * 22 - 6) + 'px');
    el.style.setProperty('--r', (Math.random() * 90 - 45) + 'deg');
    el.style.setProperty('--c', COLORS[Math.floor(Math.random() * COLORS.length)]);
    el.style.setProperty('--s', s + 'px');
    el.style.setProperty('--d', (0.55 + Math.random() * 0.45) + 's');
    if (isStar) el.textContent = '✦';
    el.addEventListener('animationend', () => el.remove(), { once: true });
    document.body.appendChild(el);
  }

  /* ---------- 解锁门 ---------- */
  function bindGate() {
    const form = $('#gate-form');
    const input = $('#gate-input');
    const btn = $('#gate-btn');
    const err = $('#gate-error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pass = input.value.trim();
      if (!pass) return;
      btn.disabled = true;
      btn.textContent = '解锁中…';
      err.hidden = true;
      try {
        state.key = await deriveKey(pass);
        const plain = await decryptBin('a/data.bin');
        state.data = JSON.parse(new TextDecoder().decode(plain));
        enterApp();
      } catch {
        err.hidden = false;
        const card = document.querySelector('.gate-card');
        card.classList.remove('shake');
        void card.offsetWidth;
        card.classList.add('shake');
        btn.disabled = false;
        btn.textContent = '解锁';
        input.select();
      }
    });
  }

  /* ---------- 数据准备 ---------- */
  function sortTrips(trips) {
    return [...trips].sort((a, b) => {
      if (a.date && b.date) return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
      if (a.date) return -1;
      if (b.date) return 1;
      return 0;
    });
  }

  function tripPoint(t) {
    const media = [...(t.photos || []), ...(t.videos || [])];
    return t.coords || (media.find((p) => p.coords) || {}).coords || null;
  }

  /* 照片 + 视频统一成 media 列表（视频的 poster 是一张加密缩略图） */
  function tripMedia(t) {
    return [
      ...(t.photos || []).map((p) => ({ ...p, type: 'photo' })),
      ...(t.videos || []).map((v) => ({ ...v, type: 'video' })),
    ];
  }

  /* 日期区间显示：同一年时结束日期省略年份 */
  function dateRange(t) {
    if (!t.date) return '日期待定';
    if (!t.end || t.end === t.date) return t.date;
    return t.date.slice(0, 4) === t.end.slice(0, 4)
      ? `${t.date} ~ ${t.end.slice(5)}`
      : `${t.date} ~ ${t.end}`;
  }

  function tripDays(t) {
    if (!t.date || !t.end) return 1;
    const d = (new Date(t.end + 'T00:00:00') - new Date(t.date + 'T00:00:00')) / 864e5 + 1;
    return d > 1 ? Math.round(d) : 1;
  }

  function haversineKm(a, b) {
    const R = 6371, toR = (d) => (d * Math.PI) / 180;
    const dLat = toR(b[0] - a[0]), dLng = toR(b[1] - a[1]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function totalKm() {
    const pts = state.sorted.map(tripPoint).filter(Boolean);
    let sum = 0;
    for (let i = 1; i < pts.length; i++) sum += haversineKm(pts[i - 1], pts[i]);
    return sum;
  }

  function animateNum(el, to, suffix = '') {
    if (reduced) { el.textContent = to.toLocaleString('zh-CN') + suffix; return; }
    const t0 = performance.now(), dur = 1100;
    (function tick(t) {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(to * eased).toLocaleString('zh-CN') + suffix;
      if (p < 1) requestAnimationFrame(tick);
    })(t0);
  }

  /* ---------- 进入应用 ---------- */
  async function enterApp() {
    const { site } = state.data;
    document.title = site.title;
    $('#gate').style.display = 'none';
    $('#app').hidden = false;

    state.sorted = sortTrips(state.data.trips);

    // 标题逐字浮现
    const titleEl = $('#site-title');
    titleEl.innerHTML = [...site.title]
      .map((ch, i) => `<span class="ltr" style="--i:${i}">${ch === ' ' ? '&nbsp;' : escapeHTML(ch)}</span>`)
      .join('');

    // 副标题打字机
    typeSubtitle(site.subtitle);

    // 统计栏
    const nMedia = state.sorted.reduce((s, t) => s + (t.photos || []).length + (t.videos || []).length, 0);
    const km = totalKm();
    const stats = [
      [state.sorted.length, '座城市'],
      [nMedia, '个瞬间'],
    ];
    if (km >= 20) stats.push([Math.round(km / 10) * 10, '公里星轨']);
    if (site.anniversary) {
      const days = Math.floor((Date.now() - new Date(site.anniversary + 'T00:00:00')) / 864e5) + 1;
      if (days > 0) stats.push([days, '天在一起']);
    }
    $('#stats').innerHTML = stats
      .map(([n, label], i) => `<div class="stat" style="--i:${i}"><b data-n="${n}">0</b><span>${label}</span></div>`)
      .join('');
    $('#stats').querySelectorAll('b').forEach((b) => animateNum(b, +b.dataset.n));

    $('#site-footer').textContent = site.footer;

    // 先选定可用底图（结果缓存），再渲染地图
    activeBase = await pickBasemap();

    renderTrail();
    renderTimeline();
    renderWall();
    bindTabs();
    bindLightbox();
    bindDetail();
    bindChrome();
    setTimeout(() => state.maps.forEach((m) => m.getContainer().offsetParent && m.invalidateSize()), 80);
  }

  function typeSubtitle(text) {
    const el = $('#site-subtitle');
    if (!text) return;
    if (reduced) { el.textContent = text; return; }
    let i = 0;
    el.innerHTML = '<span class="caret">✧</span>';
    const caret = el.querySelector('.caret');
    (function step() {
      if (i <= text.length) {
        caret.insertAdjacentText('beforebegin', text[i - 1] || '');
        i++;
        setTimeout(step, 52);
      }
    })();
  }

  /* ---------- 星轨总览 ---------- */
  function renderTrail() {
    const map = L.map('trail-map', { scrollWheelZoom: false, attributionControl: true });
    addBase(map);
    state.trailMap = map;
    state.maps.push(map);

    const pts = state.sorted.map((t) => ({ t, p: tripPoint(t) })).filter((x) => x.p);
    const latlngs = pts.map((x) => C(x.p));
    const bounds = latlngs.length > 1 ? L.latLngBounds(latlngs).pad(0.22) : null;
    if (latlngs.length >= 2) {
      L.polyline(latlngs, { color: '#ffd9a0', weight: 7, opacity: 0.1, className: 'trail-glow' }).addTo(map);
      L.polyline(latlngs, { color: '#ffd9a0', weight: 2.2, opacity: 0.95, className: 'trail-line' }).addTo(map);
    }
    pts.forEach(({ t, p }, i) => {
      const m = L.marker(p, {
        icon: L.divIcon({ className: 'trail-stop', html: `<b>${i + 1}</b>`, iconSize: [27, 27], iconAnchor: [13, 13] }),
      }).addTo(map);
      // 悬停即显示地点与时间；点击跳转到该章
      m.bindTooltip(
        `<b>${escapeHTML(cityName(t))}</b><br><span class="tt-sub">${escapeHTML(dateRange(t))} · ${escapeHTML(t.location)}</span>`,
        { direction: 'top', offset: L.point(0, -16), opacity: 1, className: 'starmap-tip' }
      );
      m.on('click', () => jumpToTrip(t.id));
    });
    if (latlngs.length === 1) map.setView(latlngs[0], 10);
    else if (bounds) map.fitBounds(bounds, { maxZoom: 7 });
    else map.setView([32, 110], 4);
    // 容器尺寸变化后校正一次视野，保证五站全部可见
    setTimeout(() => {
      map.invalidateSize();
      if (bounds) map.fitBounds(bounds, { maxZoom: 7 });
    }, 350);

    const first = pts[0]?.t, last = pts.at(-1)?.t;
    $('#trail-caption').innerHTML = pts.length >= 2
      ? `从 <b>${escapeHTML(cityName(first))}</b> 出发，到 <b>${escapeHTML(cityName(last))}</b> 落脚<br>我们把 ${pts.length} 座城市连成了一条流动的星轨 · 点击编号星跳到那一站`
      : '点亮更多城市，让星轨延伸 ✦';

    $('#trail-chips').innerHTML = state.sorted
      .map((t, i) => `<button class="chip" style="--i:${i}" data-id="${t.id}"><i>${i + 1}</i>${escapeHTML(cityName(t))}</button>`)
      .join('');
    $('#trail-chips').querySelectorAll('.chip').forEach((c) =>
      c.addEventListener('click', () => jumpToTrip(c.dataset.id))
    );
  }

  const cityName = (t) => (t.location || '').split('·').pop().trim() || t.title;

  function jumpToTrip(id) {
    switchView('timeline');
    const card = $(`#view-timeline .trip[data-id="${id}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 1700);
  }

  /* ---------- 时间线 ---------- */
  function renderTimeline() {
    const view = $('#view-timeline');
    view.innerHTML = '<div class="tl-track"><div class="tl-fill"></div></div>'
      + state.sorted.map((trip, ti) => {
        const media = tripMedia(trip);
        const strip = media.slice(0, STRIP_COUNT).map((m, mi) => `
          <div class="ph${m.type === 'video' ? ' vid' : ''}" data-mi="${mi}" data-id="${m.type === 'video' ? m.poster : m.id}" data-kind="t">
            <img data-src="" alt="${escapeHTML(m.caption)}">
            ${m.type === 'video' ? '<span class="play"><i>▶</i></span>' : ''}
          </div>`).join('')
        + (media.length > STRIP_COUNT
          ? `<div class="ph more" data-trip="${ti}">+${media.length - STRIP_COUNT}</div>`
          : '');
        return `
        <article class="trip" data-id="${trip.id}" data-trip="${ti}">
          <span class="trip-chapter">✦ 第 ${ti + 1} 章</span>
          <div class="trip-head">
            <span class="trip-date">${escapeHTML(dateRange(trip))}</span>
            <span class="trip-loc">${escapeHTML(trip.location)}</span>
          </div>
          <h2 class="trip-title">${escapeHTML(trip.title)}</h2>
          <p class="trip-desc">${escapeHTML(trip.description)}</p>
          <div class="trip-strip">${strip}</div>
          ${trip.has_map ? `<div class="trip-map" id="map-${trip.id}"></div>` : ''}
          <div class="trip-more">阅读这一章 ✦</div>
        </article>`;
      }).join('');

    // 滚动浮现
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      }
    }, { rootMargin: '-40px' });
    view.querySelectorAll('.trip').forEach((el) => io.observe(el));

    lazyImages(view);
    view.querySelectorAll('.trip-strip .ph').forEach((el) => {
      el.addEventListener('click', () => {
        const ti = +el.closest('.trip').dataset.trip;
        const media = tripMedia(state.sorted[ti]);
        const mi = el.dataset.mi ? +el.dataset.mi : 0;
        openLightbox(media, mi, state.sorted[ti]);
      });
    });
    lazyMaps(view);
    // 点击卡片任意空白处 → 进入章节详情（照片/地图除外）
    view.querySelectorAll('article.trip').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.ph, .trip-map, .leaflet-container')) return;
        openDetail(state.sorted[+card.dataset.trip]);
      });
    });
  }

  function initMap(container, trip) {
    const map = L.map(container, { scrollWheelZoom: false });
    addBase(map);
    state.maps.push(map);

    const points = tripMedia(trip).filter((p) => p.coords);
    const markers = [];
    const dot = (cls) => L.divIcon({ className: `map-dot ${cls || ''}`, html: '<i></i>', iconSize: [12, 12] });
    for (const p of points) {
      const m = L.marker(C(p.coords), { icon: dot() }).addTo(map);
      m.bindPopup(`<b>${escapeHTML(p.caption || trip.title)}</b><br>${escapeHTML(trip.location)} · ${escapeHTML(trip.date)}`);
      m.bindTooltip(escapeHTML(p.caption || trip.title), { direction: 'top', offset: L.point(0, -10), className: 'starmap-tip' });
      markers.push(m);
    }
    if (!points.length && trip.coords) {
      const m = L.marker(C(trip.coords), { icon: dot('home') }).addTo(map);
      m.bindPopup(`<b>${escapeHTML(trip.title)}</b><br>${escapeHTML(trip.location)}`);
      m.bindTooltip(escapeHTML(trip.title), { direction: 'top', offset: L.point(0, -10), className: 'starmap-tip' });
      markers.push(m);
    }
    if (markers.length === 1) map.setView(markers[0].getLatLng(), 11);
    else if (markers.length > 1) map.fitBounds(L.latLngBounds(markers.map((m) => m.getLatLng())).pad(0.18), { maxZoom: 13 });
    else map.setView([32, 110], 4);
    return map;
  }

  function lazyMaps(view) {
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        io.unobserve(en.target);
        const ti = +en.target.closest('.trip').dataset.trip;
        const map = initMap(en.target, state.sorted[ti]);
        setTimeout(() => map.invalidateSize(), 60);
      }
    }, { rootMargin: '160px' });
    view.querySelectorAll('.trip-map').forEach((el) => io.observe(el));
  }

  function lazyImages(scope) {
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        io.unobserve(en.target);
        const img = en.target.tagName === 'IMG' ? en.target : en.target.querySelector('img');
        if (!img) continue;
        const wrap = img.closest('[data-id]');
        photoURL(+wrap.dataset.id, wrap.dataset.kind).then((url) => {
          img.src = url;
          img.classList.add('on');
        });
      }
    }, { rootMargin: '260px' });
    scope.querySelectorAll('[data-id]').forEach((el) => io.observe(el));
  }

  /* ---------- 照片墙 ---------- */
  function allMedia() {
    return state.sorted.flatMap((trip) => tripMedia(trip).map((m) => ({ ...m, trip })));
  }

  function renderWall() {
    const view = $('#view-wall');
    const media = allMedia();
    view.innerHTML = media.map((p, i) => `
      <div class="wall-tile" data-idx="${i}" style="aspect-ratio:${(p.w || 4)}/${(p.h || 3)}; transition-delay:${(i % 8) * 45}ms">
        <div data-id="${p.type === 'video' ? p.poster : p.id}" data-kind="t"><img alt="${escapeHTML(p.caption)}"></div>
        ${p.type === 'video' ? '<span class="play big"><i>▶</i></span>' : ''}
        <div class="wall-cap">${escapeHTML(p.caption || '✦')}
          <small>${escapeHTML(p.trip.location)} · ${escapeHTML(dateRange(p.trip))}</small>
        </div>
      </div>`).join('');

    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      }
    }, { rootMargin: '60px' });
    view.querySelectorAll('.wall-tile').forEach((el) => io.observe(el));

    lazyImages(view);
    view.querySelectorAll('.wall-tile').forEach((el) => {
      el.addEventListener('click', () => openLightbox(media, +el.dataset.idx, null));
    });

    if (!reduced && matchMedia('(pointer: fine)').matches) bindTilt(view);
  }

  function bindTilt(view) {
    view.querySelectorAll('.wall-tile').forEach((tile) => {
      tile.addEventListener('mousemove', (e) => {
        if (!tile.classList.contains('in')) return;
        const r = tile.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        tile.style.transform = `perspective(700px) rotateY(${px * 5}deg) rotateX(${-py * 5}deg) translateY(-3px)`;
      });
      tile.addEventListener('mouseleave', () => { tile.style.transform = ''; });
    });
  }

  /* ---------- 章节详情 ---------- */
  /* 正文里独立成段的【图N】→ 在该位置嵌入照片，图文穿插 */
  function figHTML(p, i) {
    const portrait = p.h > p.w;
    return `<figure class="dt-fig${portrait ? ' portrait' : ''}" data-id="${p.id}" data-kind="t" data-i="${i}">
      <img alt="${escapeHTML(p.caption)}">
      ${p.caption ? `<figcaption>✦ ${escapeHTML(p.caption)}</figcaption>` : ''}
    </figure>`;
  }

  function renderDetailBody(trip) {
    const PH_RE = /^【?\s*图\s*(\d+)\s*】?$/;
    const paras = Array.isArray(trip.story) ? trip.story : trip.story ? String(trip.story).split(/\n\s*\n/) : [];
    const used = new Set();
    const parts = [];
    for (const para of paras) {
      const s = String(para).trim();
      if (!s) continue;
      const mm = s.match(PH_RE);
      if (mm) {
        const idx = +mm[1] - 1;
        const p = trip.photos[idx];
        if (p && !used.has(idx)) { used.add(idx); parts.push(figHTML(p, idx)); }
        continue;
      }
      if (s.startsWith('## ')) parts.push(`<h3 class="dt-h">✦ ${escapeHTML(s.slice(3))}</h3>`);
      else if (s.startsWith('> ')) parts.push(`<blockquote class="dt-quote">${escapeHTML(s.slice(2))}</blockquote>`);
      else parts.push(`<p class="dt-p">${escapeHTML(s)}</p>`);
    }
    const storyEl = $('#dt-story');
    storyEl.innerHTML = parts.join('');
    lazyImages(storyEl);
    storyEl.querySelectorAll('.dt-fig').forEach((el) =>
      el.addEventListener('click', () => openLightbox(trip.photos, +el.dataset.i, trip))
    );

    // 没被正文引用的照片 + 全部视频 → 「更多瞬间」画廊
    const media = tripMedia(trip);
    let pi = -1;
    const rest = media
      .map((m, mi) => ({ m, mi, photoIdx: m.type === 'photo' ? ++pi : null }))
      .filter(({ m, photoIdx }) => m.type === 'video' || !used.has(photoIdx));
    $('#dt-more-h').hidden = !rest.length;
    const galleryEl = $('#dt-gallery');
    galleryEl.innerHTML = rest.map(({ m, mi }) => `
      <div class="dt-ph" style="aspect-ratio:${(m.w || 4)}/${(m.h || 3)}" data-id="${m.type === 'video' ? m.poster : m.id}" data-kind="t" data-mi="${mi}">
        <img alt="${escapeHTML(m.caption)}">
        ${m.type === 'video' ? '<span class="play"><i>▶</i></span>' : ''}
        <span class="dt-cap">${escapeHTML(m.caption || trip.location)}</span>
      </div>`).join('');
    lazyImages(galleryEl);
    galleryEl.querySelectorAll('.dt-ph').forEach((el) =>
      el.addEventListener('click', () => openLightbox(media, +el.dataset.mi, trip))
    );
  }

  function openDetail(trip) {
    if (!trip) return;
    const ti = state.sorted.findIndex((t) => t.id === trip.id);
    const prev = ti > 0 ? state.sorted[ti - 1] : null;
    const next = ti < state.sorted.length - 1 ? state.sorted[ti + 1] : null;

    $('#detail').hidden = false;
    document.body.style.overflow = 'hidden';
    $('#detail').scrollTop = 0;

    $('#dt-chapter').textContent = `✦ 第 ${ti + 1} 章 · 共 ${state.sorted.length} 章`;
    $('#dt-title').textContent = trip.title;
    const days = tripDays(trip);
    $('#dt-date').textContent = dateRange(trip) + (days > 1 ? ` · 共 ${days} 天` : '');
    $('#dt-loc').textContent = trip.location;
    $('#dt-lead').textContent = trip.description || '';
    $('#dt-lead').hidden = !trip.description;

    const storyEl = $('#dt-story');
    renderDetailBody(trip);
    storyEl.hidden = !storyEl.innerHTML;

    // 详情页大地图：每次重建，避免残留旧标记
    const mapEl = $('#dt-map');
    if (state.detailMap) {
      state.detailMap.remove();
      state.maps = state.maps.filter((m) => m !== state.detailMap);
      state.detailMap = null;
    }
    if (trip.has_map) {
      mapEl.hidden = false;
      setTimeout(() => {
        state.detailMap = initMap(mapEl, trip);
        setTimeout(() => state.detailMap && state.detailMap.invalidateSize(), 80);
      }, 60);
    } else {
      mapEl.hidden = true;
    }

    const pn = $('#dt-prev'), nx = $('#dt-next');
    pn.hidden = !prev;
    nx.hidden = !next;
    if (prev) pn.textContent = `‹ 上一章：${prev.title}`;
    if (next) nx.textContent = `下一章：${next.title} ›`;
    pn.onclick = () => openDetail(prev);
    nx.onclick = () => openDetail(next);
  }

  function closeDetail() {
    $('#detail').hidden = true;
    document.body.style.overflow = '';
  }

  function bindDetail() {
    $('#detail .dt-close').addEventListener('click', closeDetail);
    $('#detail').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeDetail();
    });
  }

  /* ---------- 标签页 ---------- */
  function switchView(view) {
    if (view === state.view) return;
    state.view = view;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
    ['trail', 'timeline', 'wall'].forEach((v) => {
      $(`#view-${v}`).hidden = v !== view;
    });
    requestAnimationFrame(() => {
      setTimeout(() => state.maps.forEach((m) => m.getContainer().offsetParent && m.invalidateSize()), 60);
    });
    scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  }

  function bindTabs() {
    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
  }

  /* ---------- 灯箱 ---------- */
  function openLightbox(list, idx, trip) {
    state.lb = { list, idx, trip };
    $('#lightbox').hidden = false;
    document.body.style.overflow = 'hidden';
    showLightbox();
  }

  function closeLightbox() {
    $('#lightbox').hidden = true;
    document.body.style.overflow = '';
  }

  async function showLightbox() {
    const { list, idx: rawIdx } = state.lb;
    const idx = ((rawIdx % list.length) + list.length) % list.length;
    state.lb.idx = idx;
    const p = list[idx];
    const img = $('#lb-img');
    const vid = $('#lb-video');

    if (p.type === 'video') {
      // 视频：解密整段 → Blob 播放（URL 在 photoURLs 缓存中复用，勿 revoke）
      vid.pause();
      img.hidden = true;
      img.classList.remove('on');
      vid.hidden = false;
      if (p.poster) vid.poster = await photoURL(p.poster, 't');
      vid.src = await photoURL(p.id, 'v');
      vid.play().catch(() => {});
    } else {
      vid.pause();
      vid.hidden = true;
      vid.removeAttribute('src');
      img.hidden = false;
      img.classList.remove('on');
      img.src = await photoURL(p.id, 'f');
      requestAnimationFrame(() => img.classList.add('on'));
    }
    const where = p.trip ? `${p.trip.location} · ${dateRange(p.trip)}` : (state.lb.trip ? `${state.lb.trip.location} · ${dateRange(state.lb.trip)}` : '');
    const title = p.caption || (p.trip ? p.trip.title : '') || (state.lb.trip && state.lb.trip.title) || '';
    $('#lb-cap').innerHTML = `<b>✦</b>${escapeHTML(title)}${p.type === 'video' ? ' <span class="where">▶ 视频</span>' : ''}<span class="where">${escapeHTML(where)}</span>`;
    $('#lb-count').textContent = `${idx + 1} / ${list.length}`;
    // 预热前后两张（视频太大不预载）
    if (list.length > 1) {
      const nxt = list[(idx + 1) % list.length], prv = list[(idx - 1 + list.length) % list.length];
      if (nxt.type !== 'video') photoURL(nxt.id, 'f').catch(() => {});
      if (prv.type !== 'video') photoURL(prv.id, 'f').catch(() => {});
    }
  }

  function bindLightbox() {
    $('#lightbox .lb-close').addEventListener('click', closeLightbox);
    $('#lightbox .lb-prev').addEventListener('click', () => { state.lb.idx--; showLightbox(); });
    $('#lightbox .lb-next').addEventListener('click', () => { state.lb.idx++; showLightbox(); });
    $('#lightbox').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeLightbox();
    });
    addEventListener('keydown', (e) => {
      if (!$('#lightbox').hidden) {
        if (e.key === 'Escape') closeLightbox();
        if (e.key === 'ArrowLeft') { state.lb.idx--; showLightbox(); }
        if (e.key === 'ArrowRight') { state.lb.idx++; showLightbox(); }
        return;
      }
      if (!$('#detail').hidden && e.key === 'Escape') closeDetail();
    });
    // 触屏滑动翻页
    let tx = null;
    $('#lightbox').addEventListener('touchstart', (e) => { tx = e.touches[0].clientX; }, { passive: true });
    $('#lightbox').addEventListener('touchend', (e) => {
      if (tx === null) return;
      const dx = e.changedTouches[0].clientX - tx;
      if (Math.abs(dx) > 42) { state.lb.idx += dx < 0 ? 1 : -1; showLightbox(); }
      tx = null;
    }, { passive: true });
  }

  function escapeHTML(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  /* ---------- 启动 ---------- */
  startSky();
  bindGate();
})();
