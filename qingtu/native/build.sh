#!/usr/bin/env bash
# 重新构建 src/vendor 里的三个 wasm 模块。产物已提交到仓库，平时不需要跑这个脚本。
#
# 依赖：git、cmake、make、Rust（rustup target add wasm32-unknown-unknown）、
#       emsdk（https://github.com/emscripten-core/emsdk，已 source emsdk_env.sh）
#
# 用法：native/build.sh [工作目录，默认 ./.native-build]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VENDOR="$HERE/../src/vendor"
WORK="${1:-$HERE/../.native-build}"
mkdir -p "$WORK" "$VENDOR"

LIBJXL_TAG=v0.12.0
JPEGLI_COMMIT=031a0077f5799a6041004267fc12b956c1f52a20
SIMD_FLAGS="-msimd128 -O3"
EMCC_COMMON=(
  -O3 -msimd128 -std=c++17
  -sMODULARIZE=1 -sENVIRONMENT=node -sWASM_ASYNC_COMPILATION=0
  -sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=0 -sEXPORTED_RUNTIME_METHODS=HEAPU8
)

fetch() { # url dir ref submodules...
  local url=$1 dir=$2 ref=$3; shift 3
  if [ ! -d "$WORK/$dir/.git" ]; then
    git clone --filter=blob:none "$url" "$WORK/$dir"
  fi
  git -C "$WORK/$dir" checkout -q "$ref"
  for m in "$@"; do git -C "$WORK/$dir" submodule update --init --depth 1 "$m"; done
}

echo "==> SSIMULACRA 2"
(cd "$HERE/ssimulacra2-wasm" && RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown)
cp "$HERE/ssimulacra2-wasm/target/wasm32-unknown-unknown/release/qingtu_ssimulacra2.wasm" "$VENDOR/ssimulacra2.wasm"

echo "==> jpegli @ $JPEGLI_COMMIT"
fetch https://github.com/google/jpegli.git jpegli "$JPEGLI_COMMIT" third_party/highway third_party/libjpeg-turbo third_party/skcms
JP="$WORK/jpegli"
emcmake cmake -S "$JP" -B "$JP/build-wasm" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF \
  -DJPEGLI_ENABLE_SKCMS=ON -DJPEGLI_BUNDLE_LIBPNG=OFF -DJPEGLI_ENABLE_TOOLS=OFF -DJPEGLI_ENABLE_DEVTOOLS=OFF \
  -DJPEGLI_ENABLE_BENCHMARK=OFF -DJPEGLI_ENABLE_JNI=OFF -DJPEGLI_ENABLE_SJPEG=OFF -DJPEGLI_ENABLE_OPENEXR=OFF \
  -DJPEGLI_ENABLE_DOXYGEN=OFF -DJPEGLI_ENABLE_MANPAGES=OFF -DJPEGLI_ENABLE_WASM_THREADS=OFF -DJPEGLI_ENABLE_FUZZERS=OFF \
  -DCMAKE_C_FLAGS="$SIMD_FLAGS" -DCMAKE_CXX_FLAGS="$SIMD_FLAGS"
emmake make -C "$JP/build-wasm" -j"$(nproc)" jpegli-static
em++ "${EMCC_COMMON[@]}" -I"$JP" -I"$JP/build-wasm/lib/include/jpegli" -I"$JP/third_party/highway" \
  "$HERE/codecs/jpegli_wasm.cc" "$JP/build-wasm/lib/libjpegli-static.a" "$JP/build-wasm/third_party/highway/libhwy.a" \
  -o "$VENDOR/jpegli.js" -sEXPORT_NAME=createJpegli -sINITIAL_MEMORY=33554432 -sSTACK_SIZE=2097152 \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_jpegli_encode,_qt_out,_qt_out_size,_qt_out_release

echo "==> libjxl @ $LIBJXL_TAG"
fetch https://github.com/libjxl/libjxl.git libjxl "$LIBJXL_TAG" third_party/brotli third_party/highway third_party/skcms
JX="$WORK/libjxl"
emcmake cmake -S "$JX" -B "$JX/build-wasm" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF \
  -DJPEGXL_ENABLE_TOOLS=OFF -DJPEGXL_ENABLE_DEVTOOLS=OFF -DJPEGXL_ENABLE_BENCHMARK=OFF -DJPEGXL_ENABLE_EXAMPLES=OFF \
  -DJPEGXL_ENABLE_JNI=OFF -DJPEGXL_ENABLE_SJPEG=OFF -DJPEGXL_ENABLE_OPENEXR=OFF -DJPEGXL_ENABLE_DOXYGEN=OFF \
  -DJPEGXL_ENABLE_MANPAGES=OFF -DJPEGXL_ENABLE_PLUGINS=OFF -DJPEGXL_ENABLE_SKCMS=ON -DJPEGXL_BUNDLE_LIBPNG=OFF \
  -DJPEGXL_ENABLE_WASM_THREADS=OFF -DJPEGXL_ENABLE_TRANSCODE_JPEG=ON -DJPEGXL_ENABLE_BOXES=ON \
  -DCMAKE_C_FLAGS="$SIMD_FLAGS" -DCMAKE_CXX_FLAGS="$SIMD_FLAGS"
emmake make -C "$JX/build-wasm" -j"$(nproc)" jxl jxl_cms
B="$JX/build-wasm"
em++ "${EMCC_COMMON[@]}" -I"$JX/lib/include" -I"$B/lib/include" "$HERE/codecs/jxl_wasm.cc" \
  "$B/lib/libjxl.a" "$B/lib/libjxl_cms.a" "$B/third_party/highway/libhwy.a" \
  "$B/third_party/brotli/libbrotlienc.a" "$B/third_party/brotli/libbrotlidec.a" "$B/third_party/brotli/libbrotlicommon.a" \
  -o "$VENDOR/jxl.js" -sEXPORT_NAME=createJxl -sINITIAL_MEMORY=67108864 -sSTACK_SIZE=4194304 \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_jxl_encode,_jxl_from_jpeg,_jxl_decode,_qt_out,_qt_out_size,_qt_out_width,_qt_out_height,_qt_out_release

echo "==> 完成："
ls -la "$VENDOR"
