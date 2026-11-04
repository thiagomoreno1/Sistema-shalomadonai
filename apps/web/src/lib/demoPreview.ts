const DEMO_PREVIEW_SESSION_KEY = 'shalom-adonai-demo-preview'

export function isDemoPreviewEnabled() {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false

  const requestedInUrl = new URLSearchParams(window.location.search).get('demo') === '1'
  try {
    if (requestedInUrl) window.sessionStorage.setItem(DEMO_PREVIEW_SESSION_KEY, '1')
    return requestedInUrl || window.sessionStorage.getItem(DEMO_PREVIEW_SESSION_KEY) === '1'
  } catch {
    return requestedInUrl
  }
}

export function clearDemoPreview() {
  try {
    window.sessionStorage.removeItem(DEMO_PREVIEW_SESSION_KEY)
  } catch {
    // The query parameter still provides a one-route fallback in restricted browsers.
  }
}
