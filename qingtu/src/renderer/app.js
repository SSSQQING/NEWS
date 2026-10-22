'use strict';

// window.api 由 preload 通过 contextBridge 注入（全局只读，不能再用 const 重新声明）
const { renderName, TOKENS } = window.QingtuNaming;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clone = v => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------- 配置

const DEFAULT_SETTINGS = {
  format: 'original',
  qualityMode: 'smart',
  target: 'high',
  quality: 85,
  limitSize: false,
  maxSize: 500,
  sizeUnit: 'KB',
  allowDownscale: true,
  keepMetadata: false,
  keepSmaller: true,
  keepHdr: true,
  jxlFromJpeg: true,
  resize: { mode: 'none', width: 1920, height: 1080, percent: 50, anchor: 'attention', noEnlarge: true, bg: '#ffffff', transparent: false },
  output: { mode: 'subfolder', subfolder: 'compressed', dir: '', keepStructure: true, trashOriginal: true, conflict: 'rename', openWhenDone: false },
  naming: { mode: 'original', template: '{name}_{n}', start: 1, digits: 3 },
};

// 预设只管“怎么压”，不碰导出位置
const PRESET_KEYS = ['format', 'qualityMode', 'target', 'quality', 'limitSize', 'maxSize', 'sizeUnit', 'allowDownscale', 'keepMetadata', 'keepSmaller', 'keepHdr', 'jxlFromJpeg', 'resize', 'naming'];

const smartJpeg = { format: 'jpeg', qualityMode: 'smart', target: 'high' };
const BUILTIN_PRESETS = [
  { id: 'shop', name: '电商主图', desc: '800×800 智能裁切 · JPG · ≤ 500 KB', settings: { ...smartJpeg, limitSize: true, maxSize: 500, sizeUnit: 'KB', resize: { mode: 'cover', width: 800, height: 800, anchor: 'attention' } } },
  { id: 'idphoto', name: '报名证件照', desc: '一寸 295×413 · JPG · ≤ 100 KB', settings: { ...smartJpeg, limitSize: true, maxSize: 100, sizeUnit: 'KB', resize: { mode: 'cover', width: 295, height: 413, anchor: 'attention' } } },
  { id: 'wechat', name: '公众号封面', desc: '900×383 智能裁切 · JPG · ≤ 1 MB', settings: { ...smartJpeg, limitSize: true, maxSize: 1, sizeUnit: 'MB', resize: { mode: 'cover', width: 900, height: 383, anchor: 'attention' } } },
  { id: 'web', name: '网页图片', desc: '最长边 1920 · AVIF · 高画质', settings: { format: 'avif', qualityMode: 'smart', target: 'high', limitSize: false, resize: { mode: 'inside', width: 1920, height: 1920, noEnlarge: true } } },
  { id: 'social', name: '社交分享', desc: '最长边 1440 · JPG · 高画质', settings: { ...smartJpeg, limitSize: false, resize: { mode: 'inside', width: 1440, height: 1440, noEnlarge: true } } },
  { id: 'mail', name: '邮件附件', desc: '最长边 1600 · JPG · ≤ 300 KB', settings: { ...smartJpeg, target: 'balanced', limitSize: true, maxSize: 300, sizeUnit: 'KB', resize: { mode: 'inside', width: 1600, height: 1600, noEnlarge: true } } },
  { id: 'archive', name: '高保真存档', desc: 'JPEG XL · 视觉无损 · JPG 无损转码', settings: { format: 'jxl', qualityMode: 'smart', target: 'lossless', limitSize: false, jxlFromJpeg: true, resize: { mode: 'none' } } },
];

const FORMAT_LABEL = { original: '原格式', jpeg: 'JPG', png: 'PNG', webp: 'WebP', avif: 'AVIF', jxl: 'JPEG XL', gif: 'GIF' };
const TARGET_LABEL = { lossless: '视觉无损', high: '高画质', balanced: '均衡', small: '小体积' };
const MODE_LABEL = { none: '', cover: '裁切', contain: '留白', inside: '以内', fill: '拉伸', percent: '' };
const ANCHOR_LABEL = { attention: '智能主体', centre: '居中', north: '靠上', south: '靠下', west: '靠左', east: '靠右', northwest: '左上', northeast: '右上', southwest: '左下', southeast: '右下' };
const ENCODER_LABEL = { jpegli: 'Jpegli', mozjpeg: 'mozjpeg', libjxl: 'libjxl', libaom: 'libaom（AV1）', libwebp: 'libwebp', libimagequant: 'libimagequant', cgif: 'cgif', original: '保留原图' };

