'use strict';

// 感知画质评估：把参考图和压缩后的图都转成 RGB，按需抽样，再算 SSIMULACRA 2。

const { ssimulacra2 } = require('./ssim2');

// 智能画质的几档目标分（SSIMULACRA 2）
const TARGETS = { lossless: 90, high: 82, balanced: 75, small: 65 };

const TILE = 512;
const TILE_COUNT = 4;
// 像素数在这个范围内整图评分，超过了只评几个代表性区块，不然大图一轮要十几秒
const FULL_LIMIT = 1.2e6;

// 任意通道数 → RGB；带透明的按白底合成（和大多数看图场景一致）
function toRgb(data, width, height, channels) {
  if (channels === 3) return data;
  const n = width * height;
  const out = Buffer.allocUnsafe(n * 3);
  for (let i = 0; i < n; i++) {
    let r;
    let g;
    let b;
    let a = 255;
    if (channels === 1 || channels === 2) {
      r = g = b = data[i * channels];
      if (channels === 2) a = data[i * 2 + 1];
    } else {
      r = data[i * 4];
      g = data[i * 4 + 1];
      b = data[i * 4 + 2];
      a = data[i * 4 + 3];
    }
    if (a !== 255) {
      const k = a / 255;
      r = r * k + 255 * (1 - k);
      g = g * k + 255 * (1 - k);
      b = b * k + 255 * (1 - k);
    }
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  return out;
}

// 挑评分区块：细节最多的两块（压缩瑕疵最容易藏在这）、细节中等的一块、最平滑的一块（色带最容易出现在这）
function pickTiles(rgb, width, height) {
  if (width * height <= FULL_LIMIT) return null;
  const size = Math.min(TILE, width, height);
  if (size < 64) return null;
  const cols = Math.floor(width / size);
  const rows = Math.floor(height / size);
  if (cols * rows <= TILE_COUNT) return null;

  const tiles = [];
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const x0 = tx * size;
      const y0 = ty * size;
      let detail = 0;
      for (let y = y0; y < y0 + size - 4; y += 4) {
        for (let x = x0; x < x0 + size - 4; x += 4) {
          const i = (y * width + x) * 3;
          const right = i + 12;
          const down = i + width * 12;
          detail += Math.abs(rgb[i + 1] - rgb[right + 1]) + Math.abs(rgb[i + 1] - rgb[down + 1]);
        }
      }
      tiles.push({ x: x0, y: y0, detail });
    }
  }
  tiles.sort((a, b) => b.detail - a.detail);
  const picks = [tiles[0], tiles[1], tiles[Math.floor(tiles.length / 2)], tiles[tiles.length - 1]];
  return { size, tiles: picks };
}

// 把选中的区块竖着拼成一张图
function mosaic(rgb, width, region) {
  const { size, tiles } = region;
  const out = Buffer.allocUnsafe(size * size * tiles.length * 3);
  tiles.forEach((t, k) => {
    for (let y = 0; y < size; y++) {
      const src = ((t.y + y) * width + t.x) * 3;
      rgb.copy(out, ((k * size + y) * size) * 3, src, src + size * 3);
    }
  });
  return out;
}

/**
 * 预先处理参考图，返回 score(压缩后像素) 函数。
 * ref / dist：{ data, width, height, channels }
 */
function createScorer(ref) {
  const refRgb = toRgb(ref.data, ref.width, ref.height, ref.channels);
  const region = pickTiles(refRgb, ref.width, ref.height);
  const refEval = region ? mosaic(refRgb, ref.width, region) : refRgb;
  const evalW = region ? region.size : ref.width;
  const evalH = region ? region.size * region.tiles.length : ref.height;

  return dist => {
    if (dist.width !== ref.width || dist.height !== ref.height) throw new Error('评分时尺寸不一致');
    const rgb = toRgb(dist.data, dist.width, dist.height, dist.channels);
    const score = ssimulacra2(refEval, region ? mosaic(rgb, dist.width, region) : rgb, evalW, evalH);
    return Number.isFinite(score) ? score : 0;
  };
}

module.exports = { TARGETS, createScorer, toRgb, pickTiles };
