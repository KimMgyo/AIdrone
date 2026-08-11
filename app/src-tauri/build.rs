use std::env;
use std::fs;
use std::path::Path;

/// `ffmpeg-next` links dynamically on Windows. Cargo's linker search path is
/// enough to build, but Windows only searches beside the launched executable
/// at runtime. Stage the five DLLs imported by the codec/scaler subset in
/// Cargo's profile directory so dev runs and the Tauri bundler see them.
fn stage_ffmpeg_dlls() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let Ok(prefix) = env::var("FFMPEG_DIR") else {
        return;
    };
    let bin = Path::new(&prefix).join("bin");
    let entries = fs::read_dir(&bin)
        .unwrap_or_else(|error| panic!("read FFmpeg runtime directory {}: {error}", bin.display()))
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    let profile = Path::new(&env::var("OUT_DIR").expect("Cargo OUT_DIR"))
        .ancestors()
        .nth(3)
        .expect("Cargo OUT_DIR has profile ancestor")
        .to_path_buf();

    for prefix in [
        "avcodec-",
        "avformat-",
        "avutil-",
        "swresample-",
        "swscale-",
    ] {
        let source = entries
            .iter()
            .find(|path| {
                path.extension().is_some_and(|extension| extension == "dll")
                    && path
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().starts_with(prefix))
            })
            .unwrap_or_else(|| panic!("missing {prefix}*.dll in {}", bin.display()));
        let destination = profile.join(source.file_name().expect("FFmpeg DLL filename"));
        fs::copy(&source, &destination).unwrap_or_else(|error| {
            panic!(
                "stage FFmpeg runtime {} to {}: {error}",
                source.display(),
                destination.display()
            )
        });
        println!("cargo:rerun-if-changed={}", source.display());
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=FFMPEG_DIR");
    stage_ffmpeg_dlls();
    tauri_build::build()
}
