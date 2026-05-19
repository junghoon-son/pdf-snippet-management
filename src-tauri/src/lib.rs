use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Emitter;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use std::sync::Mutex;
use base64::Engine as _;

mod layout;
mod secrets;
use layout::LayoutEngine;

#[derive(Serialize, Deserialize, Clone)]
struct Snippet {
    id: String,
    page: u32,
    text: String,
    rects: Vec<serde_json::Value>,
    #[serde(default)]
    comment: String,
    #[serde(default)]
    created: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    group: Option<String>,
    #[serde(default)]
    groups: Vec<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pos: Option<NodePos>,
    #[serde(default = "default_kind")]
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "imagePath")]
    image_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "contextBefore")]
    context_before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "contextAfter")]
    context_after: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    anchor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "textNormalized")]
    text_normalized: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "flowPos")]
    flow_pos: Option<u32>,
}

fn default_kind() -> String {
    "text".to_string()
}

#[derive(Serialize, Deserialize, Clone)]
struct NodePos {
    x: f64,
    y: f64,
}

#[derive(Serialize, Deserialize, Clone)]
struct Edge {
    id: String,
    source: String,
    target: String,
    #[serde(default)]
    label: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct GroupMeta {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    color: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct Source {
    #[serde(default)]
    path: String,
    #[serde(default)]
    filename: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "contentHash")]
    content_hash: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct AnnotFile {
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "markleeVersion")]
    marklee_version: Option<String>,
    #[serde(default)]
    source: Source,
    #[serde(default)]
    snippets: Vec<Snippet>,
    #[serde(default)]
    edges: Vec<Edge>,
    #[serde(default)]
    groups: Vec<GroupMeta>,
}

// Response wrapper for read_annot that surfaces the sidecar's mtime to
// the JS layer so persistImmediate can do an optimistic-concurrency
// check on the next write. `_mtimeMs` is 0 when the sidecar didn't exist
// (treated as "creating from scratch" — first-write case).
#[derive(Serialize, Default)]
struct ReadAnnotResult {
    #[serde(flatten)]
    annot: AnnotFile,
    #[serde(rename = "_mtimeMs")]
    mtime_ms: u64,
}

// Response shape for write_annot. On success: ok=true, mtimeMs=new mtime.
// On mtime mismatch (someone else wrote between our read and write):
// ok=false, conflict={expected, found}. JS surfaces a reload-or-overwrite
// prompt and may retry with expectedMtimeMs=-1 to force the write.
#[derive(Serialize)]
struct WriteAnnotResult {
    ok: bool,
    #[serde(rename = "mtimeMs", skip_serializing_if = "Option::is_none")]
    mtime_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    conflict: Option<MtimeConflict>,
}

#[derive(Serialize)]
struct MtimeConflict {
    #[serde(rename = "expectedMtimeMs")]
    expected_mtime_ms: i64,
    #[serde(rename = "foundMtimeMs")]
    found_mtime_ms: u64,
}

// Read the sidecar's mtime as milliseconds since the Unix epoch. Returns
// 0 when the file does not exist, mirroring the "no prior version"
// signal the JS layer expects.
fn sidecar_mtime_ms(p: &Path) -> u64 {
    let Ok(meta) = fs::metadata(p) else { return 0; };
    let Ok(modified) = meta.modified() else { return 0; };
    let Ok(d) = modified.duration_since(std::time::UNIX_EPOCH) else { return 0; };
    d.as_millis() as u64
}

fn sidecar_path(pdf_path: &str) -> PathBuf {
    let p = Path::new(pdf_path);
    let mut s = p.as_os_str().to_owned();
    s.push(".annot.json");
    PathBuf::from(s)
}

