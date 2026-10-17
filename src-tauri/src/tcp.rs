//! The native raw-TCP bridge for the packaged client.
//!
//! Ported from the `sp-tcp-*` handlers in `desktop/runtime/main.cjs`; `public/js/tcpSocket.js`
//! drives it through `globalThis.strongholdClient` and expects the exact same event payloads
//! (`{id, type: 'open'|'message'|'error'|'close', …}`) and the exact same framing on the wire.
//!
//! Wire framing (unchanged): every outbound frame is a big-endian `u32` byte length followed by that
//! many UTF-8 bytes, and the payload the page receives is the raw server text, so `TcpSocket.send()`
//! really writes the caller's JSON with a length prefix. Inbound frames are capped by
//! [`FRAME_MAX_BYTES`]; a frame larger than the cap, or a zero-length frame, tears the connection
//! down with `code 1006, reason "invalid frame"`, exactly like the Electron client.
//!
//! The page can only reach this module through `invoke`; the bridge never exposes the socket, the
//! file system or any token to JavaScript, and `connect` accepts only a bare host name and a port.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch, Mutex};

/// Event name the init script listens on, identical to the Electron IPC channel name.
pub const EVENT_NAME: &str = "sp-tcp-event";

/// Defensive ceiling for a client-side TCP frame. The game server itself caps frames at 64 KiB.
pub const FRAME_MAX_BYTES: usize = 32 << 20;

/// Longest accepted host name (DNS name or IPv6 literal).
const HOST_MAX_CHARS: usize = 253;
const ID_MAX_CHARS: usize = 80;
const REASON_MAX_CHARS: usize = 120;

/// How long a forced close waits for the writer task before the read task gives up on it.
const FORCE_GRACE: Duration = Duration::from_millis(250);

/// Outbound work for one socket. One writer task owns the write half and processes these in order.
enum WriteCommand {
    /// A raw frame body, sent with the standard length prefix.
    Frame(Vec<u8>),
    /// The `{"_sp":"close",…}` control frame, then FIN.
    GracefulClose { framed: Vec<u8> },
    /// Drop the socket (`destroy()` in the Electron client).
    Destroy,
}

/// Per-socket state the page cannot see: who asked for the close, so the `close` event matches.
struct Closing {
    code: Option<u16>,
    reason: String,
}

struct SocketHandle {
    writer: mpsc::UnboundedSender<WriteCommand>,
    closer: Arc<Mutex<Closing>>,
    /// Dropped (or fired) to force the read task to finish immediately. It has to be *stored* here:
    /// a sender that is only kept alive by the write task cannot wake the reader from
    /// [`TcpBridge::force_close`], which was the point of the channel.
    force: Option<watch::Sender<bool>>,
    /// Identity of this socket. A read task retires only the handle it was started for, so a
    /// reconnected id is never removed by the previous connection's reader.
    token: u64,
    /// `None` only in unit tests; every real handle owns its writer task.
    write_task: Option<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Default)]
pub struct TcpBridge {
    sockets: Mutex<HashMap<String, SocketHandle>>,
    /// Handed out once per connection, so two sockets that reuse an id stay distinguishable.
    next_token: AtomicU64,
}

/// Tauri managed state wrapper, so commands can take `State<'_, TcpState>`.
pub struct TcpState(pub Arc<TcpBridge>);

impl TcpState {
    pub fn new() -> Self {
        Self(Arc::new(TcpBridge::new()))
    }
}

impl Default for TcpState {
    fn default() -> Self {
        Self::new()
    }
}

impl TcpBridge {
    pub fn new() -> Self {
        Self::default()
    }

