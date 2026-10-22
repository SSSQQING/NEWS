'use strict';

const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const codecs = require('./codecs');
const { TARGETS, createScorer } = require('./quality');
const { stripJpegMetadata } = require('./jpegmeta');

// sharp 默认会缓存打开的文件，Windows 下会锁住源图导致覆盖/删除失败
sharp.cache(false);

const EXT_FORMAT = {
  '.jpg': 'jpeg', '.jpeg': 'jpeg', '.jpe': 'jpeg', '.jfif': 'jpeg',
  '.png': 'png',
  '.webp': 'webp',
  '.avif': 'avif',
  '.jxl': 'jxl',
  '.gif': 'gif',
  '.tif': 'tiff', '.tiff': 'tiff',
  '.svg': 'svg',
};
const INPUT_EXTS = new Set(Object.keys(EXT_FORMAT));
const OUTPUT_EXT = { jpeg: '.jpg', png: '.png', webp: '.webp', avif: '.avif', jxl: '.jxl', gif: '.gif' };
// 这几种模式输出尺寸是用户钉死的，压体积时不能偷偷缩图
const EXACT_MODES = new Set(['cover', 'contain', 'fill']);
const GRAVITY = new Set(['centre', 'north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']);
const SHRINK_QUALITY_FLOOR = 40;
const HARD_QUALITY_FLOOR = 5;
const SMART_QUALITY_FLOOR = 20;
// AVIF 编码很慢：搜索时先用低 effort 打草稿，定下画质后再用正式 effort 出图
const DRAFT_FORMATS = new Set(['avif']);
// 智能画质二分的起点：8 张实拍照片上达到各档目标分所需 quality 的中位数（scripts/bench-codecs.js，见 docs/benchmark.md）
const SMART_START = {
  jpeg: { lossless: 96, high: 87, balanced: 73, small: 47 },
  webp: { lossless: 96, high: 85, balanced: 77, small: 50 },
  avif: { lossless: 89, high: 67, balanced: 57, small: 46 },
  jxl: { lossless: 94, high: 84, balanced: 73, small: 56 },
  png: { lossless: 100, high: 96, balanced: 88, small: 75 },
  gif: { lossless: 100, high: 90, balanced: 80, small: 65 },
};
// JPEG 在 quality 90 以下用 4:2:0 色度抽样更省；90 及以上切 4:4:4，否则有的照片怎么调都到不了“视觉无损”
const JPEG_FULL_CHROMA_FROM = 90;

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

// sharp 读不了 JPEG XL，先用 libjxl 解成像素再交给 sharp
async function openSource(input) {
  const base = { failOn: 'none', limitInputPixels: false };
  if (path.extname(input).toLowerCase() !== '.jxl') {
    const meta = await sharp(input, base).metadata();
    return { meta, open: (extra = {}) => sharp(input, { ...base, ...extra }) };
  }
  await codecs.ready();
  const img = codecs.jxlDecode(await fs.readFile(input), 4);
  let opaque = true;
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const raw = { width: img.width, height: img.height, channels: 4 };
  const meta = { format: 'jxl', width: img.width, height: img.height, channels: opaque ? 3 : 4, hasAlpha: !opaque, space: 'srgb', pages: 1 };
  return { meta, open: () => (opaque ? sharp(img.data, { raw }).removeAlpha() : sharp(img.data, { raw })) };
}

function createPipeline(ctx, scale, { withMeta = false } = {}) {
  const { opts, outFormat, animated } = ctx;
  const resize = opts.resize || {};
  let img = ctx.source.open({ animated }).autoOrient();

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
  if (outFormat === 'jpeg' && ctx.meta.hasAlpha) img = img.flatten({ background: solidBackground(resize) });
  if (withMeta && opts.keepMetadata) img = img.keepMetadata();
  if (withMeta && ctx.hdr) img = img.keepGainMap();
  return img;
}