fn document_kind_from_ext(ext: &str) -> Option<&'static str> {
    let lower = ext.to_ascii_lowercase();
    match lower.as_str() {
        "pdf" => Some("pdf"),
        "md" | "markdown" => Some("markdown"),
        "docx" => Some("docx"),
        "txt" | "text" => Some("text"),
        "png" | "jpg" | "jpeg" => Some("image"),
        _ => None,
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct DocEntry {
    path: String,
    kind: String,
}

#[tauri::command]
fn list_documents(dir: String) -> Result<Vec<DocEntry>, String> {
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let kind = p
            .extension()
            .and_then(|x| x.to_str())
            .and_then(document_kind_from_ext);
        if let (Some(k), Some(s)) = (kind, p.to_str()) {
            out.push(DocEntry {
                path: s.to_string(),
                kind: k.to_string(),
            });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[tauri::command]
fn list_pdfs(dir: String) -> Result<Vec<String>, String> {
    let docs = list_documents(dir)?;
    Ok(docs
        .into_iter()
        .filter(|d| d.kind == "pdf")
        .map(|d| d.path)
        .collect())
}

#[tauri::command]
fn read_pdf(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

fn clip_dir_for(pdf_path: &str) -> Result<(PathBuf, String), String> {
    let pdf = Path::new(pdf_path);
    let parent = pdf.parent().ok_or("PDF has no parent directory")?;
    let stem = pdf
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("PDF filename not utf8")?;
    let rel = format!(".{}.clips", stem);
    Ok((parent.join(&rel), rel))
}

fn resolve_clip(pdf_path: &str, image_path: &str) -> Result<PathBuf, String> {
    let p = Path::new(image_path);
    if p.is_absolute() {
        return Err("image_path must be relative to the source document".into());
    }
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                return Err("image_path must not contain '..' segments".into());
            }
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                return Err("image_path must be relative".into());
            }
            _ => {}
        }
    }
    let parent = Path::new(pdf_path)
        .parent()
        .ok_or_else(|| "source has no parent directory".to_string())?;
    Ok(parent.join(p))
}

#[tauri::command]
fn write_clip(pdf_path: String, clip_id: String, bytes: Vec<u8>) -> Result<String, String> {
    if !clip_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        || clip_id.is_empty()
        || clip_id.len() > 64
    {
        return Err("invalid clip_id".into());
    }
    let (dir, rel_dir) = clip_dir_for(&pdf_path)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join(format!("{}.png", clip_id));
    fs::write(&p, bytes).map_err(|e| e.to_string())?;
    Ok(format!("{}/{}.png", rel_dir, clip_id))
}

