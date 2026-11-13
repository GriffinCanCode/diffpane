import theme from 'material-icon-theme/dist/material-icons.json' with { type: 'json' }

interface IconTheme {
  folderNames: Record<string, string>
  folderNamesExpanded: Record<string, string>
  folderExpanded: string
  folder: string
  fileNames: Record<string, string>
  fileExtensions: Record<string, string>
  file: string
  iconDefinitions: Record<string, { iconPath: string }>
}

const ICONS: IconTheme = theme
const ASSETS = import.meta.glob<string>('../node_modules/material-icon-theme/icons/*.svg', {
  eager: true,
  query: '?url&no-inline',
  import: 'default',
})

/** Use the reference editor's actual icon associations, including compound suffixes. */
export function projectIcon(node: { name: string; kind: string }, expanded = false) {
  const name = node.name.toLowerCase()
  let icon: string | undefined
  if (node.kind === 'directory') {
    icon =
      (expanded ? ICONS.folderNamesExpanded : ICONS.folderNames)[name] ??
      (expanded ? ICONS.folderExpanded : ICONS.folder)
  } else {
    icon = ICONS.fileNames[name]
    for (let dot = name.indexOf('.'); !icon && dot >= 0; dot = name.indexOf('.', dot + 1))
      icon = ICONS.fileExtensions[name.slice(dot + 1)]
    icon ??= ICONS.file
  }
  const file = (ICONS.iconDefinitions[icon] ?? ICONS.iconDefinitions[ICONS.file])?.iconPath.split('/').pop()
  return file === undefined ? undefined : ASSETS[`../node_modules/material-icon-theme/icons/${file}`]
}
