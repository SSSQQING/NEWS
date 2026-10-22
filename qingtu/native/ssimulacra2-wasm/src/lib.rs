//! 极简 C ABI：JS 侧把两张 8 位 sRGB（RGB 交错）图拷进 wasm 内存，拿回 SSIMULACRA 2 分数。

use ssimulacra2::{compute_frame_ssimulacra2, ColorPrimaries, Rgb, TransferCharacteristic};

#[no_mangle]
pub extern "C" fn s2_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` / `len` 必须来自 `s2_alloc`。
#[no_mangle]
pub unsafe extern "C" fn s2_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

fn to_rgb(px: &[u8], width: usize, height: usize) -> Option<Rgb> {
    let data = px
        .chunks_exact(3)
        .map(|c| [f32::from(c[0]) / 255.0, f32::from(c[1]) / 255.0, f32::from(c[2]) / 255.0])
        .collect();
    Rgb::new(data, width, height, TransferCharacteristic::SRGB, ColorPrimaries::BT709).ok()
}

/// 出错（尺寸不一致、小于 8×8 等）时返回 NaN。
///
/// # Safety
/// `a`、`b` 都必须指向 `width * height * 3` 字节的有效内存。
#[no_mangle]
pub unsafe extern "C" fn s2_score(a: *const u8, b: *const u8, width: usize, height: usize) -> f64 {
    let n = width * height * 3;
    let a = std::slice::from_raw_parts(a, n);
    let b = std::slice::from_raw_parts(b, n);
    match (to_rgb(a, width, height), to_rgb(b, width, height)) {
        (Some(src), Some(dst)) => compute_frame_ssimulacra2(src, dst).unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}
