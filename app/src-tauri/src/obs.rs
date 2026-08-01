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

/// InputVolumeMeters is a "high-volume" event group OBS only sends when asked:
/// ~20 frames/s of per-input levels. Subscribed only while an OBS Center
/// session runs (obs_live_start), dropped again on obs_live_stop — nobody
/// needs a 20Hz firehose to keep a Settings card green.
const METER_SUB: u32 = 1 << 16;

/// How long a single request waits for its RequestResponse before giving up.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

/// Delay between reconnection attempts while a connection is configured.
const RECONNECT_DELAY: Duration = Duration::from_secs(3);

/// How often the live session polls GetRecordStatus / GetStreamStatus /
/// GetStats. The OLED health row quotes these numbers, and 2s matches the
/// sysvol precedent for "live but not frantic".
const LIVE_POLL: Duration = Duration::from_secs(2);

/// Minimum gap between mic-level emits. OBS sends meter frames at ~20Hz; the
/// OLED bar has 14 segments, so anything faster than ~3Hz is invisible and
/// only costs serial lines on the far side.
const METER_GAP: Duration = Duration::from_millis(330);

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

/// The live-session numbers pushed while an OBS Center is open, event
/// `obs:live`. Every field is optional: each emit carries only what just
/// changed (a meter frame is `{micPct}`, a stats tick is `{cpu,fps,...}`),
/// and the frontend merges them into its own view of the session.
#[derive(Clone, Default, serde::Serialize)]
pub struct ObsLive {
    #[serde(rename = "recSecs", skip_serializing_if = "Option::is_none")]
    pub rec_secs: Option<u64>,
    #[serde(rename = "streamSecs", skip_serializing_if = "Option::is_none")]
    pub stream_secs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dropped: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(rename = "micPct", skip_serializing_if = "Option::is_none")]
    pub mic_pct: Option<u32>,
    #[serde(rename = "micMuted", skip_serializing_if = "Option::is_none")]
    pub mic_muted: Option<bool>,
}

#[derive(Clone)]
struct ObsConfig {
    host: String,
    port: u16,
    password: String,
}

