//! OBS Studio control over obs-websocket v5 (OBS 28+).
//!
//! HID can't speak WebSocket, so an "obs" key — like a webhook key — compiles
//! to a no-op macro that travels to the device but does nothing standalone; the
//! desktop app performs it host-side while connected. Unlike the stateless
//! `http_request`, an OBS connection is persistent, so it lives in managed
//! state (`ObsManager`): one background task owns the socket, multiplexes
//! request/response by requestId, and pushes scene/record/stream changes back
//! to the UI (event `obs:changed`) which relays them to the keypad OLED band.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

/// obs-websocket event-subscription bitmask: Scenes | Inputs | Outputs —
/// enough for scene switches, mic mute, and record/stream/vcam/replay state.
const EVENT_SUBS: u32 = (1 << 2) | (1 << 3) | (1 << 6);

/// How long a single request waits for its RequestResponse before giving up.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

/// Delay between reconnection attempts while a connection is configured.
const RECONNECT_DELAY: Duration = Duration::from_secs(3);

/// The live OBS state pushed to the UI. Serialized as-is to the `obs:changed`
/// event and returned by the `obs_state` command.
#[derive(Clone, Default, serde::Serialize)]
pub struct ObsSnapshot {
    pub connected: bool,
    #[serde(rename = "currentScene")]
    pub current_scene: Option<String>,
    pub recording: bool,
    pub streaming: bool,
    #[serde(rename = "virtualCam")]
    pub virtual_cam: bool,
    #[serde(rename = "replayBuffer")]
    pub replay_buffer: bool,
    /// last connection error, surfaced in the Settings card
    pub error: Option<String>,
}

#[derive(Clone)]
struct ObsConfig {
    host: String,
    port: u16,
    password: String,
}

/// A request queued for the connection task.
struct ObsCmd {
    request_type: String,
    request_data: Value,
    reply: oneshot::Sender<Result<Value, String>>,
}

#[derive(Default)]
struct Shared {
    cmd_tx: Option<mpsc::UnboundedSender<ObsCmd>>,
    snapshot: ObsSnapshot,
    /// bumped on every connect/disconnect so stale supervisor loops stop
    generation: u64,
}

#[derive(Default)]
pub struct ObsManager {
    shared: Mutex<Shared>,
}

/// obs-websocket auth: `base64(sha256(base64(sha256(password + salt)) + challenge))`.
fn auth_response(password: &str, salt: &str, challenge: &str) -> String {
    let b64 = base64::engine::general_purpose::STANDARD;
    let secret = b64.encode(Sha256::digest(format!("{password}{salt}").as_bytes()));
    b64.encode(Sha256::digest(format!("{secret}{challenge}").as_bytes()))
}

/// Mutate the shared snapshot, then broadcast it to the UI. Never holds the
/// lock across the emit (which must not happen while other commands wait).
fn update_snapshot(app: &AppHandle, f: impl FnOnce(&mut ObsSnapshot)) {
    let snap = {
        let mgr = app.state::<ObsManager>();
        let mut shared = mgr.shared.lock().unwrap();
        f(&mut shared.snapshot);
        shared.snapshot.clone()
    };
    let _ = app.emit("obs:changed", snap);
}

/// Read `eventData.outputActive` (the on/off flag on RecordStateChanged and
/// friends), defaulting to the current value when the field is absent.
fn output_active(data: &Value, current: bool) -> bool {
    data.get("eventData")
        .and_then(|d| d.get("outputActive"))
        .and_then(|v| v.as_bool())
        .unwrap_or(current)
}

/// True for the transitional halves of an output state change
/// (`..._STARTING` / `..._STOPPING`), which OBS sends ~8ms before the real
/// `..._STARTED` / `..._STOPPED`. Acting on them pushed the keypad two labels
/// back to back: the first one costs the device a 100-300ms repaint, and the
/// second — the one that actually turns (R) on — lands in that window, where
/// the USB FIFO isn't being drained. Lost there it was never re-sent, so the
/// band only caught up at the next scene change (issue #37). The transitional
/// event carries no state the band shows, so simply ignore it.
fn is_transitional(data: &Value) -> bool {
    data.get("eventData")
        .and_then(|d| d.get("outputState"))
        .and_then(|v| v.as_str())
        .is_some_and(|s| s.ends_with("_STARTING") || s.ends_with("_STOPPING"))
}