const FORMAT_NOTES = {
  original: '每张图保持原来的格式；TIFF 会转成 JPG，SVG 会转成 PNG。',
  jpeg: '兼容性最好，哪都能打开。编码器用 Google 2024 年的 <b>Jpegli</b>：实测同画质比常见的 mozjpeg 小 1%–5%，视觉无损档小约 20%。',
  png: '无损、支持透明，但照片会很大。画质低于 100 时走调色板压缩（TinyPNG 同款思路）。',
  webp: '网页、微信基本都认。实测同画质比 JPG 小 <b>10%–13%</b>。',
  avif: '基于 AV1，实测同画质比 JPG 小 <b>33%–36%</b>，是这里最省的。新版浏览器、Windows 11、iOS 都能打开，个别老软件不认。',
  jxl: '新一代 ISO 标准，实测同画质比 JPG 小 <b>21%–30%</b>，越接近无损优势越大；JPG 转过来还能无损还原。Chrome 155+、Safari 支持，很多软件暂时打不开。',
};
const MODE_NOTES = {
  none: '保持原尺寸。',
  cover: '等比缩放后裁掉多余部分，输出正好是 宽 × 高。',
  contain: '完整保留画面，空白处填背景色，输出正好是 宽 × 高。',
  inside: '等比缩小到 宽 × 高 以内，不裁切；只填一边也行。',
  fill: '强行拉伸到 宽 × 高，画面会变形。',
  percent: '按百分比等比缩放。',
};
const EXACT = new Set(['cover', 'contain', 'fill']);
const EXT_FORMAT = { jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg', jfif: 'jpeg', png: 'png', webp: 'webp', avif: 'avif', jxl: 'jxl', gif: 'gif', tif: 'tiff', tiff: 'tiff', svg: 'svg' };
const FORMAT_EXT = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif', jxl: 'jxl', gif: 'gif' };

// ---------------------------------------------------------------- 状态

const state = {
  files: [],
  settings: clone(DEFAULT_SETTINGS),
  presets: [],
  theme: 'system',
  activePreset: null,
  running: false,
  job: null,
  lastSummary: null,
  platform: '',
};
const byId = new Map();
const cards = new Map();
let nextId = 1;

// ---------------------------------------------------------------- 工具

function getPath(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function setPath(obj, key, value) {
  const keys = key.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] = o[k] || {}), obj);
  target[last] = value;
}

function merge(base, extra) {
  const out = clone(base);
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') out[k] = merge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  const mb = n / 1048576;
  return `${mb.toFixed(mb >= 100 ? 0 : mb >= 10 ? 1 : 2)} MB`;
}

function basename(p) {
  return p.split(/[\\/]/).pop();
}

function splitExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i + 1)] : [name, ''];
}

function outputFormatFor(ext) {
  const f = state.settings.format;
  if (f !== 'original') return f;
  const src = EXT_FORMAT[ext.toLowerCase()];
  if (src === 'tiff') return 'jpeg';
  if (src === 'svg') return 'png';
  return src || 'jpeg';
}

function scoreWord(s) {
  if (s >= 90) return '肉眼无差';
  if (s >= 80) return '几乎看不出';
  if (s >= 70) return '轻微差异';
  if (s >= 50) return '差异明显';
  return '画质较差';
}

function cleanError(err) {
  return String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.saveState({ settings: state.settings, presets: state.presets, theme: state.theme }).catch(() => {});
  }, 400);
}

// ---------------------------------------------------------------- 提示与对话框

