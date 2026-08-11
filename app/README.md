# AIdrone desktop application

Tauri 2 control surface for the USB-NCM AIdrone link. Rust owns UDP and device
state; the WebView renders the operator UI and decodes video.

## Development

```bash
bun install
bun run tauri dev
```

## Release packages

Run commands from this directory:

```bash
# Windows: requires FFMPEG_DIR and LIBCLANG_PATH; produces an elevated NSIS installer.
bun run tauri build --bundles nsis

# Ubuntu: build on the exact release you will ship; derives and verifies its dependencies.
bash src-tauri/installer/linux/build-deb.sh
```

The `.deb` is the normal Ubuntu installation path because its maintainer
scripts configure the USB-NCM host link. An AppImage is manual-networking only.
See the repository [README](../README.md#host-nic-setup---done-by-the-installer)
for installation behavior, supported Ubuntu releases, and verification steps.
