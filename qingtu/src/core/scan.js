'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { isSupportedImage } = require('./processor');

const caseInsensitive = process.platform !== 'linux';

// Windows / macOS 的文件系统默认不区分大小写，比较路径时统一一下
function pathKey(p) {
  const r = path.resolve(p);
  return caseInsensitive ? r.toLowerCase() : r;
}

const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true });

/**
 * 把用户拖进来/选中的文件和文件夹展开成图片列表。
 * 文件夹会递归扫描，baseDir 记下导入时的根目录，导出时用来还原子目录结构。
 */
async function expandPaths(inputs, { skipDirNames = [] } = {}) {
  const out = [];
  const seen = new Set();
  const skip = new Set(skipDirNames.filter(Boolean).map(s => String(s).toLowerCase()));

  const add = (file, baseDir, st) => {
    const k = pathKey(file);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ path: file, baseDir, size: st.size, mtime: st.mtimeMs });
  };

  async function walk(dir, root, depth) {
    if (depth > 32) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort(byName);
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name.toLowerCase())) await walk(full, root, depth + 1);
      } else if (e.isFile() && isSupportedImage(full)) {
        try {
          add(full, root, await fsp.stat(full));
        } catch {
          // 扫描途中被删掉的文件直接忽略
        }
      }
    }
  }

  for (const p of inputs) {
    let st;
    try {
      st = await fsp.stat(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) await walk(p, p, 0);
    else if (st.isFile() && isSupportedImage(p)) add(p, null, st);
  }
  return out;
}

module.exports = { expandPaths, pathKey };