function toast(message, kind = 'success', ms = 2800) {
  const icons = { success: 'check', warn: 'alert', error: 'alert', info: 'info' };
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(icons[kind] || 'info', 16)}<span></span>`;
  el.querySelector('span').textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, ms);
}

function dialog({ title, message, okText = '确定', cancelText = '取消', danger = false, input = null }) {
  const modal = $('#dialogModal');
  const field = $('#dlgInput');
  $('#dlgTitle').textContent = title;
  $('#dlgMessage').textContent = message || '';
  $('#dlgOk').textContent = okText;
  $('#dlgOk').className = `btn ${danger ? 'danger' : 'primary'}`;
  $('#dlgCancel').textContent = cancelText;
  field.hidden = !input;
  if (input) {
    field.value = input.value || '';
    field.placeholder = input.placeholder || '';
  }
  modal.hidden = false;
  (input ? field : $('#dlgOk')).focus();

  return new Promise(resolve => {
    const close = value => {
      modal.hidden = true;
      cleanup();
      resolve(value);
    };
    const ok = () => close(input ? field.value.trim() || null : true);
    const cancel = () => close(input ? null : false);
    const onKey = e => {
      if (e.key === 'Enter') ok();
      if (e.key === 'Escape') cancel();
    };
    const onBackdrop = e => {
      if (e.target.matches('[data-close]')) cancel();
    };
    $('#dlgOk').addEventListener('click', ok);
    $('#dlgCancel').addEventListener('click', cancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
    function cleanup() {
      $('#dlgOk').removeEventListener('click', ok);
      $('#dlgCancel').removeEventListener('click', cancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
    }
  });
}

// ---------------------------------------------------------------- 设置面板

function bindSettings() {
  $$('[data-bind]').forEach(el => {
    const key = el.dataset.bind;
    const event = el.type === 'checkbox' || el.type === 'color' ? 'change' : 'input';
    el.addEventListener(event, () => {
      let value = el.value;
      if (el.type === 'checkbox') value = el.checked;
      else if (el.type === 'number' || el.type === 'range') value = el.value === '' ? '' : Number(el.value);
      setPath(state.settings, key, value);
      onSettingsChanged(key);
    });
    if (el.type === 'color') el.addEventListener('input', () => ($('#bgValue').textContent = el.value.toUpperCase()));
  });

  $$('[data-seg]').forEach(group => {
    group.addEventListener('click', e => {
      const btn = e.target.closest('[data-value]');
      if (!btn || btn.disabled) return;
      setPath(state.settings, group.dataset.seg, btn.dataset.value);
      onSettingsChanged(group.dataset.seg);
    });
  });

  $$('#sizeChips [data-size]').forEach(btn => {
    btn.addEventListener('click', () => {
      const [w, h] = btn.dataset.size.split('x').map(Number);
      state.settings.resize.width = w;
      state.settings.resize.height = h;
      if (state.settings.resize.mode === 'none' || state.settings.resize.mode === 'percent') state.settings.resize.mode = 'cover';
      onSettingsChanged('resize.width');
    });
  });

  $('#swapDims').addEventListener('click', () => {
    const r = state.settings.resize;
    [r.width, r.height] = [r.height, r.width];
    onSettingsChanged('resize.width');
  });

  $('#tokenChips').innerHTML = TOKENS.map(t => `<button type="button" class="chip-btn" data-token="${t.token}"><code>${t.token}</code> ${t.label}</button>`).join('');
  $('#tokenChips').addEventListener('click', e => {
    const btn = e.target.closest('[data-token]');
    if (!btn) return;
    const input = $('#templateInput');
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + btn.dataset.token + input.value.slice(end);
    input.focus();
    input.setSelectionRange(start + btn.dataset.token.length, start + btn.dataset.token.length);
    input.dispatchEvent(new Event('input'));
  });

  $('#pickDirBtn').addEventListener('click', async () => {
    const dir = await api.pickOutputDir(state.settings.output.dir);
    if (!dir) return;
    state.settings.output.dir = dir;
    onSettingsChanged('output.dir');
  });
}

function onSettingsChanged(key) {
  if (PRESET_KEYS.includes(key.split('.')[0])) state.activePreset = null;
  syncSettingsUI();
  saveState();
}

function show(sel, visible) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (el) el.hidden = !visible;
}

function syncSettingsUI() {
  const s = state.settings;
  $$('[data-bind]').forEach(el => {
    const v = getPath(s, el.dataset.bind);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (document.activeElement !== el) el.value = v ?? '';
  });
  $$('[data-seg]').forEach(group => {
    const v = String(getPath(s, group.dataset.seg));
    $$('[data-value]', group).forEach(b => b.classList.toggle('active', b.dataset.value === v));
  });
  $$('input[type="range"]').forEach(el => {
    const pct = ((Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min))) * 100;
    el.style.setProperty('--p', `${pct}%`);
  });

  const r = s.resize;
  const mode = r.mode;
  const exact = EXACT.has(mode);
  const smart = s.qualityMode !== 'manual';

  $('#formatNote').innerHTML = FORMAT_NOTES[s.format] || '';
  show('#smartBox', smart);
  show('#manualBox', !smart);
  $('#qualityValue').textContent = s.quality;
  $('#qualityLabel').textContent = s.limitSize ? '画质（上限）' : '画质';
  show('#sizeLimitBox', s.limitSize);
  show('#downscaleRow', !exact);
  show('#downscaleNote', exact);
  show('#jxlLosslessRow', s.format === 'jxl');

  $('#modeNote').textContent = MODE_NOTES[mode] || '';
  show('#dimsBox', exact || mode === 'inside');
  show('#percentBox', mode === 'percent');
  $('#percentValue').textContent = `${r.percent}%`;
  show('#anchorBox', mode === 'cover');
  show('#noEnlargeRow', mode === 'inside');
  const needsBg = mode === 'contain' || s.format === 'jpeg';
  show('#bgBox', needsBg);
  show('#transparentRow', mode === 'contain' && s.format !== 'jpeg');
  $('#bgHint').textContent = mode === 'contain' ? '留白和透明区域' : '透明区域转 JPG 时';
  $('#bgValue').textContent = String(r.bg || '#ffffff').toUpperCase();
  $$('#sizeChips [data-size]').forEach(b => b.classList.toggle('active', b.dataset.size === `${r.width}x${r.height}`));
  $$('.dim input').forEach(input => (input.placeholder = mode === 'inside' ? '不限' : '必填'));

  const o = s.output;
  show('#subfolderBox', o.mode === 'subfolder');
  show('#folderBox', o.mode === 'folder');
  show('#overwriteBox', o.mode === 'overwrite');
  show('#conflictBox', o.mode !== 'overwrite');
  const picker = $('#pickDirBtn');
  picker.classList.toggle('set', !!o.dir);
  $('#dirLabel').textContent = o.dir || '选择导出文件夹…';
  picker.title = o.dir || '';

  const overwrite = o.mode === 'overwrite';
  $('#namingPanel').classList.toggle('disabled', overwrite);
  show('#overwriteNameNote', overwrite);
  show('#customNameBox', s.naming.mode === 'custom');
  updateNamePreview();
  updatePresetLabel();
  updateActionBar();
}

function updateNamePreview() {
  const sample = state.files[0];
  const name = sample ? sample.name : 'IMG_2041.jpg';
  const [base, ext] = splitExt(name);
  const fmt = outputFormatFor(ext || 'jpg');
  const sameFormat = EXT_FORMAT[(ext || '').toLowerCase()] === fmt;
  const outExt = sameFormat ? ext : FORMAT_EXT[fmt];
  const r = state.settings.resize;
  const dims = EXACT.has(r.mode) ? [r.width, r.height] : sample && sample.width ? [sample.width, sample.height] : [1920, 1080];
  const out = state.settings.output.mode === 'overwrite'
    ? base
    : renderName(state.settings.naming, { name: base, index: 0, width: dims[0], height: dims[1], date: new Date(), folder: sample ? basename(sample.path.slice(0, -name.length - 1)) : '相册', fmt: outExt });
  const el = $('#namePreview');
  el.innerHTML = '预览：<b></b>';
  el.querySelector('b').textContent = `${out}.${outExt}`;
}

// ---------------------------------------------------------------- 预设

function updatePresetLabel() {
  const all = [...BUILTIN_PRESETS, ...state.presets];
  const active = all.find(p => p.id === state.activePreset);
  $('#presetLabel').textContent = active ? active.name : '场景预设';
  $('#presetTrigger').classList.toggle('active', !!active);
}

function applyPreset(p) {
  const next = clone(state.settings);
  for (const k of PRESET_KEYS) {
    if (p.settings[k] === undefined) continue;
    next[k] = typeof p.settings[k] === 'object' && p.settings[k] !== null ? merge(DEFAULT_SETTINGS[k], p.settings[k]) : p.settings[k];
  }
  state.settings = next;
  state.activePreset = p.id;
  syncSettingsUI();
  saveState();
  toast(`已切换到「${p.name}」`, 'info', 1800);
}

function describeSettings(s) {
  const parts = [FORMAT_LABEL[s.format]];
  parts.push(s.qualityMode === 'manual' ? `画质 ${s.quality}` : TARGET_LABEL[s.target]);
  const r = s.resize;
  if (EXACT.has(r.mode) || r.mode === 'inside') parts.push(`${r.width || '∞'}×${r.height || '∞'}${MODE_LABEL[r.mode]}`);
  if (r.mode === 'percent') parts.push(`${r.percent}%`);
  if (s.limitSize) parts.push(`≤ ${s.maxSize} ${s.sizeUnit}`);
  return parts.join(' · ');
}

function renderPresetMenu() {
  const menu = $('#presetMenu');
  const item = (p, removable) => `
    <button type="button" class="menu-item ${state.activePreset === p.id ? 'active' : ''}" data-preset="${p.id}">
      <span class="mi-text"><b></b><small></small></span>
      ${removable ? `<span class="mi-del" data-del="${p.id}" title="删除">${icon('x', 15)}</span>` : ''}
    </button>`;
  menu.innerHTML = `
    <div class="menu-label">常用场景</div>
    ${BUILTIN_PRESETS.map(p => item(p, false)).join('')}
    ${state.presets.length ? `<div class="menu-sep"></div><div class="menu-label">我的预设</div>${state.presets.map(p => item(p, true)).join('')}` : ''}
    <div class="menu-sep"></div>
    <button type="button" class="menu-item save" data-save>${icon('bookmarkPlus', 16)}<span class="mi-text">把当前设置存为预设</span></button>`;
  const all = [...BUILTIN_PRESETS, ...state.presets];
  $$('[data-preset]', menu).forEach(el => {
    const p = all.find(x => x.id === el.dataset.preset);
    el.querySelector('b').textContent = p.name;
    el.querySelector('small').textContent = p.desc;
  });
}

function togglePresetMenu(open) {
  const menu = $('#presetMenu');
  const trigger = $('#presetTrigger');
  const willOpen = open ?? menu.hidden;
  if (!willOpen) {
    menu.hidden = true;
    trigger.classList.remove('open');
    return;
  }
  renderPresetMenu();
  menu.hidden = false;
  trigger.classList.add('open');
  const rect = trigger.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 8}px`;
  menu.style.left = `${Math.max(12, rect.left + rect.width / 2 - menu.offsetWidth / 2)}px`;
}

