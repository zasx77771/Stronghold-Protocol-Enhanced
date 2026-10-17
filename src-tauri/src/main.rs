// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The packaged Windows client entry point.
//!
//! Everything lives in the library (`stronghold_protocol_client_lib`) so `cargo test` can exercise the
//! pure logic without launching a window; `cargo tauri build` produces
//! `src-tauri/target/release/stronghold-protocol-client.exe` from this file.
//!
//! The split also keeps the project mobile-ready: a Tauri 2 app has a library crate that the desktop
//! binary and the mobile entry points both call.

fn main() {
    std::process::exit(stronghold_protocol_client_lib::run());
}
