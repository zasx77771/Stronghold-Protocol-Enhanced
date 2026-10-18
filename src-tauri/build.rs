// A release installer ships the official art `data/assets.json` lists, so refuse to
// build one when that art is not on disk (it is git-ignored and produced by
// `npm run assets`). `tools/check-embedded-assets.mjs` holds the check so the Windows
// and Android builds cannot drift apart; debug builds skip it so development stays
// fast. `SP_SKIP_EMBED_CHECK=1` is the documented escape hatch (see
// docs/NATIVE-RECONSTRUCTION.md, 「内嵌素材校验」).
fn main() {
    println!("cargo:rerun-if-changed=../data/assets.json");
    println!("cargo:rerun-if-changed=../tools/check-embedded-assets.mjs");
    let release = std::env::var("PROFILE").as_deref() == Ok("release");
    if release && std::env::var_os("SP_SKIP_EMBED_CHECK").is_none() {
        let status = std::process::Command::new("node")
            .arg("../tools/check-embedded-assets.mjs")
            .arg("--strict")
            .status()
            .unwrap_or_else(|err| panic!("release builds need Node.js to verify the embedded assets: {err}"));
        if !status.success() {
            panic!(
                "release builds need the official art: run `npm run assets` (verified by tools/check-embedded-assets.mjs)"
            );
        }
    }
    tauri_build::build()
}
