import { app } from 'electron'
import { openPickerFlag, runOpenPicker } from './open-picker.ts'

const args = process.argv.slice(app.isPackaged ? 1 : 2)
if (process.platform === 'darwin' && args[0] === openPickerFlag) {
  runOpenPicker(args[1]).catch(() => app.exit(1))
} else await import('./main.mjs')