function bindPresets() {
  $('#presetTrigger').addEventListener('click', e => {
    e.stopPropagation();
    togglePresetMenu();
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#presetMenu')) togglePresetMenu(false);
  });
  $('#presetMenu').addEventListener('click', async e => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      state.presets = state.presets.filter(p => p.id !== del.dataset.del);
      if (state.activePreset === del.dataset.del) state.activePreset = null;
      saveState();
      renderPresetMenu();
      updatePresetLabel();
      return;
    }
    if (e.target.closest('[data-save]')) {
      togglePresetMenu(false);
      const name = await dialog({ title: '存为预设', message: '下次在「场景预设」里一键套用。', okText: '保存', input: { placeholder: '比如：小红书配图' } });
      if (!name) return;
      const settings = {};
      PRESET_KEYS.forEach(k => (settings[k] = clone(state.settings[k])));
      const p = { id: `u${Date.now()}`, name: name.slice(0, 20), desc: describeSettings(state.settings), settings };
      state.presets.push(p);
      state.activePreset = p.id;
      saveState();
      updatePresetLabel();
      toast(`预设「${p.name}」已保存`);
      return;
    }
    const btn = e.target.closest('[data-preset]');
    if (!btn) return;
    const p = [...BUILTIN_PRESETS, ...state.presets].find(x => x.id === btn.dataset.preset);
    togglePresetMenu(false);
    if (p) applyPreset(p);
  });
}

// ---------------------------------------------------------------- 主题

const THEMES = ['system', 'light', 'dark'];
const THEME_META = { system: ['monitor', '跟随系统'], light: ['sun', '浅色'], dark: ['moon', '深色'] };

