//! Self-update against this project's own GitHub releases.
//!
//! Why this is hand-written rather than `tauri-plugin-updater`: the plugin
//! cannot update a `.deb`, and on Ubuntu a `.deb` is not a packaging preference
//! - it is the only artifact that can declare `gstreamer1.0-libav` and run the
//! USB-NCM maintainer scripts. An AppImage does neither, which is exactly the
//! failure that made the first Ubuntu release unusable.
//!
//! What it does: reads the newest release (prereleases included - every build
//! here is one, tagged `build-<sha>`), picks the artifact for this platform,
//! verifies the SHA-256 GitHub publishes beside it, and hands it to the
//! platform installer. The digest check is integrity, not provenance: it proves
//! the bytes are the ones GitHub has, and nothing more. Signed updates would
//! need a signing key in CI, which is the natural next step if this ever ships
//! to anyone but its author.
//!
//! The install itself cannot be silent on either platform - a per-machine NSIS
//! installer raises UAC and `apt` needs root through `pkexec` - so the app asks
//! once and the OS asks once.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// GitHub's own hostname requirement, and a courtesy: an unversioned agent is
/// rejected outright.
const USER_AGENT: &str = concat!("AIdrone/", env!("CARGO_PKG_VERSION"));
const RELEASES_URL: &str = "https://api.github.com/repos/KimMgyo/AIdrone/releases?per_page=8";
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
/// A release's assets are ~90 MB apiece; a slow hotel link should not fail one.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(20 * 60);

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    /// `sha256:<hex>`, present on assets uploaded since 2025. Absent means the
    /// download cannot be checked, and an unverifiable installer is refused.
    #[serde(default)]
    digest: Option<String>,
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

/// What the UI is told: enough to name the version and nothing the UI could
/// tamper with usefully - the URL is re-derived from the same release when the
/// user accepts.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct AvailableUpdate {
    pub version: String,
    pub tag: String,
    pub asset: String,
    pub url: String,
    pub digest: String,
    pub size: u64,
}

/// Compares two dotted numeric versions. Anything unparseable sorts as older,
/// so a malformed release name can never trigger an update.
fn is_newer(candidate: &str, current: &str) -> bool {
    let parts = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|part| part.trim().parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parts(candidate), parts(current));
    if candidate.split('.').any(|p| p.trim().parse::<u64>().is_err()) {
        return false;
    }
    for index in 0..a.len().max(b.len()) {
        let left = a.get(index).copied().unwrap_or(0);
        let right = b.get(index).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }
    false
}

/// `AIdrone_0.1.9_x64-setup.exe` / `AIdrone_0.1.9_amd64_ubuntu26.deb` -> `0.1.9`.
fn version_of(asset: &str) -> Option<String> {
    let rest = asset.strip_prefix("AIdrone_")?;
    let (version, _) = rest.split_once('_')?;
    version
        .split('.')
        .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
        .then(|| version.to_owned())
}

/// The Ubuntu release suffix this machine's packages carry: `26.04` ->
/// `ubuntu26`. None on any other platform, and on an Ubuntu whose
/// `/etc/os-release` cannot be read - better no update than the wrong libc.
#[cfg(target_os = "linux")]
fn ubuntu_suffix(os_release: &str) -> Option<String> {
    let mut is_ubuntu = false;
    let mut major = None;
    for line in os_release.lines() {
        match line.split_once('=') {
            Some(("ID", value)) => is_ubuntu = value.trim_matches('"') == "ubuntu",
            Some(("VERSION_ID", value)) => {
                major = value
                    .trim_matches('"')
                    .split('.')
                    .next()
                    .map(str::to_owned);
            }
            _ => {}
        }
    }
    match (is_ubuntu, major) {
        (true, Some(major)) if !major.is_empty() => Some(format!("ubuntu{major}")),
        _ => None,
    }
}

