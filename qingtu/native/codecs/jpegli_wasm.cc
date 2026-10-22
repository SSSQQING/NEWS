// 把 Google jpegli 的 libjpeg 风格接口包成几个扁平的导出函数，给 Node 侧（src/core/codecs.js）调用。
// 编码参数照搬 cjpegli 的默认值：自适应量化、渐进式 level 2、优化霍夫曼表；色度抽样由调用方指定。

#include <setjmp.h>
#include <stdint.h>
#include <stdlib.h>

#include <emscripten/emscripten.h>

#include "lib/jpegli/encode.h"

namespace {

struct ErrorManager {
  jpeg_error_mgr pub;
  jmp_buf jump;
};

void OnError(j_common_ptr cinfo) {
  longjmp(reinterpret_cast<ErrorManager*>(cinfo->err)->jump, 1);
}

void OnMessage(j_common_ptr, int) {}

unsigned char* g_out = nullptr;
unsigned long g_out_size = 0;

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE uint8_t* qt_out() { return g_out; }
EMSCRIPTEN_KEEPALIVE uint32_t qt_out_size() { return static_cast<uint32_t>(g_out_size); }

EMSCRIPTEN_KEEPALIVE void qt_out_release() {
  free(g_out);
  g_out = nullptr;
  g_out_size = 0;
}

// pixels：8 位、行连续；channels 为 1（灰度）或 3（RGB）；quality 1-100；
// subsample 为 1 时色度 4:2:0，为 0 时 4:4:4（cjpegli 默认）。
// 成功返回 0，结果通过 qt_out()/qt_out_size() 取。
EMSCRIPTEN_KEEPALIVE int jpegli_encode(const uint8_t* pixels, int width, int height, int channels, int quality,
                                       int subsample) {
  qt_out_release();
  if (width <= 0 || height <= 0 || (channels != 1 && channels != 3)) return 2;

  jpeg_compress_struct cinfo;
  ErrorManager err;
  cinfo.err = jpegli_std_error(&err.pub);
  err.pub.error_exit = OnError;
  err.pub.emit_message = OnMessage;
  unsigned char* buf = nullptr;
  unsigned long size = 0;
  if (setjmp(err.jump)) {
    jpegli_destroy_compress(&cinfo);
    return 1;
  }

  jpegli_create_compress(&cinfo);
  jpegli_mem_dest(&cinfo, &buf, &size);
  cinfo.image_width = width;
  cinfo.image_height = height;
  cinfo.input_components = channels;
  cinfo.in_color_space = channels == 1 ? JCS_GRAYSCALE : JCS_RGB;
  jpegli_set_defaults(&cinfo);
  const int factor = subsample && channels == 3 ? 2 : 1;
  cinfo.comp_info[0].h_samp_factor = factor;
  cinfo.comp_info[0].v_samp_factor = factor;
  for (int i = 1; i < cinfo.num_components; ++i) {
    cinfo.comp_info[i].h_samp_factor = 1;
    cinfo.comp_info[i].v_samp_factor = 1;
  }
  jpegli_enable_adaptive_quantization(&cinfo, TRUE);
  jpegli_set_distance(&cinfo, jpegli_quality_to_distance(quality), TRUE);
  jpegli_set_progressive_level(&cinfo, 2);
  cinfo.optimize_coding = TRUE;
  jpegli_start_compress(&cinfo, TRUE);

  const size_t stride = static_cast<size_t>(width) * channels;
  while (cinfo.next_scanline < cinfo.image_height) {
    JSAMPROW row = const_cast<JSAMPROW>(pixels + cinfo.next_scanline * stride);
    jpegli_write_scanlines(&cinfo, &row, 1);
  }
  jpegli_finish_compress(&cinfo);
  jpegli_destroy_compress(&cinfo);

  g_out = buf;
  g_out_size = size;
  return 0;
}

}  // extern "C"
