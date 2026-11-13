import { app, safeStorage } from 'electron'

// DiffPane ships on macOS. Electron's async Linux provider can fall back to a hardcoded key.
export async function secureStorageAvailable() {
  return (
    ['darwin', 'win32'].includes(process.platform) &&
    !app.commandLine.hasSwitch('use-mock-keychain') &&
    (await safeStorage.isAsyncEncryptionAvailable().catch(() => false))
  )
}

export const localStateKeys = {
  /** @param {string} key */
  async wrap(key) {
    if (!(await secureStorageAvailable())) throw new Error('Secure local storage is unavailable.')
    const wrapped = await safeStorage.encryptStringAsync(key)
    if (wrapped.includes(key)) throw new Error('The operating system could not protect the local storage key.')
    return wrapped
  },
  /** @param {Buffer} wrapped */
  async unwrap(wrapped) {
    if (!(await secureStorageAvailable())) throw new Error('Secure local storage is unavailable.')
    try {
      const { result } = await safeStorage.decryptStringAsync(wrapped)
      if (wrapped.includes(result)) throw new Error()
      return result
    } catch (error) {
      throw new Error('DiffPane could not unlock its local storage. Check access to the operating system key store.', {
        cause: error,
      })
    }
  },
}