/// The one asset this machine can install.
fn asset_for_platform<'a>(assets: &'a [GhAsset], linux_suffix: Option<&str>) -> Option<&'a GhAsset> {
    if cfg!(target_os = "windows") {
        return assets.iter().find(|asset| asset.name.ends_with("_x64-setup.exe"));
    }
    let suffix = linux_suffix?;
    let wanted = format!("_amd64_{suffix}.deb");
    assets.iter().find(|asset| asset.name.ends_with(&wanted))
}

/// The newest release carrying a newer artifact for this platform.
fn pick<'a>(
    releases: &'a [GhRelease],
    current: &str,
    linux_suffix: Option<&str>,
) -> Option<AvailableUpdate> {
    for release in releases {
        let Some(asset) = asset_for_platform(&release.assets, linux_suffix) else {
            continue;
        };
        let Some(version) = version_of(&asset.name) else {
            continue;
        };
        if !is_newer(&version, current) {
            continue;
        }
        let Some(digest) = asset.digest.as_ref().and_then(|d| d.strip_prefix("sha256:")) else {
            // Refuse what cannot be checked rather than install it blind.
            continue;
        };
        return Some(AvailableUpdate {
            version,
            tag: release.tag_name.clone(),
            asset: asset.name.clone(),
            url: asset.browser_download_url.clone(),
            digest: digest.to_ascii_lowercase(),
            size: asset.size,
        });
    }
    None
}

#[cfg(target_os = "linux")]
fn platform_suffix() -> Option<String> {
    std::fs::read_to_string("/etc/os-release")
        .ok()
        .as_deref()
        .and_then(ubuntu_suffix)
}

#[cfg(not(target_os = "linux"))]
fn platform_suffix() -> Option<String> {
    None
}

/// Asks GitHub what exists. Returns None when this build is current, which is
/// also what every failure degrades to - a launcher that cannot reach GitHub
/// must still start the app.
#[tauri::command]
pub(crate) async fn update_check() -> Result<Option<AvailableUpdate>, String> {
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| format!("update client: {error}"))?;

    let response = client
        .get(RELEASES_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("reach GitHub: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("GitHub answered {}", response.status()));
    }
    let releases: Vec<GhRelease> = response
        .json()
        .await
        .map_err(|error| format!("read the release list: {error}"))?;

    Ok(pick(
        &releases,
        env!("CARGO_PKG_VERSION"),
        platform_suffix().as_deref(),
    ))
}

