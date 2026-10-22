//! Thumbnail extraction for `.uasset` files.
//!
//! Port of `src-tauri/src/uasset_parser/thumbnail_extractor.rs`. Keeps the
//! Rust-side binary parsing (uasset crate + zlib + image) inside the napi
//! addon — this is the one subsystem that stays Rust after the Electron
//! migration, because the equivalent parser in pure Node would be both
//! slower and a large porting lift.

use super::errors::{Result, UassetBridgeError};
use byteorder::{LittleEndian, ReadBytesExt};
use image::{imageops::FilterType, ImageFormat, RgbaImage};
use std::collections::hash_map::DefaultHasher;
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const UASSET_MAGIC: u32 = 0x9E2A_83C1;
const MAX_THUMBNAIL_DIM: i32 = 4096;
const MAX_COMPRESSED_SIZE: usize = 10 * 1024 * 1024;

pub fn parse_header(path: &str) -> Result<crate::UassetHeader> {
  let file_path = Path::new(path);
  let file = File::open(file_path)?;
  let mut reader = BufReader::new(file);
  let mut magic_bytes = [0u8; 4];
  reader.read_exact(&mut magic_bytes)?;
  let magic = u32::from_le_bytes(magic_bytes);

  if magic != UASSET_MAGIC {
    return Err(UassetBridgeError::Parse(format!(
      "invalid uasset magic: 0x{magic:08X}"
    )));
  }

  // Probe for thumbnail presence via the uasset crate's iterator without
  // reading the full payload. Failures here are non-fatal — older UE
  // packs without map thumbnails return an empty iterator.
  let has_thumbnail = match reopen_and_header(file_path) {
    Ok(mut header) => match header.thumbnail_iter() {
      Ok(mut iter) => iter.next().map(|r| r.is_ok()).unwrap_or(false),
      Err(_) => false,
    },
    Err(_) => false,
  };

  Ok(crate::UassetHeader {
    magic: format!("0x{magic:08X}"),
    package_file_version: 0,
    has_thumbnail,
  })
}

/// Run the synchronous thumbnail pipeline. Napi-rs v3's `async` feature
/// dispatches each call onto its own worker thread, so the blocking
/// binary parse + image decode doesn't stall the Node event loop.
pub async fn extract(path: &str, out_dir: &str, target_size: u32) -> Result<Option<String>> {
  extract_sync(path, out_dir, target_size)
}

fn extract_sync(path: &str, out_dir: &str, target_size: u32) -> Result<Option<String>> {
  let asset_path = Path::new(path);
  let thumbnail_bytes = match extract_png_bytes(asset_path, target_size) {
    Ok(bytes) => bytes,
    Err(UassetBridgeError::NoThumbnail) => return Ok(None),
    Err(err) => return Err(err),
  };

  fs::create_dir_all(out_dir)?;
  let filename = hashed_filename(path);
  let out_path = PathBuf::from(out_dir).join(filename);
  let mut out_file = File::create(&out_path)?;
  out_file.write_all(&thumbnail_bytes)?;

  Ok(Some(out_path.to_string_lossy().into_owned()))
}

fn extract_png_bytes(asset_path: &Path, target_size: u32) -> Result<Vec<u8>> {
  let thumbnail_offset = locate_thumbnail_offset(asset_path)?;
  let decoded = decode_thumbnail_at_offset(asset_path, thumbnail_offset)?;
  resize_and_encode_png(decoded, target_size)
}

fn locate_thumbnail_offset(asset_path: &Path) -> Result<u64> {
  let mut header = reopen_and_header(asset_path)?;
  let mut iter = header
    .thumbnail_iter()
    .map_err(|_| UassetBridgeError::NoThumbnail)?;
  match iter.next() {
    Some(Ok(info)) => Ok(info.file_offset as u64),
    Some(Err(_)) | None => Err(UassetBridgeError::NoThumbnail),
  }
}

fn reopen_and_header(asset_path: &Path) -> Result<uasset::AssetHeader<BufReader<File>>> {
  let file = File::open(asset_path)?;
  let reader = BufReader::new(file);
  uasset::AssetHeader::new(reader)
    .map_err(|e| UassetBridgeError::Parse(format!("uasset header parse error: {e}")))
}

