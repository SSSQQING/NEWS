'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const sharp = require('sharp');
const { compressImage, planResize, resolveOutputFormat, outputExtFor } = require('../src/core/processor');
const { tmpDir, photo, writePhoto } = require('./helpers');

const dir = tmpDir();

test('不限体积时按给定画质编码', async () => {
  const src = await writePhoto(path.join(dir, 'a.jpg'), 1200, 900);
  const r = await compressImage(src, { format: 'webp', quality: 70 });
  const meta = await sharp(r.data).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(r.ext, '.webp');
  assert.equal(r.quality, 70);
  assert.deepEqual([r.width, r.height], [1200, 900]);
});

test('限制体积时降画质压到目标以内，尺寸不动', async () => {
  const src = await writePhoto(path.join(dir, 'big.jpg'), 2400, 1800);
  const r = await compressImage(src, { format: 'jpeg', quality: 92, maxBytes: 400 * 1024 });
  assert.ok(r.ok);
  assert.ok(r.data.length <= 400 * 1024, `${r.data.length}`);
  assert.deepEqual([r.width, r.height], [2400, 1800]);
  assert.ok(r.quality < 92);
});

test('画质压到底还超标时自动缩小尺寸', async () => {
  const src = await writePhoto(path.join(dir, 'tiny-target.jpg'), 2400, 1800);
  const r = await compressImage(src, { format: 'jpeg', quality: 85, maxBytes: 30 * 1024 });
  assert.ok(r.ok);
  assert.ok(r.data.length <= 30 * 1024);
  assert.ok(r.width < 2400);
  assert.ok(Math.abs(r.width / r.height - 4 / 3) < 0.01);
});

test('精确尺寸模式只降画质，绝不改尺寸', async () => {
  const src = await writePhoto(path.join(dir, 'exact.jpg'), 2000, 1500);
  const r = await compressImage(src, { format: 'jpeg', quality: 90, maxBytes: 2 * 1024, resize: { mode: 'cover', width: 800, height: 800 } });
  assert.deepEqual([r.width, r.height], [800, 800]);
  assert.equal(r.ok, false);
  assert.equal(r.quality, 5);
});

test('裁切填满输出精确尺寸', async () => {
  const src = await writePhoto(path.join(dir, 'cover.jpg'), 1600, 900);
  for (const anchor of ['attention', 'north', 'centre']) {
    const r = await compressImage(src, { format: 'jpeg', quality: 80, resize: { mode: 'cover', width: 600, height: 800, anchor } });
    const meta = await sharp(r.data).metadata();
    assert.deepEqual([meta.width, meta.height], [600, 800]);
  }
});

test('留白适应：透明背景只在支持透明的格式生效', async () => {
  const src = await writePhoto(path.join(dir, 'contain.jpg'), 1600, 900);
  const png = await compressImage(src, { format: 'png', quality: 100, resize: { mode: 'contain', width: 500, height: 500, transparent: true } });
  const pngMeta = await sharp(png.data).metadata();
  assert.equal(pngMeta.hasAlpha, true);
  const corner = await sharp(png.data).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
  assert.equal(corner[3], 0);

  const jpg = await compressImage(src, { format: 'jpeg', quality: 90, resize: { mode: 'contain', width: 500, height: 500, transparent: true, bg: '#ff0000' } });
  const px = await sharp(jpg.data).extract({ left: 250, top: 2, width: 1, height: 1 }).raw().toBuffer();
  assert.ok(px[0] > 230 && px[1] < 30 && px[2] < 30, `${[...px]}`);
});

test('限制最大尺寸：等比缩小，小图不放大', async () => {
  const big = await writePhoto(path.join(dir, 'inside.jpg'), 3000, 2000);
  const r = await compressImage(big, { format: 'jpeg', resize: { mode: 'inside', width: 1500, height: 1500 } });
  assert.deepEqual([r.width, r.height], [1500, 1000]);

  const onlyHeight = await compressImage(big, { format: 'jpeg', resize: { mode: 'inside', height: 500 } });
  assert.deepEqual([onlyHeight.width, onlyHeight.height], [750, 500]);

  const small = await writePhoto(path.join(dir, 'small.jpg'), 400, 300);
  const s = await compressImage(small, { format: 'jpeg', resize: { mode: 'inside', width: 1500, height: 1500, noEnlarge: true } });
  assert.deepEqual([s.width, s.height], [400, 300]);
});

test('AVIF 草稿二分后正式出图仍满足体积', async () => {
  const src = await writePhoto(path.join(dir, 'av.jpg'), 1000, 750);
  const r = await compressImage(src, { format: 'avif', quality: 80, maxBytes: 40 * 1024 });
  assert.ok(r.ok);
  assert.ok(r.data.length <= 40 * 1024);
  assert.equal((await sharp(r.data).metadata()).format, 'heif');
});