/// Work queued for the connection task.
enum ObsCmd {
    /// An op-6 request whose response the caller awaits.
    Request {
        request_type: String,
        request_data: Value,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    /// Re-Identify (op 3) with a new event-subscription mask — how the
    /// InputVolumeMeters group is turned on and off mid-connection.
    SetSubs(u32),
}

#[derive(Default)]
struct Shared {
    cmd_tx: Option<mpsc::UnboundedSender<ObsCmd>>,
    snapshot: ObsSnapshot,
    /// bumped on every connect/disconnect so stale supervisor loops stop
    generation: u64,
    /// Some while an OBS Center session runs: which audio input the mic
    /// widgets follow. Read by the connection task on every meter frame and
    /// poll tick, and survives a reconnect (Identify re-applies METER_SUB).
    live_input: Option<Option<String>>,
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

/// Parse an obs-websocket `outputTimecode` ("HH:MM:SS.mmm") into whole
/// seconds. Anything malformed reads as 0 rather than an error — the OLED
/// timer restarting at zero is a visible bug report, a poisoned session isn't.
fn parse_timecode(tc: &str) -> u64 {
    let mut secs: u64 = 0;
    for part in tc.split('.').next().unwrap_or("").split(':') {
        match part.parse::<u64>() {
            Ok(v) => secs = secs * 60 + v,
            Err(_) => return 0,
        }
    }
    secs
}

/// Map a meter multiplier (linear 0..1) to the 0..100 the OLED segment bar
/// quantizes, over a -60dB..0dB window — the same window OBS's own mixer
/// meters use, so the keypad bar moves like the one on screen.
fn mul_to_pct(mul: f64) -> u32 {
    if mul <= 0.0 {
        return 0;
    }
    let db = 20.0 * mul.log10();
    (((db + 60.0) / 60.0).clamp(0.0, 1.0) * 100.0).round() as u32
}

/// The audio input the live session follows, or None when no session runs.
fn live_input(app: &AppHandle) -> Option<Option<String>> {
    let mgr = app.state::<ObsManager>();
    let shared = mgr.shared.lock().unwrap();
    shared.live_input.clone()
}

/// Handle one InputVolumeMeters frame (op 5, high-volume group): pick the
/// session's input, take the loudest channel's current level, and emit it —
/// throttled and quantized to the 14 segments the OLED can actually show.
fn on_meter_frame(app: &AppHandle, d: &Value, last: &mut (std::time::Instant, i64)) {
    let Some(Some(want)) = live_input(app) else { return };
    let inputs = d
        .get("eventData")
        .and_then(|e| e.get("inputs"))
        .and_then(|v| v.as_array());
    let Some(inputs) = inputs else { return };
    let mut mul: f64 = 0.0;
    for inp in inputs {
        let name = inp.get("inputName").and_then(|v| v.as_str()).unwrap_or("");
        if name != want {
            continue;
        }
        if let Some(levels) = inp.get("inputLevelsMul").and_then(|v| v.as_array()) {
            for ch in levels {
                if let Some(cur) = ch.get(0).and_then(|v| v.as_f64()) {
                    if cur > mul {
                        mul = cur;
                    }
                }
            }
        }
        break;
    }
    let pct = mul_to_pct(mul);
    let seg = (pct as i64 * 14 + 50) / 100;
    if seg == last.1 && last.0.elapsed() < Duration::from_secs(2) {
        return; // the bar would not move
    }
    if last.0.elapsed() < METER_GAP {
        return;
    }
    *last = (std::time::Instant::now(), seg);
    let _ = app.emit(
        "obs:live",
        ObsLive {
            mic_pct: Some(pct),
            ..Default::default()
        },
    );
}

/// Seed / refresh the live-session numbers from a `live-` prefixed poll
/// response (GetRecordStatus / GetStreamStatus / GetStats).
fn on_live_response(app: &AppHandle, which: &str, data: &Value) {
    let mut live = ObsLive::default();
    match which {
        "record" => {
            let active = data
                .get("outputActive")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            live.rec_secs = Some(if active {
                parse_timecode(data.get("outputTimecode").and_then(|v| v.as_str()).unwrap_or(""))
            } else {
                0
            });
        }
        "stream" => {
            let active = data
                .get("outputActive")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            live.stream_secs = Some(if active {
                parse_timecode(data.get("outputTimecode").and_then(|v| v.as_str()).unwrap_or(""))
            } else {
                0
            });
            live.dropped = data.get("outputSkippedFrames").and_then(|v| v.as_u64());
            live.total = data.get("outputTotalFrames").and_then(|v| v.as_u64());
        }
        "stats" => {
            live.cpu = data.get("cpuUsage").and_then(|v| v.as_f64());
            live.fps = data.get("activeFps").and_then(|v| v.as_f64());
        }
        _ => return,
    }
    let _ = app.emit("obs:live", live);
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
        // Only relayed while an OBS Center session follows this input — the
        // dashboard's MIC label inverts on mute, and a keypad-fired
        // ToggleInputMute answers through this same event.
        "InputMuteStateChanged" => {
            let Some(Some(want)) = live_input(app) else { return };
            let ed = d.get("eventData");
            let name = ed
                .and_then(|e| e.get("inputName"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if name == want {
                if let Some(m) = ed.and_then(|e| e.get("inputMuted")).and_then(|v| v.as_bool()) {
                    let _ = app.emit(
                        "obs:live",
                        ObsLive {
                            mic_muted: Some(m),
                            ..Default::default()
                        },
                    );
                }
            }
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

    // op 0 Hello -> op 1 Identify -> op 2 Identified. A reconnect while an
    // OBS Center session runs re-applies the meter subscription here, so the
    // dashboard's VU bar survives an OBS restart without a new live_start.
    let subs = if live_input(app).is_some() {
        EVENT_SUBS | METER_SUB
    } else {
        EVENT_SUBS
    };
    let hello = next_json(&mut read)
        .await
        .ok_or_else(|| "no Hello from OBS".to_string())?;
    let hello_d = &hello["d"];
    let mut ident = json!({ "rpcVersion": 1, "eventSubscriptions": subs });
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
    // meter throttle: (last emit, last quantized segment)
    let mut meter_last = (std::time::Instant::now() - METER_GAP, -1i64);
    let mut live_tick = tokio::time::interval(LIVE_POLL);
    live_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

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
                            Some(5) => {
                                let et = v["d"].get("eventType")
                                    .and_then(|t| t.as_str()).unwrap_or("");
                                if et == "InputVolumeMeters" {
                                    // high-volume: handled with local throttle
                                    // state, never reaches on_event
                                    on_meter_frame(app, &v["d"], &mut meter_last);
                                } else {
                                    on_event(app, &v["d"]);
                                }
                            }
                            Some(7) => on_response(app, &v["d"], &mut pending),
                            _ => {}
                        }
                    }
                    Message::Ping(p) => { let _ = write.send(Message::Pong(p)).await; }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            _ = live_tick.tick() => {
                if live_input(app).is_some() {
                    for (id, req) in [
                        ("live-record", "GetRecordStatus"),
                        ("live-stream", "GetStreamStatus"),
                        ("live-stats", "GetStats"),
                    ] {
                        let frame = request_frame(id, req, &json!({}));
                        if write.send(Message::Text(frame.to_string())).await.is_err() {
                            break;
                        }
                    }
                }
            }
            cmd = cmd_rx.recv() => {
                let Some(cmd) = cmd else { break };
                match cmd {
                    ObsCmd::Request { request_type, request_data, reply } => {
                        next_id += 1;
                        let id = format!("r{next_id}");
                        let frame = request_frame(&id, &request_type, &request_data);
                        if write.send(Message::Text(frame.to_string())).await.is_err() {
                            let _ = reply.send(Err("OBS connection lost".to_string()));
                            break;
                        }
                        pending.insert(id, reply);
                    }
                    ObsCmd::SetSubs(mask) => {
                        let frame = json!({ "op": 3, "d": { "eventSubscriptions": mask } });
                        if write.send(Message::Text(frame.to_string())).await.is_err() {
                            break;
                        }
                        if mask & METER_SUB != 0 {
                            // a session just started: pull the first numbers
                            // now instead of waiting out the poll interval
                            for (id, req) in [
                                ("live-record", "GetRecordStatus"),
                                ("live-stream", "GetStreamStatus"),
                                ("live-stats", "GetStats"),
                            ] {
                                let frame = request_frame(id, req, &json!({}));
                                let _ = write.send(Message::Text(frame.to_string())).await;
                            }
                        }
                    }
                }
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
    if let Some(which) = request_id.strip_prefix("live-") {
        if ok {
            on_live_response(app, which, &response_data);
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
    tx.send(ObsCmd::Request {
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

/// Start an OBS Center live session: subscribe to InputVolumeMeters (for
/// `input_name`, when given) and arm the 2s status/stats poll. Idempotent —
/// reopening the dashboard just replaces the followed input.
#[tauri::command]
pub fn obs_live_start(mgr: State<'_, ObsManager>, input_name: Option<String>) {
    let tx = {
        let mut shared = mgr.shared.lock().unwrap();
        shared.live_input = Some(input_name);
        shared.cmd_tx.clone()
    };
    if let Some(tx) = tx {
        let _ = tx.send(ObsCmd::SetSubs(EVENT_SUBS | METER_SUB));
    }
}

/// End the live session: drop the meter subscription and stop polling.
#[tauri::command]
pub fn obs_live_stop(mgr: State<'_, ObsManager>) {
    let tx = {
        let mut shared = mgr.shared.lock().unwrap();
        if shared.live_input.is_none() {
            return; // never started (or already stopped): nothing to undo
        }
        shared.live_input = None;
        shared.cmd_tx.clone()
    };
    if let Some(tx) = tx {
        let _ = tx.send(ObsCmd::SetSubs(EVENT_SUBS));
    }
}

#[cfg(test)]
mod tests {
    use super::{auth_response, mul_to_pct, parse_timecode};

    #[test]
    fn timecode_parses() {
        assert_eq!(parse_timecode("00:00:00.000"), 0);
        assert_eq!(parse_timecode("00:00:07.499"), 7);
        assert_eq!(parse_timecode("01:02:33.123"), 3753);
        assert_eq!(parse_timecode("12:00:00"), 43200);
        // malformed reads as zero, never an error
        assert_eq!(parse_timecode(""), 0);
        assert_eq!(parse_timecode("garbage"), 0);
        assert_eq!(parse_timecode("1:xx:00"), 0);
    }

    #[test]
    fn meter_multiplier_maps_to_percent() {
        assert_eq!(mul_to_pct(0.0), 0);
        assert_eq!(mul_to_pct(-1.0), 0);
        assert_eq!(mul_to_pct(1.0), 100); // 0dB = full scale
        assert_eq!(mul_to_pct(0.001), 0); // -60dB = floor
        let mid = mul_to_pct(0.0316); // ~-30dB
        assert!((45..=55).contains(&mid), "got {mid}");
    }

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
