'use strict';

// 不重新编码，直接从 JPEG 字节流里删掉 EXIF / XMP / IPTC / 注释段：像素一个不动，隐私信息没了。
// 保留 JFIF（APP0）、ICC 色彩配置（APP2）和 Adobe 段（APP14，影响颜色解释）。

const KEEP_APP = new Set([0xe0, 0xe2, 0xee]);

function stripJpegMetadata(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    // 扫描开始之后就是压缩数据，原样拷贝
    if (marker === 0xda) {
      parts.push(buf.subarray(i));
      return Buffer.concat(parts);
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    const isApp = marker >= 0xe1 && marker <= 0xef;
    const drop = (isApp && !KEEP_APP.has(marker)) || marker === 0xfe;
    if (!drop) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

module.exports = { stripJpegMetadata };