function applyTheme() {
  const [ic, label] = THEME_META[state.theme] || THEME_META.system;
  $('#themeBtn').innerHTML = icon(ic, 18);
  $('#themeBtn').title = `主题：${label}（点击切换）`;
  api.setTheme(state.theme);
}

// ---------------------------------------------------------------- 文件列表

function scanOptions() {
  const o = state.settings.output;
  return { skipDirNames: o.mode === 'subfolder' ? [o.subfolder || 'compressed'] : [] };
}

function addEntries(entries) {
  if (!entries || !entries.length) {
    toast('没找到支持的图片', 'warn');
    return;
  }
  const known = new Set(state.files.map(f => f.path));
  let added = 0;
  for (const e of entries) {
    if (known.has(e.path)) continue;
    known.add(e.path);
    const f = { id: nextId++, path: e.path, name: basename(e.path), baseDir: e.baseDir, size: e.size, status: 'idle', width: 0, height: 0, thumb: null, result: null, error: null };
    state.files.push(f);
    byId.set(f.id, f);
    mountCard(f);
    queueThumb(f);
    added++;
  }
  if (!added) toast('这些图片已经在列表里了', 'info');
  else if (entries.length > added) toast(`已添加 ${added} 张，${entries.length - added} 张重复的已跳过`, 'info');
  refreshList();
}

// 对话框点了取消会返回 null，这时什么都不提示
async function addFiles() {
  const entries = await api.pickFiles();
  if (entries) addEntries(entries);
}

async function addFolder() {
  const entries = await api.pickFolder(scanOptions());
  if (entries) addEntries(entries);
}

function refreshList() {
  $('#content').classList.toggle('has-files', state.files.length > 0);
  const total = state.files.reduce((s, f) => s + (f.size || 0), 0);
  $('#countChip').textContent = state.files.length ? `${state.files.length} 张 · ${formatBytes(total)}` : '0 张';
  $('#clearBtn').disabled = !state.files.length || state.running;
  updateNamePreview();
  updateActionBar();
}

function removeFile(id) {
  const f = byId.get(id);
  if (!f || state.running) return;
  state.files = state.files.filter(x => x !== f);
  byId.delete(id);
  cards.get(id)?.remove();
  cards.delete(id);
  refreshList();
}

async function clearFiles() {
  if (!state.files.length || state.running) return;
  if (state.files.length > 20 && !(await dialog({ title: '清空列表？', message: `列表里的 ${state.files.length} 张图片会被移出（不会删除文件）。`, okText: '清空' }))) return;
  state.files = [];
  byId.clear();
  cards.forEach(el => el.remove());
  cards.clear();
  state.lastSummary = null;
  refreshList();
}

const thumbQueue = [];
let thumbActive = 0;

function queueThumb(f) {
  thumbQueue.push(f);
  pumpThumbs();
}

function pumpThumbs() {
  while (thumbActive < 3 && thumbQueue.length) {
    const f = thumbQueue.shift();
    if (!byId.has(f.id)) continue;
    thumbActive++;
    api.thumbnail(f.path)
      .then(t => {
        Object.assign(f, { thumb: t.thumb, width: t.width, height: t.height, format: t.format, hdr: t.hdr, animated: t.animated });
      })
      .catch(() => {
        f.thumbFailed = true;
      })
      .finally(() => {
        thumbActive--;
        updateCard(f);
        if (f === state.files[0]) updateNamePreview();
        pumpThumbs();
      });
  }
}

function mountCard(f) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = f.id;
  el.innerHTML = `
    <div class="thumb">
      <div class="thumb-ph">${icon('image', 28)}</div>
      <img alt="" draggable="false">
      <div class="thumb-busy"><span class="spinner"></span></div>
      <span class="badge"></span>
      <div class="tag-row"></div>
      <div class="card-tools">
        <button type="button" class="tool" data-act="compare" title="对比效果">${icon('compare', 16)}</button>
        <button type="button" class="tool" data-act="reveal" title="在文件夹中显示">${icon('folderOpen', 16)}</button>
        <button type="button" class="tool" data-act="remove" title="移出列表">${icon('x', 16)}</button>
      </div>
    </div>
    <div class="card-body">
      <div class="card-name"></div>
      <div class="card-meta"></div>
      <div class="card-result"></div>
    </div>`;
  $('#grid').appendChild(el);
  cards.set(f.id, el);
  updateCard(f);
}