#[tauri::command]
fn read_clip(pdf_path: String, image_path: String) -> Result<Vec<u8>, String> {
    let p = resolve_clip(&pdf_path, &image_path)?;
    fs::read(&p).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_clip(pdf_path: String, image_path: String) -> Result<(), String> {
    let p = resolve_clip(&pdf_path, &image_path)?;
    if p.exists() {
        fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn check_paths(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).exists()).collect()
}

#[tauri::command]
fn copy_image_to_clipboard(pdf_path: String, image_path: String) -> Result<(), String> {
    let p = resolve_clip(&pdf_path, &image_path)?;
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard
        .set_image(arboard::ImageData {
            width: w as usize,
            height: h as usize,
            bytes: std::borrow::Cow::Owned(rgba.into_raw()),
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn global_groups_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = Path::new(&home).join(".pdf-annotator");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("groups.json"))
}

// Placeholder "clipboard doc" path used as the source-path argument to
// write_clip / read_clip for pasted snippets. No actual file is written
// at this path — only its derived clip directory is used. Lives under
// ~/.marklee/ so it's workspace-agnostic and doesn't depend on any open
// document.
#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("path does not exist: {}", path));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // xdg-open opens the parent directory; most file managers don't
        // support "select item" via CLI cleanly across distros.
        let parent = p.parent().unwrap_or_else(|| Path::new("."));
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Tracks the spawned Ollama child process so we can stop it on shutdown.
// We use a Mutex-wrapped Option so the lifecycle is explicit and we can
// gracefully refuse a double-spawn.
#[derive(Default)]
struct OllamaState {
    pid: Mutex<Option<u32>>,
}

// Start the bundled Ollama server as a child process. Returns the
// process ID once stdout/stderr show the server is listening. If a
// process is already running (either ours or the user's external
// install), this returns Ok immediately without spawning a new one.
#[tauri::command]
async fn start_bundled_ollama(
    app: tauri::AppHandle,
    state: tauri::State<'_, OllamaState>,
) -> Result<String, String> {
    // First, check if an Ollama server is already responding on 11434.
    // If so, no need to spawn — reuse whatever's already there.
    if probe_ollama().await {
        return Ok("external-running".to_string());
    }
    // Guard against double-spawn.
    if state.pid.lock().map(|g| g.is_some()).unwrap_or(false) {
        return Ok("already-spawned".to_string());
    }
    let sidecar = app
        .shell()
        .sidecar("ollama")
        .map_err(|e| format!("sidecar lookup failed: {}", e))?
        .args(["serve"])
        // Allow 4 concurrent requests so Marklee can pipeline pages.
        .env("OLLAMA_NUM_PARALLEL", "4")
        // Keep the model resident in VRAM between calls (5 min idle).
        .env("OLLAMA_KEEP_ALIVE", "5m")
        // Bind to localhost only — never expose outside this machine.
        .env("OLLAMA_HOST", "127.0.0.1:11434");
    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("ollama spawn failed: {}", e))?;
    let pid = child.pid();
    if let Ok(mut guard) = state.pid.lock() {
        *guard = Some(pid);
    }
    // Forward stdout/stderr to the dev console so users can diagnose
    // model-pull progress and load errors.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[ollama-stdout] {}", String::from_utf8_lossy(&line).trim());
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[ollama-stderr] {}", String::from_utf8_lossy(&line).trim());
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[ollama] terminated: {:?}", payload);
                }
                _ => {}
            }
        }
    });
    Ok(format!("spawned-{}", pid))
}

async fn probe_ollama() -> bool {
    // No reqwest dep — use a one-shot TCP connect to 127.0.0.1:11434.
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;
    let addr: SocketAddr = "127.0.0.1:11434".parse().unwrap();
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

// Best-effort stop. Tauri's child handle owns kill semantics; if we
// don't have a PID we just nop. Uses the system kill/taskkill rather
// than pulling in libc/nix.
#[tauri::command]
fn stop_bundled_ollama(state: tauri::State<'_, OllamaState>) -> Result<(), String> {
    if let Ok(mut guard) = state.pid.lock() {
        if let Some(pid) = guard.take() {
            #[cfg(unix)]
            {
                let _ = std::process::Command::new("kill")
                    .args(["-TERM", &pid.to_string()])
                    .output();
            }
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/F"])
                    .output();
            }
        }
    }
    Ok(())
}

// Run the bundled ONNX layout detector (RT-DETR) on a page image
// (PNG, base64-encoded). First call lazily downloads the model file
// (~150 MB) to ~/Library/Application Support/Marklee/models and
// builds an ort::Session; subsequent calls reuse it.
#[tauri::command]
fn detect_page_layout(
    image_base64: String,
    engine: tauri::State<LayoutEngine>,
) -> Result<Vec<layout::DetectionBox>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_base64.as_bytes())
        .map_err(|e| format!("base64 decode failed: {}", e))?;
    engine.detect(&bytes)
}

