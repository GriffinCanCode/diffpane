import { installErrorHandlers, showStartupFailure } from './errors.ts'

installErrorHandlers()
import('./main.js').catch(showStartupFailure).catch((cause: unknown) => {
  console.error('Could not render Diffpane startup failure', cause)
})
