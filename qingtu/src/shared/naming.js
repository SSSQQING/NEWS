// 文件命名规则：主进程（真正写文件）和界面（实时预览）共用这一份
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QingtuNaming = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_TEMPLATE = '{name}_compressed';

  const TOKENS = [
    { token: '{name}', label: '原文件名' },
    { token: '{n}', label: '序号' },
    { token: '{w}', label: '宽' },
    { token: '{h}', label: '高' },
    { token: '{date}', label: '日期' },
    { token: '{time}', label: '时间' },
    { token: '{folder}', label: '所在文件夹' },
    { token: '{fmt}', label: '格式' },
  ];

  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  function pad(value, digits) {
    return String(value).padStart(Math.max(1, Math.min(10, digits | 0)), '0');
  }

  function stamp(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    return {
      date: `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`,
      time: `${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}${pad(d.getSeconds(), 2)}`,
    };
  }

  function sanitizeFileName(name, fallback) {
    let s = String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/, '')
      .trim();
    if (s.length > 180) s = s.slice(0, 180);
    if (RESERVED.test(s)) s += '_';
    return s || (fallback === undefined ? 'image' : fallback);
  }

  function templateFor(naming) {
    const mode = naming && naming.mode;
    if (mode === 'default') return DEFAULT_TEMPLATE;
    if (mode === 'custom') return (naming.template || '').trim() || '{name}';
    return '{name}';
  }

  // ctx: { name, index(从 0 开始), width, height, date, folder, fmt }
  function renderName(naming, ctx) {
    const start = Number.isFinite(Number(naming && naming.start)) ? Number(naming.start) : 1;
    const digits = Number(naming && naming.digits) || 3;
    const { date, time } = stamp(ctx.date);
    const values = {
      name: ctx.name || 'image',
      n: pad(start + (ctx.index || 0), digits),
      w: ctx.width || 0,
      h: ctx.height || 0,
      date,
      time,
      folder: ctx.folder || '',
      fmt: ctx.fmt || '',
    };
    const out = templateFor(naming).replace(/\{(name|n|w|h|date|time|folder|fmt)\}/g, (_, k) => values[k]);
    return sanitizeFileName(out, values.name);
  }

  return { DEFAULT_TEMPLATE, TOKENS, renderName, sanitizeFileName, templateFor };
});
