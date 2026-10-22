'use strict';

// 同等感知画质下各编码器要多少字节：node scripts/bench-codecs.js 图片1.png 图片2.png ...
// 画质用 SSIMULACRA 2 打分；输出达到各目标分所需的 bpp（每像素比特数，越小越好）。
// 只测部分编码器：CODECS=jpegli,avif node scripts/bench-codecs.js ...

const sharp = require('sharp');
const codecs = require('../src/core/codecs');
const { ssimulacra2 } = require('../src/core/ssim2');

const QUALITIES = [15, 25, 35, 45, 55, 65, 72, 78, 84, 88, 92, 95, 98, 100];
const TARGETS = [65, 75, 82, 90];
const MAX_SIDE = 1600;

const decodeRgb = async buf => sharp(buf).removeAlpha().raw().toBuffer();

const ENCODERS = {
  'mozjpeg 4:2:0': (img, q) => sharp(img.data, { raw: img.raw }).jpeg({ quality: q, mozjpeg: true }).toBuffer(),
  'mozjpeg 4:4:4': (img, q) => sharp(img.data, { raw: img.raw }).jpeg({ quality: q, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer(),
  'jpegli 4:4:4': async (img, q) => codecs.jpegliEncode(img.data, img.w, img.h, 3, q, { subsample: false }),
  'jpegli 4:2:0': async (img, q) => codecs.jpegliEncode(img.data, img.w, img.h, 3, q, { subsample: true }),
  'webp e5': (img, q) => sharp(img.data, { raw: img.raw }).webp({ quality: q, effort: 5, smartSubsample: true }).toBuffer(),
  'avif e3': (img, q) => sharp(img.data, { raw: img.raw }).avif({ quality: q, effort: 3 }).toBuffer(),
  'jxl e7': async (img, q) => codecs.jxlEncode(img.data, img.w, img.h, 3, { quality: q, effort: 7 }),
};

async function decode(name, buf) {
  return name.startsWith('jxl') ? codecs.jxlDecode(buf, 3).data : decodeRgb(buf);
}

// 在 (bytes, score) 曲线上插值出达到目标分所需字节数
function bytesFor(curve, target) {
  const pts = [...curve].sort((a, b) => a.bytes - b.bytes);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a.score < target && b.score >= target) {
      const t = (target - a.score) / (b.score - a.score);
      return Math.exp(Math.log(a.bytes) + t * (Math.log(b.bytes) - Math.log(a.bytes)));
    }
  }
  return NaN;
}

// 达到目标分时对应的 quality 参数（给智能画质当二分起点）
function qualityFor(curve, target) {
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (a.score < target && b.score >= target) return a.q + ((target - a.score) / (b.score - a.score)) * (b.q - a.q);
  }
  return NaN;
}

const median = vals => {
  const v = [...vals].sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : NaN;
};

const geomean = vals => (vals.length ? Math.exp(vals.reduce((sum, v) => sum + Math.log(v), 0) / vals.length) : NaN);
const fmt = v => (Number.isFinite(v) ? v.toFixed(3).padStart(6) : '     -');

(async () => {
  await codecs.ready();
  const only = process.env.CODECS ? process.env.CODECS.split(',') : null;
  const names = Object.keys(ENCODERS).filter(n => !only || only.some(o => n.startsWith(o)));
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('用法：node scripts/bench-codecs.js 图片1.png 图片2.png ...');
    process.exit(1);
  }
  const bpp = {};
  const qs = {};
  for (const file of files) {
    let pipe = sharp(file).removeAlpha();
    const meta = await sharp(file).metadata();
    if (Math.max(meta.width, meta.height) > MAX_SIDE) pipe = pipe.resize(MAX_SIDE, MAX_SIDE, { fit: 'inside' });
    const { data, info } = await pipe.raw().toBuffer({ resolveWithObject: true });
    const img = { data, w: info.width, h: info.height, raw: { width: info.width, height: info.height, channels: 3 } };
    console.log(`\n# ${file.split('/').pop()} ${img.w}x${img.h}    bpp @ ${TARGETS.join(' / ')}`);
    for (const name of names) {
      const t0 = Date.now();
      const curve = [];
      for (const q of QUALITIES) {
        const buf = await ENCODERS[name](img, q);
        curve.push({ q, bytes: buf.length, score: ssimulacra2(data, await decode(name, buf), img.w, img.h) });
      }
      const row = TARGETS.map(t => (bytesFor(curve, t) * 8) / (img.w * img.h));
      qs[name] = qs[name] || TARGETS.map(() => []);
      TARGETS.forEach((t, i) => {
        const q = qualityFor(curve, t);
        if (Number.isFinite(q)) qs[name][i].push(q);
      });
      bpp[name] = bpp[name] || TARGETS.map(() => []);
      row.forEach((v, i) => Number.isFinite(v) && bpp[name][i].push(v));
      const best = Math.max(...curve.map(c => c.score));
      console.log(name.padEnd(14), row.map(fmt).join(' '), `  最高分 ${best.toFixed(1)}  (${Date.now() - t0} ms)`);
    }
  }
  console.log(`\n# 几何平均 bpp（括号里是能达到该分数的图片数 / ${files.length}）`);
  for (const name of names) {
    console.log(name.padEnd(14), bpp[name].map(v => `${fmt(geomean(v))}(${v.length})`).join(' '));
  }
  console.log('\n# 达到各目标分所需 quality 的中位数');
  for (const name of names) {
    console.log(name.padEnd(14), qs[name].map(v => (v.length ? median(v).toFixed(0).padStart(6) : '     -')).join(' '));
  }
})();