    /// Validate and start a connection. A rejected endpoint emits `error` + `close 1006`, which is
    /// what the page turns into a failed `WebSocket` open.
    pub async fn connect(self: &Arc<Self>, app: AppHandle, id: String, host: String, port: Value) {
        let host = host.trim().to_string();
        let port = port.as_u64().unwrap_or(0);
        let port = u16::try_from(port).unwrap_or(0);
        if !valid_id(&id)
            || host.is_empty()
            || host.chars().count() > HOST_MAX_CHARS
            || host.chars().any(|c| c.is_whitespace() || c == '/' || c == '\\')
            || port == 0
        {
            emit(&app, json!({ "id": id, "type": "error", "message": "TCP 地址格式不正确" }));
            emit(&app, json!({ "id": id, "type": "close", "code": 1006, "reason": "invalid endpoint" }));
            return;
        }
        // A repeated id replaces the previous socket, as in the Electron client.
        self.kill(&id).await;

        let stream = match TcpStream::connect((host.as_str(), port)).await {
            Ok(stream) => stream,
            Err(error) => {
                emit(&app, json!({ "id": id, "type": "error", "message": tcp_error_message(&error) }));
                emit(&app, json!({ "id": id, "type": "close", "code": 1006, "reason": "" }));
                return;
            }
        };
        let _ = stream.set_nodelay(true);
        let (mut reader, mut writer) = stream.into_split();
        let (tx, mut rx) = mpsc::unbounded_channel::<WriteCommand>();
        let (force_tx, mut force_rx) = watch::channel(false);
        let closer = Arc::new(Mutex::new(Closing { code: None, reason: String::new() }));
        let token = self.next_token.fetch_add(1, Ordering::Relaxed);
        // One sender goes into the handle (so `force_close` can wake the reader) and the write task
        // keeps the other, which it fires when it stops on its own.
        let force_for_handle = force_tx.clone();

        let read_app = app.clone();
        let read_id = id.clone();
        let bridge = Arc::clone(self);
        let write_task = tauri::async_runtime::spawn(async move {
            loop {
                match rx.recv().await {
                    Some(WriteCommand::Frame(body)) => {
                        let framed = frame_bytes(&body);
                        if writer.write_all(&framed).await.is_err() {
                            break;
                        }
                    }
                    Some(WriteCommand::GracefulClose { framed }) => {
                        let _ = writer.write_all(&framed).await;
                        let _ = writer.flush().await;
                        let _ = writer.shutdown().await;
                        // Keep draining so a late `close` from the page cannot reorder behind the FIN.
                        while rx.recv().await.is_some() {}
                        break;
                    }
                    Some(WriteCommand::Destroy) | None => {
                        let _ = writer.shutdown().await;
                        break;
                    }
                }
            }
            let _ = force_tx.send(true);
        });

        {
            let mut sockets = self.sockets.lock().await;
            sockets.insert(
                id.clone(),
                SocketHandle {
                    writer: tx,
                    closer: Arc::clone(&closer),
                    force: Some(force_for_handle),
                    token,
                    write_task: Some(write_task),
                },
            );
        }
        emit(&app, json!({ "id": id, "type": "open" }));

        tauri::async_runtime::spawn(async move {
            let mut buffer: Vec<u8> = Vec::with_capacity(64 * 1024);
            let mut chunk = [0u8; 32 * 1024];
            'read: loop {
                tokio::select! {
                    changed = force_rx.changed() => {
                        if changed.is_err() || *force_rx.borrow() {
                            break;
                        }
                    }
                    read = reader.read(&mut chunk) => {
                        match read {
                            Ok(0) | Err(_) => break,
                            Ok(count) => buffer.extend_from_slice(&chunk[..count]),
                        }
                    }
                }
                loop {
                    if buffer.len() < 4 {
                        break;
                    }
                    let length = u32::from_be_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]) as usize;
                    if length == 0 || length > FRAME_MAX_BYTES {
                        let mut state = closer.lock().await;
                        state.code = Some(1006);
                        state.reason = "invalid frame".to_string();
                        drop(state);
                        bridge.force_close(&read_id).await;
                        break 'read;
                    }
                    if buffer.len() < length + 4 {
                        break;
                    }
                    let payload = buffer[4..length + 4].to_vec();
                    buffer.drain(..length + 4);
                    let text = String::from_utf8_lossy(&payload).to_string();
                    if !handle_inbound(&bridge, &read_app, &read_id, &text).await {
                        // A `_sp: close` frame from the server: the tail below emits the close event.
                        break 'read;
                    }
                }
            }
            let (code, reason) = {
                let state = closer.lock().await;
                (state.code.unwrap_or(1006), state.reason.clone())
            };
            // Retire only the handle this reader was started for: a reconnect under the same id must
            // keep both its socket and its `close` event.
            if bridge.retire(&read_id, token).await {
                emit(&read_app, json!({ "id": read_id, "type": "close", "code": code, "reason": reason }));
            }
        });
    }

    /// Queue a text frame. The caller has already validated the frame size.
    pub async fn send(&self, id: &str, data: &str) {
        let handle = {
            let sockets = self.sockets.lock().await;
            sockets.get(id).map(|handle| (handle.writer.clone(), Arc::clone(&handle.closer)))
        };
        let Some((writer, _)) = handle else {
            // Unknown id (an already closed socket): the page ignores the write, as before.
            return;
        };
        let _ = writer.send(WriteCommand::Frame(data.as_bytes().to_vec()));
    }

    /// Send the explicit `{"_sp":"close",…}` control frame and let the server finish the close.
    pub async fn request_close(&self, id: &str, code: u16, reason: &str) {
        let handle = {
            let sockets = self.sockets.lock().await;
            sockets.get(id).map(|handle| (handle.writer.clone(), Arc::clone(&handle.closer)))
        };
        let Some((writer, closer)) = handle else {
            return;
        };
        {
            let mut state = closer.lock().await;
            state.code = Some(code);
            state.reason = truncate(reason, REASON_MAX_CHARS);
        }
        let control = json!({ "_sp": "close", "code": code, "reason": truncate(reason, REASON_MAX_CHARS) });
        let _ = writer.send(WriteCommand::GracefulClose { framed: frame(&control.to_string()) });
    }

    /// Tear a socket down immediately (an invalid inbound frame, a repeated id, window teardown).
    pub async fn force_close(&self, id: &str) {
        let handle = self.take(id).await;
        let Some(handle) = handle else {
            return;
        };
        if let Some(force) = handle.force {
            let _ = force.send(true);
        }
        let _ = handle.writer.send(WriteCommand::Destroy);
        if let Some(task) = handle.write_task {
            let _ = tokio::time::timeout(FORCE_GRACE, task).await;
        }
    }

    /// Drop a socket without asking the server, used when the window goes away.
    pub async fn destroy_all(&self) {
        let handles = {
            let mut sockets = self.sockets.lock().await;
            sockets.drain().map(|(_, handle)| handle).collect::<Vec<_>>()
        };
        for handle in handles {
            if let Some(force) = handle.force {
                let _ = force.send(true);
            }
            let _ = handle.writer.send(WriteCommand::Destroy);
        }
    }

    async fn kill(&self, id: &str) {
        if let Some(handle) = self.take(id).await {
            if let Some(force) = handle.force {
                let _ = force.send(true);
            }
            let _ = handle.writer.send(WriteCommand::Destroy);
            if let Some(task) = handle.write_task {
                let _ = tokio::time::timeout(FORCE_GRACE, task).await;
            }
        }
    }

    async fn take(&self, id: &str) -> Option<SocketHandle> {
        let mut sockets = self.sockets.lock().await;
        sockets.remove(id)
    }

    /// Retire the socket a read task was started for. `true` means this read task still speaks for
    /// the id, so it may emit the `close` event; `false` means a reconnect already replaced the
    /// handle under the same id, which the old task must neither remove nor close.
    async fn retire(&self, id: &str, token: u64) -> bool {
        let mut sockets = self.sockets.lock().await;
        match sockets.get(id) {
            Some(handle) if handle.token != token => false,
            Some(_) => {
                sockets.remove(id);
                true
            }
            None => true,
        }
    }
}

