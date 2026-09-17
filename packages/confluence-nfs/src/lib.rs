//! Private pipe protocol shared with apps/cli/src/vfs/nfs-framing.ts.
use std::io::{self, Read, Write};

pub const BRIDGE_VERSION: u32 = 7;
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// None means clean EOF between frames; partial frames are always errors.
pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<serde_json::Value>> {
    let mut header = [0; 4];
    loop {
        match reader.read(&mut header[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    reader.read_exact(&mut header[1..])?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > MAX_FRAME_BYTES {
        return Err(invalid("Invalid NFS bridge frame size"));
    }
    let mut body = vec![0; size];
    reader.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|_| invalid("Invalid NFS bridge JSON or UTF-8"))
}

pub fn write_frame(writer: &mut impl Write, value: &serde_json::Value) -> io::Result<()> {
    // A bounded writer also limits allocation during serialization.
    struct Bounded(Vec<u8>);
    impl Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if bytes.len() > MAX_FRAME_BYTES - self.0.len() {
                return Err(invalid("Invalid NFS bridge frame size"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut body = Bounded(Vec::new());
    serde_json::to_writer(&mut body, value)
        .map_err(|_| invalid("Invalid NFS bridge frame size"))?;
    writer.write_all(&(body.0.len() as u32).to_be_bytes())?;
    writer.write_all(&body.0)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn wire_format_and_coalescing() {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &serde_json::json!({"id": 1})).unwrap();
        assert_eq!(bytes, b"\x00\x00\x00\x08{\"id\":1}");
        let unicode = serde_json::json!({"data": "Grüße 🐴"});
        write_frame(&mut bytes, &unicode).unwrap();
        let mut stream = Cursor::new(bytes);
        assert_eq!(
            read_frame(&mut stream).unwrap(),
            Some(serde_json::json!({"id":1}))
        );
        assert_eq!(read_frame(&mut stream).unwrap(), Some(unicode));
        assert!(read_frame(&mut stream).unwrap().is_none());
    }

    #[test]
    fn partial_frames_are_not_clean_eof() {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &serde_json::json!({"id":1})).unwrap();
        for length in 1..bytes.len() {
            assert_eq!(
                read_frame(&mut Cursor::new(&bytes[..length]))
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::UnexpectedEof
            );
        }
    }

    #[test]
    fn oversized_headers_and_invalid_payloads() {
        for size in [0, MAX_FRAME_BYTES as u32 + 1, u32::MAX] {
            assert!(read_frame(&mut Cursor::new(size.to_be_bytes())).is_err());
        }
        for body in [b"secret-tenant-data".as_slice(), b"\"\xff\""] {
            let mut bytes = (body.len() as u32).to_be_bytes().to_vec();
            bytes.extend_from_slice(body);
            assert_eq!(
                read_frame(&mut Cursor::new(bytes)).unwrap_err().to_string(),
                "Invalid NFS bridge JSON or UTF-8"
            );
        }
        assert!(write_frame(
            &mut Vec::new(),
            &serde_json::json!("x".repeat(MAX_FRAME_BYTES))
        )
        .is_err());
    }
}