function updateCard(f) {
  const el = cards.get(f.id);
  if (!el) return;
  el.dataset.status = f.status;
  const img = $('img', el);
  if (f.thumb && img.getAttribute('src') !== f.thumb) {
    img.src = f.thumb;
    el.classList.add('has-thumb');
  }
  const name = $('.card-name', el);
  name.textContent = f.name;
  name.title = f.path;
  $('.card-meta', el).textContent = [f.width ? `${f.width}×${f.height}` : '', formatBytes(f.size)].filter(Boolean).join(' · ');

  const badge = $('.badge', el);
  const result = $('.card-result', el);
  const tags = [];
  let badgeText = '';
  let badgeKind = '';
  let resultText = '';
  el.classList.remove('warn');
  el.classList.toggle('replaced', !!(f.result && f.result.replaced));

  if (f.status === 'queued') {
    badgeText = '排队中';
    badgeKind = 'muted';
  } else if (f.status === 'done' && f.result) {
    const r = f.result;
    const saved = 1 - r.outSize / r.inSize;
    if (r.kept) {
      badgeText = '原图已最优';
      badgeKind = 'muted';
    } else {
      badgeText = saved >= 0 ? `−${Math.round(saved * 100)}%` : `+${Math.round(-saved * 100)}%`;
      badgeKind = 'ok';
    }
    if (!r.ok) {
      badgeText = '超出大小限制';
      badgeKind = 'warn';
      el.classList.add('warn');
    }
    resultText = `→ ${formatBytes(r.outSize)} · ${r.width}×${r.height}`;
    tags.push(FORMAT_LABEL[r.format] || r.format);
    if (r.lossless && !r.kept) tags.push('无损');
    else if (Number.isFinite(r.score)) tags.push(`画质 ${Math.round(r.score)}`);
    if (r.hdr) tags.push('HDR');
  } else if (f.status === 'error') {
    badgeText = '失败';
    badgeKind = 'err';
    resultText = f.error || '处理失败';
  } else if (f.status === 'skipped') {
    badgeText = '已跳过';
    badgeKind = 'muted';
    resultText = f.error || '';
  } else if (f.hdr) {
    tags.push('HDR');
  }
  badge.textContent = badgeText;
  badge.className = `badge ${badgeText ? `show ${badgeKind}` : ''}`;
  result.textContent = resultText;
  result.title = resultText;
  $('.tag-row', el).innerHTML = tags.map(t => `<span class="tag">${t}</span>`).join('');
}

// ---------------------------------------------------------------- 处理任务

function pendingFiles() {
  return state.files.filter(f => f.status !== 'done');
}

function updateActionBar() {
  const s = state.settings;
  const btn = $('#startBtn');
  const files = state.files;
  const total = files.reduce((n, f) => n + (f.size || 0), 0);
  const where = s.output.mode === 'overwrite' ? '覆盖原图' : s.output.mode === 'folder' ? (s.output.dir ? `导出到 ${basename(s.output.dir)}` : '导出到（未选择文件夹）') : `原图旁 ${s.output.subfolder || 'compressed'}/`;

  $('#sidebar').classList.toggle('locked', state.running);
  document.body.classList.toggle('is-running', state.running);
  $('#addFilesBtn').disabled = state.running;
  $('#addFolderBtn').disabled = state.running;
  $('#clearBtn').disabled = !files.length || state.running;

  if (state.running && state.job) {
    const j = state.job;
    const finished = j.done + j.failed + j.skipped;
    const pct = j.total ? Math.round((finished / j.total) * 100) : 0;
    $('#abTitle').textContent = `正在处理 ${Math.min(finished + 1, j.total)} / ${j.total}`;
    $('#abSub').innerHTML = j.inBytes ? `已节省 <b>${formatBytes(Math.max(0, j.inBytes - j.outBytes))}</b>` : '智能画质会给每张图打分找最优参数，稍等一下';
    show('#abProgress', true);
    $('#abBar').style.width = `${pct}%`;
    $('#abPct').textContent = `${pct}%`;
    btn.className = 'btn lg stop';
    btn.innerHTML = `${icon('stop', 16)}<span>停止</span>`;
    btn.disabled = false;
    show('#openOutBtn', false);
    return;
  }

  show('#abProgress', false);
  btn.className = 'btn primary lg';
  const pending = pendingFiles().length;
  btn.innerHTML = `${icon(pending || !files.length ? 'play' : 'refresh', 16)}<span></span>`;
  $('span', btn).textContent = !files.length || pending === files.length ? '开始压缩' : pending ? `继续处理 ${pending} 张` : '全部重新处理';
  btn.disabled = !files.length;

  const sum = state.lastSummary;
  if (sum && files.length) {
    const saved = Math.max(0, sum.inBytes - sum.outBytes);
    const pct = sum.inBytes ? Math.round((saved / sum.inBytes) * 100) : 0;
    $('#abTitle').textContent = `完成 ${sum.done} 张，省下 ${formatBytes(saved)}（−${pct}%）`;
    const extra = [sum.failed ? `${sum.failed} 张失败` : '', sum.skipped ? `${sum.skipped} 张跳过` : '', sum.cancelled ? '已手动停止' : ''].filter(Boolean);
    $('#abSub').textContent = extra.length ? extra.join(' · ') : `${describeSettings(s)} → ${where}`;
    show('#openOutBtn', sum.outDirs && sum.outDirs.length > 0);
  } else {
    $('#abTitle').textContent = files.length ? `共 ${files.length} 张 · ${formatBytes(total)}` : '还没有图片';
    $('#abSub').textContent = files.length ? `${describeSettings(s)} → ${where}` : '拖进来就能开始';
    show('#openOutBtn', false);
  }
}

