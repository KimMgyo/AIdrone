//! AprilTag 3 comparison detector for the existing ARUCO_MIP_36h12 print set.
//!
//! `aruco-rs` stores this dictionary as six-by-six row-major payload bits,
//! whereas AprilTag walks those cells in a perimeter-first order. We derive
//! the AprilTag codebook from the existing source-of-truth list rather than
//! substituting a similarly named family or duplicating 250 codewords. The
//! coordinate order follows AprilTag's `tagArucoMIP36h12` source (BSD-2-Clause;
//! its OpenCV-originating dictionary data carries Apache-2.0 provenance).

use std::ffi::CString;
use std::ptr::NonNull;

use apriltag_sys as sys;
use aruco_rs::core::dictionary::DICTIONARY_ARUCO_MIP_36H12;

pub const FAMILY_NAME: &str = "ARUCO_MIP_36h12";

/// AprilTag's fast decode table is deliberately capped at two corrected bits.
/// The emitted Hamming value stays visible to the A/B surface; it is not used
/// to issue a command or to retain a past detection.
const BITS_CORRECTED: i32 = 2;

/// AprilTag's published scan order for the 6×6 MIP payload inside the black
/// 8×8 marker. Coordinates are measured from the black marker's top-left cell.
const MIP_BIT_POSITIONS: [(u32, u32); 36] = [
    (1, 1),
    (2, 1),
    (3, 1),
    (4, 1),
    (5, 1),
    (2, 2),
    (3, 2),
    (4, 2),
    (3, 3),
    (6, 1),
    (6, 2),
    (6, 3),
    (6, 4),
    (6, 5),
    (5, 2),
    (5, 3),
    (5, 4),
    (4, 3),
    (6, 6),
    (5, 6),
    (4, 6),
    (3, 6),
    (2, 6),
    (5, 5),
    (4, 5),
    (3, 5),
    (4, 4),
    (1, 6),
    (1, 5),
    (1, 4),
    (1, 3),
    (1, 2),
    (2, 5),
    (2, 4),
    (2, 3),
    (3, 4),
];

#[derive(Debug, Clone, Copy)]
pub struct Detection {
    pub id: i32,
    pub hamming_distance: i32,
    pub decision_margin: f32,
    pub corners: [[f32; 2]; 4],
}

/// Safe, single-thread-owned wrapper around AprilTag 3's C detector.
///
/// It is intentionally not `Send` or shared: `vision::worker_loop` owns this
/// instance, exactly as it owns the baseline `aruco-rs` detector.
pub struct Detector {
    raw: NonNull<sys::apriltag_detector_t>,
    // The detector retains only this pointer. Keep every family backing buffer
    // alive until after `apriltag_detector_destroy` clears its decode table.
    _family: Mip36h12Family,
    grayscale: Vec<u8>,
}

impl Detector {
    pub fn new() -> Result<Self, String> {
        let mut family = Mip36h12Family::new()?;
        let raw = NonNull::new(unsafe { sys::apriltag_detector_create() })
            .ok_or_else(|| "AprilTag 3 detector allocation failed".to_owned())?;

        unsafe {
            sys::apriltag_detector_add_family_bits(raw.as_ptr(), family.raw_mut(), BITS_CORRECTED)
        };
        if family.raw.impl_.is_null() {
            unsafe { sys::apriltag_detector_destroy(raw.as_ptr()) };
            return Err("AprilTag 3 MIP decode table initialization failed".to_owned());
        }

        Ok(Self {
            raw,
            _family: family,
            grayscale: Vec::new(),
        })
    }