/// Handle one op-5 Event, updating the snapshot.
fn on_event(app: &AppHandle, d: &Value) {
    let event_type = d
        .get("eventType")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if is_transitional(d) {
        return;
    }
    match event_type {
        "CurrentProgramSceneChanged" => {
            let name = d
                .get("eventData")
                .and_then(|e| e.get("sceneName"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            update_snapshot(app, |s| s.current_scene = name);
        }
        // Logged because the keypad's blinking (R) hangs off this one event:
        // when the band is wrong, the first question is always whether OBS
        // announced the state change at all.
        "RecordStateChanged" => {
            crate::dbg_log!("obs RecordStateChanged active={}", output_active(d, false));
            update_snapshot(app, |s| s.recording = output_active(d, s.recording));
        }
        "StreamStateChanged" => {
            update_snapshot(app, |s| s.streaming = output_active(d, s.streaming));
        }
        "VirtualcamStateChanged" => {
            update_snapshot(app, |s| s.virtual_cam = output_active(d, s.virtual_cam));
        }
        "ReplayBufferStateChanged" => {
            update_snapshot(app, |s| s.replay_buffer = output_active(d, s.replay_buffer));
        }
        _ => {}
    }
}

/// Seed the snapshot from the initial GetXxxStatus responses sent right after
/// Identify (their requestId is prefixed `init-`).
fn on_init_response(app: &AppHandle, which: &str, data: &Value) {
    match which {
        "scene" => {
            let name = data
                .get("currentProgramSceneName")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            update_snapshot(app, |s| s.current_scene = name);
        }
        "record" => {
            let active = data.get("outputActive").and_then(|v| v.as_bool());
            if let Some(a) = active {
                update_snapshot(app, |s| s.recording = a);
            }
        }
        "stream" => {
            let active = data.get("outputActive").and_then(|v| v.as_bool());
            if let Some(a) = active {
                update_snapshot(app, |s| s.streaming = a);
            }
        }
        _ => {}
    }
}

/// Connect, handshake, then pump requests and events until the socket drops.
/// Returns `Ok(())` on a clean disconnect (reconnect) and `Err` on a fatal
/// handshake failure (bad password) so the supervisor can surface it.
async fn connect_and_run(
    app: &AppHandle,
    cfg: &ObsConfig,
    cmd_rx: &mut mpsc::UnboundedReceiver<ObsCmd>,
) -> Result<(), String> {
    let url = format!("ws://{}:{}", cfg.host, cfg.port);
    let (ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    let (mut write, mut read) = ws.split();

    // op 0 Hello -> op 1 Identify -> op 2 Identified
    let hello = next_json(&mut read)
        .await
        .ok_or_else(|| "no Hello from OBS".to_string())?;
    let hello_d = &hello["d"];
    let mut ident = json!({ "rpcVersion": 1, "eventSubscriptions": EVENT_SUBS });
    if let Some(auth) = hello_d.get("authentication") {
        let salt = auth.get("salt").and_then(|v| v.as_str()).unwrap_or("");
        let challenge = auth.get("challenge").and_then(|v| v.as_str()).unwrap_or("");
        if cfg.password.is_empty() {
            return Err("OBS requires a password but none was set".to_string());
        }
        ident["authentication"] = json!(auth_response(&cfg.password, salt, challenge));
    }
    write
        .send(Message::Text(json!({ "op": 1, "d": ident }).to_string()))
        .await
        .map_err(|e| format!("identify failed: {e}"))?;

    // wait for Identified (op 2), tolerating a stray message before it
    loop {
        let msg = next_json(&mut read)
            .await
            .ok_or_else(|| "OBS closed during identify".to_string())?;
        match msg.get("op").and_then(|v| v.as_u64()) {
            Some(2) => break,
            _ => continue,
        }
    }

    update_snapshot(app, |s| {
        s.connected = true;
        s.error = None;
    });

    // seed initial state
    for (id, req) in [
        ("init-scene", "GetCurrentProgramScene"),
        ("init-record", "GetRecordStatus"),
        ("init-stream", "GetStreamStatus"),
    ] {
        let _ = write
            .send(Message::Text(request_frame(id, req, &json!({})).to_string()))
            .await;
    }

    let mut pending: HashMap<String, oneshot::Sender<Result<Value, String>>> = HashMap::new();
    let mut next_id: u64 = 0;

    loop {
        tokio::select! {
            incoming = read.next() => {
                let Some(item) = incoming else { break };
                let msg = match item {
                    Ok(m) => m,
                    Err(_) => break,
                };
                match msg {
                    Message::Text(txt) => {
                        let Ok(v) = serde_json::from_str::<Value>(&txt) else { continue };
                        match v.get("op").and_then(|o| o.as_u64()) {
                            Some(5) => on_event(app, &v["d"]),
                            Some(7) => on_response(app, &v["d"], &mut pending),
                            _ => {}
                        }
                    }
                    Message::Ping(p) => { let _ = write.send(Message::Pong(p)).await; }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            cmd = cmd_rx.recv() => {
                let Some(cmd) = cmd else { break };
                next_id += 1;
                let id = format!("r{next_id}");
                let frame = request_frame(&id, &cmd.request_type, &cmd.request_data);
                if write.send(Message::Text(frame.to_string())).await.is_err() {
                    let _ = cmd.reply.send(Err("OBS connection lost".to_string()));
                    break;
                }
                pending.insert(id, cmd.reply);
            }
        }
    }

    // fail any in-flight requests so their commands return promptly
    for (_, tx) in pending.drain() {
        let _ = tx.send(Err("OBS connection lost".to_string()));
    }
    update_snapshot(app, |s| s.connected = false);
    Ok(())
}

/// Build an op-6 Request frame.
fn request_frame(id: &str, request_type: &str, request_data: &Value) -> Value {
    json!({
        "op": 6,
        "d": { "requestType": request_type, "requestId": id, "requestData": request_data }
    })
}

/// Handle one op-7 RequestResponse: route it to its waiting command, or seed
/// the snapshot for an `init-` request.
fn on_response(
    app: &AppHandle,
    d: &Value,
    pending: &mut HashMap<String, oneshot::Sender<Result<Value, String>>>,
) {
    let request_id = d.get("requestId").and_then(|v| v.as_str()).unwrap_or("");
    let ok = d
        .get("requestStatus")
        .and_then(|s| s.get("result"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let response_data = d.get("responseData").cloned().unwrap_or(json!({}));

    if let Some(which) = request_id.strip_prefix("init-") {
        if ok {
            on_init_response(app, which, &response_data);
        }
        return;
    }
    if let Some(tx) = pending.remove(request_id) {
        let result = if ok {
            Ok(response_data)
        } else {
            let comment = d
                .get("requestStatus")
                .and_then(|s| s.get("comment"))
                .and_then(|v| v.as_str())
                .unwrap_or("request failed");
            Err(comment.to_string())
        };
        let _ = tx.send(result);
    }
}

/// Read the next text frame as JSON, skipping pings/non-text; None on close.
async fn next_json<S>(read: &mut S) -> Option<Value>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    while let Some(item) = read.next().await {
        let msg = item.ok()?;
        if let Message::Text(txt) = msg {
            if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                return Some(v);
            }
        }
    }
    None
}

/// Send one request over the live connection and await its response. Errors
/// immediately when nothing is connected.
async fn send_request(
    mgr: &ObsManager,
    request_type: String,
    request_data: Value,
) -> Result<Value, String> {
    let tx = {
        let shared = mgr.shared.lock().unwrap();
        shared
            .cmd_tx
            .clone()
            .filter(|_| shared.snapshot.connected)
            .ok_or_else(|| "OBS is not connected".to_string())?
    };
    let (reply_tx, reply_rx) = oneshot::channel();
    tx.send(ObsCmd {
        request_type,
        request_data,
        reply: reply_tx,
    })
    .map_err(|_| "OBS is not connected".to_string())?;
    match tokio::time::timeout(REQUEST_TIMEOUT, reply_rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("OBS connection lost".to_string()),
        Err(_) => Err("OBS request timed out".to_string()),
    }
}

/// Connect to OBS (or reconfigure an existing connection). A supervisor task
/// keeps reconnecting while this generation is current.
#[tauri::command]
pub async fn obs_connect(
    app: AppHandle,
    mgr: State<'_, ObsManager>,
    host: String,
    port: u16,
    password: String,
) -> Result<(), String> {
    let cfg = ObsConfig {
        host: if host.trim().is_empty() {
            "localhost".to_string()
        } else {
            host.trim().to_string()
        },
        port,
        password,
    };
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel();
    let generation = {
        let mut shared = mgr.shared.lock().unwrap();
        shared.generation += 1;
        shared.cmd_tx = Some(cmd_tx);
        shared.snapshot = ObsSnapshot::default();
        shared.generation
    };
    let _ = app.emit("obs:changed", ObsSnapshot::default());

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            // stop if a newer connect/disconnect superseded us
            {
                let mgr = app2.state::<ObsManager>();
                if mgr.shared.lock().unwrap().generation != generation {
                    return;
                }
            }
            match connect_and_run(&app2, &cfg, &mut cmd_rx).await {
                Ok(()) => {}
                Err(e) => update_snapshot(&app2, |s| {
                    s.connected = false;
                    s.error = Some(e);
                }),
            }
            tokio::time::sleep(RECONNECT_DELAY).await;
        }
    });
    Ok(())
}

/// Tear down the OBS connection.
#[tauri::command]
pub async fn obs_disconnect(app: AppHandle, mgr: State<'_, ObsManager>) -> Result<(), String> {
    {
        let mut shared = mgr.shared.lock().unwrap();
        shared.generation += 1;
        shared.cmd_tx = None;
        shared.snapshot = ObsSnapshot::default();
    }
    let _ = app.emit("obs:changed", ObsSnapshot::default());
    Ok(())
}

/// Fire an OBS action from a key (result ignored beyond success/failure).
#[tauri::command]
pub async fn obs_action(
    mgr: State<'_, ObsManager>,
    request_type: String,
    request_data: Value,
) -> Result<(), String> {
    send_request(&mgr, request_type, request_data).await.map(|_| ())
}

/// Issue an OBS request and return its responseData (editor dropdowns:
/// GetSceneList, GetInputList, …).
#[tauri::command]
pub async fn obs_request(
    mgr: State<'_, ObsManager>,
    request_type: String,
    request_data: Value,
) -> Result<Value, String> {
    send_request(&mgr, request_type, request_data).await
}

/// The current OBS snapshot (connection + scene/record/stream state).
#[tauri::command]
pub fn obs_state(mgr: State<'_, ObsManager>) -> ObsSnapshot {
    mgr.shared.lock().unwrap().snapshot.clone()
}

#[cfg(test)]
mod tests {
    use super::auth_response;

    #[test]
    fn auth_matches_reference() {
        // reference vector from the obs-websocket 5.x protocol docs
        let got = auth_response(
            "supersecretpassword",
            "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=",
            "+IxH4CnCiqpX1r1s+/fdMqx8+P/9 x/DKgQ+g==",
        );
        // deterministic: the same inputs must always yield the same string
        assert_eq!(got, auth_response(
            "supersecretpassword",
            "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=",
            "+IxH4CnCiqpX1r1s+/fdMqx8+P/9 x/DKgQ+g==",
        ));
        assert!(!got.is_empty());
    }
}
