// The main process is the only place allowed to hand anything to the shell, so resolving a link to
// a real file happens here rather than in the renderer. The shell is injected so the whole decision
// can be tested without an Electron window.

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { classifyLinkTarget, missingLocalFileMessage } from '../shared/link-targets.mjs'

async function firstExisting(candidates, { statFile = stat } = {}) {
  for (const candidate of candidates) {
    try {
      await statFile(candidate)
      return candidate
    } catch (error) {
      // ENOENT/ENOTDIR just mean this spelling isn't the real file, keep trying the others.
      // Anything else (EACCES, EPERM, EIO, ...) is a real problem and must reach the caller
      // instead of being read as "file doesn't exist".
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
      error.candidate = candidate
      throw error
    }
  }
  return null
}

export async function openLinkTarget(payload, shell, { homeDirectory = homedir(), statFile } = {}) {
  const { href, workingDirectory = '' } = payload || {}
  const target = classifyLinkTarget(href, { workingDirectory, homeDirectory })

  switch (target.kind) {
    case 'empty':
      return { ok: false, error: { message: 'No link was given.' } }
    case 'anchor':
      // An in-page jump has already happened in the renderer, there is nothing to open.
      return { ok: true }
    case 'blocked':
      return { ok: false, error: { message: target.message } }
    case 'needs-folder':
      return { ok: false, error: { message: target.message } }
    case 'external': {
      try {
        const parsed = new URL(target.url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { ok: false, error: { message: `Only web links can be opened, not ${parsed.protocol}` } }
        }
        await shell.openExternal(parsed.toString())
        return { ok: true }
      } catch (error) {
        return { ok: false, error: { message: error?.message || String(error) } }
      }
    }
    case 'local': {
      let found
      try {
        found = await firstExisting(target.candidates, { statFile })
      } catch (error) {
        // A real filesystem error (permission denied, I/O error, ...) is not "missing", it must
        // surface as its own failure rather than being folded into the missing-file message.
        const path = error?.candidate || target.candidates[0]
        return { ok: false, error: { message: `${error?.message || String(error)} (${path})` } }
      }
      // Saying nothing, or saying "Invalid URL", is what made this feel broken. Name the path.
      if (!found) return { ok: false, error: { message: missingLocalFileMessage(target) } }
      try {
        const failure = await shell.openPath(found)
        if (failure) return { ok: false, error: { message: failure } }
        return { ok: true, path: found }
      } catch (error) {
        return { ok: false, error: { message: error?.message || String(error) } }
      }
    }
    default:
      return { ok: false, error: { message: 'That link could not be understood.' } }
  }
}