    /// Detect from the exact RGBA frame sampled by the baseline detector.
    /// Results are current-frame observations only; callers own any policy.
    pub fn detect(
        &mut self,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<Vec<Detection>, String> {
        if width == 0 || height == 0 {
            return Err("AprilTag requires a non-empty frame".to_owned());
        }
        let pixels = (width as usize)
            .checked_mul(height as usize)
            .ok_or_else(|| "AprilTag frame dimensions overflow".to_owned())?;
        let expected_rgba = pixels
            .checked_mul(4)
            .ok_or_else(|| "AprilTag RGBA length overflow".to_owned())?;
        if rgba.len() != expected_rgba {
            return Err(format!(
                "AprilTag expected {expected_rgba} RGBA bytes for {width}×{height}, received {}",
                rgba.len()
            ));
        }
        if width > i32::MAX as u32 || height > i32::MAX as u32 {
            return Err("AprilTag frame dimensions exceed C API range".to_owned());
        }

        self.grayscale.resize(pixels, 0);
        for (source, gray) in rgba.chunks_exact(4).zip(&mut self.grayscale) {
            // Integer BT.601 luma: no temporary pixel buffer or float work.
            *gray = ((77 * source[0] as u16 + 150 * source[1] as u16 + 29 * source[2] as u16 + 128)
                >> 8) as u8;
        }

        let mut image = sys::image_u8_t {
            width: width as i32,
            height: height as i32,
            stride: width as i32,
            buf: self.grayscale.as_mut_ptr(),
        };
        let detections =
            NonNull::new(unsafe { sys::apriltag_detector_detect(self.raw.as_ptr(), &mut image) })
                .ok_or_else(|| "AprilTag detector returned no detection array".to_owned())?;
        let result = unsafe { copy_detections(detections) };
        unsafe { sys::apriltag_detections_destroy(detections.as_ptr()) };
        result
    }
}

impl Drop for Detector {
    fn drop(&mut self) {
        unsafe { sys::apriltag_detector_destroy(self.raw.as_ptr()) };
    }
}

struct Mip36h12Family {
    _codes: Box<[u64]>,
    _bit_x: Box<[u32]>,
    _bit_y: Box<[u32]>,
    _name: CString,
    raw: Box<sys::apriltag_family_t>,
}

impl Mip36h12Family {
    fn new() -> Result<Self, String> {
        let config = &DICTIONARY_ARUCO_MIP_36H12;
        if config.n_bits != 36 || config.code_list.len() != 250 {
            return Err(format!(
                "unexpected {FAMILY_NAME} dictionary shape: {} bits, {} codes",
                config.n_bits,
                config.code_list.len()
            ));
        }

        let mut codes = config
            .code_list
            .iter()
            .copied()
            .map(repack_row_major)
            .collect::<Vec<_>>()
            .into_boxed_slice();
        let mut bit_x = MIP_BIT_POSITIONS
            .iter()
            .map(|(x, _)| *x)
            .collect::<Vec<_>>()
            .into_boxed_slice();
        let mut bit_y = MIP_BIT_POSITIONS
            .iter()
            .map(|(_, y)| *y)
            .collect::<Vec<_>>()
            .into_boxed_slice();
        let name = CString::new("tagArucoMIP_36h12").expect("literal has no NUL");
        let raw = Box::new(sys::apriltag_family_t {
            ncodes: codes.len() as u32,
            codes: codes.as_mut_ptr(),
            width_at_border: 8,
            total_width: 10,
            reversed_border: false,
            nbits: 36,
            bit_x: bit_x.as_mut_ptr(),
            bit_y: bit_y.as_mut_ptr(),
            h: 12,
            name: name.as_ptr().cast_mut(),
            impl_: std::ptr::null_mut(),
        });

        Ok(Self {
            _codes: codes,
            _bit_x: bit_x,
            _bit_y: bit_y,
            _name: name,
            raw,
        })
    }

    fn raw_mut(&mut self) -> *mut sys::apriltag_family_t {
        self.raw.as_mut()
    }
}

fn repack_row_major(row_major: u64) -> u64 {
    MIP_BIT_POSITIONS.iter().fold(0, |packed, (x, y)| {
        let row_major_bit = (y - 1) * 6 + (x - 1);
        (packed << 1) | ((row_major >> (35 - row_major_bit)) & 1)
    })
}

unsafe fn copy_detections(detections: NonNull<sys::zarray_t>) -> Result<Vec<Detection>, String> {
    let count = detections.as_ref().size;
    if count < 0 {
        return Err("AprilTag detector returned a negative detection count".to_owned());
    }
    if detections.as_ref().el_sz != std::mem::size_of::<*mut sys::apriltag_detection_t>() {
        return Err("AprilTag detector returned an unexpected detection array layout".to_owned());
    }
    if count == 0 {
        return Ok(Vec::new());
    }
    let raw = std::slice::from_raw_parts(
        detections
            .as_ref()
            .data
            .cast::<*mut sys::apriltag_detection_t>(),
        count as usize,
    );
    let mut copied = Vec::with_capacity(raw.len());
    for &pointer in raw {
        let detection = NonNull::new(pointer)
            .ok_or_else(|| "AprilTag detector returned a null detection".to_owned())?
            .as_ref();
        let corners = detection.p.map(|point| [point[0] as f32, point[1] as f32]);
        if !detection.decision_margin.is_finite()
            || corners
                .iter()
                .flatten()
                .any(|coordinate| !coordinate.is_finite())
        {
            return Err("AprilTag detector returned non-finite geometry".to_owned());
        }
        copied.push(Detection {
            id: detection.id,
            hamming_distance: detection.hamming,
            decision_margin: detection.decision_margin,
            corners,
        });
    }
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repacks_current_id_zero_to_apriltag_order() {
        assert_eq!(repack_row_major(0xd2b63a09d), 0xd2a2af057);
    }
}
