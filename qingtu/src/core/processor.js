'use strict';

const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

// sharp 默认会缓存打开的文件，Windows 下会锁住源图导致覆盖/删除失败
sharp.cache(false);

const EXT_FORMAT = {
  '.jpg': 'jpeg', '.jpeg': 'jpeg', '.jpe': 'jpeg', '.jfif': 'jpeg',
  '.png': 'png',
  '.webp': 'webp',
  '.avif': 'avif',
  '.gif': 'gif',
  '.tif': 'tiff', '.tiff': 'tiff',
  '.svg': 'svg',
};
const INPUT_EXTS = new Set(Object.keys(EXT_FORMAT));
const OUTPUT_EXT = { jpeg: '.jpg', png: '.png', webp: '.webp', avif: '.avif', gif: '.gif' };
// 这几种模式输出尺寸是用户钉死的，压体积时不能偷偷缩图
const EXACT_MODES = new Set(['cover', 'contain', 'fill']);
const GRAVITY = new Set(['centre', 'north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']);
const SHRINK_QUALITY_FLOOR = 40;
// AVIF 编码很慢：二分时先用低 effort 打草稿，定下画质后再用正式 effort 出图
const DRAFT_FORMATS = new Set(['avif']);
const HARD_QUALITY_FLOOR = 5;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function posInt(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isSupportedImage(file) {
  return INPUT_EXTS.has(path.extname(file).toLowerCase());
}

function resolveOutputFormat(choice, inputExt) {
  if (choice && choice !== 'original' && OUTPUT_EXT[choice]) return choice;
  const f = EXT_FORMAT[String(inputExt).toLowerCase()];
  if (f === 'tiff') return 'jpeg';
  if (f === 'svg') return 'png';
  return f || 'jpeg';
}

// 格式没变就沿用原扩展名（含大小写），覆盖模式下才能落回同一个文件
function outputExtFor(outFormat, inputExt) {
  return EXT_FORMAT[String(inputExt).toLowerCase()] === outFormat ? inputExt : OUTPUT_EXT[outFormat];
}

function orientedSize(meta) {
  const w = meta.width;
  const h = meta.pageHeight || meta.height;
  return (meta.orientation || 1) >= 5 ? { w: h, h: w } : { w, h };
}

// 返回 null 表示不需要缩放
function planResize(src, resize = {}, scale = 1) {
  const W = posInt(resize.width);
  const H = posInt(resize.height);
  const mode = resize.mode || 'none';
  const dims = (w, h, fit = 'fill') => ({ width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)), fit });

  if (EXACT_MODES.has(mode) && W && H) return dims(W * scale, H * scale, mode);

  let k = 1;
  if (mode === 'inside' && (W || H)) {
    k = Math.min(W ? W / src.w : Infinity, H ? H / src.h : Infinity);
    if (resize.noEnlarge !== false) k = Math.min(k, 1);
  } else if (mode === 'percent') {
    k = clamp(Number(resize.percent) || 100, 1, 1000) / 100;
  }
  k *= scale;
  return k === 1 ? null : dims(src.w * k, src.h * k);
}

function solidBackground(resize = {}) {
  return /^#[0-9a-f]{6}$/i.test(resize.bg || '') ? resize.bg : '#ffffff';
}

function createPipeline(input, ctx, scale) {
  const { opts, outFormat, animated } = ctx;
  const resize = opts.resize || {};
  let img = sharp(input, { animated, failOn: 'none', limitInputPixels: false }).autoOrient();

  const plan = planResize(ctx.srcSize, resize, scale);
  if (plan) {
    let position = 'centre';
    if (plan.fit === 'cover') {
      if (resize.anchor === 'attention' || resize.anchor === 'entropy') position = animated ? 'centre' : resize.anchor;
      else if (GRAVITY.has(resize.anchor)) position = resize.anchor;
    }
    const background = resize.transparent && outFormat !== 'jpeg'
      ? { r: 0, g: 0, b: 0, alpha: 0 }
      : solidBackground(resize);
    img = img.resize({ width: plan.width, height: plan.height, fit: plan.fit, position, background });
  }
  if (outFormat === 'jpeg') img = img.flatten({ background: solidBackground(resize) });
  if (opts.keepMetadata) img = img.keepMetadata();
  return img;
}

function encodeWith(img, format, quality, draft = false) {
  const q = clamp(Math.round(quality), 1, 100);
  switch (format) {
    case 'jpeg':
      return img.jpeg({ quality: q, mozjpeg: true });
    case 'png':
      // 100 走无损；低于 100 用调色板量化，思路跟 TinyPNG 一样
      return q >= 100
        ? img.png({ compressionLevel: 9, adaptiveFiltering: true })
        : img.png({ palette: true, quality: q, effort: 3, compressionLevel: 9, dither: 1 });
    case 'webp':
      return img.webp({ quality: q, effort: 5, smartSubsample: true });
    case 'avif':
      return img.avif({ quality: q, effort: draft ? 1 : 3 });
    case 'gif':
      return img.gif({ colours: clamp(Math.round(256 * q / 100), 2, 256), effort: 7, dither: 1 });
    default:
      throw new Error(`不支持的输出格式：${format}`);
  }
}

