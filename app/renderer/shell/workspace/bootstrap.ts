import { attemptAsync } from '../../../shared/recovery/app-errors.ts'
import { observeRendererResponsiveness, rendererDiagnostics } from '../diagnostics/diagnostics.ts'
import { installErrorHandlers, showStartupFailure } from '../recovery/errors.ts'
import { startWorkspaceOpeningPeeks } from '../recovery/workspace-opening.ts'
import { applyOpeningTheme } from './preferences.ts'

installErrorHandlers()
observeRendererResponsiveness()
performance.mark('workspace-opening')
const stopOpeningTheme = applyOpeningTheme()
startWorkspaceOpeningPeeks(document.getElementById('workspace-opening'))
const startedAt = performance.now()
attemptAsync(() => import('./main.js'), { recoverable: false })
  .then(result => {
    rendererDiagnostics.measure('renderer.startup', startedAt, result)
    if (!result.ok) showStartupFailure(result.error)
    else stopOpeningTheme()
    return undefined
  })
  .catch((cause: unknown) => rendererDiagnostics.error('renderer.startup-recovery', cause))
