# AIdrone desktop application

Tauri 2 control surface for the AIdrone USB vendor-bulk link. Rust claims
interface 0 through WinUSB on Windows or usbfs on Linux, carries the Tello
protocol over bulk records, and owns device state; the WebView renders the
operator UI and decodes video.

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

The `.deb` is the only supported Ubuntu distribution because it installs the
udev `uaccess` permission rule for the vendor interface and declares the
WebKitGTK H.264 decoder dependency. It does not configure a USB NIC,
NetworkManager, an IP address, or firewall rules. See the repository
README's [host USB setup](../README.md#host-usb-setup) for transport identity,
installation behavior, and supported Ubuntu releases.
