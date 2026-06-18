// OS secure credential store (S-11, FR-035).
//
// Wraps `keyring::Entry` with three Tauri commands so the frontend accessor
// (`src/ai/api-key.js`) can persist API keys to the macOS Keychain instead of
// plaintext `localStorage`. Keyed by (service, account) where service is a
// fixed app id and account is the provider id (e.g. "openrouter").
//
// `keyring::Error::NoEntry` is NOT a failure — a first-run empty Keychain maps
// to `Ok(None)` so the frontend doesn't spam error toasts on a clean install.

use keyring::{Entry, Error};

/// Fixed Keychain service name; one entry per provider account under it.
const SERVICE: &str = "reel-automator";

/// Read a stored secret for a provider.
/// Returns `Ok(None)` when no entry exists, `Ok(Some(secret))` on hit.
#[tauri::command]
pub fn get_credential(provider: String) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, &provider).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Persist (create or overwrite) a secret for a provider.
#[tauri::command]
pub fn set_credential(provider: String, secret: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &provider).map_err(|e| e.to_string())?;
    entry.set_password(&secret).map_err(|e| e.to_string())
}

/// Delete a provider's secret. Missing entry is treated as success (idempotent).
#[tauri::command]
pub fn delete_credential(provider: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &provider).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
