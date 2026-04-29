use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

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
}

#[derive(Serialize, Deserialize, Default)]
struct AnnotFile {
    #[serde(default)]
    source: Source,
    #[serde(default)]
    snippets: Vec<Snippet>,
    #[serde(default)]
    edges: Vec<Edge>,
    #[serde(default)]
    groups: Vec<GroupMeta>,
}

fn sidecar_path(pdf_path: &str) -> PathBuf {
    let p = Path::new(pdf_path);
    let mut s = p.as_os_str().to_owned();
    s.push(".annot.json");
    PathBuf::from(s)
}

#[tauri::command]
fn list_pdfs(dir: String) -> Result<Vec<String>, String> {
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if p.is_file()
            && p.extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case("pdf"))
                .unwrap_or(false)
        {
            if let Some(s) = p.to_str() {
                out.push(s.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

#[tauri::command]
fn read_pdf(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| e.to_string())
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

fn resolve_clip(pdf_path: &str, image_path: &str) -> PathBuf {
    let p = Path::new(image_path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        Path::new(pdf_path)
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(p)
    }
}

#[tauri::command]
fn write_clip(pdf_path: String, clip_id: String, bytes: Vec<u8>) -> Result<String, String> {
    let (dir, rel_dir) = clip_dir_for(&pdf_path)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join(format!("{}.png", clip_id));
    fs::write(&p, bytes).map_err(|e| e.to_string())?;
    Ok(format!("{}/{}.png", rel_dir, clip_id))
}

#[tauri::command]
fn read_clip(pdf_path: String, image_path: String) -> Result<Vec<u8>, String> {
    let p = resolve_clip(&pdf_path, &image_path);
    fs::read(&p).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_clip(pdf_path: String, image_path: String) -> Result<(), String> {
    let p = resolve_clip(&pdf_path, &image_path);
    if p.exists() {
        fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn check_paths(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).exists()).collect()
}

fn global_groups_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = Path::new(&home).join(".pdf-annotator");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("groups.json"))
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
fn read_annot(pdf_path: String) -> Result<AnnotFile, String> {
    let p = sidecar_path(&pdf_path);
    if !p.exists() {
        return Ok(AnnotFile::default());
    }
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    let mut af = if let Ok(af) = serde_json::from_slice::<AnnotFile>(&bytes) {
        af
    } else {
        let snippets: Vec<Snippet> = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        AnnotFile {
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
                });
            }
        }
    }
    Ok(af)
}

#[tauri::command]
fn write_annot(pdf_path: String, payload: AnnotFile) -> Result<(), String> {
    let p = sidecar_path(&pdf_path);
    let json = serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(&p, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            list_pdfs,
            read_pdf,
            read_annot,
            write_annot,
            write_clip,
            read_clip,
            delete_clip,
            check_paths,
            read_global_groups,
            write_global_groups
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
