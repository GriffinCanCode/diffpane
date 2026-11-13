import { installErrorHandlers, showStartupFailure } from '../recovery/errors.ts'
import { applyOpeningTheme } from './preferences.ts'

installErrorHandlers()
performance.mark('workspace-opening')
const stopOpeningTheme = applyOpeningTheme()
import('./main.js')
  .then(stopOpeningTheme, showStartupFailure)
  .catch((cause: unknown) => {
    console.error('Could not render Diffpane startup failure', cause)
  })
