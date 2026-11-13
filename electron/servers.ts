import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const application = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonSettings = {
  analysis: {
    diagnosticMode: 'openFilesOnly',
    autoImportCompletions: false,
    inlayHints: {
      variableTypes: true,
      callArgumentNames: true,
      functionReturnTypes: true,
      genericTypes: true,
    },
  },
};

type ServerSpec = {
  name: string;
  manifests: readonly string[];
  commands: readonly string[];
  args: readonly string[];
  modules?: readonly string[];
  managed?: readonly string[];
  settings: object;
};

export type DiscoveredServer = ServerSpec & {
  language: string;
  command: string | null;
  env: NodeJS.ProcessEnv;
};

export const SERVER_SPECS: Record<string, ServerSpec> = {
  python: {
    name: 'basedpyright',
    manifests: ['pyproject.toml', 'pyrightconfig.json'],
    commands: ['basedpyright-langserver', 'pyright-langserver'],
    args: ['--stdio'],
    modules: ['basedpyright/dist/pyright-langserver.js', 'pyright/dist/pyright-langserver.js'],
    settings: { basedpyright: pythonSettings, python: pythonSettings },
  },
  rust: {
    name: 'rust-analyzer',
    manifests: ['Cargo.toml'],
    commands: ['rust-analyzer'],
    args: [],
    settings: {
      'rust-analyzer': {
        checkOnSave: false,
        numThreads: 2,
        cargo: { buildScripts: { enable: false } },
        procMacro: { enable: false },
      },
    },
  },
  elixir: {
    name: 'ElixirLS',
    manifests: ['mix.exs'],
    commands: ['elixir-ls', 'elixir-ls-language-server'],
    args: [],
    managed: ['elixir-ls/language_server.sh'],
    settings: { elixirLS: { autoBuild: false, dialyzerEnabled: false, fetchDeps: false } },
  },
  go: {
    name: 'gopls',
    manifests: ['go.mod', 'go.work'],
    commands: ['gopls'],
    args: ['serve'],
    settings: {
      gopls: {
        semanticTokens: true,
        hints: {
          assignVariableTypes: true,
          compositeLiteralTypes: true,
          constantValues: true,
          functionTypeParameters: true,
          parameterNames: true,
          rangeVariableTypes: true,
        },
      },
    },
  },
  swift: {
    name: 'SourceKit-LSP',
    manifests: ['Package.swift'],
    commands: ['sourcekit-lsp'],
    args: [],
    settings: {},
  },
  typescript: {
    name: 'TypeScript',
    manifests: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    commands: ['typescript-language-server'],
    args: ['--stdio'],
    modules: ['typescript-language-server/lib/cli.mjs'],
    settings: Object.fromEntries(
      ['typescript', 'javascript'].map(language => [
        language,
        {
          inlayHints: {
            includeInlayParameterNameHints: 'all',
            includeInlayParameterNameHintsWhenArgumentMatchesName: false,
            includeInlayFunctionParameterTypeHints: true,
            includeInlayVariableTypeHints: true,
            includeInlayPropertyDeclarationTypeHints: true,
            includeInlayFunctionLikeReturnTypeHints: true,
            includeInlayEnumMemberValueHints: true,
          },
        },
      ]),
    ),
  },
};

function exists(file: string, executable = false) {
  try {
    accessSync(file, executable ? constants.X_OK : constants.R_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function discoverServers({
  env = process.env,
  toolsDir = env.DIFFPANE_LANGUAGE_DIR ??
    path.join(homedir(), 'Library/Application Support/Diffpane/languages'),
  moduleRoot = path.join(application, 'node_modules'),
  node = process.execPath,
}: {
  env?: NodeJS.ProcessEnv;
  toolsDir?: string;
  moduleRoot?: string;
  node?: string;
} = {}): Record<string, DiscoveredServer> {
  // GUI launches need the standard tool locations even when macOS supplies a minimal PATH.
  const searchPath = [
    ...new Set([
      path.join(toolsDir, 'bin'),
      ...(env.PATH ?? '').split(path.delimiter).filter(Boolean),
      path.join(homedir(), '.cargo/bin'),
      path.join(homedir(), 'go/bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ]),
  ];
  const processEnv: NodeJS.ProcessEnv = { ...env, PATH: searchPath.join(path.delimiter) };
  // Forked analyzers need real filesystem entries, including TypeScript's worker and server scripts.
  let physicalModules = moduleRoot;
  for (
    let directory = moduleRoot;
    path.dirname(directory) !== directory;
    directory = path.dirname(directory)
  ) {
    if (path.basename(directory).endsWith('.asar')) {
      physicalModules = path.join(`${directory}.unpacked`, path.relative(directory, moduleRoot));
      break;
    }
  }
  return Object.fromEntries(
    Object.entries(SERVER_SPECS).map(([language, spec]) => {
      for (const module of spec.modules ?? []) {
        const entry = path.join(physicalModules, module);
        if (exists(entry))
          return [
            language,
            {
              ...spec,
              language,
              command: node,
              args: [entry, ...spec.args],
              env: { ...processEnv, ELECTRON_RUN_AS_NODE: '1' },
            },
          ];
      }
      const candidates = [
        ...(spec.managed ?? []).map(file => path.join(toolsDir, file)),
        ...spec.commands.flatMap(command =>
          searchPath.map(directory => path.join(directory, command)),
        ),
      ];
      const command = candidates.find(file => exists(file, true));
      const limits =
        language === 'elixir'
          ? { ERL_FLAGS: processEnv.ERL_FLAGS ?? '+S 2:2 +SDcpu 1 +SDio 1' }
          : language === 'go'
            ? { GOMAXPROCS: processEnv.GOMAXPROCS ?? '2' }
            : {};
      return [
        language,
        { ...spec, language, command: command ?? null, env: { ...processEnv, ...limits } },
      ];
    }),
  );
}
