// libjxl 编解码的扁平导出函数，给 Node 侧（src/core/codecs.js）调用：
//   jxl_encode     有损 / 无损编码 8 位像素
//   jxl_from_jpeg  JPEG 无损转码为 JPEG XL（可逐字节还原回原 JPEG）
//   jxl_decode     解码成 8 位像素（对比画质、生成预览用）

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <vector>

#include <emscripten/emscripten.h>
#include <jxl/decode.h>
#include <jxl/encode.h>

namespace {

std::vector<uint8_t> g_out;
uint32_t g_width = 0;
uint32_t g_height = 0;

bool Drain(JxlEncoder* enc) {
  g_out.resize(64 * 1024);
  uint8_t* next = g_out.data();
  size_t avail = g_out.size();
  JxlEncoderStatus st;
  while ((st = JxlEncoderProcessOutput(enc, &next, &avail)) == JXL_ENC_NEED_MORE_OUTPUT) {
    size_t offset = next - g_out.data();
    g_out.resize(g_out.size() * 2);
    next = g_out.data() + offset;
    avail = g_out.size() - offset;
  }
  g_out.resize(next - g_out.data());
  return st == JXL_ENC_SUCCESS;
}

JxlEncoderFrameSettings* Settings(JxlEncoder* enc, int effort) {
  JxlEncoderFrameSettings* fs = JxlEncoderFrameSettingsCreate(enc, nullptr);
  JxlEncoderFrameSettingsSetOption(fs, JXL_ENC_FRAME_SETTING_EFFORT, effort);
  return fs;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE uint8_t* qt_out() { return g_out.data(); }
EMSCRIPTEN_KEEPALIVE uint32_t qt_out_size() { return static_cast<uint32_t>(g_out.size()); }
EMSCRIPTEN_KEEPALIVE uint32_t qt_out_width() { return g_width; }
EMSCRIPTEN_KEEPALIVE uint32_t qt_out_height() { return g_height; }

EMSCRIPTEN_KEEPALIVE void qt_out_release() {
  std::vector<uint8_t>().swap(g_out);
  g_width = g_height = 0;
}

// channels：1 灰度 / 2 灰度+透明 / 3 RGB / 4 RGBA；quality 1-100（lossless 时忽略）。成功返回 0。
EMSCRIPTEN_KEEPALIVE int jxl_encode(const uint8_t* pixels, int width, int height, int channels, float quality,
                                    int effort, int lossless) {
  qt_out_release();
  if (width <= 0 || height <= 0 || channels < 1 || channels > 4) return 2;
  const bool alpha = channels == 2 || channels == 4;
  const bool gray = channels < 3;

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize = width;
  info.ysize = height;
  info.bits_per_sample = 8;
  info.num_color_channels = gray ? 1 : 3;
  info.num_extra_channels = alpha ? 1 : 0;
  info.alpha_bits = alpha ? 8 : 0;
  info.uses_original_profile = lossless ? JXL_TRUE : JXL_FALSE;

  bool ok = JxlEncoderSetBasicInfo(enc, &info) == JXL_ENC_SUCCESS;
  if (ok && alpha) {
    JxlExtraChannelInfo eci;
    JxlEncoderInitExtraChannelInfo(JXL_CHANNEL_ALPHA, &eci);
    eci.bits_per_sample = 8;
    ok = JxlEncoderSetExtraChannelInfo(enc, 0, &eci) == JXL_ENC_SUCCESS;
  }
  JxlColorEncoding color;
  JxlColorEncodingSetToSRGB(&color, gray ? JXL_TRUE : JXL_FALSE);
  ok = ok && JxlEncoderSetColorEncoding(enc, &color) == JXL_ENC_SUCCESS;

  JxlEncoderFrameSettings* fs = Settings(enc, effort);
  if (lossless) {
    ok = ok && JxlEncoderSetFrameLossless(fs, JXL_TRUE) == JXL_ENC_SUCCESS;
    ok = ok && JxlEncoderSetFrameDistance(fs, 0.f) == JXL_ENC_SUCCESS;
  } else {
    ok = ok && JxlEncoderSetFrameDistance(fs, JxlEncoderDistanceFromQuality(quality)) == JXL_ENC_SUCCESS;
  }

  JxlPixelFormat format = {static_cast<uint32_t>(channels), JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
  const size_t bytes = static_cast<size_t>(width) * height * channels;
  ok = ok && JxlEncoderAddImageFrame(fs, &format, pixels, bytes) == JXL_ENC_SUCCESS;
  JxlEncoderCloseInput(enc);
  ok = ok && Drain(enc);
  JxlEncoderDestroy(enc);
  if (!ok) qt_out_release();
  return ok ? 0 : 1;
}

// JPEG 无损转码：保存重建 JPEG 所需的元数据，djxl 可还原出与原文件逐字节一致的 JPEG。
EMSCRIPTEN_KEEPALIVE int jxl_from_jpeg(const uint8_t* jpeg, uint32_t size, int effort) {
  qt_out_release();
  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  bool ok = JxlEncoderStoreJPEGMetadata(enc, JXL_TRUE) == JXL_ENC_SUCCESS;
  JxlEncoderFrameSettings* fs = Settings(enc, effort);
  ok = ok && JxlEncoderAddJPEGFrame(fs, jpeg, size) == JXL_ENC_SUCCESS;
  JxlEncoderCloseInput(enc);
  ok = ok && Drain(enc);
  JxlEncoderDestroy(enc);
  if (!ok) qt_out_release();
  return ok ? 0 : 1;
}

// 解码为 8 位像素，channels 为 3（RGB）或 4（RGBA）。成功返回 0。
EMSCRIPTEN_KEEPALIVE int jxl_decode(const uint8_t* data, uint32_t size, int channels) {
  qt_out_release();
  if (channels != 3 && channels != 4) return 2;
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE);
  JxlDecoderSetInput(dec, data, size);
  JxlDecoderCloseInput(dec);
  JxlPixelFormat format = {static_cast<uint32_t>(channels), JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};

  bool ok = false;
  for (;;) {
    JxlDecoderStatus st = JxlDecoderProcessInput(dec);
    if (st == JXL_DEC_BASIC_INFO) {
      JxlBasicInfo info;
      if (JxlDecoderGetBasicInfo(dec, &info) != JXL_DEC_SUCCESS) break;
      g_width = info.xsize;
      g_height = info.ysize;
    } else if (st == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t need = 0;
      if (JxlDecoderImageOutBufferSize(dec, &format, &need) != JXL_DEC_SUCCESS) break;
      g_out.resize(need);
      if (JxlDecoderSetImageOutBuffer(dec, &format, g_out.data(), g_out.size()) != JXL_DEC_SUCCESS) break;
    } else if (st == JXL_DEC_FULL_IMAGE) {
      continue;
    } else if (st == JXL_DEC_SUCCESS) {
      ok = true;
      break;
    } else {
      break;
    }
  }
  JxlDecoderDestroy(dec);
  if (!ok) qt_out_release();
  return ok ? 0 : 1;
}

}  // extern "C"