fn sha256_hex(bytes: &[u8]) -> String {
    // A 32-bit SHA-256, written out rather than pulled in: the only consumer is
    // this one comparison, and a hash crate is a dependency that has to be kept
    // current forever.
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut state: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    let mut message = bytes.to_vec();
    let bit_len = (bytes.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    for block in message.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (index, word) in block.chunks_exact(4).enumerate() {
            w[index] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for index in 16..64 {
            let s0 = w[index - 15].rotate_right(7)
                ^ w[index - 15].rotate_right(18)
                ^ (w[index - 15] >> 3);
            let s1 = w[index - 2].rotate_right(17)
                ^ w[index - 2].rotate_right(19)
                ^ (w[index - 2] >> 10);
            w[index] = w[index - 16]
                .wrapping_add(s0)
                .wrapping_add(w[index - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[index])
                .wrapping_add(w[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (slot, value) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(value);
        }
    }

    state.iter().map(|word| format!("{word:08x}")).collect()
}

async fn download_verified(update: &AvailableUpdate) -> Result<PathBuf, String> {
    let client = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| format!("download client: {error}"))?;

    let bytes = client
        .get(&update.url)
        .send()
        .await
        .map_err(|error| format!("download {}: {error}", update.asset))?
        .error_for_status()
        .map_err(|error| format!("download {}: {error}", update.asset))?
        .bytes()
        .await
        .map_err(|error| format!("read {}: {error}", update.asset))?;

    let actual = sha256_hex(&bytes);
    if actual != update.digest {
        return Err(format!(
            "{} failed its checksum - refusing to install it",
            update.asset
        ));
    }

    let path = std::env::temp_dir().join(&update.asset);
    std::fs::write(&path, &bytes).map_err(|error| format!("stage {}: {error}", path.display()))?;
    Ok(path)
}

/// Hands the artifact to the platform installer and returns once the handoff
/// is made. The caller exits; the helper relaunches the new build.
#[cfg(target_os = "windows")]
fn install(installer: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;

    let exe = std::env::current_exe().map_err(|error| format!("locate this app: {error}"))?;
    // A script, because the sequence has to outlive the process being replaced:
    // wait for the installer, then start what it installed. `timeout` gives the
    // app a second to exit first - an installer that finds its own target
    // running replaces the files anyway, but the relaunch would then race a
    // half-written binary.
    let script = std::env::temp_dir().join("aidrone-update.cmd");
    std::fs::write(
        &script,
        format!(
            "@echo off\r\ntimeout /t 1 /nobreak >nul\r\n\"{}\" /S\r\nstart \"\" \"{}\"\r\n",
            installer.display(),
            exe.display()
        ),
    )
    .map_err(|error| format!("write the update script: {error}"))?;

    // DETACHED_PROCESS is what makes it survive this app's exit.
    std::process::Command::new("cmd")
        .args(["/C", &script.to_string_lossy()])
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("start the installer: {error}"))?;
    Ok(())
}

/// How this process can become root to run `apt-get`. Ordered by how little it
/// asks of the operator.
#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Elevation {
    /// Already root - a headless or packaged-service run.
    None,
    /// Passwordless sudo, which a developer box often has and a desktop rarely.
    Sudo,
    /// The desktop's own authentication dialog.
    Pkexec,
}

#[cfg(target_os = "linux")]
fn elevation(effective_uid: u32, sudo_without_password: bool, has_pkexec: bool) -> Option<Elevation> {
    if effective_uid == 0 {
        return Some(Elevation::None);
    }
    if sudo_without_password {
        return Some(Elevation::Sudo);
    }
    has_pkexec.then_some(Elevation::Pkexec)
}

/// The effective uid, read out of `/proc/self/status` rather than through a
/// libc binding this crate would otherwise not need.
#[cfg(target_os = "linux")]
fn effective_uid_from(status: &str) -> Option<u32> {
    status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .and_then(|value| value.split_whitespace().nth(1).map(str::to_owned))
        .and_then(|uid| uid.parse().ok())
}

#[cfg(target_os = "linux")]
fn install(package: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| format!("locate this app: {error}"))?;

    let effective_uid = std::fs::read_to_string("/proc/self/status")
        .ok()
        .as_deref()
        .and_then(effective_uid_from)
        .unwrap_or(u32::MAX);
    let sudo_without_password = std::process::Command::new("sudo")
        .args(["-n", "true"])
        .status()
        .map(|status| status.success())
        .unwrap_or(false);

    // `apt-get install` on a local .deb pulls any new dependency with it, which
    // a bare `dpkg -i` would leave unconfigured.
    let command = match elevation(effective_uid, sudo_without_password, which("pkexec").is_some()) {
        Some(Elevation::None) => "apt-get".to_owned(),
        Some(Elevation::Sudo) => "sudo -n apt-get".to_owned(),
        Some(Elevation::Pkexec) => "pkexec apt-get".to_owned(),
        None => {
            return Err(format!(
                "no way to become root from here - run: sudo apt install {}",
                package.display()
            ))
        }
    };

    // The helper has to outlive the process that started it, and a plain child
    // does not: it stays in this app's process group, and whatever supervises
    // the app - a desktop session scope, a terminal, a test harness - takes the
    // whole group down when the app exits. Measured: the script was written and
    // never ran. `setsid` puts it in a session of its own; the second of sleep
    // is so `apt` starts after the binary it is replacing has gone.
    let log = std::env::temp_dir().join("aidrone-update.log");
    let script = std::env::temp_dir().join("aidrone-update.sh");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nsleep 1\n{command} install -y --allow-downgrades '{}' >>'{}' 2>&1\nexec '{}'\n",
            package.display(),
            log.display(),
            exe.display()
        ),
    )
    .map_err(|error| format!("write the update script: {error}"))?;

    let detached = which("setsid").is_some();
    let mut helper = if detached {
        let mut command = std::process::Command::new("setsid");
        command.args(["sh", &script.to_string_lossy()]);
        command
    } else {
        let mut command = std::process::Command::new("sh");
        command.arg(&script);
        command
    };
    helper
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("start the installer: {error}"))?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn which(program: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(program))
            .find(|candidate| candidate.is_file())
    })
}

