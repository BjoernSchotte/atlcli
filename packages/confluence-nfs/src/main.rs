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
    io::Read,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::{oneshot, OwnedSemaphorePermit, Semaphore};

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;
// The dispatch deadline can drop call() at any await, before its own timeout.
struct PendingCall<'a> {
    pending: &'a Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    id: u64,
}
impl Drop for PendingCall<'_> {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.id);
    }
}
// spawn_blocking cannot be aborted once started. Keep capacity owned by the
// blocking write even if its caller is cancelled, then return it for the reply wait.
async fn send_request(
    permit: OwnedSemaphorePermit,
    write: impl FnOnce() -> std::io::Result<()> + Send + 'static,
) -> Result<OwnedSemaphorePermit, nfsstat3> {
    tokio::task::spawn_blocking(move || {
        write().map_err(|_| nfsstat3::NFS3ERR_IO)?;
        Ok(permit)
    })
    .await
    .map_err(|_| nfsstat3::NFS3ERR_IO)?
}
struct Bridge {
    writable: bool,
    session: [u8; 16],
    pending: Pending,
    sequence: AtomicU64,
    capacity: Arc<Semaphore>,
}
impl Bridge {
    async fn call(&self, op: &str, args: Value) -> Result<Value, nfsstat3> {
        let permit = self
            .capacity
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| nfsstat3::NFS3ERR_IO)?;
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let _pending = PendingCall {
            pending: &self.pending,
            id,
        };
        let frame = json!({"id":id,"op":op,"args":args});
        let _permit = send_request(permit, move || {
            write_frame(&mut std::io::stdout().lock(), &frame)
        })
        .await?;
        let response = tokio::time::timeout(std::time::Duration::from_secs(60), rx).await;
        let value = response
            .map_err(|_| nfsstat3::NFS3ERR_JUKEBOX)?
            .map_err(|_| nfsstat3::NFS3ERR_IO)?;
        if let Some(error) = value.get("error").and_then(Value::as_str) {
            return Err(match error {
                "ENOENT" => nfsstat3::NFS3ERR_NOENT,
                "EEXIST" => nfsstat3::NFS3ERR_EXIST,
                "ESTALE" => nfsstat3::NFS3ERR_STALE,
                "EBADCOOKIE" => nfsstat3::NFS3ERR_BAD_COOKIE,
                "EACCES" => nfsstat3::NFS3ERR_ACCES,
                "EROFS" => nfsstat3::NFS3ERR_ROFS,
                "EISDIR" => nfsstat3::NFS3ERR_ISDIR,
                "ENOTDIR" => nfsstat3::NFS3ERR_NOTDIR,
                "ENOTEMPTY" => nfsstat3::NFS3ERR_NOTEMPTY,
                "ENAMETOOLONG" => nfsstat3::NFS3ERR_NAMETOOLONG,
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
        mode: if let Some(mode) = v.get("mode") {
            let mode = mode
                .as_u64()
                .filter(|m| *m <= 0o777)
                .ok_or(nfsstat3::NFS3ERR_IO)?;
            mode as u32
        } else if directory {
            if v["writable"].as_bool() == Some(true) {
                0o755
            } else {
                0o555
            }
        } else if v["writable"].as_bool() == Some(true) {
            0o644
        } else {
            0o444
        },
        uid: v
            .get("uid")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .try_into()
            .map_err(|_| nfsstat3::NFS3ERR_IO)?,
        gid: v
            .get("gid")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .try_into()
            .map_err(|_| nfsstat3::NFS3ERR_IO)?,
        nlink: 1,
        size,
        used: size,
        fsid: 1,
        fileid: uint(v, "id")?,
        atime: if let Some(millis) = v.get("atime").and_then(Value::as_u64) {
            nfstime3 {
                seconds: (millis / 1000).min(u32::MAX as u64) as u32,
                nseconds: ((millis % 1000) * 1_000_000) as u32,
            }
        } else {
            time
        },
        mtime: time,
        ctime: time,
        ..Default::default()
    })
}
// Some native chmod/copyfile clients include the file-type bits in st_mode.
// They cannot change an object's type; retain only supported permission bits.
fn permissions(mode: u32) -> Result<u32, nfsstat3> {
    let mode = mode & !0o170000;
    if mode > 0o777 {
        return Err(nfsstat3::NFS3ERR_NOTSUPP);
    }
    Ok(mode)
}

fn name(bytes: &[u8]) -> Result<&str, nfsstat3> {
    std::str::from_utf8(bytes).map_err(|_| nfsstat3::NFS3ERR_INVAL)
}
#[async_trait]
impl NFSFileSystem for Bridge {
    fn capabilities(&self) -> VFSCapabilities {
        if self.writable {
            VFSCapabilities::ReadWrite
        } else {
            VFSCapabilities::ReadOnly
        }
    }
    fn root_dir(&self) -> fileid3 {
        1
    }
    fn id_to_fh(&self, id: fileid3) -> nfs_fh3 {
        let mut data = self.session.to_vec();
        data.extend_from_slice(&id.to_le_bytes());
        nfs_fh3 { data }
    }
    fn fh_to_id(&self, handle: &nfs_fh3) -> Result<fileid3, nfsstat3> {
        // The previous helper used a 16-byte timestamp-based handle.
        if handle.data.len() == 16 {
            return Err(nfsstat3::NFS3ERR_STALE);
        }
        if handle.data.len() != 24 {
            return Err(nfsstat3::NFS3ERR_BADHANDLE);
        }
        if handle.data[..16] != self.session {
            return Err(nfsstat3::NFS3ERR_STALE);
        }
        Ok(u64::from_le_bytes(handle.data[16..24].try_into().unwrap()))
    }
    fn serverid(&self) -> cookieverf3 {
        self.session[..8].try_into().unwrap()
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
            wtmax: if self.writable { 1024 * 1024 } else { 0 },
            wtpref: if self.writable { 128 * 1024 } else { 0 },
            wtmult: 4096,
            dtpref: 16384,
            maxfilesize: if self.writable {
                64 * 1024 * 1024
            } else {
                128 * 1024 * 1024 * 1024
            },
            time_delta: nfstime3 {
                seconds: 0,
                nseconds: 1_000_000,
            },
            properties: 0,
        })
    }
    async fn setattr(&self, id: fileid3, value: sattr3) -> Result<fattr3, nfsstat3> {
        if !self.writable {
            return Err(nfsstat3::NFS3ERR_ROFS);
        }
        if matches!(value.size, set_size3::Void) {
            if !matches!(value.uid, set_uid3::Void) || !matches!(value.gid, set_gid3::Void) {
                return Err(nfsstat3::NFS3ERR_NOTSUPP);
            }
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| nfsstat3::NFS3ERR_IO)?
                .as_millis() as u64;
            let mut args = json!({"file": id});
            if let set_mode3::mode(mode) = value.mode {
                args["mode"] = json!(permissions(mode)?);
            }
            match value.atime {
                set_atime::DONT_CHANGE => (),
                set_atime::SET_TO_SERVER_TIME => args["atime"] = json!(now),
                _ => return Err(nfsstat3::NFS3ERR_NOTSUPP),
            }
            match value.mtime {
                set_mtime::DONT_CHANGE => (),
                set_mtime::SET_TO_SERVER_TIME => args["mtime"] = json!(now),
                _ => return Err(nfsstat3::NFS3ERR_NOTSUPP),
            }
            if args.as_object().unwrap().len() == 1 {
                return self.getattr(id).await;
            }
            return attr(&self.call("set-attributes", args).await?);
        }
        if !matches!(value.mode, set_mode3::Void)
            || !matches!(value.uid, set_uid3::Void)
            || !matches!(value.gid, set_gid3::Void)
            || !matches!(value.atime, set_atime::DONT_CHANGE)
            || !(matches!(value.mtime, set_mtime::DONT_CHANGE)
                || (matches!(value.mtime, set_mtime::SET_TO_SERVER_TIME)
                    && matches!(value.size, set_size3::size(_))))
        {
            return Err(nfsstat3::NFS3ERR_NOTSUPP);
        }
        match value.size {
            set_size3::size(size) => attr(
                &self
                    .call("truncate", json!({"file":id,"size":size}))
                    .await?,
            ),
            set_size3::Void => self.getattr(id).await,
        }
    }
    async fn write(&self, id: fileid3, offset: u64, bytes: &[u8]) -> Result<fattr3, nfsstat3> {
        if !self.writable {
            return Err(nfsstat3::NFS3ERR_ROFS);
        }
        if bytes.len() > 1024 * 1024 {
            return Err(nfsstat3::NFS3ERR_INVAL);
        }
        attr(
            &self
                .call(
                    "write",
                    json!({"file":id,"offset":offset,"data":STANDARD.encode(bytes)}),
                )
                .await?,
        )
    }
    async fn create(
        &self,
        parent: fileid3,
        filename: &filename3,
        value: sattr3,
        guarded: bool,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        if !self.writable {
            return Err(nfsstat3::NFS3ERR_ROFS);
        }
        if !matches!(value.uid, set_uid3::Void)
            || !matches!(value.gid, set_gid3::Void)
            || !matches!(value.atime, set_atime::DONT_CHANGE)
            || !matches!(value.mtime, set_mtime::DONT_CHANGE)
        {
            return Err(nfsstat3::NFS3ERR_NOTSUPP);
        }
        let mut args = json!({"parent":parent,"name":name(filename)?,"guarded":guarded});
        if let set_mode3::mode(mode) = value.mode {
            args["mode"] = json!(permissions(mode)?);
        }
        if let set_size3::size(size) = value.size {
            args["size"] = json!(size);
        }
        let id = self
            .call("create", args)
            .await?
            .as_u64()
            .ok_or(nfsstat3::NFS3ERR_IO)?;
        Ok((id, self.getattr(id).await?))
    }
    async fn create_exclusive(
        &self,
        parent: fileid3,
        name: &filename3,
        verifier: createverf3,
    ) -> Result<fileid3, nfsstat3> {
        if !self.writable {
            return Err(nfsstat3::NFS3ERR_ROFS);
        }
        let name = std::str::from_utf8(name).map_err(|_| nfsstat3::NFS3ERR_INVAL)?;
        self.call("create-exclusive", json!({"parent":parent,"name":name,"verifier":format!("{:016x}",u64::from_be_bytes(verifier))}))
            .await?.as_u64().ok_or(nfsstat3::NFS3ERR_IO)
    }
    async fn mkdir(
        &self,
        parent: fileid3,
        filename: &filename3,
        value: sattr3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        if !self.writable {
            return Err(nfsstat3::NFS3ERR_ROFS);
        }
        if !matches!(value.uid, set_uid3::Void)
            || !matches!(value.gid, set_gid3::Void)
            || !matches!(value.size, set_size3::Void)
            || !matches!(value.atime, set_atime::DONT_CHANGE)
            || !matches!(value.mtime, set_mtime::DONT_CHANGE)
        {
            return Err(nfsstat3::NFS3ERR_NOTSUPP);
        }
        let mode = match value.mode {
            set_mode3::mode(mode) => permissions(mode)?,
            set_mode3::Void => 0o755,
        };
        let id = self
            .call(
                "mkdir",
                json!({"parent":parent,"name":name(filename)?,"mode":mode}),
            )
            .await?
            .as_u64()
            .ok_or(nfsstat3::NFS3ERR_IO)?;
        Ok((id, self.getattr(id).await?))
    }
    async fn remove(
        &self,
        parent: fileid3,
        name: &filename3,
        directory: bool,
    ) -> Result<(), nfsstat3> {
        if !self.writable {
            return Err(nfsstat3::NFS3ERR_ROFS);
        }
        let name = std::str::from_utf8(name).map_err(|_| nfsstat3::NFS3ERR_INVAL)?;
        self.call(
            if directory { "rmdir" } else { "remove" },
            json!({"parent":parent,"name":name}),
        )
        .await?;
        Ok(())
    }
    async fn rename(
        &self,
        parent: fileid3,
        name: &filename3,
        target_parent: fileid3,
        target_name: &filename3,
    ) -> Result<(), nfsstat3> {
        if !self.writable {
            return Err(nfsstat3::NFS3ERR_ROFS);
        }
        let name = std::str::from_utf8(name).map_err(|_| nfsstat3::NFS3ERR_INVAL)?;
        let target_name = std::str::from_utf8(target_name).map_err(|_| nfsstat3::NFS3ERR_INVAL)?;
        self.call("rename", json!({"parent":parent,"name":name,"targetParent":target_parent,"targetName":target_name})).await?;
        Ok(())
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
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!(
            "{}",
            json!({
                "name": "atlcli-confluence-nfs",
                "version": env!("CARGO_PKG_VERSION"),
                "bridgeVersion": BRIDGE_VERSION,
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
            })
        );
        return Ok(());
    }
    let port: u16 = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "0".into())
        .parse()?;
    let writable = std::env::args().nth(2).as_deref() == Some("--staged-rw");
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let mut session = [0; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut session)?;
    let bridge = Bridge {
        writable,
        session,
        pending: pending.clone(),
        sequence: AtomicU64::new(1),
        capacity: Arc::new(Semaphore::new(32)),
    };
    let server = Arc::new(NFSTcpListener::bind(&format!("127.0.0.1:{port}"), bridge).await?);
    write_frame(
        &mut std::io::stdout().lock(),
        &json!({"hello":BRIDGE_VERSION,"port":server.get_listen_port(),"mode":if writable { "staged-rw" } else { "ro" }}),
    )?;
    let (closed_tx, closed_rx) = oneshot::channel::<()>();
    let metrics_server = server.clone();
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        loop {
            match read_frame(&mut input) {
                Ok(Some(value)) => {
                    if let Some(id) = value["stats"].as_u64() {
                        if write_frame(
                            &mut std::io::stdout().lock(),
                            &json!({"stats":id,"requests":metrics_server.request_count()}),
                        )
                        .is_err()
                        {
                            break;
                        }
                        continue;
                    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_mode_type_bits_do_not_change_permissions() {
        for mode in [0o644, 0o100644, 0o40644] {
            assert_eq!(permissions(mode).unwrap(), 0o644);
        }
        for mode in [0o104644, 0o102644, 0o101644, 0o200644] {
            assert!(matches!(permissions(mode), Err(nfsstat3::NFS3ERR_NOTSUPP)));
        }
    }

    fn bridge(session: [u8; 16]) -> Bridge {
        Bridge {
            writable: false,
            session,
            pending: Arc::new(Mutex::new(HashMap::new())),
            sequence: AtomicU64::new(1),
            capacity: Arc::new(Semaphore::new(32)),
        }
    }

    #[tokio::test]
    async fn cancelled_calls_release_pending_responses_and_capacity() {
        let bridge = Arc::new(bridge([1; 16]));
        let caller = bridge.clone();
        let task = tokio::spawn(async move { caller.call("getattr", json!({"id": 1})).await });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while bridge.pending.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(bridge.pending.lock().unwrap().is_empty());
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while bridge.capacity.available_permits() != 32 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn cancelled_blocking_write_keeps_capacity_until_it_finishes() {
        let capacity = Arc::new(Semaphore::new(1));
        let permit = capacity.clone().acquire_owned().await.unwrap();
        let (started, ready) = oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let task = tokio::spawn(send_request(permit, move || {
            let _ = started.send(());
            blocked
                .recv_timeout(std::time::Duration::from_secs(2))
                .map_err(std::io::Error::other)?;
            Ok(())
        }));
        ready.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(capacity.available_permits(), 0);
        release.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while capacity.available_permits() != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[test]
    fn handles_expire_between_sessions_even_when_file_ids_are_reused() {
        let first = bridge([1; 16]);
        let second = bridge([2; 16]);
        let old = first.id_to_fh(2);
        assert!(matches!(first.fh_to_id(&old), Ok(2)));
        assert!(matches!(
            second.fh_to_id(&old),
            Err(nfsstat3::NFS3ERR_STALE)
        ));
        assert!(matches!(
            second.fh_to_id(&second.id_to_fh(u64::MAX)),
            Ok(u64::MAX)
        ));
        assert!(matches!(
            second.fh_to_id(&nfs_fh3 { data: vec![0; 16] }),
            Err(nfsstat3::NFS3ERR_STALE)
        ));
        assert!(matches!(
            second.fh_to_id(&nfs_fh3 { data: vec![0; 7] }),
            Err(nfsstat3::NFS3ERR_BADHANDLE)
        ));
    }
}