// sharp 内置编码器（mozjpeg / libspng+libimagequant / libwebp / libaom）
function sharpEncode(img, format, q, draft) {
  switch (format) {
    case 'jpeg':
      return img.jpeg({ quality: q, mozjpeg: true, chromaSubsampling: q < JPEG_FULL_CHROMA_FROM ? '4:2:0' : '4:4:4' });
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

function encoderName(format, viaSharp) {
  if (format === 'jpeg') return viaSharp ? 'mozjpeg' : 'jpegli';
  return { png: 'libimagequant', webp: 'libwebp', avif: 'libaom', jxl: 'libjxl', gif: 'cgif' }[format];
}

async function decodeForScore(format, buf, channels) {
  if (format === 'jxl') return codecs.jxlDecode(buf, channels === 2 || channels === 4 ? 4 : 3);
  const { data, info } = await sharp(buf).raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/**
 * 解码 + 缩放只做一次，得到参考像素；之后搜画质只重复“编码 →（解码 → 打分）”。
 * 保留元数据 / HDR 增益图 / 动图时必须从源文件走 sharp 全流程，参考像素只用来打分。
 */
async function prepare(ctx, scale) {
  const { outFormat } = ctx;
  const viaSharp = outFormat !== 'jxl' && (ctx.animated || ctx.opts.keepMetadata || ctx.hdr);
  const encoder = encoderName(outFormat, viaSharp);

  if (ctx.animated) {
    return {
      encoder,
      score: null,
      encode: async q => {
        const { data, info } = await sharpEncode(createPipeline(ctx, scale, { withMeta: true }), outFormat, q).toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.pageHeight || info.height };
      },
    };
  }

  const grey = ctx.meta.space === 'b-w' || ctx.meta.space === 'grey16';
  const { data, info } = await createPipeline(ctx, scale)
    .toColourspace(grey ? 'b-w' : 'srgb')
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  const ref = { data, width: info.width, height: info.height, channels: info.channels };
  const raw = { raw: { width: ref.width, height: ref.height, channels: ref.channels } };
  const scorer = createScorer(ref);

  let encode;
  if (outFormat === 'jxl') {
    encode = async q => ({ data: codecs.jxlEncode(ref.data, ref.width, ref.height, ref.channels, { quality: q }), width: ref.width, height: ref.height });
  } else if (outFormat === 'jpeg' && !viaSharp) {
    encode = async q => ({
      data: codecs.jpegliEncode(ref.data, ref.width, ref.height, ref.channels, q, { subsample: q < JPEG_FULL_CHROMA_FROM }),
      width: ref.width,
      height: ref.height,
    });
  } else {
    const source = viaSharp ? () => createPipeline(ctx, scale, { withMeta: true }) : () => sharp(data, raw);
    encode = async (q, draft) => {
      const out = await sharpEncode(source(), outFormat, q, draft).toBuffer({ resolveWithObject: true });
      return { data: out.data, width: out.info.width, height: out.info.height };
    };
  }

  return {
    encoder,
    encode,
    score: async buf => scorer(await decodeForScore(outFormat, buf, ref.channels)),
  };
}

// 在 [qMin, qMax] 里找满足体积上限的最高画质
async function searchForSize(encode, maxBytes, qMax, qMin, draft = false) {
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

// 找“刚好达到目标感知画质”的最低 quality —— 同画质下体积最小
async function searchForScore(prep, target, start, draft) {
  const seen = new Map();
  const tryQ = async q => {
    if (!seen.has(q)) {
      const r = await prep.encode(q, draft);
      seen.set(q, { ...r, quality: q, score: await prep.score(r.data) });
    }
    return seen.get(q);
  };
  let lo = SMART_QUALITY_FLOOR;
  let hi = 100;
  const first = await tryQ(clamp(start, lo, hi));
  if (first.score >= target) hi = first.quality;
  else lo = first.quality + 1;
  while (hi - lo > 2) {
    const mid = (lo + hi) >> 1;
    const r = await tryQ(mid);
    if (r.score >= target) hi = mid;
    else lo = mid + 1;
  }
  return tryQ(hi);
}

/**
 * opts: {
 *   format: 'original'|'jpeg'|'png'|'webp'|'avif'|'jxl',
 *   qualityMode: 'smart'（按感知画质自动找参数）| 'manual',
 *   target: 'lossless'|'high'|'balanced'|'small'（smart 模式）,
 *   quality: 1-100（manual 模式；限制体积时作为上限）,
 *   maxBytes: 体积上限（0 = 不限）,
 *   allowDownscale: 画质压到底还超标时允许缩小尺寸,
 *   keepMetadata, keepSmaller, keepHdr, jxlFromJpeg,
 *   resize: { mode, width, height, percent, anchor, noEnlarge, bg, transparent }
 * }
 */
async function compressImage(input, opts = {}) {
  await codecs.ready();
  const [source, stat] = await Promise.all([openSource(input), fs.stat(input)]);
  const { meta } = source;
  const inputExt = path.extname(input);
  const inputFormat = EXT_FORMAT[inputExt.toLowerCase()];
  const outFormat = resolveOutputFormat(opts.format, inputExt);
  const ctx = {
    source,
    meta,
    opts,
    outFormat,
    animated: (meta.pages || 1) > 1 && (outFormat === 'gif' || outFormat === 'webp'),
    hdr: opts.keepHdr !== false && !!meta.gainMap && inputFormat === 'jpeg' && outFormat === 'jpeg',
    srcSize: orientedSize(meta),
  };
  const smart = opts.qualityMode !== 'manual';
  const target = TARGETS[opts.target] || TARGETS.high;
  const qMax = clamp(Math.round(Number(opts.quality) || 85), 1, 100);
  const maxBytes = posInt(opts.maxBytes);
  const canShrink = maxBytes > 0 && opts.allowDownscale !== false && !EXACT_MODES.has(opts.resize && opts.resize.mode);
  const draft = DRAFT_FORMATS.has(outFormat);
  const base = { format: outFormat, ext: outputExtFor(outFormat, inputExt), inputSize: stat.size, kept: false, lossless: false };

  // JPG → JXL：不改尺寸时优先无损转码，像素一个不变还能还原回原 JPG
  const untouched = !planResize(ctx.srcSize, opts.resize, 1) && (meta.orientation || 1) === 1;
  if (outFormat === 'jxl' && inputFormat === 'jpeg' && opts.jxlFromJpeg !== false && untouched) {
    let jpeg = await fs.readFile(input);
    if (!opts.keepMetadata) jpeg = stripJpegMetadata(jpeg) || jpeg;
    try {
      const data = codecs.jxlFromJpeg(jpeg);
      if (!maxBytes || data.length <= maxBytes) {
        return { ...base, data, width: ctx.srcSize.w, height: ctx.srcSize.h, quality: null, score: 100, ok: true, lossless: true, encoder: 'libjxl', scale: 1 };
      }
    } catch {
      // 少数 JPEG（比如算术编码）不支持转码，退回普通有损编码
    }
  }

  // HDR 增益图保留是 sharp 的实验功能，不支持的组合直接退回普通 JPEG，别让整张图失败
  let hdrDropped = false;
  if (ctx.hdr) {
    try {
      await sharpEncode(createPipeline(ctx, 1, { withMeta: true }), 'jpeg', 80).toBuffer();
    } catch {
      ctx.hdr = false;
      hdrDropped = true;
    }
  }

  let prep = await prepare(ctx, 1);
  let result;
  let scale = 1;
  if (ctx.animated || !smart) {
    result = { ...(await prep.encode(ctx.animated && smart ? 80 : qMax)), quality: ctx.animated && smart ? 80 : qMax };
  } else {
    const start = (SMART_START[outFormat] || SMART_START.jpeg)[opts.target] || 80;
    result = await searchForScore(prep, target, start, draft);
  }

  if (maxBytes && result.data.length > maxBytes) {
    // 智能模式下 result.quality 已是达标的最低画质，体积还超标就只能继续往下找
    const qTop = result.quality;
    const qMin = Math.min(qTop, canShrink ? SHRINK_QUALITY_FLOOR : HARD_QUALITY_FLOOR);
    for (let round = 0; ; round++) {
      result = await searchForSize(prep.encode, maxBytes, qTop, qMin, draft);
      if (result.ok || !canShrink || round >= 10 || Math.min(result.width, result.height) <= 16) break;
      scale *= clamp(Math.sqrt(maxBytes / result.data.length) * 0.95, 0.3, 0.9);
      prep = await prepare(ctx, scale);
    }
    result.score = undefined;
  }

  if (draft) {
    const final = await prep.encode(result.quality, false);
    if (!maxBytes || final.data.length <= Math.max(maxBytes, result.data.length)) result = { ...result, ...final, score: undefined };
  }
  if (result.score === undefined) result.score = prep.score ? await prep.score(result.data) : null;
  if (result.score === undefined) result.score = null;

  let data = result.data;
  let kept = false;
  const sameShape = inputFormat === outFormat && result.width === ctx.srcSize.w && result.height === ctx.srcSize.h;
  if (opts.keepSmaller !== false && sameShape && data.length >= stat.size && !ctx.animated) {
    // 原图本身更小：直接用原图。要去元数据的 JPEG 无损删掉 EXIF 段，像素不动
    const original = await fs.readFile(input);
    const hasMeta = !!(meta.exif || meta.xmp || meta.iptc);
    if (opts.keepMetadata || !hasMeta) {
      data = original;
      kept = true;
    } else if (inputFormat === 'jpeg' && (meta.orientation || 1) === 1 && !meta.gainMap) {
      const stripped = stripJpegMetadata(original);
      if (stripped && stripped.length < data.length) {
        data = stripped;
        kept = true;
      }
    }
  }

  return {
    ...base,
    data,
    width: result.width,
    height: result.height,
    quality: result.quality,
    score: kept ? 100 : result.score,
    ok: maxBytes ? data.length <= maxBytes : true,
    kept,
    lossless: kept || (outFormat === 'png' && result.quality >= 100) || (outFormat === 'jxl' && result.quality >= 100),
    encoder: kept ? 'original' : prep.encoder,
    hdr: ctx.hdr && !kept,
    hdrDropped,
    scale,
  };
}

async function makeThumbnail(input, size = 360) {
  const { meta, open } = await openSource(input);
  const buf = await open()
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
    hdr: !!meta.gainMap,
  };
}

// 浏览器画不了的格式（TIFF、JPEG XL）给对比视图转一份 PNG
async function previewBuffer(input) {
  const { open } = await openSource(input);
  return open().autoOrient().png({ compressionLevel: 1 }).toBuffer();
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
  searchForSize,
  compressImage,
  makeThumbnail,
  previewBuffer,
};