/// Downloads, verifies, installs and relaunches. The window is gone by the time
/// the installer runs, so the caller must have nothing in flight - the UI only
/// offers this from the landing screen, never during a session.
///
/// `AIDRONE_UPDATE_DRY_RUN=1` stops after the checksum and returns where the
/// artifact landed. It exists because the install step is the one part that
/// cannot be exercised unattended: a per-machine NSIS installer raises UAC on
/// Windows' secure desktop, which no automation may touch. Everything before
/// it - the release query, the platform pick, the download, the digest - is
/// then testable on both platforms.
#[tauri::command]
pub(crate) async fn update_apply(
    app: tauri::AppHandle,
    update: AvailableUpdateInput,
) -> Result<Option<String>, String> {
    let update = AvailableUpdate {
        version: update.version,
        tag: update.tag,
        asset: update.asset,
        url: update.url,
        digest: update.digest.to_ascii_lowercase(),
        size: update.size,
    };
    if !update.url.starts_with("https://github.com/KimMgyo/AIdrone/releases/download/") {
        return Err("that download does not come from this project's releases".to_owned());
    }

    let staged = download_verified(&update).await?;
    if std::env::var("AIDRONE_UPDATE_DRY_RUN").is_ok_and(|value| value == "1") {
        return Ok(Some(staged.display().to_string()));
    }

    install(&staged)?;
    // Give the helper a moment to start before this process disappears.
    tokio::time::sleep(Duration::from_millis(250)).await;
    app.exit(0);
    Ok(None)
}