/// Reads the thumbnail section at the given offset and returns a decoded
/// `DynamicImage`. Handles the three UE encodings: raw BGRA, zlib-compressed
/// BGRA, and PNG/JPEG payload.
fn decode_thumbnail_at_offset(
  asset_path: &Path,
  offset: u64,
) -> Result<image::DynamicImage> {
  let file = File::open(asset_path)?;
  let mut file = file;
  file
    .seek(SeekFrom::Start(offset))
    .map_err(|e| UassetBridgeError::Parse(format!("seek to thumbnail failed: {e}")))?;
  let mut reader = BufReader::new(file);

  let width = reader
    .read_i32::<LittleEndian>()
    .map_err(|e| UassetBridgeError::Parse(format!("read width: {e}")))?;
  let height = reader
    .read_i32::<LittleEndian>()
    .map_err(|e| UassetBridgeError::Parse(format!("read height: {e}")))?;

  if width <= 0 || height <= 0 || width > MAX_THUMBNAIL_DIM || height > MAX_THUMBNAIL_DIM {
    return Err(UassetBridgeError::Parse(format!(
      "invalid thumbnail dimensions: {width}x{height}"
    )));
  }

  let format_or_size = reader
    .read_i32::<LittleEndian>()
    .map_err(|e| UassetBridgeError::Parse(format!("read format/size: {e}")))?;

  if format_or_size > 0 {
    let compressed_size = format_or_size as usize;
    if compressed_size > MAX_COMPRESSED_SIZE {
      return Err(UassetBridgeError::Parse(format!(
        "compressed thumbnail too large: {compressed_size} bytes"
      )));
    }
    let mut compressed_data = vec![0u8; compressed_size];
    reader
      .read_exact(&mut compressed_data)
      .map_err(|e| UassetBridgeError::Parse(format!("read compressed body: {e}")))?;

    // Try PNG/JPEG first — newer UE packs embed standard image formats.
    if let Ok(img) = image::load_from_memory(&compressed_data) {
      return Ok(img);
    }
    // Then zlib-compressed BGRA.
    if let Ok(decompressed) = decompress_zlib(&compressed_data) {
      let expected = (width * height * 4) as usize;
      if decompressed.len() == expected {
        return bgra_to_dynamic_image(&decompressed, width as u32, height as u32);
      }
    }
    // Last resort — feed the raw bytes to image::load_from_memory again
    // in case of leading header bytes we didn't recognize.
    image::load_from_memory(&compressed_data)
      .map_err(|e| UassetBridgeError::Parse(format!("could not decode thumbnail: {e}")))
  } else {
    // Uncompressed BGRA.
    let raw_size = (width * height * 4) as usize;
    let mut raw_data = vec![0u8; raw_size];
    reader
      .read_exact(&mut raw_data)
      .map_err(|e| UassetBridgeError::Parse(format!("read raw BGRA: {e}")))?;
    bgra_to_dynamic_image(&raw_data, width as u32, height as u32)
  }
}

fn bgra_to_dynamic_image(bgra: &[u8], width: u32, height: u32) -> Result<image::DynamicImage> {
  let mut rgba = bgra.to_vec();
  for chunk in rgba.chunks_exact_mut(4) {
    chunk.swap(0, 2);
  }
  RgbaImage::from_raw(width, height, rgba)
    .map(image::DynamicImage::ImageRgba8)
    .ok_or_else(|| UassetBridgeError::Parse("BGRA → RGBA dim mismatch".into()))
}

fn decompress_zlib(data: &[u8]) -> std::result::Result<Vec<u8>, std::io::Error> {
  let mut decoder = flate2::read::ZlibDecoder::new(data);
  let mut out = Vec::new();
  decoder.read_to_end(&mut out)?;
  Ok(out)
}

fn resize_and_encode_png(img: image::DynamicImage, target_size: u32) -> Result<Vec<u8>> {
  let resized = if target_size > 0 {
    img.resize(target_size, target_size, FilterType::Lanczos3)
  } else {
    img
  };
  let mut buf = Vec::new();
  resized
    .write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
    .map_err(|e| UassetBridgeError::Parse(format!("png encode: {e}")))?;
  Ok(buf)
}

fn hashed_filename(path: &str) -> String {
  let mut hasher = DefaultHasher::new();
  path.hash(&mut hasher);
  format!("{:016x}.png", hasher.finish())
}

