// Prevent a console window for the installed Windows client.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let profiles = stronghold_protocol_native::prepare_runtime();
    std::process::exit(stronghold_protocol_native::run(profiles));
}
