#![deny(clippy::unwrap_used)]
#![deny(clippy::expect_used)]

use napi_derive::napi;

mod errors;
mod thumbnail;

use errors::bridge_error;

/// Parsed uasset header metadata returned to the Node side.
#[napi(object)]
pub struct UassetHeader {
  pub magic: String,
  pub package_file_version: i32,
  pub has_thumbnail: bool,
}

/// Parse a `.uasset` file and return header metadata.
///
/// Validates the `0x9E2A83C1` magic and probes for an embedded thumbnail
/// via the `uasset` crate's thumbnail iterator.
#[napi]
pub fn parse_uasset(path: String) -> napi::Result<UassetHeader> {
  thumbnail::parse_header(&path).map_err(bridge_error)
}

/// Extract an embedded thumbnail from a `.uasset` file into `out_dir`.
/// Returns the absolute path of the written PNG, or `None` if no thumbnail found.
#[napi]
pub async fn extract_thumbnail(
  path: String,
  out_dir: String,
  target_size: Option<u32>,
) -> napi::Result<Option<String>> {
  let size = target_size.unwrap_or(256);
  thumbnail::extract(&path, &out_dir, size)
    .await
    .map_err(bridge_error)
}