#[cfg(test)]
// Tests legitimately use unwrap/expect/panic to assert; the crate-level
// `deny(clippy::unwrap_used / expect_used)` is meant for production paths.
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
  use super::*;
  use std::time::{SystemTime, UNIX_EPOCH};

  // --- tiny test-only temp helpers (no external dev-deps) ------------------

  /// Unique temp dir under the OS temp root. Each call gets a fresh path so
  /// parallel test threads never collide. Cleaned up via `TempDir::drop`.
  struct TempDir(PathBuf);

  impl TempDir {
    fn new(tag: &str) -> Self {
      let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
      let mut dir = std::env::temp_dir();
      dir.push(format!(
        "omnidex-uasset-test-{tag}-{nanos}-{:?}",
        std::thread::current().id()
      ));
      fs::create_dir_all(&dir).expect("create temp dir");
      TempDir(dir)
    }

    fn path(&self) -> &Path {
      &self.0
    }

    /// Write `bytes` to `<tempdir>/<name>` and return the full path.
    fn write_file(&self, name: &str, bytes: &[u8]) -> PathBuf {
      let p = self.0.join(name);
      let mut f = File::create(&p).expect("create test file");
      f.write_all(bytes).expect("write test file");
      p
    }
  }

  impl Drop for TempDir {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  /// Build a UE thumbnail *section* (the bytes that live at `file_offset`):
  /// `i32 width`, `i32 height`, `i32 format_or_size`, then `body`.
  /// `format_or_size <= 0` means the body is raw uncompressed BGRA.
  fn thumbnail_section(width: i32, height: i32, format_or_size: i32, body: &[u8]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&width.to_le_bytes());
    v.extend_from_slice(&height.to_le_bytes());
    v.extend_from_slice(&format_or_size.to_le_bytes());
    v.extend_from_slice(body);
    v
  }

  /// A 2x2 opaque BGRA buffer (16 bytes): blue, green, red, white pixels.
  fn bgra_2x2() -> Vec<u8> {
    vec![
      255, 0, 0, 255, // B
      0, 255, 0, 255, // G
      0, 0, 255, 255, // R
      255, 255, 255, 255, // white
    ]
  }

  // --- hashed_filename ------------------------------------------------------

  #[test]
  fn hashed_filename_is_deterministic_and_png() {
    let a = hashed_filename("/Vault/Pack/Foo.uasset");
    let b = hashed_filename("/Vault/Pack/Foo.uasset");
    let c = hashed_filename("/Vault/Pack/Bar.uasset");
    assert_eq!(a, b, "same path → same name");
    assert_ne!(a, c, "different path → different name");
    assert!(a.ends_with(".png"), "name is a .png: {a}");
    // 16 hex chars + ".png"
    assert_eq!(a.len(), 20, "expected 16-hex + .png, got {a}");
    assert!(
      a.trim_end_matches(".png").chars().all(|ch| ch.is_ascii_hexdigit()),
      "stem must be hex: {a}"
    );
  }

  // --- bgra_to_dynamic_image (BGRA → RGBA channel swap) ---------------------

  #[test]
  fn bgra_to_dynamic_image_swaps_b_and_r() {
    // single pixel: BGRA = (10, 20, 30, 40) → RGBA should be (30, 20, 10, 40)
    let img = bgra_to_dynamic_image(&[10, 20, 30, 40], 1, 1).expect("decode 1x1");
    let rgba = img.to_rgba8();
    let px = rgba.get_pixel(0, 0).0;
    assert_eq!(px, [30, 20, 10, 40], "B/R channels must be swapped, A/G kept");
  }

  #[test]
  fn bgra_to_dynamic_image_rejects_dim_mismatch() {
    // 3 bytes can't make a 1x1 RGBA (needs 4) → Err, must not panic.
    let r = bgra_to_dynamic_image(&[1, 2, 3], 1, 1);
    assert!(matches!(r, Err(UassetBridgeError::Parse(_))), "short buffer must error");
  }

  // --- decompress_zlib ------------------------------------------------------

  #[test]
  fn decompress_zlib_roundtrips_and_rejects_garbage() {
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    let payload = b"omnidex-thumbnail-bytes";
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    enc.write_all(payload).expect("encode");
    let compressed = enc.finish().expect("finish");
    let back = decompress_zlib(&compressed).expect("roundtrip");
    assert_eq!(back, payload);

    // garbage is not a valid zlib stream → Err, never a panic. (This is the
    // branch the decoder actually relies on to fall through on a non-zlib
    // body: a bad header means "this wasn't zlib", try the next decoder.)
    assert!(
      decompress_zlib(&[0xDE, 0xAD, 0xBE, 0xEF]).is_err(),
      "invalid zlib header must error so the decoder can fall through"
    );
    // A non-zlib body of the *expected BGRA length* must NOT accidentally
    // decode to the right size and get treated as pixels — it errors, and
    // decode_thumbnail_at_offset then falls back to image::load_from_memory.
    let sixteen_junk = vec![0xABu8; 16];
    assert!(decompress_zlib(&sixteen_junk).is_err());
  }

  // --- resize_and_encode_png ------------------------------------------------

  #[test]
  fn resize_and_encode_png_emits_a_png_signature() {
    let img = bgra_to_dynamic_image(&bgra_2x2(), 2, 2).expect("decode 2x2");
    let png = resize_and_encode_png(img, 64).expect("encode png");
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A
    assert_eq!(
      &png[..8],
      &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
      "output must be a real PNG"
    );
  }

  // --- decode_thumbnail_at_offset: GOLDEN raw-BGRA path ---------------------

  #[test]
  fn decode_thumbnail_golden_raw_bgra() {
    let tmp = TempDir::new("golden");
    // offset 0, uncompressed (format_or_size = 0), 2x2 BGRA body.
    let section = thumbnail_section(2, 2, 0, &bgra_2x2());
    let p = tmp.write_file("golden.bin", &section);
    let img = decode_thumbnail_at_offset(&p, 0).expect("golden decode must succeed");
    assert_eq!(img.width(), 2);
    assert_eq!(img.height(), 2);
    let rgba = img.to_rgba8();
    // first BGRA pixel (255,0,0,255) → RGBA (0,0,255,255)
    assert_eq!(rgba.get_pixel(0, 0).0, [0, 0, 255, 255]);
  }

  #[test]
  fn decode_thumbnail_golden_at_nonzero_offset() {
    let tmp = TempDir::new("offset");
    let mut blob = vec![0xAB; 37]; // arbitrary leading junk
    let section = thumbnail_section(2, 2, 0, &bgra_2x2());
    let offset = blob.len() as u64;
    blob.extend_from_slice(&section);
    let p = tmp.write_file("offset.bin", &blob);
    let img = decode_thumbnail_at_offset(&p, offset).expect("decode at offset");
    assert_eq!((img.width(), img.height()), (2, 2));
  }

  // --- decode_thumbnail_at_offset: EMPTY blob -------------------------------

  #[test]
  fn decode_thumbnail_empty_blob_errors_no_panic() {
    let tmp = TempDir::new("empty");
    let p = tmp.write_file("empty.bin", &[]);
    // Can't even read the width i32 → Parse error, must not panic.
    let r = decode_thumbnail_at_offset(&p, 0);
    assert!(matches!(r, Err(UassetBridgeError::Parse(_))), "empty → Parse err, got {r:?}");
  }

  // --- decode_thumbnail_at_offset: TRUNCATED blob ---------------------------

  #[test]
  fn decode_thumbnail_truncated_body_errors_no_panic() {
    let tmp = TempDir::new("trunc");
    // Header says 2x2 raw BGRA (needs 16 body bytes) but we give only 4.
    let mut section = thumbnail_section(2, 2, 0, &[]);
    section.extend_from_slice(&[1, 2, 3, 4]); // 4 < 16 expected
    let p = tmp.write_file("trunc.bin", &section);
    let r = decode_thumbnail_at_offset(&p, 0);
    assert!(
      matches!(r, Err(UassetBridgeError::Parse(_))),
      "truncated body → Parse err, got {r:?}"
    );
  }

  #[test]
  fn decode_thumbnail_truncated_header_errors_no_panic() {
    let tmp = TempDir::new("trunchdr");
    // Only width + height present, format/size i32 missing.
    let mut section = Vec::new();
    section.extend_from_slice(&2i32.to_le_bytes());
    section.extend_from_slice(&2i32.to_le_bytes());
    let p = tmp.write_file("trunchdr.bin", &section);
    let r = decode_thumbnail_at_offset(&p, 0);
    assert!(matches!(r, Err(UassetBridgeError::Parse(_))), "got {r:?}");
  }

  // --- decode_thumbnail_at_offset: ABSURD / hostile dimensions --------------

  #[test]
  fn decode_thumbnail_absurd_dimensions_rejected_no_overflow() {
    let tmp = TempDir::new("absurd");
    // width * height * 4 would overflow i32 if not guarded; the dim cap
    // (MAX_THUMBNAIL_DIM = 4096) must reject this BEFORE any multiply/alloc.
    for (w, h) in [
      (i32::MAX, i32::MAX),
      (100_000, 100_000),
      (MAX_THUMBNAIL_DIM + 1, 8),
      (8, MAX_THUMBNAIL_DIM + 1),
    ] {
      let section = thumbnail_section(w, h, 0, &[]);
      let p = tmp.write_file("absurd.bin", &section);
      let r = decode_thumbnail_at_offset(&p, 0);
      assert!(
        matches!(r, Err(UassetBridgeError::Parse(_))),
        "dims {w}x{h} must be rejected, got {r:?}"
      );
    }
  }

  #[test]
  fn decode_thumbnail_nonpositive_dimensions_rejected() {
    let tmp = TempDir::new("nonpos");
    for (w, h) in [(0, 0), (-1, 4), (4, -1), (0, 4), (4, 0)] {
      let section = thumbnail_section(w, h, 0, &bgra_2x2());
      let p = tmp.write_file("nonpos.bin", &section);
      let r = decode_thumbnail_at_offset(&p, 0);
      assert!(
        matches!(r, Err(UassetBridgeError::Parse(_))),
        "dims {w}x{h} must be rejected, got {r:?}"
      );
    }
  }

  #[test]
  fn decode_thumbnail_oversized_compressed_size_rejected() {
    let tmp = TempDir::new("bigcompressed");
    // format_or_size > MAX_COMPRESSED_SIZE must be rejected BEFORE the
    // `vec![0u8; compressed_size]` allocation (DoS / OOM guard).
    let huge = (MAX_COMPRESSED_SIZE + 1) as i32;
    let section = thumbnail_section(8, 8, huge, &[]);
    let p = tmp.write_file("bigcompressed.bin", &section);
    let r = decode_thumbnail_at_offset(&p, 0);
    assert!(
      matches!(r, Err(UassetBridgeError::Parse(_))),
      "oversized compressed size must be rejected, got {r:?}"
    );
  }

  #[test]
  fn decode_thumbnail_garbage_compressed_body_errors_no_panic() {
    let tmp = TempDir::new("garbagebody");
    // Valid dims, positive size, but the body is neither PNG/JPEG, valid
    // zlib, nor a correctly-sized BGRA buffer → must Err, never panic.
    let body = vec![0x00, 0xFF, 0x37, 0x9C, 0xAB, 0xCD, 0xEF, 0x42];
    let section = thumbnail_section(2, 2, body.len() as i32, &body);
    let p = tmp.write_file("garbagebody.bin", &section);
    let r = decode_thumbnail_at_offset(&p, 0);
    assert!(
      matches!(r, Err(UassetBridgeError::Parse(_))),
      "undecodable body → Parse err, got {r:?}"
    );
  }

  #[test]
  fn decode_thumbnail_missing_file_errors_no_panic() {
    let tmp = TempDir::new("missing");
    let p = tmp.path().join("does-not-exist.bin");
    let r = decode_thumbnail_at_offset(&p, 0);
    // File::open fails → Io error mapped through. Just must not panic.
    assert!(r.is_err(), "missing file must be an error");
  }

  // --- parse_header: magic validation --------------------------------------

  #[test]
  fn parse_header_rejects_bad_magic() {
    let tmp = TempDir::new("badmagic");
    let p = tmp.write_file("bad.uasset", &[0xDE, 0xAD, 0xBE, 0xEF, 0, 0, 0, 0]);
    let r = parse_header(p.to_str().expect("utf8 path"));
    match r {
      Err(UassetBridgeError::Parse(msg)) => {
        assert!(msg.contains("invalid uasset magic"), "msg was: {msg}");
      }
      Err(other) => panic!("expected Parse err for bad magic, got {other:?}"),
      Ok(_) => panic!("expected Parse err for bad magic, got Ok header"),
    }
  }

  #[test]
  fn parse_header_empty_file_errors_no_panic() {
    let tmp = TempDir::new("emptyhdr");
    let p = tmp.write_file("empty.uasset", &[]);
    // read_exact of 4 magic bytes on a 0-byte file → Io err, no panic.
    let r = parse_header(p.to_str().expect("utf8 path"));
    assert!(r.is_err(), "empty file must error");
  }

  #[test]
  fn parse_header_truncated_magic_errors_no_panic() {
    let tmp = TempDir::new("trunchmagic");
    // Only 2 of the 4 magic bytes present.
    let p = tmp.write_file("short.uasset", &[0xC1, 0x83]);
    let r = parse_header(p.to_str().expect("utf8 path"));
    assert!(r.is_err(), "truncated magic must error");
  }

  #[test]
  fn parse_header_valid_magic_but_garbage_body_is_no_thumbnail_not_panic() {
    let tmp = TempDir::new("magicgarbage");
    // Correct magic, then garbage. parse_header treats the uasset crate's
    // header-parse failure as non-fatal (has_thumbnail=false) and STILL
    // returns Ok — it must not panic on the malformed body.
    let mut bytes = UASSET_MAGIC.to_le_bytes().to_vec();
    bytes.extend_from_slice(&[0xFF; 64]);
    let p = tmp.write_file("magic.uasset", &bytes);
    let hdr = parse_header(p.to_str().expect("utf8 path")).expect("valid magic → Ok header");
    assert_eq!(hdr.magic, "0x9E2A83C1");
    assert!(!hdr.has_thumbnail, "garbage body → no thumbnail probed");
  }

  // --- extract_sync: end-to-end error paths --------------------------------
  //
  // Contract: on a non-extractable input, extract_sync must (a) NOT panic,
  // (b) return a graceful Result (Err for a header that fails to parse,
  // Ok(None) only when a header parses but exposes no thumbnail), and
  // (c) NOT have written anything — the out_dir is created lazily, only
  // after PNG bytes are in hand, so a failure leaves no partial output.

  /// Drive extract_sync and assert it neither panics nor leaves output behind.
  /// Returns the Result so individual tests can pin the variant.
  fn extract_no_output(tmp: &TempDir, asset: &Path) -> Result<Option<String>> {
    let out_dir = tmp.path().join("out");
    let r = extract_sync(
      asset.to_str().expect("utf8"),
      out_dir.to_str().expect("utf8"),
      256,
    );
    assert!(
      !out_dir.exists(),
      "failed extraction must not create the out dir / write a PNG"
    );
    r
  }

  #[test]
  fn extract_sync_on_non_uasset_errs_gracefully() {
    let tmp = TempDir::new("extractnone");
    // A plain text file is not a uasset: reopen_and_header fails to parse →
    // mapped to Parse(...). Must be a clean Err, never a panic, no output.
    let asset = tmp.write_file("notes.txt", b"this is not a uasset file at all");
    let r = extract_no_output(&tmp, &asset);
    assert!(
      matches!(r, Err(UassetBridgeError::Parse(_))),
      "non-uasset → graceful Parse err, got {r:?}"
    );
  }

  #[test]
  fn extract_sync_on_empty_file_errs_gracefully() {
    let tmp = TempDir::new("extractempty");
    let asset = tmp.write_file("empty.uasset", &[]);
    let r = extract_no_output(&tmp, &asset);
    assert!(r.is_err(), "empty file → graceful err, got {r:?}");
  }

  #[test]
  fn extract_sync_on_missing_file_errs_gracefully() {
    let tmp = TempDir::new("extractmissing");
    let asset = tmp.path().join("nope.uasset");
    let r = extract_no_output(&tmp, &asset);
    assert!(r.is_err(), "missing file → graceful err, got {r:?}");
  }

  #[test]
  fn extract_sync_on_garbage_after_valid_magic_errs_gracefully() {
    let tmp = TempDir::new("extractmagic");
    // Valid magic so the magic gate passes, but the rest is junk the uasset
    // crate can't turn into a header → graceful err, no panic, no output.
    let mut bytes = UASSET_MAGIC.to_le_bytes().to_vec();
    bytes.extend_from_slice(&[0xFF; 128]);
    let asset = tmp.write_file("magic.uasset", &bytes);
    let r = extract_no_output(&tmp, &asset);
    assert!(r.is_err(), "magic+garbage → graceful err, got {r:?}");
  }
}
