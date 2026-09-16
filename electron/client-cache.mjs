export function dropDisconnectedClient(cachedClient, activeSessions) {
  // CopilotClient has no public synchronous connection-state accessor. SDK 1.0.13
  // sets this exact state when the transport closes, so do not treat timeouts or other errors as
  // proof that an active client must be discarded.
  if (!cachedClient || cachedClient.state !== 'disconnected') return false

  for (const active of activeSessions.values()) {
    try {
      active?.unsubscribe?.()
    } catch {
      // A stale SDK subscription is already unusable, so cleanup is best effort.
    }
  }
  activeSessions.clear()
  return true
}

export function getReusableSession(cachedClient, activeSessions, sessionId) {
  if (cachedClient?.state !== 'connected') return undefined
  return activeSessions.get(sessionId)?.session
}