/// The same shape coming back from the WebView. Deserialized separately so the
/// serialized-out type stays free of `Deserialize`, and so a hand-made object
/// cannot smuggle in fields the checker above does not look at.
#[derive(Debug, Deserialize)]
pub(crate) struct AvailableUpdateInput {
    pub version: String,
    pub tag: String,
    pub asset: String,
    pub url: String,
    pub digest: String,
    #[serde(default)]
    pub size: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str, digest: Option<&str>) -> GhAsset {
        GhAsset {
            name: name.to_owned(),
            browser_download_url: format!(
                "https://github.com/KimMgyo/AIdrone/releases/download/build-abc/{name}"
            ),
            digest: digest.map(str::to_owned),
            size: 1,
        }
    }

    fn release(names: &[&str]) -> GhRelease {
        GhRelease {
            tag_name: "build-abc".to_owned(),
            assets: names
                .iter()
                .map(|name| asset(name, Some("sha256:AA")))
                .collect(),
        }
    }

    #[test]
    fn versions_compare_by_component_not_by_string() {
        assert!(is_newer("0.1.10", "0.1.9"), "10 > 9, not '1' < '9'");
        assert!(is_newer("0.2.0", "0.1.99"));
        assert!(!is_newer("0.1.8", "0.1.8"));
        assert!(!is_newer("0.1.7", "0.1.8"));
        // A release named something else must never look newer.
        assert!(!is_newer("nightly", "0.1.8"));
        assert!(!is_newer("0.1.x", "0.1.8"));
    }

    #[test]
    fn the_version_comes_off_the_artifact_name() {
        assert_eq!(version_of("AIdrone_0.1.9_x64-setup.exe").as_deref(), Some("0.1.9"));
        assert_eq!(
            version_of("AIdrone_0.1.9_amd64_ubuntu26.deb").as_deref(),
            Some("0.1.9")
        );
        assert_eq!(version_of("AIdrone_0.1.9_amd64.deb").as_deref(), Some("0.1.9"));
        assert_eq!(version_of("something-else.exe"), None);
        assert_eq!(version_of("AIdrone_nightly_x64-setup.exe"), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_ubuntu_release_decides_which_deb_fits() {
        let os_release = "ID=ubuntu\nVERSION_ID=\"26.04\"\nNAME=\"Ubuntu\"\n";
        assert_eq!(ubuntu_suffix(os_release).as_deref(), Some("ubuntu26"));
        assert_eq!(
            ubuntu_suffix("ID=debian\nVERSION_ID=\"12\"\n"),
            None,
            "a Debian is not an Ubuntu, and its libc baseline is not ours"
        );
        assert_eq!(ubuntu_suffix("NAME=\"Whatever\"\n"), None);

        let assets = release(&[
            "AIdrone_0.1.9_amd64_ubuntu22.deb",
            "AIdrone_0.1.9_amd64_ubuntu24.deb",
            "AIdrone_0.1.9_amd64_ubuntu26.deb",
            "AIdrone_0.1.9_x64-setup.exe",
        ])
        .assets;
        assert_eq!(
            asset_for_platform(&assets, Some("ubuntu26"))
                .map(|found| found.name.as_str()),
            Some("AIdrone_0.1.9_amd64_ubuntu26.deb")
        );
        assert!(
            asset_for_platform(&assets, Some("ubuntu20")).is_none(),
            "no artifact for this release means no update, not the nearest one"
        );
        assert!(asset_for_platform(&assets, None).is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn root_needs_no_prompt_and_a_desktop_gets_one() {
        assert_eq!(elevation(0, false, false), Some(Elevation::None));
        // Passwordless sudo beats a dialog nobody is sitting in front of.
        assert_eq!(elevation(1000, true, true), Some(Elevation::Sudo));
        assert_eq!(elevation(1000, false, true), Some(Elevation::Pkexec));
        // Neither: say so instead of writing a script that cannot work.
        assert_eq!(elevation(1000, false, false), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_effective_uid_comes_from_proc_status() {
        let status = "Name:\tapp\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n";
        assert_eq!(effective_uid_from(status), Some(1000));
        // Field two is the EFFECTIVE uid: a setuid binary differs here, and
        // reading the real one would ask for a password it does not need.
        assert_eq!(
            effective_uid_from("Uid:\t1000\t0\t0\t0\n"),
            Some(0)
        );
        assert_eq!(effective_uid_from("Name:\tapp\n"), None);
    }

    #[test]
    fn an_unverifiable_asset_is_not_offered() {
        let mut release = release(&["AIdrone_0.1.9_x64-setup.exe"]);
        release.assets[0].digest = None;
        let suffix = if cfg!(target_os = "linux") {
            release.assets[0].name = "AIdrone_0.1.9_amd64_ubuntu26.deb".to_owned();
            Some("ubuntu26")
        } else {
            None
        };
        assert!(pick(&[release], "0.1.8", suffix).is_none());
    }

    #[test]
    fn only_a_newer_build_is_offered() {
        let (name, suffix) = if cfg!(target_os = "linux") {
            ("AIdrone_0.1.9_amd64_ubuntu26.deb", Some("ubuntu26"))
        } else {
            ("AIdrone_0.1.9_x64-setup.exe", None)
        };
        let newer = release(&[name]);
        assert_eq!(
            pick(&[newer], "0.1.8", suffix).map(|found| found.version),
            Some("0.1.9".to_owned())
        );

        let same = release(&[name]);
        assert!(pick(&[same], "0.1.9", suffix).is_none());
        let older = release(&[name]);
        assert!(pick(&[older], "0.2.0", suffix).is_none());
    }

    #[test]
    fn sha256_matches_the_reference_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // Longer than one 64-byte block, which is where padding goes wrong.
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }
}
