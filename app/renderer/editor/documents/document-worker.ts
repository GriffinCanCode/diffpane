/// <reference lib="webworker" />

import { processDocument } from './document-processing.ts'
import type { DocumentTask } from './document-processing.ts'

declare const self: DedicatedWorkerGlobalScope

self.addEventListener('message', ({ data }: MessageEvent<DocumentTask>) => {
  let result: ReturnType<typeof processDocument> | Error
  try {
    result = processDocument(data)
  } catch (cause) {
    result = cause instanceof Error ? cause : new Error('Could not process document.', { cause })
  }
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A dedicated worker replies on its own port.
  self.postMessage(result)
})
