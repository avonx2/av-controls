//! Minimal Rust receiver ("artwork" side) for the av-controls websocket broker.
//!
//! The artwork announces a panel of faders to the broker (`pnpm dev:broker`),
//! the av-controls controller UI shows them, and signals come back as values:
//!
//! ```no_run
//! let controls = av_controls::Panel::new("my-artwork")
//!     .fader("speed", 0.0, 10.0, 2.0)
//!     .fader_with("count", 1.0, 8.0, 4.0, 0)
//!     .connect("ws://localhost:8080");
//! let speed = controls.get("speed");
//! ```
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

/// A panel: a named group of faders, laid out in rows automatically.
#[derive(Clone, Debug)]
pub struct Panel {
    pub id: String,
    pub faders: Vec<Fader>,
}

/// Live values of a connected panel; cheap to clone.
#[derive(Clone)]
pub struct Controls {
    values: Arc<Mutex<HashMap<String, f32>>>,
}

impl Controls {
    /// Current value of a fader (its initial value until the controller sends one).
    /// Panics if the id was not declared, which is a programming error.
    pub fn get(&self, id: &str) -> f32 {
        *self
            .values
            .lock()
            .unwrap()
            .get(id)
            .unwrap_or_else(|| panic!("av-controls: unknown control {id:?}"))
    }
}

impl Panel {
    pub fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            faders: Vec::new(),
        }
    }

    /// Add a fader with 2 decimal places.
    pub fn fader(self, id: &str, min: f32, max: f32, initial: f32) -> Self {
        self.fader_with(id, min, max, initial, 2)
    }

    /// Add a fader with a number of decimal places (0 for integer steps).
    pub fn fader_with(mut self, id: &str, min: f32, max: f32, initial: f32, decimals: u32) -> Self {
        // '/' is the persistence path separator in av-controls.
        self.faders.push(Fader {
            id: id.replace('/', "-"),
            min,
            max,
            initial,
            decimals,
        });
        self
    }

    /// Start the background connection to a broker (e.g. `ws://localhost:8080`).
    pub fn connect(self, url: &str) -> Controls {
        let values = self.faders.iter().map(|f| (f.id.clone(), f.initial)).collect();
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

    fn spec(&self, values: &HashMap<String, f32>, initialized: bool) -> Value {
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
        // Rows of up to 10 faders, each 10% wide and 45% high.
        let mut specs = serde_json::Map::new();
        let mut states = serde_json::Map::new();
        for (i, f) in self.faders.iter().enumerate() {
            let rect = [(i % 10) as f32 * 10., (i / 10) as f32 * 50., 9., 45.];
            let extra = json!({
                "initialState": { "value": f.initial },
                "min": f.min, "max": f.max, "decimalPlaces": f.decimals,
                "isHorizontal": false, "mapping": "linear",
            });
            specs.insert(f.id.clone(), control("fader", &f.id, rect, COLORS[i % COLORS.len()], extra));
            states.insert(f.id.clone(), json!({ "value": values[&f.id] }));
        }
        let root = control("group", &self.id, [0., 0., 100., 100.], "#888", json!({ "controlSpecs": specs }));
        json!({
            "type": "controller-specification",
            "name": self.id,
            "rootControlSpec": root,
            "currentState": { "states": states },
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
                    let mut update = serde_json::Map::new();
                    if let Some(children) = message["signal"]["children"].as_object() {
                        let mut values = controls.values.lock().unwrap();
                        for (id, child) in children {
                            if let (Some(value), Some(slot)) = (child["signal"]["value"].as_f64(), values.get_mut(id)) {
                                *slot = value as f32;
                                update.insert(id.clone(), json!({ "update": { "value": value } }));
                            }
                        }
                    }
                    // Echo as an update so other controllers stay in sync.
                    if !update.is_empty() {
                        let origin = if message["origin"].is_object() {
                            message["origin"].clone()
                        } else {
                            json!({ "kind": "controller" })
                        };
                        socket.send(self.wrapped(json!({
                            "type": "control-update",
                            "update": { "children": update },
                            "origin": origin,
                        })))?;
                    }
                }
                Some(kind @ ("control-state-patch" | "control-state-restore")) => {
                    if let Some(states) = message["state"]["states"].as_object() {
                        let mut values = controls.values.lock().unwrap();
                        for (id, state) in states {
                            if let (Some(value), Some(slot)) = (state["value"].as_f64(), values.get_mut(id)) {
                                *slot = value as f32;
                            }
                        }
                    }
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
