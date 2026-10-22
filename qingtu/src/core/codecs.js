'use strict';

// sharp 之外的两个新一代编码器（源码与构建脚本见 native/codecs）：
//   jpegli  Google 2024 年的 JPEG 编码器，输出标准 JPEG，同画质体积更小
//   libjxl  JPEG XL 官方实现：编码、解码、JPEG 无损转码
// 都编译成了 wasm，Windows / macOS / Linux 共用同一份文件。

const path = require('path');

const VENDOR = path.join(__dirname, '../vendor');

let jpegliModule = null;
let jxlModule = null;
let loading = null;

function ready() {
  if (!loading) {
    loading = Promise.all([
      require(path.join(VENDOR, 'jpegli.js'))(),
      require(path.join(VENDOR, 'jxl.js'))(),
    ]).then(([jpegli, jxl]) => {
      jpegliModule = jpegli;
      jxlModule = jxl;
    });
  }
  return loading;
}

function need(mod) {
  if (!mod) throw new Error('编码器还没初始化，先 await codecs.ready()');
  return mod;
}

// 把输入拷进 wasm 堆，跑完把结果拷出来并释放
function call(mod, input, run) {
  const ptr = mod._malloc(Math.max(1, input.length));
  try {
    mod.HEAPU8.set(input, ptr);
    const rc = run(ptr);
    if (rc !== 0) throw new Error(`编码器返回错误码 ${rc}`);
    const out = mod._qt_out();
    return Buffer.from(mod.HEAPU8.subarray(out, out + mod._qt_out_size()));
  } finally {
    mod._free(ptr);
  }
}

/** pixels：8 位，channels 1（灰度）或 3（RGB）；subsample 为 true 时色度 4:2:0 */
function jpegliEncode(pixels, width, height, channels, quality, { subsample = false } = {}) {
  const mod = need(jpegliModule);
  try {
    return call(mod, pixels, ptr => mod._jpegli_encode(ptr, width, height, channels, Math.round(quality), subsample ? 1 : 0));
  } finally {
    mod._qt_out_release();
  }
}

/** pixels：8 位，channels 1-4；quality 100 等同无损（libjxl 不接受有损模式下的零误差） */
function jxlEncode(pixels, width, height, channels, { quality = 90, effort = 7, lossless = false } = {}) {
  const mod = need(jxlModule);
  const exact = lossless || quality >= 100;
  try {
    return call(mod, pixels, ptr => mod._jxl_encode(ptr, width, height, channels, quality, effort, exact ? 1 : 0));
  } finally {
    mod._qt_out_release();
  }
}

/** JPEG → JPEG XL 无损转码，可还原出逐字节相同的原 JPEG */
function jxlFromJpeg(jpeg, effort = 7) {
  const mod = need(jxlModule);
  try {
    return call(mod, jpeg, ptr => mod._jxl_from_jpeg(ptr, jpeg.length, effort));
  } finally {
    mod._qt_out_release();
  }
}

/** 解码成 8 位像素，channels 3 或 4 */
function jxlDecode(data, channels = 3) {
  const mod = need(jxlModule);
  try {
    const pixels = call(mod, data, ptr => mod._jxl_decode(ptr, data.length, channels));
    return { data: pixels, width: mod._qt_out_width(), height: mod._qt_out_height(), channels };
  } finally {
    mod._qt_out_release();
  }
}

module.exports = { ready, jpegliEncode, jxlEncode, jxlFromJpeg, jxlDecode };
