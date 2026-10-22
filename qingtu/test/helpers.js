'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qingtu-test-'));
}

// 模糊过的噪点图：体积和压缩难度都接近真实照片
function photo(width, height, { alpha = false } = {}) {
  return sharp({ create: { width, height, channels: alpha ? 4 : 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 60 } } })
    .blur(1.2);
}

async function writePhoto(file, width, height, opts = {}) {
  let img = photo(width, height, opts);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') img = img.png();
  else if (ext === '.webp') img = img.webp({ quality: 90 });
  else img = img.jpeg({ quality: opts.quality || 92 });
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation });
  await img.toFile(file);
  return file;
}

module.exports = { tmpDir, photo, writePhoto };
