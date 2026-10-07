export async function interruptTurn({
  sessionId, pending, abort, onStopped, onError,
}) {
  if (pending.has(sessionId)) return false
  pending.add(sessionId)
  try {
    const result = await abort(sessionId)
    if (!result?.ok) throw new Error(result?.error?.message || 'Could not stop this session.')
  } catch (error) {
    onError(error)
    return false
  } finally {
    pending.delete(sessionId)
  }
  onStopped()
  return true
}

export function prioritizeQueuedMessage(items, id) {
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) return items
  return [items[index], ...items.slice(0, index), ...items.slice(index + 1)]
}
