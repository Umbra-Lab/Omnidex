use thiserror::Error;

#[derive(Error, Debug)]
pub enum UassetBridgeError {
  #[error("I/O error: {0}")]
  Io(#[from] std::io::Error),

  #[error("uasset parse error: {0}")]
  Parse(String),

  #[error("image error: {0}")]
  Image(#[from] image::ImageError),

  #[error("no thumbnail found in asset")]
  NoThumbnail,
}

pub type Result<T> = std::result::Result<T, UassetBridgeError>;

pub fn bridge_error(err: UassetBridgeError) -> napi::Error {
  napi::Error::new(napi::Status::GenericFailure, err.to_string())
}
