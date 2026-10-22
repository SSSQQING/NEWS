'use strict';

// 线性图标（24×24，描边风格），用 <i data-icon="name"></i> 占位
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="9.5" r="1.7"/><path d="m21 15.5-4.6-4.6L6 20"/>',
  images: '<rect x="7" y="3" width="14" height="13" rx="2.2"/><path d="M3.5 8v10.5A2.5 2.5 0 0 0 6 21h10.5"/><path d="m21 12.5-3.5-3.5-6.5 7"/><circle cx="12" cy="7.8" r="1.3"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v7.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  folderPlus: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v7.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M12 10.5v6M9 13.5h6"/>',
  folderOpen: '<path d="M4 19.5 6.4 12A2 2 0 0 1 8.3 10.6H20a1.3 1.3 0 0 1 1.2 1.7l-2 6.2A1.8 1.8 0 0 1 17.5 20H5.4A2.4 2.4 0 0 1 3 17.6V6.5A2.5 2.5 0 0 1 5.5 4h3l2 2.4h6A2.5 2.5 0 0 1 19 8.9v1.7"/>',
  trash: '<path d="M4 7h16M9.5 7V4.8c0-.4.4-.8.8-.8h3.4c.4 0 .8.4.8.8V7M6.5 7l.8 12.2c.1 1 .9 1.8 1.9 1.8h5.6c1 0 1.8-.8 1.9-1.8L17.5 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
  compare: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M12 2v20"/><path d="m8 10-2 2 2 2M16 10l2 2-2 2"/>',
  play: '<path d="M7.5 5.3v13.4c0 .8.9 1.3 1.6.9l10.5-6.7c.6-.4.6-1.3 0-1.7L9.1 4.4c-.7-.4-1.6.1-1.6.9z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  minimize: '<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  export: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M4 17v1.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V17"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  bookmark: '<path d="M6.5 3h11A1.5 1.5 0 0 1 19 4.5V21l-7-4.5L5 21V4.5A1.5 1.5 0 0 1 6.5 3z"/>',
  bookmarkPlus: '<path d="M6.5 3h11A1.5 1.5 0 0 1 19 4.5V21l-7-4.5L5 21V4.5A1.5 1.5 0 0 1 6.5 3z"/><path d="M12 7.5v5M9.5 10h5"/>',
  swap: '<path d="M7 4 3 8l4 4M3 8h13M17 20l4-4-4-4M21 16H8"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4.5M12 8h.01"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3.5"/>',
  sparkles: '<path d="M12 3.5 13.7 8l4.5 1.7-4.5 1.7L12 16l-1.7-4.6L5.8 9.7 10.3 8z"/><path d="M18.5 15.5 19.3 17.7 21.5 18.5 19.3 19.3 18.5 21.5 17.7 19.3 15.5 18.5 17.7 17.7z"/>',
  modeNone: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 16 5-5 4 4 3-3 5 5"/>',
  modeCover: '<rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M2.5 9V6.5a1 1 0 0 1 1-1M2.5 15v2.5a1 1 0 0 0 1 1M21.5 9V6.5a1 1 0 0 0-1-1M21.5 15v2.5a1 1 0 0 1-1 1" stroke-dasharray="2 2.2"/>',
  modeContain: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="4" y="8.5" width="16" height="7" fill="currentColor" fill-opacity=".22" stroke="none"/>',
  modeInside: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  modeFill: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 12h10M9 10l-2 2 2 2M15 10l2 2-2 2"/>',
  modePercent: '<path d="M18.5 5.5 5.5 18.5"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
};

function icon(name, size = 18) {
  const body = ICONS[name] || '';
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-icon]').forEach(el => {
    el.outerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 18);
  });
}
