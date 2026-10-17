These are the application icons `tauri.conf.json` (`bundle.icon`) points at:

  32x32.png    window icon and small shell surfaces
  128x128.png  explorer / installer surfaces
  icon.ico     the executable icon and the NSIS installer icon

They are generated, not hand-drawn. Run (from the repository root):

  node tools/tauri-icons.mjs --write     # write the three files into this directory
  node tools/tauri-icons.mjs --check     # exit 1 when one is missing or empty

`scripts/build-windows-client.ps1` calls `--write` automatically before `cargo tauri build`, so a
fresh checkout never has to commit binaries for a build input that is fully deterministic.

Replace the palette and geometry in `ICON_SPEC` (tools/tauri-icons.mjs) with the project's real
artwork when it exists. Nothing else has to change: the file names and the ICO entry list stay the
same, and both `cargo tauri dev` (tauri.conf.json.dev.json reuses the same list) and
`cargo tauri build` read them from here.