async function makeEncoder(input, ctx, scale) {
  const encodeFrom = source => (q, draft) => encodeWith(source(), ctx.outFormat, q, draft).toBuffer({ resolveWithObject: true });
  if (ctx.animated || ctx.opts.keepMetadata) return encodeFrom(() => createPipeline(input, ctx, scale));

  // 解码 + 缩放只做一次，之后二分画质时只重复编码这一步
  const grey = ctx.meta.space === 'b-w' || ctx.meta.space === 'grey16';
  const { data, info } = await createPipeline(input, ctx, scale)
    .toColourspace(grey ? 'b-w' : 'srgb')
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  const raw = { width: info.width, height: info.height, channels: info.channels };
  return encodeFrom(() => sharp(data, { raw }));
}

// 在 [qMin, qMax] 里找满足体积上限的最高画质
async function searchQuality(encode, maxBytes, qMax, qMin, draft = false) {
  const top = await encode(qMax, draft);
  if (top.data.length <= maxBytes) return { ...top, quality: qMax, ok: true };
  if (qMin >= qMax) return { ...top, quality: qMax, ok: false };

  const floor = await encode(qMin, draft);
  if (floor.data.length > maxBytes) return { ...floor, quality: qMin, ok: false };

  let best = { ...floor, quality: qMin };
  let lo = qMin + 1;
  let hi = qMax - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = await encode(mid, draft);
    if (r.data.length <= maxBytes) {
      best = { ...r, quality: mid };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { ...best, ok: true };
}

/**
 * opts: {
 *   format: 'original'|'jpeg'|'png'|'webp'|'avif',
 *   quality: 1-100,
 *   maxBytes: 体积上限（0 = 不限）,
 *   allowDownscale: 画质压到底还超标时允许缩小尺寸,
 *   keepMetadata, keepSmaller,
 *   resize: { mode, width, height, percent, anchor, noEnlarge, bg, transparent }
 * }
 */
async function compressImage(input, opts = {}) {
  const [meta, stat] = await Promise.all([sharp(input, { failOn: 'none' }).metadata(), fs.stat(input)]);
  const inputExt = path.extname(input);
  const inputFormat = EXT_FORMAT[inputExt.toLowerCase()];
  const outFormat = resolveOutputFormat(opts.format, inputExt);
  const ctx = {
    meta,
    opts,
    outFormat,
    animated: (meta.pages || 1) > 1 && (outFormat === 'gif' || outFormat === 'webp'),
    srcSize: orientedSize(meta),
  };

  const qMax = clamp(Math.round(Number(opts.quality) || 80), 1, 100);
  const maxBytes = posInt(opts.maxBytes);
  const canShrink = maxBytes > 0 && opts.allowDownscale !== false && !EXACT_MODES.has(opts.resize && opts.resize.mode);

  let result;
  let scale = 1;
  if (!maxBytes) {
    const encode = await makeEncoder(input, ctx, 1);
    result = { ...(await encode(qMax)), quality: qMax };
  } else {
    const draft = DRAFT_FORMATS.has(outFormat);
    const qMin = Math.min(qMax, canShrink ? SHRINK_QUALITY_FLOOR : HARD_QUALITY_FLOOR);
    let encode;
    for (let round = 0; ; round++) {
      encode = await makeEncoder(input, ctx, scale);
      result = await searchQuality(encode, maxBytes, qMax, qMin, draft);
      const { width, height } = result.info;
      if (result.ok || !canShrink || round >= 10 || Math.min(width, height) <= 16) break;
      scale *= clamp(Math.sqrt(maxBytes / result.data.length) * 0.95, 0.3, 0.9);
    }
    if (draft) {
      const final = await encode(result.quality);
      if (final.data.length <= Math.max(maxBytes, result.data.length)) result = { ...final, quality: result.quality, ok: result.ok || final.data.length <= maxBytes };
    }
  }

  let data = result.data;
  const width = result.info.width;
  const height = result.info.pageHeight || result.info.height;
  const sameShape = inputFormat === outFormat && width === ctx.srcSize.w && height === ctx.srcSize.h;
  // 用户要求去元数据时，不能拿带 EXIF/GPS 的原图凑数
  const metaOk = opts.keepMetadata || !(meta.exif || meta.xmp || meta.iptc);
  let kept = false;
  if (opts.keepSmaller !== false && sameShape && metaOk && data.length >= stat.size) {
    data = await fs.readFile(input);
    kept = true;
  }

  return {
    data,
    width,
    height,
    format: outFormat,
    ext: outputExtFor(outFormat, inputExt),
    quality: result.quality,
    ok: maxBytes ? data.length <= maxBytes : true,
    kept,
    scale,
    inputSize: stat.size,
  };
}

async function makeThumbnail(input, size = 360) {
  const meta = await sharp(input, { failOn: 'none' }).metadata();
  const buf = await sharp(input, { failOn: 'none', limitInputPixels: false })
    .autoOrient()
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 72 })
    .toBuffer();
  const { w, h } = orientedSize(meta);
  return {
    thumb: `data:image/webp;base64,${buf.toString('base64')}`,
    width: w,
    height: h,
    format: meta.format,
    hasAlpha: !!meta.hasAlpha,
    animated: (meta.pages || 1) > 1,
  };
}

// 浏览器画不了的格式（如 TIFF）给对比视图转一份 PNG
function previewBuffer(input) {
  return sharp(input, { failOn: 'none', limitInputPixels: false }).autoOrient().png({ compressionLevel: 1 }).toBuffer();
}

module.exports = {
  EXT_FORMAT,
  INPUT_EXTS,
  OUTPUT_EXT,
  EXACT_MODES,
  isSupportedImage,
  resolveOutputFormat,
  outputExtFor,
  planResize,
  searchQuality,
  compressImage,
  makeThumbnail,
  previewBuffer,
};
