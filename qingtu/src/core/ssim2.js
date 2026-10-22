'use strict';

// SSIMULACRA 2 感知画质评分（rust-av/ssimulacra2 编译成的 wasm，源码见 native/ssimulacra2-wasm）
// 分数参考：90+ 肉眼基本看不出差别，70–90 轻微，50–70 明显，50 以下翻车

const fs = require('fs');
const path = require('path');

let exportsCache = null;

function load() {
  if (exportsCache) return exportsCache;
  const mod = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, '../vendor/ssimulacra2.wasm')));
  // v_frame 在 wasm 目标下硬依赖 wasm-bindgen，这几个导入在打分路径上根本不会被调用
  const imports = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    imports[imp.module] = imports[imp.module] || {};
    imports[imp.module][imp.name] = () => {
      throw new Error(`ssimulacra2.wasm 调用了意外的导入 ${imp.module}.${imp.name}`);
    };
  }
  exportsCache = new WebAssembly.Instance(mod, imports).exports;
  return exportsCache;
}

/** ref / dist：8 位 sRGB，RGB 交错，长度 width * height * 3 */
function ssimulacra2(ref, dist, width, height) {
  const wasm = load();
  const n = width * height * 3;
  if (ref.length !== n || dist.length !== n) throw new Error('SSIMULACRA 2：两张图尺寸不一致');
  const a = wasm.s2_alloc(n);
  const b = wasm.s2_alloc(n);
  try {
    // 两次分配都完成后再取视图，避免内存扩容导致旧视图失效
    new Uint8Array(wasm.memory.buffer, a, n).set(ref);
    new Uint8Array(wasm.memory.buffer, b, n).set(dist);
    return wasm.s2_score(a, b, width, height);
  } finally {
    wasm.s2_free(a, n);
    wasm.s2_free(b, n);
  }
}

module.exports = { ssimulacra2 };
