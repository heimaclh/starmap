/* 星图管理台前端 */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let state = null;        // {site, trips, has_secret}
  let currentId = null;
  let dirtyPhotos = [];    // [{file, caption}]，点「保存修改」才写回
  let dirtyVideos = [];

  /* ---------- 访问码（--lan 手机模式） ---------- */
  let authBusy = false;
  async function ensureLogin() {
    if (authBusy) return false;
    authBusy = true;
    try {
      const saved = localStorage.getItem('starmap_access_code') || '';
      if (saved) {
        const r = await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: saved }),
        });
        if (r.ok) return true;
      }
      // 首次：弹出输入框
      for (let tries = 0; tries < 3; tries++) {
        const code = prompt('请输入管理台访问码（电脑上启动 admin.py 时显示的 6 位数字）');
        if (!code) return false;
        const r = await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: code.trim() }),
        });
        if (r.ok) {
          localStorage.setItem('starmap_access_code', code.trim());
          return true;
        }
        alert('访问码不对，请看电脑终端上打印的那一行');
      }
      return false;
    } finally {
      authBusy = false;
    }
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    if (res.status === 401) {
      const ok = await ensureLogin();
      if (!ok) throw new Error('未登录');
      const retry = await fetch(path, opts);
      const data2 = await retry.json().catch(() => ({ ok: false, error: '响应解析失败' }));
      if (!retry.ok || data2.ok === false) throw new Error(data2.error || `请求失败 ${retry.status}`);
      return data2;
    }
    const data = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
    if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 ${res.status}`);
    return data;
  }
  const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  function toast(msg, ms = 2200) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._tm);
    t._tm = setTimeout(() => (t.hidden = true), ms);
  }
  function showLog(text) {
    $('#log-text').textContent = text || '（无输出）';
    $('#log').hidden = false;
  }

  const savedPass = () => localStorage.getItem('starmap_pass') || '';

  /* ---------- WGS-84 ↔ GCJ-02（管理台地图用高德卫星，需双向纠偏） ---------- */
  function outOfChina(lat, lng) { return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271; }
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
  function wgs2gcj(lat, lng) {
    if (outOfChina(lat, lng)) return [lat, lng];
    const a = 6378245, ee = 0.00669342162296594323;
    const rad = (lat / 180) * Math.PI;
    let magic = Math.sin(rad); magic = 1 - ee * magic * magic;
    const sqrt = Math.sqrt(magic);
    return [
      lat + (tLatFn(lng - 105, lat - 35) * 180) / ((a * (1 - ee)) / (magic * sqrt) * Math.PI),
      lng + (tLngFn(lng - 105, lat - 35) * 180) / ((a / sqrt) * Math.cos(rad) * Math.PI),
    ];
  }
  function gcj2wgs(lat, lng) {
    let wLat = lat, wLng = lng;
    for (let i = 0; i < 2; i++) {
      const [gLat, gLng] = wgs2gcj(wLat, wLng);
      wLat -= gLat - lat;
      wLng -= gLng - lng;
    }
    return [wLat, wLng];
  }

  /* ---------- 地图选点器 ---------- */
  let geoCtx = null;

  function openGeo(tripId, file, coords, tripCoords) {
    geoCtx = { tripId, file, marker: null, map: null, current: coords || null };
    $('#geo-keyhint').hidden = !!(state && state.has_amap_key);
    $('#geo-results').hidden = true;
    $('#geo-search').value = '';
    $('#dlg-geo').showModal();
    setTimeout(() => {
      if (geoCtx.map) geoCtx.map.remove();
      const map = L.map('geo-map', { scrollWheelZoom: true });
      L.tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', {
        attribution: '&copy; 高德地图', subdomains: '1234', maxZoom: 19, maxNativeZoom: 18,
      }).addTo(map);
      geoCtx.map = map;
      // 界面上始终用 GCJ-02 显示；存储用 WGS-84
      const center = coords ? wgs2gcj(coords[0], coords[1])
        : tripCoords ? wgs2gcj(tripCoords[0], tripCoords[1]) : [32.5, 110];
      map.setView(center, coords ? 14 : tripCoords ? 10 : 4);
      if (coords) placeMarker(center);
      map.on('click', (e) => placeMarker([e.latlng.lat, e.latlng.lng]));
      setTimeout(() => map.invalidateSize(), 80);
      updateGeoReadout();
    }, 60);
  }

  /* 搜索：调后端 /api/geocode（高德优先），点结果跳图上放标记 */
  function bindGeoSearch() {
    const doSearch = async () => {
      const q = $('#geo-search').value.trim();
      if (!q) return;
      const box = $('#geo-results');
      box.hidden = false;
      box.innerHTML = '<div class="geo-r muted">搜索中…</div>';
      try {
        const r = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
        if (!r.results.length) { box.innerHTML = '<div class="geo-r muted">没有找到结果</div>'; return; }
        const src = r.source === 'amap' ? '高德' : r.source === 'osm' ? 'OpenStreetMap' : '';
        box.innerHTML = (src ? `<div class="geo-r muted head">来源：${src}，点击结果放到地图上</div>` : '')
          + r.results.map((x, i) => `
          <div class="geo-r" data-i="${i}"><b>${esc(x.name)}</b><span>${esc(x.address || '')}</span></div>`).join('');
        box.querySelectorAll('.geo-r[data-i]').forEach((el) => el.addEventListener('click', () => {
          const x = r.results[+el.dataset.i];
          const gcj = wgs2gcj(x.lat, x.lng);
          geoCtx.map.setView(gcj, 14);
          placeMarker(gcj);
          box.hidden = true;
        }));
      } catch (e) {
        box.innerHTML = `<div class="geo-r muted">${esc(e.message)}</div>`;
      }
    };
    $('#geo-search-btn').addEventListener('click', doSearch);
    $('#geo-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  }

  function placeMarker(latlng) {
    if (!geoCtx.marker) {
      geoCtx.marker = L.marker(latlng, { draggable: true }).addTo(geoCtx.map);
      geoCtx.marker.on('dragend', updateGeoReadout);
    } else {
      geoCtx.marker.setLatLng(latlng);
    }
    updateGeoReadout();
  }

  function geoWGS() {
    if (!geoCtx.marker) return null;
    const ll = geoCtx.marker.getLatLng();
    return gcj2wgs(ll.lat, ll.lng);
  }

  function updateGeoReadout() {
    const w = geoWGS();
    $('#geo-readout').textContent = w
      ? `存储坐标 (WGS-84)：${w[0].toFixed(5)}, ${w[1].toFixed(5)}`
      : '未设置（点击地图放置标记）';
  }

  function bindGeo() {
    bindGeoSearch();
    $('#geo-save').addEventListener('click', async () => {
      const w = geoWGS();
      if (!w) { toast('先在地图上点击一个位置'); return; }
      await post(`/api/photo-geo/${geoCtx.tripId}`, { file: geoCtx.file, coords: [w[0].toFixed(6), w[1].toFixed(6)] });
      $('#dlg-geo').close();
      await loadState();
      selectTrip(currentId);
      toast('位置已保存 ✦ 记得点「构建并发布」同步到网站');
    });
    $('#geo-clear').addEventListener('click', async () => {
      await post(`/api/photo-geo/${geoCtx.tripId}`, { file: geoCtx.file, coords: null });
      $('#dlg-geo').close();
      await loadState();
      selectTrip(currentId);
      toast('已清除该照片的定位');
    });
    $('#geo-cancel').addEventListener('click', () => $('#dlg-geo').close());
  }

  function dateLabel(t) {
    if (!t.date) return '未设置日期';
    if (!t.end || t.end === t.date) return t.date;
    return t.date.slice(0, 4) === (t.end || '').slice(0, 4)
      ? `${t.date} ~ ${t.end.slice(5)}`
      : `${t.date} ~ ${t.end}`;
  }

  /* ---------- 数据 ---------- */
  async function loadState() {
    state = await api('/api/state');
    renderTrips();
  }

  function renderTrips() {
    const ul = $('#trip-list');
    ul.innerHTML = '';
    for (const t of state.trips) {
      const li = document.createElement('li');
      li.dataset.id = t.id;
      li.className = t.id === currentId ? 'active' : '';
      const n = (t.photos || []).length + (t.videos || []).length;
      li.innerHTML = `<span class="t">${esc(t.title)}</span>
        <span class="m">${esc(dateLabel(t))} · ${n} 个</span>`;
      li.addEventListener('click', () => selectTrip(t.id));
      ul.appendChild(li);
    }
  }

  function currentTrip() {
    return state.trips.find((t) => t.id === currentId);
  }

  function selectTrip(id) {
    currentId = id;
    const t = currentTrip();
    dirtyPhotos = (t.photos || []).map((p) => ({ file: p.file, caption: p.caption }));
    dirtyVideos = (t.videos || []).map((p) => ({ file: p.file, caption: p.caption }));
    $('#editor-empty').hidden = true;
    $('#editor-body').hidden = false;
    $('#f-title').value = t.title;
    $('#f-date').value = t.date || '';
    $('#f-date-end').value = t.end || '';
    $('#f-location').value = t.location || '';
    $('#f-desc').value = t.description || '';
    $('#f-story').value = (t.story || []).join('\n\n');
    renderPhotos();
    renderTrips();
  }

  function renderPhotos() {
    const t = currentTrip();
    const all = [
      ...dirtyPhotos.map((p, idx) => ({ p, idx, isVideo: false })),
      ...dirtyVideos.map((p, idx) => ({ p, idx, isVideo: true })),
    ];
    $('#photo-count').textContent = `${all.length} 个（${all.filter((x) => !x.p.caption).length} 个未写说明）`;
    const grid = $('#photo-grid');
    grid.innerHTML = '';
    all.forEach(({ p, idx, isVideo }) => {
      const card = document.createElement('div');
      card.className = 'ph-card';
      const meta = (t.photos || []).find((x) => x.file === p.file)
        || (t.videos || []).find((x) => x.file === p.file) || {};
      const media = isVideo
        ? `<video src="/media/${encodeURIComponent(p.file)}" preload="metadata" muted playsinline></video><span class="vidtag">▶ 视频</span>`
        : `<img loading="lazy" src="/media/${encodeURIComponent(p.file)}" alt=""
               onerror="this.replaceWith(Object.assign(document.createElement('div'),{textContent:'该格式无法预览（如 HEIC），不影响构建',style:'padding:20px;font-size:12px;color:#94a0c2'}))">`;
      card.innerHTML = `
        <div class="box">
          ${media}
          <button class="geo ${meta.coords ? 'on' : ''}" title="在地图上设置/修改拍摄地点">📍 ${meta.coords ? '已定位' : '设位置'}</button>
          <button class="del" title="从网站移除">✕</button>
        </div>
        <textarea rows="2" placeholder="${isVideo ? '给这段视频写一段描述…' : '写一段描述…'}（会显示在下方）">${esc(p.caption)}</textarea>`;
      card.querySelector('textarea').addEventListener('input', (e) => {
        (isVideo ? dirtyVideos : dirtyPhotos)[idx].caption = e.target.value;
      });
      card.querySelector('.geo').addEventListener('click', () =>
        openGeo(currentId, p.file, meta.coords || null, t.coords || null));
      card.querySelector('.del').addEventListener('click', async () => {
        if (!confirm('从网站移除这个文件？（原文件仍保留在本机 photos/ 目录）')) return;
        await api(`/api/photo/${currentId}?file=${encodeURIComponent(p.file)}`, { method: 'DELETE' });
        (isVideo ? dirtyVideos : dirtyPhotos).splice(idx, 1);
        await loadState();
        selectTrip(currentId);
        toast('已移除');
      });
      grid.appendChild(card);
    });
  }

  /* ---------- 旅行 ---------- */
  async function saveTrip() {
    await api(`/api/trip/${currentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: $('#f-title').value,
        date: $('#f-date').value,
        end: $('#f-date-end').value,
        location: $('#f-location').value,
        description: $('#f-desc').value,
        story: $('#f-story').value,
        photos: dirtyPhotos,
        videos: dirtyVideos,
      }),
    });
    await loadState();
    renderPhotos();
    toast('已保存 ✦ 记得点「构建并发布」才会更新到网上');
  }

  async function newTrip() {
    const title = prompt('这次旅行的标题：', '新的旅行');
    if (!title) return;
    const r = await post('/api/trips', { title });
    await loadState();
    selectTrip(r.id);
    $('#f-title').focus();
  }

  async function deleteTrip() {
    if (!confirm(`确定删除「${currentTrip().title}」？整个旅行会从网站上消失（照片文件仍保留在本机）。`)) return;
    await api(`/api/trip/${currentId}`, { method: 'DELETE' });
    currentId = null;
    $('#editor-body').hidden = true;
    $('#editor-empty').hidden = false;
    await loadState();
    toast('已删除');
  }

  /* ---------- 上传 ---------- */
  async function uploadFiles(files) {
    const list = [...files].filter((f) => f.size > 0);
    if (!list.length || !currentId) return;
    const dz = $('#dropzone');
    for (let i = 0; i < list.length; i++) {
      dz.querySelector('b').textContent = `上传中 ${i + 1}/${list.length}：${list[i].name}`;
      const body = await list[i].arrayBuffer();
      try {
        const r = await api(`/api/upload/${currentId}?filename=${encodeURIComponent(list[i].name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body,
        });
        if (r.warning) alert(r.warning);
      } catch (e) {
        alert(`「${list[i].name}」上传失败：${e.message}`);
      }
    }
    dz.querySelector('b').textContent = '把照片拖到这里，或点击选择文件';
    await loadState();
    selectTrip(currentId);
    toast(`上传完成 ✦ 别忘了写说明并保存`);
  }

  /* ---------- 设置 / 构建 / 发布 ---------- */
  function openSettings() {
    $('#s-title').value = state.site.title || '';
    $('#s-subtitle').value = state.site.subtitle || '';
    $('#s-anniversary').value = state.site.anniversary || '';
    $('#s-footer').value = state.site.footer || '';
    $('#s-pass').value = savedPass();
    $('#s-remember').checked = state.has_secret;
    $('#dlg-settings').showModal();
  }

  async function saveSettings() {
    await post('/api/site', {
      title: $('#s-title').value,
      subtitle: $('#s-subtitle').value,
      anniversary: $('#s-anniversary').value,
      footer: $('#s-footer').value,
    });
    localStorage.setItem('starmap_pass', $('#s-pass').value);
    await loadState();
    $('#dlg-settings').close();
    toast('设置已保存，构建后生效');
  }

  async function buildOrPublish(url, label) {
    if (!savedPass() && !state.has_secret) {
      openSettings();
      toast('请先在设置里填写加密暗号');
      return;
    }
    const btn = label === 'build' ? $('#btn-build') : $('#btn-publish');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '处理中…';
    try {
      const r = await post(url, { passphrase: savedPass(), remember: !state.has_secret && !!savedPass() });
      showLog(r.output || '');
      if (r.need_passphrase) openSettings();
      else if (r.ok) toast(`${label === 'build' ? '构建完成' : '发布成功'} ✦`);
      await loadState();
    } catch (e) {
      showLog(String(e));
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  /* ---------- 绑定 ---------- */
  $('#btn-new').addEventListener('click', newTrip);
  $('#btn-save-trip').addEventListener('click', saveTrip);
  $('#btn-delete-trip').addEventListener('click', deleteTrip);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-settings-save').addEventListener('click', saveSettings);
  $('#btn-settings-cancel').addEventListener('click', () => $('#dlg-settings').close());
  $('#btn-build').addEventListener('click', () => buildOrPublish('/api/build', 'build'));
  $('#btn-publish').addEventListener('click', () => buildOrPublish('/api/publish', 'publish'));
  $('#log-close').addEventListener('click', () => ($('#log').hidden = true));

  const dz = $('#dropzone');
  dz.addEventListener('click', () => $('#file-input').click());
  bindGeo();
  $('#file-input').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    uploadFiles(e.dataTransfer.files);
  });

  loadState().catch((e) => toast('加载失败：' + e.message));
})();
