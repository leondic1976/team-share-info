/**
 * Script served to plugins as teamhub-plugin://<id>/__sdk.js.
 *   const me = await TeamHub.call('me')
 *   TeamHub.on('room.changed', ({ roomId }) => …)
 * Calls go to the TeamHub window through postMessage; only declared permissions work.
 */
export const PLUGIN_SDK = `(() => {
  let seq = 0
  const waiting = new Map()
  const handlers = new Map()
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return
    const m = e.data
    if (!m || m.th !== 1) return
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id)
      waiting.delete(m.id)
      m.error ? w.reject(new Error(m.error)) : w.resolve(m.result)
    } else if (m.event) {
      for (const cb of handlers.get(m.event) || []) { try { cb(m.data) } catch (err) { console.error(err) } }
    }
  })
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = 'c' + (++seq)
    waiting.set(id, { resolve, reject })
    window.parent.postMessage({ th: 1, id, method, params: params ?? null }, '*')
  })
  const on = (event, cb) => {
    if (!handlers.has(event)) handlers.set(event, new Set())
    handlers.get(event).add(cb)
    return () => handlers.get(event).delete(cb)
  }
  const params = new URLSearchParams(location.search)
  window.TeamHub = { call, on, room: params.get('room'), theme: params.get('theme') || 'light' }
  document.documentElement.dataset.theme = window.TeamHub.theme
})()
`
