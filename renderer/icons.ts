import theme from 'material-icon-theme/dist/material-icons.json' with { type: 'json' };

type IconTheme = {
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  folderExpanded: string;
  folder: string;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  file: string;
  iconDefinitions: Record<string, { iconPath: string }>;
};

const icons = theme as IconTheme;
const assets = import.meta.glob('../node_modules/material-icon-theme/icons/*.svg', {
  eager: true,
  query: '?url&no-inline',
  import: 'default',
});

/** Use the reference editor's actual icon associations, including compound suffixes. */
export function projectIcon(node: { name: string; kind: string }, expanded = false) {
  const name = node.name.toLowerCase();
  let icon: string | undefined;
  if (node.kind === 'directory') {
    icon =
      (expanded ? icons.folderNamesExpanded : icons.folderNames)[name] ??
      (expanded ? icons.folderExpanded : icons.folder);
  } else {
    icon = icons.fileNames[name];
    for (let dot = name.indexOf('.'); !icon && dot >= 0; dot = name.indexOf('.', dot + 1))
      icon = icons.fileExtensions[name.slice(dot + 1)];
    icon ??= icons.file;
  }
  const file = icons.iconDefinitions[icon].iconPath.split('/').pop();
  return assets[`../node_modules/material-icon-theme/icons/${file}`];
}
