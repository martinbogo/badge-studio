// Copyright 2026 Martin Bogomolni
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! Document storage: projects, single messages, recents, and crash recovery.
//!
//! Two extensions, deliberately. A `.badge` file is a whole project and opening
//! one replaces the document. A `.badgemsg` file is one message and opening one
//! inserts into the document. Same JSON underneath, but double-clicking a file
//! in a file manager should never leave you guessing which of those happened.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

pub const PROJECT_EXT: &str = "badge";
pub const MESSAGE_EXT: &str = "badgemsg";

/// Kept small on purpose. A long list is a menu nobody reads.
const MAX_RECENT: usize = 10;

#[derive(Debug, Clone, Serialize)]
pub struct Opened {
    pub path: String,
    pub text: String,
}

/// An autosave from a session that did not end cleanly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recovery {
    pub json: String,
    /// The file the work belonged to, if it had one. A recovered untitled
    /// document has nowhere to save back to and must go through Save As.
    pub path: Option<String>,
    pub saved_at: String,
}

fn describe(kind: &str) -> (&'static str, Vec<&'static str>) {
    if kind == "message" {
        ("Badge Studio message", vec![MESSAGE_EXT])
    } else {
        ("Badge Studio project", vec![PROJECT_EXT])
    }
}

/// Where recovery and recents live. Created on demand: Tauri does not
/// guarantee the directory exists before something writes to it.
fn state_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No application data directory: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn recovery_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(state_dir(app)?.join("recovery.json"))
}

fn recent_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(state_dir(app)?.join("recent.json"))
}

#[tauri::command]
pub async fn pick_open(app: AppHandle, kind: String) -> Result<Option<Opened>, String> {
    let (label, exts) = describe(&kind);
    let path = app
        .dialog()
        .file()
        .add_filter(label, &exts)
        .blocking_pick_file();
    let Some(path) = path else { return Ok(None) };
    let path = path
        .into_path()
        .map_err(|e| format!("Could not resolve that file: {e}"))?;
    let text = read_text_at(&path)?;
    push_recent(&app, &path, &kind);
    Ok(Some(Opened {
        path: path.display().to_string(),
        text,
    }))
}

#[tauri::command]
pub async fn pick_save(
    app: AppHandle,
    kind: String,
    suggested: String,
) -> Result<Option<String>, String> {
    let (label, exts) = describe(&kind);
    let path = app
        .dialog()
        .file()
        .add_filter(label, &exts)
        .set_file_name(&suggested)
        .blocking_save_file();
    let Some(path) = path else { return Ok(None) };
    let mut path = path
        .into_path()
        .map_err(|e| format!("Could not resolve that location: {e}"))?;
    // Some platforms return exactly what was typed. A project without its
    // extension will not open by double-clicking later, so put it back.
    if path.extension().and_then(|e| e.to_str()) != Some(exts[0]) {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("untitled")
            .to_string();
        path.set_file_name(format!("{name}.{}", exts[0]));
    }
    Ok(Some(path.display().to_string()))
}

fn read_text_at(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("Could not read {}: {e}", path.display()))
}

#[tauri::command]
pub fn read_text(app: AppHandle, path: String, kind: Option<String>) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let text = read_text_at(&p)?;
    push_recent(&app, &p, kind.as_deref().unwrap_or("project"));
    Ok(text)
}

#[tauri::command]
pub fn write_text(
    app: AppHandle,
    path: String,
    contents: String,
    kind: Option<String>,
) -> Result<(), String> {
    let p = PathBuf::from(&path);
    std::fs::write(&p, contents).map_err(|e| format!("Could not write {}: {e}", p.display()))?;
    push_recent(&app, &p, kind.as_deref().unwrap_or("project"));
    Ok(())
}

// --- crash recovery ------------------------------------------------------

/// Write the working copy somewhere the next launch can find it.
///
/// Never writes to the user's own file. An autosave that overwrote the document
/// would turn a crash into data loss instead of protecting against it.
#[tauri::command]
pub fn recovery_write(app: AppHandle, json: String, path: Option<String>, saved_at: String) -> Result<(), String> {
    let rec = Recovery { json, path, saved_at };
    let text = serde_json::to_string(&rec).map_err(|e| e.to_string())?;
    std::fs::write(recovery_path(&app)?, text).map_err(|e| format!("Could not autosave: {e}"))
}

#[tauri::command]
pub fn recovery_read(app: AppHandle) -> Result<Option<Recovery>, String> {
    let p = recovery_path(&app)?;
    if !p.exists() {
        return Ok(None);
    }
    let text = read_text_at(&p)?;
    // A corrupt autosave is not worth an error dialog on startup. Treat it as
    // nothing to recover and let the user get on with their day.
    Ok(serde_json::from_str(&text).ok())
}

/// Called on a clean quit and after a successful save. Its absence at startup
/// is precisely the signal that the last session ended badly.
#[tauri::command]
pub fn recovery_clear(app: AppHandle) -> Result<(), String> {
    let p = recovery_path(&app)?;
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| format!("Could not clear the autosave: {e}"))?;
    }
    Ok(())
}

// --- recent files --------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentEntry {
    pub path: String,
    pub kind: String,
}

#[tauri::command]
pub fn recent_list(app: AppHandle) -> Vec<RecentEntry> {
    let Ok(p) = recent_path(&app) else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(p) else {
        return Vec::new();
    };
    let list: Vec<RecentEntry> = serde_json::from_str(&text).unwrap_or_default();
    // Files move and get deleted between sessions; a menu full of dead entries
    // is worse than a short one.
    list.into_iter()
        .filter(|e| Path::new(&e.path).exists())
        .collect()
}

#[tauri::command]
pub fn recent_clear(app: AppHandle) -> Result<(), String> {
    let p = recent_path(&app)?;
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    crate::menu::rebuild(&app);
    Ok(())
}

fn push_recent(app: &AppHandle, path: &Path, kind: &str) {
    let entry = RecentEntry {
        path: path.display().to_string(),
        kind: kind.to_string(),
    };
    let mut list = recent_list(app.clone());
    list.retain(|e| e.path != entry.path);
    list.insert(0, entry);
    list.truncate(MAX_RECENT);

    if let (Ok(p), Ok(text)) = (recent_path(app), serde_json::to_string(&list)) {
        let _ = std::fs::write(p, text);
    }
    crate::menu::rebuild(app);
}
