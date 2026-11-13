import { installErrorHandlers, showStartupFailure } from '../recovery/errors.ts'
import { startWorkspaceOpeningPeeks } from '../recovery/workspace-opening.ts'
import { applyOpeningTheme } from './preferences.ts'

installErrorHandlers()
performance.mark('workspace-opening')
const stopOpeningTheme = applyOpeningTheme()
startWorkspaceOpeningPeeks(document.getElementById('workspace-opening'))
import('./main.js').then(stopOpeningTheme, showStartupFailure).catch((cause: unknown) => {
  console.error('Could not render Diffpane startup failure', cause)
})
