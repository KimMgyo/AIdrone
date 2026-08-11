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

The `.deb` is the only supported Ubuntu distribution because its maintainer
scripts configure the USB-NCM host link and its package dependencies install
WebKitGTK's H.264 decoder. See the repository
README's [host NIC setup](../README.md#host-nic-setup---done-by-the-installer)
for installation behavior, supported Ubuntu releases, and verification steps.
