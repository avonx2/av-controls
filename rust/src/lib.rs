//! Minimal Rust receiver ("artwork" side) for the av-controls websocket broker.
//!
//! The artwork announces a panel of faders to the broker (`pnpm dev:broker`),
//! the av-controls controller UI shows them, and signals come back as values:
//!
//! ```no_run
//! let controls = av_controls::Panel::new("my-artwork")
//!     .section("motion")
//!     .fader("speed", 0.0, 10.0, 2.0)
//!     .fader_with("count", 1.0, 8.0, 4.0, 0)
//!     .switch("auto", false)
//!     .connect("ws://localhost:8080");
//! let speed = controls.get("speed");
//! let auto = controls.on("auto");
//! ```
//!
//! Layout: each section is a row, its name as a label in the first cell, then its
//! controls left to right (rows of 10 cells; controls before any section get a row
//! without a label).
//!
//! `ws://` and `wss://` both work. For `wss://` the broker's certificate is NOT
//! verified: av-controls brokers typically run on a local network with a
//! self-signed certificate. Use the broker's `?password=` for access control.
//!
//! The connection runs on a background thread and reconnects forever, so the
//! artwork works the same with or without a broker (values stay at their
//! defaults). Speaks protocol 1.x: register-receiver, add-net-panel, and
//! control-signal / control-state-patch / control-state-restore wrapped in an
//! av-controls envelope; signals are echoed back as control-update.

