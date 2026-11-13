import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Idea, IdeaChange } from '../ideas.ts';
import type { ReviewNote, ReviewNoteChange } from '../review-notes.ts';
import type { UiPreferencesBridge } from './ui-preferences.ts';

export type ClaudeFileReference = {
  path: string;
  side: 'working' | 'head';
  startLine?: number;
  endLine?: number;
};

export type ClaudePrompt = {
  prompt: string;
  proposeEdits: boolean;
  requestId?: string;
  path?: string;
  fileContext?: ClaudeFileReference;
  ideaId?: string;
  ideaContext?: string;
};

export type ClaudeActivity = { requestId: string; step: number } & (
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      label: string;
      status: 'running' | 'done' | 'error';
      detail?: string;
      path?: string;
      side?: ClaudeFileReference['side'];
      startLine?: number;
      endLine?: number;
    }
);

type ClaudeStatus = { configured: boolean; secureStorage: boolean };
export type ClaudeProposal = { id: string; before: string; after: string } & (
  | { kind: 'file'; path: string; startLine: number }
  | {
      kind: 'idea';
      action: 'create' | 'update';
      ideaId: string;
      title: string;
      beforeTitle?: string;
    }
);
type ClaudeReply = { text: string; step: number; proposal?: ClaudeProposal };
type ClaudeApplied = { path: string } | { idea: Idea };

function isClaudeActivity(value: unknown): value is ClaudeActivity {
  if (typeof value !== 'object' || value === null) return false;
  const activity = value as Record<string, unknown>;
  const {
    requestId,
    step,
    type,
    text,
    id,
    name,
    label,
    status,
    detail,
    path,
    side,
    startLine,
    endLine,
  } = activity;
  if (
    typeof requestId !== 'string' ||
    typeof step !== 'number' ||
    !Number.isSafeInteger(step) ||
    step < 0
  )
    return false;
  if (type === 'text') return typeof text === 'string';
  return (
    type === 'tool' &&
    typeof id === 'string' &&
    typeof name === 'string' &&
    typeof label === 'string' &&
    (status === 'running' || status === 'done' || status === 'error') &&
    (detail === undefined || typeof detail === 'string') &&
    (path === undefined || typeof path === 'string') &&
    (side === undefined || side === 'working' || side === 'head') &&
    (startLine === undefined ||
      (typeof startLine === 'number' && Number.isSafeInteger(startLine) && startLine > 0)) &&
    (endLine === undefined ||
      (typeof endLine === 'number' && Number.isSafeInteger(endLine) && endLine > 0))
  );
}

type Unsubscribe = () => void;
const listen = <T>(channel: string, callback: (value: T) => void): Unsubscribe => {
  const listener = (_event: IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api = {
  preferences: {
    get: legacy => ipcRenderer.invoke('preferences-get', legacy),
    set: (key, value) => ipcRenderer.invoke('preferences-set', key, value),
    onChange: callback => listen('preferences-updated', callback),
  } satisfies UiPreferencesBridge,
  onOpenSettings: (callback: () => void) => listen('open-settings', callback),
  reviewNotes: {
    list: () => ipcRenderer.invoke('review-notes-list'),
    change: (change: ReviewNoteChange) => ipcRenderer.invoke('review-notes-change', change),
    copy: () => ipcRenderer.invoke('review-notes-copy'),
    onChange: (callback: (notes: ReviewNote[]) => void) => listen('review-notes-updated', callback),
  },
  claude: {
    status: (): Promise<ClaudeStatus> => ipcRenderer.invoke('claude-status'),
    saveKey: (key: string): Promise<ClaudeStatus> => ipcRenderer.invoke('claude-save-key', key),
    removeKey: (): Promise<ClaudeStatus> => ipcRenderer.invoke('claude-remove-key'),
    send: (input: ClaudePrompt): Promise<ClaudeReply> => ipcRenderer.invoke('claude-send', input),
    apply: (id: string): Promise<ClaudeApplied> => ipcRenderer.invoke('claude-apply', id),
    discard: (id: string): Promise<void> => ipcRenderer.invoke('claude-discard', id),
    reset: (): Promise<void> => ipcRenderer.invoke('claude-reset'),
    cancel: (): Promise<void> => ipcRenderer.invoke('claude-cancel'),
    onActivity: (callback: (activity: ClaudeActivity) => void) =>
      listen('claude-activity', (activity: unknown) => {
        if (isClaudeActivity(activity)) callback(activity);
      }),
    onReset: (callback: (status: ClaudeStatus) => void) => listen('claude-reset', callback),
  },
  ideas: {
    list: (): Promise<Idea[]> => ipcRenderer.invoke('ideas-list'),
    upsert: (idea: Idea): Promise<Idea> => ipcRenderer.invoke('ideas-upsert', idea),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('ideas-delete', id),
    onChange: (callback: (change: IdeaChange) => void) => listen('ideas-change', callback),
  },
  howmany: {
    export: () => ipcRenderer.invoke('howmany-export'),
    analyze: (force?: boolean) => ipcRenderer.invoke('howmany-analyze', force),
    file: (path: string) => ipcRenderer.invoke('howmany-file', path),
    close: (path: string) => ipcRenderer.invoke('howmany-close', path),
    onEvent: (callback: (value: unknown) => void) => listen('howmany-event', callback),
  },
  language: {
    open: (input: unknown) => ipcRenderer.invoke('language-open', input),
    request: (input: unknown) => ipcRenderer.invoke('language-request', input),
    cancel: (id: number) => ipcRenderer.invoke('language-cancel', id),
    close: (path: string) => ipcRenderer.invoke('language-close', path),
    status: () => ipcRenderer.invoke('language-status'),
    onEvent: (callback: (value: unknown) => void) => listen('language-event', callback),
  },
  snapshot: () => ipcRenderer.invoke('snapshot'),
  captureCheckpoint: () => ipcRenderer.invoke('capture-checkpoint'),
  files: () => ipcRenderer.invoke('files'),
  filesDelta: (revision: number | null) => ipcRenderer.invoke('files-delta', revision),
  directoryExpanded: (path: string, expanded: boolean) =>
    ipcRenderer.invoke('directory-expanded', path, expanded),
  document: (path: string, comparison = 'head') => ipcRenderer.invoke('document', path, comparison),
  save: (path: string, text: string, expected: string) =>
    ipcRenderer.invoke('save', path, text, expected),
  rename: (path: string, name: string) => ipcRenderer.invoke('rename', path, name),
  fileAction: (action: string, path: string) => ipcRenderer.invoke('file-action', action, path),
  onFlushSaves: (callback: () => void) => listen('flush-saves', callback),
  onResumeEditing: (callback: () => void) => listen('resume-editing', callback),
  savesFlushed: (success: boolean) => ipcRenderer.send('saves-flushed', success),
  setSaveState: (dirty: boolean) => ipcRenderer.send('save-state', dirty),
  rendererReady: () => ipcRenderer.send('renderer-ready'),
  media: (path: string) => ipcRenderer.invoke('media', path),
  refresh: () => ipcRenderer.invoke('refresh'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  openFile: () => ipcRenderer.invoke('open-file'),
  recentTargets: () => ipcRenderer.invoke('recent-targets'),
  openRecent: (path: string) => ipcRenderer.invoke('open-recent', path),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  onChange: (callback: (value: unknown) => void) => listen('change', callback),
  onPaths: (callback: (paths: string[]) => void) => listen('paths', callback),
  onError: (callback: (value: unknown) => void) => listen('backend-error', callback),
};

export type DiffpaneApi = typeof api;
contextBridge.exposeInMainWorld('diffpane', api);
