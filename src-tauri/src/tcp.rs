use std::{collections::HashMap, sync::Arc};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpStream, sync::{mpsc, Mutex}};

const FRAME_MAX: usize = 64 * 1024;

enum Outbound { Frame(Vec<u8>), Close(u16, String) }

#[derive(Default)]
pub struct TcpState { sockets: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Outbound>>>> }

impl TcpState {
    pub async fn connect(&self, app: AppHandle, id: String, host: String, port: u16) -> Result<(), String> {
        if id.is_empty() || id.len() > 96 || port == 0 { return Err("invalid TCP endpoint".into()); }
        self.close(&id, 1000, String::new()).await.ok();
        let (tx, mut rx) = mpsc::unbounded_channel();
        self.sockets.lock().await.insert(id.clone(), tx);
        let sockets = Arc::clone(&self.sockets);
        tauri::async_runtime::spawn(async move {
            let stream = match TcpStream::connect((host.as_str(), port)).await {
                Ok(stream) => stream,
                Err(error) => { emit(&app, &id, "error", json!({ "message": error.to_string() })); emit(&app, &id, "close", json!({ "code": 1006, "reason": "connect failed" })); sockets.lock().await.remove(&id); return; }
            };
            let (mut reader, mut writer) = stream.into_split();
            emit(&app, &id, "open", json!({}));
            let writer_id = id.clone();
            let writer_app = app.clone();
            let writer_task = tauri::async_runtime::spawn(async move {
                while let Some(command) = rx.recv().await {
                    match command {
                        Outbound::Frame(data) => {
                            let size = (data.len() as u32).to_be_bytes();
                            if writer.write_all(&size).await.is_err() || writer.write_all(&data).await.is_err() { break; }
                        }
                        Outbound::Close(code, reason) => {
                            let body = json!({ "_sp": "close", "code": code, "reason": reason }).to_string().into_bytes();
                            let _ = writer.write_all(&(body.len() as u32).to_be_bytes()).await;
                            let _ = writer.write_all(&body).await;
                            let _ = writer.shutdown().await;
                            break;
                        }
                    }
                }
                let _ = writer_app;
                let _ = writer_id;
            });
            loop {
                let size = match reader.read_u32().await { Ok(value) => value as usize, Err(_) => break };
                if size == 0 || size > FRAME_MAX { emit(&app, &id, "error", json!({ "message": "invalid TCP frame" })); break; }
                let mut body = vec![0; size];
                if reader.read_exact(&mut body).await.is_err() { break; }
                match String::from_utf8(body) {
                    Ok(data) => emit(&app, &id, "message", json!({ "data": data })),
                    Err(_) => { emit(&app, &id, "error", json!({ "message": "non-UTF8 TCP frame" })); break; }
                }
            }
            writer_task.abort();
            sockets.lock().await.remove(&id);
            emit(&app, &id, "close", json!({ "code": 1006, "reason": "connection closed" }));
        });
        Ok(())
    }

    pub async fn send(&self, id: &str, data: Vec<u8>) -> Result<(), String> {
        if data.is_empty() || data.len() > FRAME_MAX { return Err("invalid TCP frame".into()); }
        self.sockets.lock().await.get(id).ok_or_else(|| "TCP socket not found".to_string())?.send(Outbound::Frame(data)).map_err(|_| "TCP socket closed".to_string())
    }

    pub async fn close(&self, id: &str, code: u16, reason: String) -> Result<(), String> {
        if let Some(sender) = self.sockets.lock().await.remove(id) { let _ = sender.send(Outbound::Close(code, reason.chars().take(120).collect())); }
        Ok(())
    }
}

fn emit(app: &AppHandle, id: &str, kind: &str, extra: serde_json::Value) {
    let mut payload = extra;
    if let Some(object) = payload.as_object_mut() { object.insert("id".to_string(), json!(id)); object.insert("type".to_string(), json!(kind)); }
    let _ = app.emit("sp-tcp-event", payload);
}
