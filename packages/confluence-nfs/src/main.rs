use async_trait::async_trait;
use atlcli_confluence_nfs::{read_frame, write_frame, BRIDGE_VERSION};
use base64::{engine::general_purpose::STANDARD, Engine};
use nfsserve::{
    nfs::*,
    tcp::{NFSTcp, NFSTcpListener},
    vfs::*,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::{oneshot, Semaphore};

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;
struct Bridge {
    pending: Pending,
    sequence: AtomicU64,
    capacity: Semaphore,
}
impl Bridge {
    async fn call(&self, op: &str, args: Value) -> Result<Value, nfsstat3> {
        let _permit = self
            .capacity
            .acquire()
            .await
            .map_err(|_| nfsstat3::NFS3ERR_IO)?;
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let frame = json!({"id":id,"op":op,"args":args});
        let sent =
            tokio::task::spawn_blocking(move || write_frame(&mut std::io::stdout().lock(), &frame))
                .await;
        if !matches!(sent, Ok(Ok(()))) {
            self.pending.lock().unwrap().remove(&id);
            return Err(nfsstat3::NFS3ERR_IO);
        }
        let response = tokio::time::timeout(std::time::Duration::from_secs(60), rx).await;
        self.pending.lock().unwrap().remove(&id);
        let value = response
            .map_err(|_| nfsstat3::NFS3ERR_JUKEBOX)?
            .map_err(|_| nfsstat3::NFS3ERR_IO)?;
        if let Some(error) = value.get("error").and_then(Value::as_str) {
            return Err(match error {
                "ENOENT" => nfsstat3::NFS3ERR_NOENT,
                "ESTALE" => nfsstat3::NFS3ERR_STALE,
                "EBADCOOKIE" => nfsstat3::NFS3ERR_BAD_COOKIE,
                "EACCES" => nfsstat3::NFS3ERR_ACCES,
                "EROFS" => nfsstat3::NFS3ERR_ROFS,
                "EISDIR" => nfsstat3::NFS3ERR_ISDIR,
                "ENOTDIR" => nfsstat3::NFS3ERR_NOTDIR,
                "EINVAL" => nfsstat3::NFS3ERR_INVAL,
                "ENOSPC" => nfsstat3::NFS3ERR_NOSPC,
                "EAGAIN" => nfsstat3::NFS3ERR_JUKEBOX,
                _ => nfsstat3::NFS3ERR_IO,
            });
        }
        value.get("result").cloned().ok_or(nfsstat3::NFS3ERR_IO)
    }
}
fn uint(v: &Value, key: &str) -> Result<u64, nfsstat3> {
    v.get(key)
        .and_then(Value::as_u64)
        .ok_or(nfsstat3::NFS3ERR_IO)
}
fn attr(v: &Value) -> Result<fattr3, nfsstat3> {
    let directory = v
        .get("directory")
        .and_then(Value::as_bool)
        .ok_or(nfsstat3::NFS3ERR_IO)?;
    let millis = uint(v, "mtime")?;
    let time = nfstime3 {
        seconds: (millis / 1000).min(u32::MAX as u64) as u32,
        nseconds: ((millis % 1000) * 1_000_000) as u32,
    };
    let size = uint(v, "size")?;
    Ok(fattr3 {
        ftype: if directory {
            ftype3::NF3DIR
        } else {
            ftype3::NF3REG
        },
        mode: if directory { 0o555 } else { 0o444 },
        nlink: 1,
        size,
        used: size,
        fsid: 1,
        fileid: uint(v, "id")?,
        atime: time,
        mtime: time,
        ctime: time,
        ..Default::default()
    })
}
fn name(bytes: &[u8]) -> Result<&str, nfsstat3> {
    std::str::from_utf8(bytes).map_err(|_| nfsstat3::NFS3ERR_INVAL)
}
#[async_trait]
impl NFSFileSystem for Bridge {
    fn capabilities(&self) -> VFSCapabilities {
        VFSCapabilities::ReadOnly
    }
    fn root_dir(&self) -> fileid3 {
        1
    }
    async fn lookup(&self, parent: fileid3, filename: &filename3) -> Result<fileid3, nfsstat3> {
        self.call("lookup", json!({"parent":parent,"name":name(filename)?}))
            .await?
            .as_u64()
            .ok_or(nfsstat3::NFS3ERR_IO)
    }
    async fn getattr(&self, id: fileid3) -> Result<fattr3, nfsstat3> {
        attr(&self.call("getattr", json!({"file":id})).await?)
    }
    async fn read(
        &self,
        id: fileid3,
        offset: u64,
        count: u32,
    ) -> Result<(Vec<u8>, bool), nfsstat3> {
        let result = self
            .call(
                "read",
                json!({"file":id,"offset":offset,"count":count.min(1024*1024)}),
            )
            .await?;
        let data = STANDARD
            .decode(result["data"].as_str().ok_or(nfsstat3::NFS3ERR_IO)?)
            .map_err(|_| nfsstat3::NFS3ERR_IO)?;
        if data.len() > count as usize || data.len() > 1024 * 1024 {
            return Err(nfsstat3::NFS3ERR_IO);
        }
        Ok((data, result["eof"].as_bool().ok_or(nfsstat3::NFS3ERR_IO)?))
    }
    async fn readdir(
        &self,
        id: fileid3,
        after: fileid3,
        count: usize,
    ) -> Result<ReadDirResult, nfsstat3> {
        let time = self.getattr(id).await?.mtime;
        let verifier = ((u64::from(time.seconds) << 32) | u64::from(time.nseconds)).to_be_bytes();
        self.readdir_with_verifier(id, after, count, verifier).await
    }
    async fn readdir_with_verifier(
        &self,
        id: fileid3,
        after: fileid3,
        count: usize,
        verifier: cookieverf3,
    ) -> Result<ReadDirResult, nfsstat3> {
        if count == 0 {
            return Ok(ReadDirResult {
                entries: vec![],
                end: false,
            });
        }
        let result = self
            .call(
                "readdir",
                json!({"file":id,"after":after,"count":count.min(256),"verifier":format!("{:016x}", u64::from_be_bytes(verifier))}),
            )
            .await?;
        let mut entries = Vec::new();
        for row in result["entries"].as_array().ok_or(nfsstat3::NFS3ERR_IO)? {
            let attributes = attr(&row["attr"])?;
            entries.push(DirEntry {
                fileid: attributes.fileid,
                attr: attributes,
                name: row["name"]
                    .as_str()
                    .ok_or(nfsstat3::NFS3ERR_IO)?
                    .as_bytes()
                    .into(),
            });
        }
        Ok(ReadDirResult {
            entries,
            end: result["end"].as_bool().ok_or(nfsstat3::NFS3ERR_IO)?,
        })
    }
    async fn fsinfo(&self, id: fileid3) -> Result<fsinfo3, nfsstat3> {
        Ok(fsinfo3 {
            obj_attributes: post_op_attr::attributes(self.getattr(id).await?),
            rtmax: 1024 * 1024,
            rtpref: 128 * 1024,
            rtmult: 4096,
            wtmax: 0,
            wtpref: 0,
            wtmult: 4096,
            dtpref: 16384,
            maxfilesize: 128 * 1024 * 1024 * 1024,
            time_delta: nfstime3 {
                seconds: 0,
                nseconds: 1_000_000,
            },
            properties: 0,
        })
    }
    async fn setattr(&self, _: fileid3, _: sattr3) -> Result<fattr3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }
    async fn write(&self, _: fileid3, _: u64, _: &[u8]) -> Result<fattr3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }
    async fn create(
        &self,
        _: fileid3,
        _: &filename3,
        _: sattr3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }
    async fn create_exclusive(&self, _: fileid3, _: &filename3) -> Result<fileid3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }
    async fn mkdir(&self, _: fileid3, _: &filename3) -> Result<(fileid3, fattr3), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }
    async fn remove(&self, _: fileid3, _: &filename3) -> Result<(), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }
    async fn rename(
        &self,
        _: fileid3,
        _: &filename3,
        _: fileid3,
        _: &filename3,
    ) -> Result<(), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }
    async fn symlink(
        &self,
        _: fileid3,
        _: &filename3,
        _: &nfspath3,
        _: &sattr3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }
    async fn readlink(&self, _: fileid3) -> Result<nfspath3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_INVAL)
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "0".into())
        .parse()?;
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let bridge = Bridge {
        pending: pending.clone(),
        sequence: AtomicU64::new(1),
        capacity: Semaphore::new(32),
    };
    let server = NFSTcpListener::bind(&format!("127.0.0.1:{port}"), bridge).await?;
    write_frame(
        &mut std::io::stdout().lock(),
        &json!({"hello":BRIDGE_VERSION,"port":server.get_listen_port(),"mode":"ro"}),
    )?;
    let (closed_tx, closed_rx) = oneshot::channel::<()>();
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        loop {
            match read_frame(&mut input) {
                Ok(Some(value)) => {
                    let Some(id) = value["id"].as_u64() else {
                        break;
                    };
                    if let Some(tx) = pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(value);
                    }
                }
                Ok(None) => break,
                Err(_) => {
                    eprintln!("NFS bridge input failed");
                    break;
                }
            }
        }
        pending.lock().unwrap().clear();
        let _ = closed_tx.send(());
    });
    tokio::select! { result=server.handle_forever()=>{result?;}, _=closed_rx=>{} }
    Ok(())
}
