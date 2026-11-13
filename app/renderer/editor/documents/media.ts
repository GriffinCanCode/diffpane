export function showMedia(
  host: ParentNode,
  media: { type: string; url: string },
  filename: string,
  { onReady, onError }: { onReady: (description: string) => void; onError: (message: string) => void },
) {
  const video = media.type.startsWith('video/')
  const viewport = document.createElement('div')
  viewport.className = 'media-preview'
  const element = video ? document.createElement('video') : document.createElement('img')
  element.className = 'media-content'
  element.setAttribute('aria-label', filename)
  const listeners = new AbortController()
  const options = { signal: listeners.signal }
  const ready = (description: string) => {
    if (!listeners.signal.aborted) onReady(description)
  }
  const failed = () => {
    if (listeners.signal.aborted) return
    dispose()
    onError(
      video
        ? 'This video could not be played. Its format or codec may be unsupported, or the file may be missing or damaged.'
        : 'This image could not be displayed. The file may be missing, damaged, or in an unsupported format.',
    )
  }
  element.addEventListener('error', failed, options)
  if (element instanceof HTMLVideoElement) {
    element.controls = true
    element.playsInline = true
    element.preload = 'metadata'
    element.addEventListener(
      'loadedmetadata',
      () => {
        const seconds = Math.round(element.duration)
        const duration = Number.isFinite(seconds)
          ? ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
          : ''
        ready(`${element.videoWidth} × ${element.videoHeight}${duration}`)
      },
      options,
    )
    viewport.append(element)
  } else {
    element.alt = filename
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'media-image-toggle'
    toggle.setAttribute('aria-label', 'View image at actual size')
    toggle.setAttribute('aria-pressed', 'false')
    toggle.title = 'Click to view at actual size'
    toggle.addEventListener(
      'click',
      () => {
        const actualSize = viewport.classList.toggle('media-actual-size')
        toggle.setAttribute('aria-label', actualSize ? 'Fit image to view' : 'View image at actual size')
        toggle.title = actualSize ? 'Click to fit image to view' : 'Click to view at actual size'
        toggle.setAttribute('aria-pressed', String(actualSize))
      },
      options,
    )
    element.addEventListener('load', () => ready(`${element.naturalWidth} × ${element.naturalHeight}`), options)
    toggle.append(element)
    viewport.append(toggle)
  }
  host.replaceChildren(viewport)
  element.src = media.url
  function dispose() {
    if (listeners.signal.aborted) return
    listeners.abort()
    if (element instanceof HTMLVideoElement) element.pause()
    element.removeAttribute('src')
    if (element instanceof HTMLVideoElement) element.load()
    viewport.remove()
  }
  return dispose
}