function validate() {
  const s = state.settings;
  if (s.output.mode === 'folder' && !s.output.dir) {
    toast('先选一个导出文件夹', 'warn');
    $('#pickDirBtn').classList.add('flash');
    setTimeout(() => $('#pickDirBtn').classList.remove('flash'), 1900);
    return false;
  }
  if (s.limitSize && !(Number(s.maxSize) > 0)) {
    toast('文件大小上限要填一个大于 0 的数', 'warn');
    return false;
  }
  const r = s.resize;
  if (EXACT.has(r.mode) && !(r.width > 0 && r.height > 0)) {
    toast('这个尺寸模式需要同时填写宽和高', 'warn');
    return false;
  }
  if (r.mode === 'inside' && !(r.width > 0) && !(r.height > 0)) {
    toast('“限制最大”至少填写宽或高其中一个', 'warn');
    return false;
  }
  return true;
}

async function start() {
  if (state.running) {
    api.cancelJob();
    $('#abTitle').textContent = '正在停止…（手头这几张处理完就停）';
    return;
  }
  if (!state.files.length || !validate()) return;
  const pending = pendingFiles();
  const targets = pending.length ? pending : state.files;
  const s = state.settings;
  if (s.output.mode === 'overwrite') {
    const ok = await dialog({
      title: `覆盖 ${targets.length} 个原文件？`,
      message: s.output.trashOriginal ? '原图会先移入回收站，需要时可以还原。' : '你关掉了“移入回收站”，原图会被直接替换，无法找回。',
      okText: '确定覆盖',
      danger: !s.output.trashOriginal,
    });
    if (!ok) return;
  }

  targets.forEach(f => {
    f.status = 'queued';
    f.result = null;
    f.error = null;
    updateCard(f);
  });
  state.running = true;
  state.lastSummary = null;
  state.job = { total: targets.length, done: 0, failed: 0, skipped: 0, inBytes: 0, outBytes: 0 };
  updateActionBar();

  try {
    const summary = await api.startJob({
      files: targets.map(f => ({ id: f.id, path: f.path, baseDir: f.baseDir, index: state.files.indexOf(f) })),
      settings: s,
    });
    state.lastSummary = summary;
    if (summary.done) {
      const saved = Math.max(0, summary.inBytes - summary.outBytes);
      toast(`搞定！${summary.done} 张图省下 ${formatBytes(saved)}${summary.failed ? `，${summary.failed} 张失败` : ''}`, summary.failed ? 'warn' : 'success', 3600);
    } else if (summary.failed) {
      toast(`${summary.failed} 张都没处理成功，看看卡片上的原因`, 'error', 3600);
    }
    if (s.output.openWhenDone && summary.outDirs[0]) api.openPath(summary.outDirs[0]);
  } catch (err) {
    toast(`处理出错：${cleanError(err)}`, 'error', 4200);
  } finally {
    state.running = false;
    state.job = null;
    targets.forEach(f => {
      if (f.status === 'queued' || f.status === 'working') {
        f.status = 'idle';
        updateCard(f);
      }
    });
    refreshList();
  }
}

function onProgress(ev) {
  const f = byId.get(ev.id);
  if (!f) return;
  const j = state.job;
  if (ev.status === 'working') {
    f.status = 'working';
  } else if (ev.status === 'done') {
    f.status = 'done';
    f.result = { ...ev };
    if (j) {
      j.done++;
      j.inBytes += ev.inSize;
      j.outBytes += ev.outSize;
    }
    if (ev.replaced) {
      // 原图已被替换：列表里的条目跟着指向新文件
      f.path = ev.outPath;
      f.name = basename(ev.outPath);
      f.size = ev.outSize;
      f.width = ev.width;
      f.height = ev.height;
      queueThumb(f);
    }
  } else if (ev.status === 'error') {
    f.status = 'error';
    f.error = ev.error;
    if (j) j.failed++;
  } else if (ev.status === 'skipped') {
    f.status = 'skipped';
    f.error = ev.reason;
    if (j) j.skipped++;
  }
  updateCard(f);
  updateActionBar();
}

// ---------------------------------------------------------------- 对比视图

const compare = { file: null, x: 50 };

function imgUrl(p, bust) {
  return `qingtu://img/?p=${encodeURIComponent(p)}&v=${bust || 0}`;
}

function openCompare(f) {
  if (!f.result || f.result.replaced) return;
  const r = f.result;
  compare.file = f;
  const sameAspect = f.width && Math.abs(f.width / f.height - r.width / r.height) < 0.01;
  $('#cmpName').textContent = f.name;
  $('#cmpIn').textContent = formatBytes(r.inSize);
  $('#cmpInDim').textContent = f.width ? `${f.width}×${f.height}` : '';
  $('#cmpOut').textContent = formatBytes(r.outSize);
  $('#cmpOutDim').textContent = `${r.width}×${r.height}`;
  $('#cmpScore').textContent = r.kept ? '原图已最优' : r.lossless ? '无损' : Number.isFinite(r.score) ? `画质 ${Math.round(r.score)} · ${scoreWord(r.score)}` : '';
  const foot = [
    `编码器 <b>${ENCODER_LABEL[r.encoder] || r.encoder || '—'}</b>`,
    r.quality ? `参数 quality <b>${r.quality}</b>` : '',
    Number.isFinite(r.score) ? 'SSIMULACRA 2 评分：90+ 肉眼无差，70–90 轻微，50 以下明显' : '',
    r.hdrDropped ? '这张 HDR 照片的增益图没能保留' : '',
  ].filter(Boolean);
  $('#cmpFoot').innerHTML = foot.join('　·　');

  const bust = Date.now();
  show('#cmpSlider', sameAspect);
  show('#cmpSide', !sameAspect);
  if (sameAspect) {
    $('#cmpBefore').src = imgUrl(f.path, bust);
    $('#cmpAfter').src = imgUrl(r.outPath, bust);
    compare.x = 50;
    $('#cmpSlider').style.setProperty('--x', '50%');
  } else {
    $('#cmpSideBefore').src = imgUrl(f.path, bust);
    $('#cmpSideAfter').src = imgUrl(r.outPath, bust);
  }
  $('#compareModal').hidden = false;
  requestAnimationFrame(layoutCompare);
}