// Run the bundled Docling layout-detection script on a PDF. Spawns
// python3 with scripts/docling_detect.py and returns the JSON output
// as a string. JS-side wrappers parse the result and surface errors.
//
// Script resolution: looks for `scripts/docling_detect.py` relative to
// the current working dir AND its parent (covers dev mode where cwd
// may be either the project root or `src-tauri/`). Production bundling
// would need to switch to `tauri::path::resource_dir`.
#[tauri::command]
fn run_docling_layout(
    pdf_path: String,
    python: Option<String>,
) -> Result<String, String> {
    if !Path::new(&pdf_path).exists() {
        return Err(format!("PDF not found: {}", pdf_path));
    }
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let candidates = [
        cwd.join("scripts/docling_detect.py"),
        cwd.join("../scripts/docling_detect.py"),
        cwd.parent().unwrap_or(Path::new(".")).join("scripts/docling_detect.py"),
    ];
    let script = candidates
        .iter()
        .find(|p| p.exists())
        .ok_or_else(|| format!(
            "Docling script not found near {}. Looked in {:?}",
            cwd.display(), candidates,
        ))?;

    let py = python.unwrap_or_else(|| "python3".to_string());
    let out = std::process::Command::new(&py)
        .arg(script)
        .arg(&pdf_path)
        .output()
        .map_err(|e| format!("failed to spawn {}: {}", py, e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(stderr.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
fn clipboard_doc_path() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = Path::new(&home).join(".marklee");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("clipboard").to_string_lossy().to_string())
}

#[tauri::command]
fn read_global_groups() -> Result<Vec<GroupMeta>, String> {
    let p = global_groups_path()?;
    if !p.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_global_groups(groups: Vec<GroupMeta>) -> Result<(), String> {
    let p = global_groups_path()?;
    let json = serde_json::to_vec_pretty(&groups).map_err(|e| e.to_string())?;
    fs::write(&p, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn read_annot(pdf_path: String) -> Result<ReadAnnotResult, String> {
    let p = sidecar_path(&pdf_path);
    if !p.exists() {
        return Ok(ReadAnnotResult::default());
    }
    let mtime_ms = sidecar_mtime_ms(&p);
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    let mut af = if let Ok(af) = serde_json::from_slice::<AnnotFile>(&bytes) {
        af
    } else {
        let snippets: Vec<Snippet> = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        AnnotFile {
            marklee_version: None,
            source: Source::default(),
            snippets,
            edges: Vec::new(),
            groups: Vec::new(),
        }
    };
    for s in &mut af.snippets {
        if let Some(g) = s.group.take() {
            if !s.groups.contains(&g) {
                s.groups.push(g);
            }
        }
    }
    let known: std::collections::HashSet<String> =
        af.groups.iter().map(|g| g.id.clone()).collect();
    let mut seen = known.clone();
    for s in &af.snippets {
        for gid in &s.groups {
            if !seen.contains(gid) {
                seen.insert(gid.clone());
                af.groups.push(GroupMeta {
                    id: gid.clone(),
                    name: String::new(),
                    color: None,
                });
            }
        }
    }
    Ok(ReadAnnotResult { annot: af, mtime_ms })
}

// expected_mtime_ms semantics:
//   -1  → skip the check (explicit user-consent overwrite).
//    0  → caller expects no prior file (first write); write only if the
//         sidecar still doesn't exist.
//   >0  → compare against actual mtime; on mismatch, return conflict.
#[tauri::command]
fn write_annot(
    pdf_path: String,
    payload: AnnotFile,
    expected_mtime_ms: Option<i64>,
) -> Result<WriteAnnotResult, String> {
    let p = sidecar_path(&pdf_path);
    let expected = expected_mtime_ms.unwrap_or(-1);
    if expected != -1 {
        let actual = sidecar_mtime_ms(&p);
        if expected == 0 && actual != 0 {
            return Ok(WriteAnnotResult {
                ok: false,
                mtime_ms: None,
                conflict: Some(MtimeConflict { expected_mtime_ms: expected, found_mtime_ms: actual }),
            });
        }
        if expected > 0 && actual as i64 != expected {
            return Ok(WriteAnnotResult {
                ok: false,
                mtime_ms: None,
                conflict: Some(MtimeConflict { expected_mtime_ms: expected, found_mtime_ms: actual }),
            });
        }
    }
    let json = serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(&p, json).map_err(|e| e.to_string())?;
    let new_mtime = sidecar_mtime_ms(&p);
    Ok(WriteAnnotResult { ok: true, mtime_ms: Some(new_mtime), conflict: None })
}

fn build_app_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    let mi = |id: &str, label: &str, accel: Option<&str>| {
        let mut b = MenuItemBuilder::with_id(id, label);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };

    let app_submenu = SubmenuBuilder::new(app, "Marklee")
        .item(&PredefinedMenuItem::about(app, Some("About Marklee"), None)?)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&mi("file_open", "Open File…", Some("CmdOrCtrl+O"))?)
        .item(&mi("file_open_folder", "Open Folder…", Some("CmdOrCtrl+Shift+O"))?)
        .separator()
        .item(&mi("file_summary", "Summary…", None)?)
        .item(&mi("file_export_summary", "Export Summary as HTML…", None)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    let workspace_menu = SubmenuBuilder::new(app, "Workspace")
        .item(&mi("ws_new", "New Workspace", Some("CmdOrCtrl+N"))?)
        .item(&mi("ws_rename", "Rename Active Workspace…", None)?)
        .item(&mi("ws_close", "Close Active Workspace", Some("CmdOrCtrl+W"))?)
        .separator()
        .item(&mi("ws_next", "Next Workspace", Some("CmdOrCtrl+]"))?)
        .item(&mi("ws_prev", "Previous Workspace", Some("CmdOrCtrl+["))?)
        .separator()
        .item(&mi("ws_clear", "Clear Files in Workspace", None)?)
        .separator()
        .item(&mi("ws_cycle_theme", "Cycle Theme", Some("CmdOrCtrl+T"))?)
        .build()?;

    let groups_menu = SubmenuBuilder::new(app, "Groups")
        .item(&mi("groups_template", "Apply Template…", None)?)
        .item(&mi("groups_from_workspace", "Import from Another Workspace…", None)?)
        .item(&mi("groups_import_file", "Import from JSON File…", None)?)
        .item(&mi("groups_export", "Export Groups as JSON…", None)?)
        .separator()
        .item(&mi("groups_toggle_panel", "Toggle Groups Panel", None)?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&mi("edit_undo", "Undo", Some("CmdOrCtrl+Z"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&mi("edit_find", "Find in Document", Some("CmdOrCtrl+F"))?)
        .item(&mi("edit_find_workspace", "Find in Workspace", Some("CmdOrCtrl+Shift+F"))?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&mi("view_zoom_in", "Zoom In", Some("CmdOrCtrl+="))?)
        .item(&mi("view_zoom_out", "Zoom Out", Some("CmdOrCtrl+-"))?)
        .item(&mi("view_zoom_fit", "Fit Width", Some("CmdOrCtrl+0"))?)
        .separator()
        .item(&mi("view_toggle_sidebar", "Toggle Sidebar", Some("CmdOrCtrl+B"))?)
        .item(&mi("view_maximize", "Maximize Snippets Pane", Some("CmdOrCtrl+Shift+M"))?)
        .separator()
        .item(&mi("view_cycle_theme", "Cycle Theme", None)?)
        .item(&mi("view_help", "How To & Shortcuts", None)?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_submenu, &file_menu, &edit_menu, &view_menu, &workspace_menu, &groups_menu])
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(OllamaState::default())
        .manage(LayoutEngine::new())
        .setup(|app| {
            let menu = build_app_menu(app.handle())?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                let id = event.id().0.clone();
                let _ = app.emit("app-menu", id);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_pdfs,
            list_documents,
            read_pdf,
            write_file,
            read_annot,
            write_annot,
            write_clip,
            read_clip,
            delete_clip,
            check_paths,
            read_global_groups,
            write_global_groups,
            copy_image_to_clipboard,
            clipboard_doc_path,
            reveal_in_finder,
            run_docling_layout,
            start_bundled_ollama,
            stop_bundled_ollama,
            detect_page_layout,
            secrets::set_provider_key,
            secrets::get_provider_key,
            secrets::clear_provider_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