use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::TcpStream,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use rustls::{
    ClientConfig, DigitallySignedStruct, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{CryptoProvider, ring, verify_tls12_signature, verify_tls13_signature},
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use tungstenite::{Connector, Message, WebSocket, http::Uri, stream::MaybeTlsStream};

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

/// Accepts any server certificate (self-signed local brokers) but still checks
/// the handshake signatures.
#[derive(Debug)]
struct AnyCertificate(Arc<CryptoProvider>);

impl ServerCertVerifier for AnyCertificate {
    fn verify_server_cert(
        &self,
        _: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// Open a `ws://` or `wss://` connection.
fn open(url: &str) -> Result<Socket, String> {
    let uri: Uri = url.parse().map_err(|e| format!("bad url: {e}"))?;
    let host = uri.host().ok_or("url has no host")?;
    let secure = uri.scheme_str() == Some("wss");
    let port = uri.port_u16().unwrap_or(if secure { 443 } else { 80 });
    let stream = TcpStream::connect((host, port)).map_err(|e| e.to_string())?;
    let provider = Arc::new(ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AnyCertificate(provider)))
        .with_no_client_auth();
    let connector = Connector::Rustls(Arc::new(config));
    tungstenite::client_tls_with_config(url, stream, None, Some(connector))
        .map(|(socket, _)| socket)
        .map_err(|e| e.to_string())
}

/// Set the leaves of a signal tree (`{children: {id: {signal | children}}}`; ids are
/// unique across tabs) and return the matching update tree, if any leaf was known.
fn apply_signal(tree: &Value, values: &mut Values) -> Option<Value> {
    let mut children = serde_json::Map::new();
    for (id, child) in tree["children"].as_object()? {
        // A container (a tab, a group) has children; it may share its id with a control
        // inside it (a tab "city" with a switch "city").
        let leaf = if child["children"].is_object() {
            apply_signal(child, values)
        } else {
            apply_leaf(id, &child["signal"], values).map(|update| json!({ "update": update }))
        };
        if let Some(leaf) = leaf {
            children.insert(id.clone(), leaf);
        }
    }
    (!children.is_empty()).then(|| json!({ "children": children }))
}

/// A control's signal or state (`{value}`, `{on}` or `{position, rotation}`) into its
/// value; the update to echo, None if the id or the shape is unknown.
fn apply_leaf(id: &str, signal: &Value, values: &mut Values) -> Option<Value> {
    if let Some(pose) = values.poses.get_mut(id) {
        return pose.set(signal).then(|| pose.json());
    }
    let slot = values.scalars.get_mut(id)?;
    if let Some(value) = signal["value"].as_f64() {
        *slot = value as f32;
        Some(json!({ "value": value }))
    } else if let Some(on) = signal["on"].as_bool() {
        *slot = if on { 1. } else { 0. };
        Some(json!({ "on": on }))
    } else {
        None
    }
}

/// Set the leaves of a (nested) group state `{states: {id: state}}`.
fn apply_state(state: &Value, values: &mut Values) {
    let Some(states) = state["states"].as_object() else { return };
    for (id, state) in states {
        if state["states"].is_object() {
            apply_state(state, values);
        } else {
            apply_leaf(id, state, values);
        }
    }
}

/// Protocol version stamped on every envelope (same major as @av-controls/protocol).
pub const PROTOCOL: &str = "1.0.0";

#[derive(Clone, Debug)]
pub struct Fader {
    pub id: String,
    pub min: f32,
    pub max: f32,
    pub initial: f32,
    pub decimals: u32,
}

/// A Player3D pose: the controller flies it with WASD and the mouse (-z forward, y up),
/// the position in its own units (moveSpeed per second).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    pub position: [f32; 3],
    /// x, y, z, w
    pub rotation: [f32; 4],
}

impl Default for Pose {
    fn default() -> Self {
        Self { position: [0.; 3], rotation: [0., 0., 0., 1.] }
    }
}

impl Pose {
    /// From a signal or state `{position, rotation}`; false if it has neither.
    fn set(&mut self, value: &Value) -> bool {
        let numbers = |v: &Value| -> Option<Vec<f32>> {
            v.as_array()?.iter().map(|n| n.as_f64().map(|n| n as f32).filter(|n| n.is_finite())).collect()
        };
        let mut changed = false;
        if let Some(p) = numbers(&value["position"]).filter(|p| p.len() == 3) {
            self.position = [p[0], p[1], p[2]];
            changed = true;
        }
        if let Some(q) = numbers(&value["rotation"]).filter(|q| q.len() == 4) {
            self.rotation = [q[0], q[1], q[2], q[3]];
            changed = true;
        }
        changed
    }

    fn json(&self) -> Value {
        json!({ "position": self.position, "rotation": self.rotation })
    }
}

/// The live values: faders and switches as numbers, Player3D poses.
#[derive(Default)]
struct Values {
    scalars: HashMap<String, f32>,
    poses: HashMap<String, Pose>,
}

#[derive(Clone, Debug)]
pub enum Control {
    Fader(Fader),
    /// A camera the controller flies (keyboard and mouse); three cells wide.
    Player3D { id: String, move_speed: f32, look_sensitivity: f32, roll: bool },
    /// On/off; its value reads as 1 or 0.
    Switch { id: String, initial: bool },
    /// Starts a new tab, named.
    Section(String),
}

impl Control {
    fn value(&self) -> Option<(String, f32)> {
        match self {
            Control::Fader(f) => Some((f.id.clone(), f.initial)),
            Control::Switch { id, initial } => Some((id.clone(), if *initial { 1. } else { 0. })),
            Control::Section(_) | Control::Player3D { .. } => None,
        }
    }
}

/// A panel: a named set of controls in tabs (one per section), laid out automatically.
#[derive(Clone, Debug)]
pub struct Panel {
    pub id: String,
    pub controls: Vec<Control>,
}

/// Live values of a connected panel; cheap to clone.
#[derive(Clone)]
pub struct Controls {
    values: Arc<Mutex<Values>>,
}

impl Controls {
    /// Current value of a fader (its initial value until the controller sends one).
    /// Panics if the id was not declared, which is a programming error.
    pub fn get(&self, id: &str) -> f32 {
        *self
            .values
            .lock()
            .unwrap()
            .scalars
            .get(id)
            .unwrap_or_else(|| panic!("av-controls: unknown control {id:?}"))
    }

    /// Current pose of a Player3D (identity until the controller flies it).
    pub fn pose(&self, id: &str) -> Pose {
        *self
            .values
            .lock()
            .unwrap()
            .poses
            .get(id)
            .unwrap_or_else(|| panic!("av-controls: unknown player3d {id:?}"))
    }

    /// Whether a switch is on.
    pub fn on(&self, id: &str) -> bool {
        self.get(id) > 0.5
    }
}

impl Panel {
    pub fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            controls: Vec::new(),
        }
    }

    /// Start a new tab named `name`.
    pub fn section(mut self, name: &str) -> Self {
        self.controls.push(Control::Section(name.to_string()));
        self
    }

    /// Add an on/off switch.
    pub fn switch(mut self, id: &str, initial: bool) -> Self {
        self.controls.push(Control::Switch { id: id.replace('/', "-"), initial });
        self
    }

    /// Add a Player3D: a camera flown from the controller (WASD at `move_speed` units/s,
    /// mouse look at `look_sensitivity` rad/px, Q/E roll if `roll`).
    pub fn player3d(mut self, id: &str, move_speed: f32, look_sensitivity: f32, roll: bool) -> Self {
        self.controls.push(Control::Player3D { id: id.replace('/', "-"), move_speed, look_sensitivity, roll });
        self
    }

    /// Add a fader with 2 decimal places.
    pub fn fader(self, id: &str, min: f32, max: f32, initial: f32) -> Self {
        self.fader_with(id, min, max, initial, 2)
    }

    /// Add a fader with a number of decimal places (0 for integer steps).
    pub fn fader_with(mut self, id: &str, min: f32, max: f32, initial: f32, decimals: u32) -> Self {
        // '/' is the persistence path separator in av-controls.
        self.controls.push(Control::Fader(Fader {
            id: id.replace('/', "-"),
            min,
            max,
            initial,
            decimals,
        }));
        self
    }

    /// Start the background connection to a broker (e.g. `ws://localhost:8080`).
    pub fn connect(self, url: &str) -> Controls {
        let values = Values {
            scalars: self.controls.iter().filter_map(Control::value).collect(),
            poses: self.controls.iter().filter_map(|c| match c {
                Control::Player3D { id, .. } => Some((id.clone(), Pose::default())),
                _ => None,
            }).collect(),
        };
        let controls = Controls {
            values: Arc::new(Mutex::new(values)),
        };
        let shared = controls.clone();
        let url = url.to_string();
        thread::Builder::new()
            .name("av-controls".into())
            .spawn(move || {
                let mut reported = false;
                loop {
                    match open(&url) {
                        Ok(mut socket) => {
                            eprintln!("av-controls: connected to {url}");
                            reported = false;
                            if let Err(error) = self.serve(&mut socket, &shared) {
                                eprintln!("av-controls: disconnected: {error}");
                            }
                        }
                        Err(error) if !reported => {
                            eprintln!("av-controls: no broker at {url} ({error}), retrying in the background");
                            reported = true;
                        }
                        Err(_) => {}
                    }
                    thread::sleep(Duration::from_secs(3));
                }
            })
            .expect("spawn av-controls thread");
        controls
    }

    fn spec(&self, all: &Values, initialized: bool) -> Value {
        let values = &all.scalars;
        const COLORS: [&str; 6] = ["#486", "#77a", "#a75", "#5aa", "#a5a", "#aa5"];
        // A control spec carries its base args both flat and as `baseArgs`.
        let control = |kind: &str, name: &str, rect: [f32; 4], color: &str, extra: Value| {
            let base = json!({
                "name": name, "x": rect[0], "y": rect[1], "width": rect[2], "height": rect[3],
                "color": color, "stateSnapshotMask": {},
            });
            let mut spec = base.clone();
            let object = spec.as_object_mut().unwrap();
            object.insert("type".into(), json!(kind));
            object.insert("baseArgs".into(), base);
            object.extend(extra.as_object().unwrap().clone());
            spec
        };
        // One tab per section (controls before the first section go to "controls"),
        // its controls side by side, 10 cells wide.
        let mut tabs: Vec<(String, Vec<&Control>)> = Vec::new();
        for c in &self.controls {
            match c {
                Control::Section(name) => tabs.push((name.clone(), Vec::new())),
                _ => {
                    if tabs.is_empty() {
                        tabs.push(("controls".into(), Vec::new()));
                    }
                    tabs.last_mut().unwrap().1.push(c);
                }
            }
        }
        let mut tab_specs = serde_json::Map::new();
        let mut tab_states = serde_json::Map::new();
        for (t, (name, cells)) in tabs.iter().enumerate() {
            let color = COLORS[t % COLORS.len()];
            let mut specs = serde_json::Map::new();
            let mut states = serde_json::Map::new();
            let mut x = 0.;
            for c in cells.iter() {
                let wide = if matches!(c, Control::Player3D { .. }) { 30. } else { 10. };
                let rect = [x, 0., wide, 100.];
                x += wide;
                match c {
                    Control::Player3D { id, move_speed, look_sensitivity, roll } => {
                        let extra = json!({
                            "initialState": Pose::default().json(),
                            "moveSpeed": move_speed, "lookSensitivity": look_sensitivity, "enableRoll": roll,
                        });
                        specs.insert(id.clone(), control("player3d", id, rect, color, extra));
                        states.insert(id.clone(), all.poses[id].json());
                    }
                    Control::Fader(f) => {
                        let extra = json!({
                            "initialState": { "value": f.initial },
                            "min": f.min, "max": f.max, "decimalPlaces": f.decimals,
                            "isHorizontal": false, "mapping": "linear",
                        });
                        specs.insert(f.id.clone(), control("fader", &f.id, rect, color, extra));
                        states.insert(f.id.clone(), json!({ "value": values[&f.id] }));
                    }
                    Control::Switch { id, initial } => {
                        let extra = json!({ "initialState": { "on": initial } });
                        specs.insert(id.clone(), control("switch", id, rect, color, extra));
                        states.insert(id.clone(), json!({ "on": values[id] > 0.5 }));
                    }
                    Control::Section(_) => {}
                }
            }
            let group = control("group", name, [0., 0., 100., 100.], color, json!({ "controlSpecs": specs }));
            tab_specs.insert(name.clone(), group);
            tab_states.insert(name.clone(), json!({ "states": states }));
        }
        let first = tabs.first().map(|(name, _)| name.clone()).unwrap_or_default();
        let root = control("tabs", &self.id, [0., 0., 100., 100.], "#888", json!({
            "controlSpecs": tab_specs.clone(), "tabs": tab_specs, "initialActiveId": first,
            "syncSelection": false, "vertical": false, "tabLabels": {},
        }));
        let states = json!({ "activeId": first, "states": tab_states });
        json!({
            "type": "controller-specification",
            "name": self.id,
            "rootControlSpec": root,
            "currentState": states,
            "stateInitialized": initialized,
        })
    }

    fn wrapped(&self, message: Value) -> Message {
        let text = json!({
            "type": "wrapped-message",
            "panelId": self.id,
            "envelope": { "type": "av-controls-envelope", "protocol": PROTOCOL, "message": message },
        });
        Message::text(text.to_string())
    }

    fn serve(&self, socket: &mut Socket, controls: &Controls) -> tungstenite::Result<()> {
        socket.send(Message::text(json!({ "type": "register-receiver" }).to_string()))?;
        let spec = self.spec(&controls.values.lock().unwrap(), false);
        let announce = json!({ "type": "add-net-panel", "id": self.id, "rootSpecification": spec, "protocol": PROTOCOL });
        socket.send(Message::text(announce.to_string()))?;
        loop {
            let Message::Text(text) = socket.read()? else { continue };
            let Ok(parsed) = serde_json::from_str::<Value>(&text) else { continue };
            if parsed["type"] != "wrapped-message" || parsed["panelId"] != self.id.as_str() {
                continue;
            }
            let message = &parsed["envelope"]["message"];
            match message["type"].as_str() {
                Some("control-signal") => {
                    let update = apply_signal(&message["signal"], &mut controls.values.lock().unwrap());
                    // Echo as an update so other controllers stay in sync.
                    if let Some(update) = update {
                        let origin = if message["origin"].is_object() {
                            message["origin"].clone()
                        } else {
                            json!({ "kind": "controller" })
                        };
                        socket.send(self.wrapped(json!({
                            "type": "control-update",
                            "update": update,
                            "origin": origin,
                        })))?;
                    }
                }
                Some(kind @ ("control-state-patch" | "control-state-restore")) => {
                    apply_state(&message["state"], &mut controls.values.lock().unwrap());
                    if kind == "control-state-restore" {
                        let spec = self.spec(&controls.values.lock().unwrap(), true);
                        socket.send(self.wrapped(spec))?;
                    }
                }
                _ => {}
            }
        }
    }
}
