import { installErrorHandlers, showStartupFailure } from '../recovery/errors.ts'

installErrorHandlers()
performance.mark('workspace-opening')
import('./main.js').catch(showStartupFailure).catch((cause: unknown) => {
  console.error('Could not render Diffpane startup failure', cause)
})