/// Interpret one inbound frame. Returns `false` when the read task must stop.
async fn handle_inbound(bridge: &Arc<TcpBridge>, app: &AppHandle, id: &str, text: &str) -> bool {
    let control = serde_json::from_str::<Value>(text).ok();
    let marker = control
        .as_ref()
        .and_then(|value| value.get("_sp"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    match marker.as_deref() {
        Some("ping") => {
            if let Some(handle) = bridge.sockets.lock().await.get(id) {
                let _ = handle.writer.send(WriteCommand::Frame(b"{\"_sp\":\"pong\"}".to_vec()));
            }
            true
        }
        Some("close") => {
            // The server asked for the close; remember its code so the single `close` event the
            // read task emits carries the server's answer, not a synthetic one.
            let code = control
                .as_ref()
                .and_then(|value| value.get("code"))
                .and_then(|value| value.as_u64())
                .unwrap_or(1000)
                .min(u64::from(u16::MAX)) as u16;
            let reason = truncate(
                control
                    .as_ref()
                    .and_then(|value| value.get("reason"))
                    .and_then(|value| value.as_str())
                    .unwrap_or(""),
                REASON_MAX_CHARS,
            );
            let closer = {
                let sockets = bridge.sockets.lock().await;
                sockets.get(id).map(|handle| Arc::clone(&handle.closer))
            };
            if let Some(closer) = closer {
                let mut closing = closer.lock().await;
                closing.code = Some(code);
                closing.reason = reason;
            }
            if let Some(handle) = bridge.take(id).await {
                let _ = handle.writer.send(WriteCommand::Destroy);
            }
            let _ = app;
            // Stop reading: the socket is gone and the read loop's tail emits the close event.
            false
        }
        _ => {
            emit(app, json!({ "id": id, "type": "message", "data": text }));
            true
        }
    }
}

/// Big-endian `u32` length prefix + body bytes.
pub fn frame_bytes(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&u32::try_from(body.len()).unwrap_or(u32::MAX).to_be_bytes());
    out.extend_from_slice(body);
    out
}

/// Big-endian `u32` length prefix + UTF-8 body, for tests and control frames.
pub fn frame(text: &str) -> Vec<u8> {
    frame_bytes(text.as_bytes())
}

/// Rebuild the bytes a page handed us as a JSON number array, refusing an empty or oversized frame.
pub fn decode_page_bytes(values: &[Value]) -> Result<Vec<u8>, ()> {
    if values.is_empty() || values.len() > FRAME_MAX_BYTES {
        return Err(());
    }
    let mut out = Vec::with_capacity(values.len());
    for value in values {
        let byte = value.as_u64().ok_or(())?;
        out.push(u8::try_from(byte).map_err(|_| ())?);
    }
    Ok(out)
}

/// `^[a-z0-9-]{1,80}$`, case-insensitive: the socket ids the page generates.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= ID_MAX_CHARS
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn truncate(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

/// A stable, page-safe error string; the Electron client forwarded `err.message` the same way.
fn tcp_error_message(error: &std::io::Error) -> String {
    let text = error.to_string();
    if text.is_empty() {
        "TCP connection error".to_string()
    } else {
        text
    }
}

fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit(EVENT_NAME, payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_use_a_big_endian_length_prefix() {
        assert_eq!(frame("hi"), vec![0, 0, 0, 2, b'h', b'i']);
        assert_eq!(frame(""), vec![0, 0, 0, 0]);
        let framed = frame("{}");
        assert_eq!(&framed[..4], &[0, 0, 0, 2]);
        assert_eq!(&framed[4..], b"{}");
        // The pong control frame the bridge answers `_sp: ping` with.
        assert_eq!(frame_bytes(b"{\"_sp\":\"pong\"}")[4..], *b"{\"_sp\":\"pong\"}");
    }

    #[test]
    fn socket_ids_are_restricted_to_the_page_alphabet() {
        assert!(valid_id("tcp-abc-1"));
        assert!(valid_id("tcp-lx1-2z"));
        assert!(valid_id("A"));
        assert!(!valid_id(""));
        assert!(!valid_id("tcp abc"));
        assert!(!valid_id("tcp/abc"));
        assert!(!valid_id("tcp.abc"));
        assert!(!valid_id(&"a".repeat(ID_MAX_CHARS + 1)));
    }

    #[test]
    fn page_bytes_round_trip_and_reject_junk() {
        let values: Vec<Value> = vec![json!(0), json!(1), json!(255)];
        assert_eq!(decode_page_bytes(&values).unwrap(), vec![0u8, 1, 255]);
        assert!(decode_page_bytes(&[]).is_err());
        assert!(decode_page_bytes(&[json!(256)]).is_err());
        assert!(decode_page_bytes(&[json!(-1)]).is_err());
        assert!(decode_page_bytes(&[json!("x")]).is_err());
    }

    #[test]
    fn reasons_are_truncated_to_the_page_limit() {
        assert_eq!(truncate("abcdef", 3), "abc");
        assert_eq!(truncate("abc", 10), "abc");
        assert_eq!(truncate("卫戍协议", 2), "卫戍");
    }

    /// A handle with no writer task, so the close paths can be driven without a real socket.
    fn test_socket(
        token: u64,
    ) -> (
        SocketHandle,
        watch::Receiver<bool>,
        mpsc::UnboundedReceiver<WriteCommand>,
    ) {
        let (writer, writes) = mpsc::unbounded_channel();
        let (force, forced) = watch::channel(false);
        let handle = SocketHandle {
            writer,
            closer: Arc::new(Mutex::new(Closing { code: None, reason: String::new() })),
            force: Some(force),
            token,
            write_task: None,
        };
        (handle, forced, writes)
    }

    #[tokio::test]
    async fn force_close_fires_the_sender_stored_in_the_handle() {
        let bridge = Arc::new(TcpBridge::new());
        let (handle, forced, mut writes) = test_socket(1);
        bridge.sockets.lock().await.insert("tcp-1".to_string(), handle);

        bridge.force_close("tcp-1").await;

        // The reader is woken by the value, not merely by the sender being dropped. `borrow()` is the
        // same read the read loop performs right after `changed()`, so a stored-but-unfired sender
        // fails here instead of passing on channel bookkeeping.
        assert!(*forced.borrow(), "force close must store `true` in the watch channel");
        assert!(matches!(writes.recv().await, Some(WriteCommand::Destroy)));
        assert!(bridge.sockets.lock().await.is_empty(), "force close removes the handle");
    }

    /// The read task in `connect` waits in `select!` on `force_rx.changed()` and then inspects the
    /// value. This drives that exact wait, so a sender that is only stored — never fired — leaves the
    /// task parked and the timeout fails the test: an unfired sender can never pass by accident.
    #[tokio::test]
    async fn force_close_wakes_a_reader_task_selecting_on_the_force_channel() {
        let bridge = Arc::new(TcpBridge::new());
        let (handle, mut reader_side, _writes) = test_socket(1);
        let observer = reader_side.clone();
        bridge.sockets.lock().await.insert("tcp-1".to_string(), handle);

        let reader = tokio::spawn(async move {
            let changed = reader_side.changed().await;
            changed.is_err() || *reader_side.borrow()
        });

        bridge.force_close("tcp-1").await;

        let woke = tokio::time::timeout(Duration::from_secs(2), reader)
            .await
            .expect("the read task must wake when the force sender fires")
            .expect("the read task must not panic");
        assert!(woke, "the read task must leave its select arm after the force close");
        assert!(*observer.borrow(), "the wake must carry `true`, not just a closed channel");
    }

    #[tokio::test]
    async fn destroy_all_fires_every_stored_sender() {
        let bridge = Arc::new(TcpBridge::new());
        let (first, first_forced, mut first_writes) = test_socket(1);
        let (second, second_forced, mut second_writes) = test_socket(2);
        {
            let mut sockets = bridge.sockets.lock().await;
            sockets.insert("tcp-1".to_string(), first);
            sockets.insert("tcp-2".to_string(), second);
        }

        bridge.destroy_all().await;

        // Both handles must carry the fired value; the read loop breaks on `*force_rx.borrow()`.
        assert!(*first_forced.borrow(), "destroy_all must fire the first stored sender");
        assert!(*second_forced.borrow(), "destroy_all must fire the second stored sender");
        assert!(matches!(first_writes.recv().await, Some(WriteCommand::Destroy)));
        assert!(matches!(second_writes.recv().await, Some(WriteCommand::Destroy)));
        assert!(bridge.sockets.lock().await.is_empty());
    }

    #[tokio::test]
    async fn a_reconnect_survives_the_previous_read_task_retiring() {
        let bridge = Arc::new(TcpBridge::new());
        let (old, _old_forced, _old_writes) = test_socket(1);
        let (new, _new_forced, _new_writes) = test_socket(2);

        // `connect` with a repeated id takes the old handle out of the map before inserting the new
        // one; the old reader is still running and reaches its tail afterwards.
        bridge.sockets.lock().await.insert("tcp-1".to_string(), old);
        let stale = bridge.take("tcp-1").await.expect("the first socket");
        assert_eq!(stale.token, 1);
        drop(stale);
        bridge.sockets.lock().await.insert("tcp-1".to_string(), new);

        assert!(
            !bridge.retire("tcp-1", 1).await,
            "a replaced id must not be retired (or closed) by the old read task"
        );
        let owner = bridge.sockets.lock().await.get("tcp-1").map(|handle| handle.token);
        assert_eq!(owner, Some(2), "the reconnected socket must stay registered");

        assert!(bridge.retire("tcp-1", 2).await, "the current owner retires its own handle");
        assert!(bridge.sockets.lock().await.is_empty());

        // A handle already taken out of the map (a forced close) still reports ownership, so the
        // read task emits the single close event the page expects.
        assert!(bridge.retire("tcp-1", 3).await, "an absent id still closes");
    }

    #[test]
    fn socket_tokens_are_handed_out_once_per_connection() {
        let bridge = TcpBridge::new();
        let first = bridge.next_token.fetch_add(1, Ordering::Relaxed);
        let second = bridge.next_token.fetch_add(1, Ordering::Relaxed);
        assert_ne!(first, second);
    }
}
