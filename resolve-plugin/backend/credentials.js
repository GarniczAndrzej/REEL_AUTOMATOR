// Node reimplementation of keychain.rs (get/set/delete_credential, S-09 Phase 1)
// using Electron safeStorage (OS-encrypted) instead of the keyring crate — no
// extra native .node to sign/notarize. Encrypted blobs persist under
// `<userData>/credentials/<provider>.bin`. Fresh Electron namespace by decision
// (no migration from the Tauri macOS Keychain).
//
// Matches the Tauri command shapes:
//   get_credential({ provider }) -> string | null
//   set_credential({ provider, secret }) -> void
//   delete_credential({ provider }) -> void

const fsp = require('fs/promises');
const path = require('path');
const { app, safeStorage } = require('electron');

function credDir() {
  return path.join(app.getPath('userData'), 'credentials');
}

function credFile(provider) {
  // Provider ids are simple slugs ('openrouter', 'huggingface').
  return path.join(credDir(), `${provider}.bin`);
}

/** @param {{ provider: string }} args @returns {Promise<string|null>} */
async function getCredential({ provider }) {
  try {
    const buf = await fsp.readFile(credFile(provider));
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(buf);
  } catch {
    return null; // no entry yet
  }
}

/** @param {{ provider: string, secret: string }} args @returns {Promise<void>} */
async function setCredential({ provider, secret }) {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('safeStorage: szyfrowanie niedostępne');
  await fsp.mkdir(credDir(), { recursive: true });
  await fsp.writeFile(credFile(provider), safeStorage.encryptString(secret));
}

/** @param {{ provider: string }} args @returns {Promise<void>} */
async function deleteCredential({ provider }) {
  try {
    await fsp.unlink(credFile(provider));
  } catch {
    /* already absent */
  }
}

module.exports = { getCredential, setCredential, deleteCredential };
