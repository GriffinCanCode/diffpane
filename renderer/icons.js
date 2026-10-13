import theme from 'material-icon-theme/dist/material-icons.json';

const assets = import.meta.glob('../node_modules/material-icon-theme/icons/*.svg', { eager: true, query: '?url&no-inline', import: 'default' });

/** Use the reference editor's actual icon associations, including compound suffixes. */
export function projectIcon(node, expanded = false) {
  const name = node.name.toLowerCase();
  let icon;
  if (node.kind === 'directory') {
    icon = (expanded ? theme.folderNamesExpanded : theme.folderNames)[name] ?? (expanded ? theme.folderExpanded : theme.folder);
  } else {
    icon = theme.fileNames[name];
    for (let dot = name.indexOf('.'); !icon && dot >= 0; dot = name.indexOf('.', dot + 1)) icon = theme.fileExtensions[name.slice(dot + 1)];
    icon ??= theme.file;
  }
  const file = theme.iconDefinitions[icon].iconPath.split('/').pop();
  return assets[`../node_modules/material-icon-theme/icons/${file}`];
}