test('按百分比缩放', async () => {
  const src = await writePhoto(path.join(dir, 'pct.jpg'), 1000, 600);
  const r = await compressImage(src, { format: 'jpeg', resize: { mode: 'percent', percent: 25 } });
  assert.deepEqual([r.width, r.height], [250, 150]);
});

test('透明 PNG 转 JPG 用背景色铺底', async () => {
  const src = path.join(dir, 'alpha.png');
  await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(src);
  const r = await compressImage(src, { format: 'jpeg', quality: 90, resize: { bg: '#00ff00' } });
  const px = await sharp(r.data).raw().toBuffer();
  assert.ok(px[0] < 20 && px[1] > 235 && px[2] < 20, `${[...px.slice(0, 3)]}`);
});

test('PNG 低于 100 画质走调色板压缩，能压到目标体积', async () => {
  const src = await writePhoto(path.join(dir, 'p.png'), 900, 900);
  const lossless = await compressImage(src, { format: 'png', quality: 100, keepSmaller: false });
  const r = await compressImage(src, { format: 'png', quality: 100, maxBytes: Math.floor(lossless.data.length * 0.4) });
  assert.ok(r.ok);
  assert.ok(r.quality < 100);
  assert.equal((await sharp(r.data).metadata()).isPalette, true);
});

test('重新编码反而变大时保留原图', async () => {
  const src = await writePhoto(path.join(dir, 'already.jpg'), 800, 600, { quality: 40 });
  const r = await compressImage(src, { format: 'original', quality: 98 });
  assert.equal(r.kept, true);
  const r2 = await compressImage(src, { format: 'original', quality: 98, keepSmaller: false });
  assert.equal(r2.kept, false);
  assert.ok(r2.data.length > r.data.length);
});

test('按 EXIF 方向自动摆正，并默认去掉元数据', async () => {
  const src = await writePhoto(path.join(dir, 'rotated.jpg'), 400, 300, { orientation: 6 });
  const r = await compressImage(src, { format: 'jpeg', quality: 80, keepSmaller: false });
  const meta = await sharp(r.data).metadata();
  assert.deepEqual([meta.width, meta.height], [300, 400]);
  assert.equal(meta.exif, undefined);
  assert.equal(meta.orientation, undefined);

  const kept = await compressImage(src, { format: 'jpeg', quality: 80, keepMetadata: true, keepSmaller: false });
  assert.ok((await sharp(kept.data).metadata()).exif);
});

test('CMYK 与 16 位 PNG 输入都能正确转成 sRGB', async () => {
  const cmyk = path.join(dir, 'cmyk.jpg');
  await photo(300, 200).toColourspace('cmyk').jpeg().toFile(cmyk);
  assert.equal((await sharp(cmyk).metadata()).space, 'cmyk');
  const r = await compressImage(cmyk, { format: 'jpeg', quality: 80, maxBytes: 50 * 1024 });
  assert.equal((await sharp(r.data).metadata()).space, 'srgb');

  const deep = path.join(dir, 'deep.png');
  await photo(300, 200).toColourspace('rgb16').png().toFile(deep);
  const r16 = await compressImage(deep, { format: 'webp', quality: 80, maxBytes: 40 * 1024 });
  assert.equal((await sharp(r16.data).metadata()).format, 'webp');
});

test('动图 GIF 保持动画', async () => {
  const src = path.join(dir, 'anim.gif');
  const frames = await Promise.all(['#ff0000', '#00ff00', '#0000ff'].map(c => sharp({ create: { width: 120, height: 80, channels: 3, background: c } }).raw().toBuffer()));
  await sharp(Buffer.concat(frames), { raw: { width: 120, height: 240, channels: 3, pageHeight: 80 } }).gif({ delay: [100, 100, 100] }).toFile(src);
  const r = await compressImage(src, { format: 'original', quality: 80, keepSmaller: false, resize: { mode: 'inside', width: 60 } });
  const meta = await sharp(r.data).metadata();
  assert.equal(meta.pages, 3);
  assert.deepEqual([r.width, r.height], [60, 40]);
});

test('格式与扩展名映射', () => {
  assert.equal(resolveOutputFormat('original', '.JPEG'), 'jpeg');
  assert.equal(resolveOutputFormat('original', '.tif'), 'jpeg');
  assert.equal(resolveOutputFormat('original', '.svg'), 'png');
  assert.equal(resolveOutputFormat('webp', '.png'), 'webp');
  assert.equal(outputExtFor('jpeg', '.JPG'), '.JPG');
  assert.equal(outputExtFor('jpeg', '.png'), '.jpg');
  assert.equal(planResize({ w: 100, h: 100 }, { mode: 'none' }), null);
  assert.equal(planResize({ w: 100, h: 100 }, { mode: 'cover', width: 0, height: 50 }), null);
});
