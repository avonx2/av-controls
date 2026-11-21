//! Announce two faders and print their values: `cargo run --example faders [url]`.
fn main() {
    let url = std::env::args().nth(1).unwrap_or_else(|| "ws://localhost:8080".into());
    let controls = av_controls::Panel::new("rust-example")
        .fader("speed", 0., 10., 2.)
        .fader_with("count", 1., 8., 4., 0)
        .connect(&url);
    for _ in 0..8 {
        println!("speed {} count {}", controls.get("speed"), controls.get("count"));
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}