function layoutCompare() {
  const f = compare.file;
  if (!f || $('#compareModal').hidden || $('#cmpSlider').hidden) return;
  const stage = $('#cmpStage');
  const maxW = stage.clientWidth - 36;
  const maxH = stage.clientHeight - 36;
  const ratio = f.result.width / f.result.height;
  let w = Math.min(maxW, f.result.width * 4);
  let h = w / ratio;
  if (h > maxH) {
    h = maxH;
    w = h * ratio;
  }
  const slider = $('#cmpSlider');
  slider.style.width = `${Math.round(w)}px`;
  slider.style.height = `${Math.round(h)}px`;
}

function closeCompare() {
  $('#compareModal').hidden = true;
  compare.file = null;
  ['#cmpBefore', '#cmpAfter', '#cmpSideBefore', '#cmpSideAfter'].forEach(sel => $(sel).removeAttribute('src'));
}

function bindCompare() {
  const slider = $('#cmpSlider');
  const move = e => {
    const rect = slider.getBoundingClientRect();
    compare.x = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
    slider.style.setProperty('--x', `${compare.x}%`);
  };
  slider.addEventListener('pointerdown', e => {
    slider.setPointerCapture(e.pointerId);
    move(e);
  });
  slider.addEventListener('pointermove', e => {
    if (slider.hasPointerCapture(e.pointerId)) move(e);
  });
  $('#compareModal').addEventListener('click', e => {
    if (e.target.closest('[data-close]')) closeCompare();
  });
  window.addEventListener('resize', layoutCompare);
}

// ---------------------------------------------------------------- 拖放与快捷键

function bindDragDrop() {
  let depth = 0;
  const overlay = $('#dropOverlay');
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => {
    if (!hasFiles(e) || state.running) return;
    e.preventDefault();
    depth++;
    overlay.classList.add('show');
  });
  window.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = state.running ? 'none' : 'copy';
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.classList.remove('show');
  });
  window.addEventListener('drop', async e => {
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('show');
    if (state.running) return;
    const paths = [...e.dataTransfer.files].map(file => api.pathForFile(file)).filter(Boolean);
    if (paths.length) addEntries(await api.expandPaths(paths, scanOptions()));
  });
}

function bindKeys() {
  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if (!$('#compareModal').hidden) closeCompare();
      togglePresetMenu(false);
    }
    if (mod && e.key.toLowerCase() === 'o' && !state.running) {
      e.preventDefault();
      addFiles();
    }
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      start();
    }
  });
}

// ---------------------------------------------------------------- 启动

async function init() {
  api.onProgress(onProgress);
  api.onExternalFiles(entries => !state.running && addEntries(entries));

  const [saved, info] = await Promise.all([api.loadState().catch(() => null), api.appInfo()]);
  state.platform = info.platform;
  document.documentElement.classList.add(`platform-${info.platform}`);
  $('#versionLabel').textContent = `轻图 v${info.version} · 编码器：Jpegli · libjxl · libaom · libwebp`;
  if (saved) {
    state.settings = merge(DEFAULT_SETTINGS, saved.settings);
    state.presets = Array.isArray(saved.presets) ? saved.presets : [];
    state.theme = THEMES.includes(saved.theme) ? saved.theme : 'system';
  }

  hydrateIcons();
  bindSettings();
  bindPresets();
  bindCompare();
  bindDragDrop();
  bindKeys();

  $('#themeBtn').addEventListener('click', () => {
    state.theme = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length];
    applyTheme();
    saveState();
  });
  $('#addFilesBtn').addEventListener('click', addFiles);
  $('#addFolderBtn').addEventListener('click', addFolder);
  $('#emptyAddFiles').addEventListener('click', addFiles);
  $('#emptyAddFolder').addEventListener('click', addFolder);
  $('#clearBtn').addEventListener('click', clearFiles);
  $('#startBtn').addEventListener('click', start);
  $('#openOutBtn').addEventListener('click', () => {
    const dir = state.lastSummary && state.lastSummary.outDirs[0];
    if (dir) api.openPath(dir);
  });
  $('#grid').addEventListener('click', e => {
    const tool = e.target.closest('[data-act]');
    const card = e.target.closest('.card');
    if (!card) return;
    const f = byId.get(Number(card.dataset.id));
    if (!f) return;
    if (!tool) {
      if (f.status === 'done') openCompare(f);
      return;
    }
    if (tool.dataset.act === 'remove') removeFile(f.id);
    if (tool.dataset.act === 'compare') openCompare(f);
    if (tool.dataset.act === 'reveal' && f.result) api.reveal(f.result.outPath);
  });

  applyTheme();
  syncSettingsUI();
  refreshList();
}

init();
