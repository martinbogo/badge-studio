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

//! The application menu.
//!
//! One definition, three placements: Tauri puts it in the system menu bar on
//! macOS and attaches it to the window on Windows and Linux, which is the
//! convention on each.
//!
//! The menu owns only document commands. Undo, copy, paste and the drawing
//! shortcuts stay in the frontend's key handler, because a menu accelerator is
//! consumed before the webview sees it: adding Cmd+C here would break copying
//! text out of the message-name field, and the app's Cmd+C means "copy the
//! selected pixels" anyway.
//!
//! Every item emits its id to the frontend rather than acting in Rust. The
//! frontend is the only place that knows whether the document is dirty, so it
//! has to be the one deciding whether "New" needs a confirmation first.

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Wry};

/// Carries the activated item's id.
pub const MENU_EVENT: &str = "menu";

/// Ids the frontend dispatches on. Recent-file items use `open-recent:<path>`.
pub const RECENT_PREFIX: &str = "open-recent:";

fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let recent = files_recent_submenu(app)?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&MenuItemBuilder::with_id("new-project", "New Project")
            .accelerator("CmdOrCtrl+N")
            .build(app)?)
        .item(&MenuItemBuilder::with_id("open-project", "Open Project...")
            .accelerator("CmdOrCtrl+O")
            .build(app)?)
        .item(&recent)
        .separator()
        .item(&MenuItemBuilder::with_id("save-project", "Save")
            .accelerator("CmdOrCtrl+S")
            .build(app)?)
        .item(&MenuItemBuilder::with_id("save-project-as", "Save As...")
            .accelerator("CmdOrCtrl+Shift+S")
            .build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("import-message", "Import Message...")
            .build(app)?)
        .item(&MenuItemBuilder::with_id("export-message", "Export Message...")
            .build(app)?)
        .separator()
        .item(&quit_item(app)?)
        .build()?;

    let builder = MenuBuilder::new(app);

    #[cfg(target_os = "macos")]
    let builder = {
        // macOS expects the leftmost menu to be the app's own, and expects Quit
        // to live there rather than under File.
        let app_menu = SubmenuBuilder::new(app, "Badge Studio")
            .about(None)
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .item(&quit_item(app)?)
            .build()?;
        builder.item(&app_menu)
    };

    builder.item(&file).build()
}

/// Not `PredefinedMenuItem::quit`.
///
/// The predefined item terminates the process through the platform's own quit
/// path, which on macOS never reaches Tauri's `ExitRequested`. The guard that
/// asks about unsaved work would be skipped by the one route most likely to be
/// taken in a hurry, so quitting goes through the frontend like every other
/// document command.
fn quit_item(app: &AppHandle) -> tauri::Result<tauri::menu::MenuItem<Wry>> {
    MenuItemBuilder::with_id("quit-app", "Quit Badge Studio")
        .accelerator("CmdOrCtrl+Q")
        .build(app)
}

fn files_recent_submenu(app: &AppHandle) -> tauri::Result<tauri::menu::Submenu<Wry>> {
    let recents = crate::files::recent_list(app.clone());
    let mut sub = SubmenuBuilder::new(app, "Open Recent");

    if recents.is_empty() {
        sub = sub.item(
            &MenuItemBuilder::with_id("no-recent", "Nothing yet")
                .enabled(false)
                .build(app)?,
        );
    } else {
        for entry in &recents {
            // The full path is the id so the frontend does not have to keep its
            // own parallel list in sync with the menu.
            let label = std::path::Path::new(&entry.path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&entry.path);
            sub = sub.item(
                &MenuItemBuilder::with_id(format!("{RECENT_PREFIX}{}", entry.path), label)
                    .build(app)?,
            );
        }
        sub = sub
            .separator()
            .item(&MenuItemBuilder::with_id("clear-recent", "Clear Menu").build(app)?);
    }
    sub.build()
}

/// Install the menu and route every activation to the frontend.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let menu = build(app)?;
    app.set_menu(menu)?;
    let handle = app.clone();
    app.on_menu_event(move |_app, event| {
        let _ = handle.emit(MENU_EVENT, event.id().0.clone());
    });
    Ok(())
}

/// Rebuild after the recents list changes.
///
/// Tauri has no API for editing a submenu in place, so the whole menu is
/// replaced. It is cheap and happens only on open and save.
pub fn rebuild(app: &AppHandle) {
    if let Ok(menu) = build(app) {
        let _ = app.set_menu(menu);
    }
}
