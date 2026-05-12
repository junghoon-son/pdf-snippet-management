// Encrypted-at-rest API-key store.
//
// We never put the user's API key in plaintext on disk. The key is
// AES-256-GCM-encrypted with a key derived from a *machine-stable*
// identifier — `IOPlatformUUID` on macOS, with a per-install random
// fallback for systems where ioreg isn't available. Effects:
//
//   * The on-disk `secrets.json` is meaningless to anyone copying it
//     to another Mac (Time Machine, iCloud backup, accidental Slack
//     paste of `~/Library/Application Support/Marklee/`).
//   * A local attacker who has code execution as the user can still
//     derive the same key (the salt is in our binary, the machine ID
//     is on the same host) — but at that point they can read process
//     memory anyway. The bar is "no plaintext on disk", not "secure
//     against active local malware."
//
// Storage layout (one file `secrets.json` in the app data dir):
//
//   { "anthropic": { "nonce": "<b64>", "ciphertext": "<b64>" },
//     "openai":    { "nonce": "<b64>", "ciphertext": "<b64>" } }
//
// Each entry is encrypted with a fresh random nonce so re-saving the
// same key doesn't produce identical ciphertext.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::Engine as _;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

const SECRETS_FILE: &str = "secrets.json";
const FALLBACK_ID_FILE: &str = "install-id";
const APP_SALT: &[u8] = b"marklee.v1.secrets.aes256gcm";

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn app_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn secrets_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join(SECRETS_FILE))
}

/// Return a machine-stable identifier string. macOS path uses
/// `ioreg -d2 -c IOPlatformExpertDevice` and parses out `IOPlatformUUID`.
/// On other platforms (or if ioreg fails), generate-and-persist a random
/// UUID under the app data dir — still beats plaintext because the file
/// is per-install and not part of the same `secrets.json`.
fn machine_id(app: &tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("ioreg")
            .args(["-d2", "-c", "IOPlatformExpertDevice"])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                if !line.contains("IOPlatformUUID") {
                    continue;
                }
                // Format: ... "IOPlatformUUID" = "XXXXXXXX-XXXX-..."
                let mut parts = line.split('"');
                while let Some(p) = parts.next() {
                    if p.trim_end().ends_with('=') {
                        if let Some(uuid) = parts.next() {
                            if !uuid.is_empty() {
                                return Ok(uuid.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    // Fallback path: persisted random UUID
    let path = app_dir(app)?.join(FALLBACK_ID_FILE);
    if let Ok(b) = fs::read_to_string(&path) {
        let s = b.trim().to_string();
        if !s.is_empty() {
            return Ok(s);
        }
    }
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).map_err(|e| e.to_string())?;
    let id = b64().encode(buf);
    fs::write(&path, &id).map_err(|e| e.to_string())?;
    Ok(id)
}

fn derive_key(app: &tauri::AppHandle) -> Result<[u8; 32], String> {
    let mid = machine_id(app)?;
    let mut h = Sha256::new();
    h.update(APP_SALT);
    h.update(mid.as_bytes());
    let digest = h.finalize();
    let mut k = [0u8; 32];
    k.copy_from_slice(&digest);
    Ok(k)
}

fn encrypt(app: &tauri::AppHandle, plaintext: &str) -> Result<(String, String), String> {
    let key = derive_key(app)?;
    let cipher = Aes256Gcm::new((&key).into());
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("encrypt: {}", e))?;
    Ok((b64().encode(nonce_bytes), b64().encode(ct)))
}

fn decrypt(app: &tauri::AppHandle, nonce_b64: &str, ct_b64: &str) -> Result<String, String> {
    let key = derive_key(app)?;
    let cipher = Aes256Gcm::new((&key).into());
    let nonce_bytes = b64()
        .decode(nonce_b64)
        .map_err(|e| format!("nonce b64: {}", e))?;
    let ct = b64()
        .decode(ct_b64)
        .map_err(|e| format!("ciphertext b64: {}", e))?;
    let pt = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ct.as_slice())
        .map_err(|e| format!("decrypt: {}", e))?;
    String::from_utf8(pt).map_err(|e| e.to_string())
}

fn read_store(app: &tauri::AppHandle) -> Result<Value, String> {
    let path = secrets_path(app)?;
    if !path.exists() {
        return Ok(serde_json::json!({ "version": 1 }));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Ok(serde_json::json!({ "version": 1 }));
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn write_store(app: &tauri::AppHandle, v: &Value) -> Result<(), String> {
    let path = secrets_path(app)?;
    let pretty = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    fs::write(&path, pretty).map_err(|e| e.to_string())?;
    // Belt-and-suspenders: tighten perms so other local accounts
    // can't even read the (encrypted) file.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
pub fn set_provider_key(
    app: tauri::AppHandle,
    provider: String,
    key: String,
) -> Result<(), String> {
    let mut store = read_store(&app)?;
    let obj = store
        .as_object_mut()
        .ok_or("secrets store malformed")?;
    obj.entry("version").or_insert(serde_json::json!(1));
    if key.is_empty() {
        obj.remove(&provider);
    } else {
        let (nonce, ct) = encrypt(&app, &key)?;
        obj.insert(
            provider,
            serde_json::json!({ "nonce": nonce, "ciphertext": ct }),
        );
    }
    write_store(&app, &store)
}

#[tauri::command]
pub fn get_provider_key(
    app: tauri::AppHandle,
    provider: String,
) -> Result<Option<String>, String> {
    let store = read_store(&app)?;
    let entry = match store.get(&provider) {
        Some(e) => e,
        None => return Ok(None),
    };
    let nonce = entry
        .get("nonce")
        .and_then(|v| v.as_str())
        .ok_or("entry missing nonce")?;
    let ct = entry
        .get("ciphertext")
        .and_then(|v| v.as_str())
        .ok_or("entry missing ciphertext")?;
    Ok(Some(decrypt(&app, nonce, ct)?))
}

#[tauri::command]
pub fn clear_provider_key(app: tauri::AppHandle, provider: String) -> Result<(), String> {
    let mut store = read_store(&app)?;
    if let Some(obj) = store.as_object_mut() {
        obj.remove(&provider);
    }
    write_store(&app, &store)
}
