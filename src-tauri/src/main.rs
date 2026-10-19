// Prevent a console window for the installed Windows client.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    std::process::exit(stronghold_protocol_native::run());
}
