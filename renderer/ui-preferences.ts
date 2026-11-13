import {
  applyUiPreferencePatch,
  defaultUiPreferences,
  parseUiPreferencePatch,
  parseUiPreferences,
  uiPreferenceKeys,
} from '../electron/ui-preferences.ts';
import type {
  UiPreferenceKey,
  UiPreferencePatch,
  UiPreferencePatches,
  UiPreferences,
  UiPreferencesBridge,
  UiPreferenceUpdate,
} from '../electron/ui-preferences.ts';

const LEGACY_KEYS = {
  appearance: 'diffpane.appearance',
  layout: 'diffpane.workspace-layout.v1',
  ideasVisible: 'diffpane.ideas.visible',
};

const LABELS = {
  appearance: 'appearance settings',
  layout: 'workspace layout',
  ideasVisible: 'Ideas panel visibility',
};

function mergePatches(
  first: UiPreferencePatch | undefined,
  latest: UiPreferencePatch,
): UiPreferencePatch {
  if (first?.key === 'appearance' && latest.key === 'appearance')
    return { key: latest.key, value: { ...first.value, ...latest.value } };
  if (first?.key === 'layout' && latest.key === 'layout')
    return { key: latest.key, value: { ...first.value, ...latest.value } };
  return latest;
}

function preferenceValue(update: UiPreferenceUpdate): Partial<UiPreferences> {
  switch (update.key) {
    case 'appearance':
      return { appearance: update.value };
    case 'layout':
      return { layout: update.value };
    case 'ideasVisible':
      return { ideasVisible: update.value };
    default: {
      const unhandled: never = update;
      throw new Error(`Unexpected UI preference: ${String(unhandled)}`);
    }
  }
}

type PreferenceFailure = { message: string; retry: () => void };
type ReportFailure = (key: UiPreferenceKey | 'load', failure?: PreferenceFailure) => void;

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

export function createUiPreferences(bridge?: UiPreferencesBridge, reportFailure?: ReportFailure) {
  const legacyValues: Partial<Record<UiPreferenceKey, unknown>> = {};
  const legacyItems = new Map<UiPreferenceKey, string>();
  for (const key of uiPreferenceKeys) {
    try {
      const raw = localStorage.getItem(LEGACY_KEYS[key]);
      if (raw === null) continue;
      legacyValues[key] = JSON.parse(raw);
      legacyItems.set(key, raw);
    } catch {
      // A malformed or inaccessible legacy value leaves this setting at its default.
    }
  }
  const legacy = parseUiPreferences(legacyValues);
  const saved: UiPreferences = { ...defaultUiPreferences, ...legacy };
  const latestCommits = new Map<UiPreferenceKey, UiPreferenceUpdate>();
  const queued = new Map<UiPreferenceKey, UiPreferencePatch>();
  const writing = new Map<UiPreferenceKey, UiPreferencePatch>();
  const operations = new Map<UiPreferenceKey, Promise<void>>();
  const failures = new Set<UiPreferenceKey>();
  const listeners = new Set<(key: UiPreferenceKey) => void>();
  let disposed = false;

  const notify = (key: UiPreferenceKey) => {
    if (!disposed) for (const listener of listeners) listener(key);
  };

  function accept(update: UiPreferenceUpdate) {
    const previousRevision = latestCommits.get(update.key)?.revision;
    if (
      previousRevision !== undefined &&
      update.revision !== undefined &&
      previousRevision >= update.revision
    )
      return;
    latestCommits.set(update.key, update);
    Object.assign(saved, preferenceValue(update));
  }

  const unsubscribe = bridge?.onChange(update => {
    accept(update);
    notify(update.key);
  });

  async function load() {
    if (!bridge || disposed) return;
    const previous = new Map(latestCommits);
    const values = parseUiPreferences(await bridge.get(legacy));
    if (disposed) return;
    for (const key of uiPreferenceKeys) {
      const value = values[key];
      if (value === undefined) continue;
      if (previous.get(key) === latestCommits.get(key)) {
        Object.assign(saved, { [key]: value });
        notify(key);
      }
      const old = legacyItems.get(key);
      if (old === undefined) continue;
      try {
        if (localStorage.getItem(LEGACY_KEYS[key]) === old)
          localStorage.removeItem(LEGACY_KEYS[key]);
      } catch (cause) {
        console.error('Could not remove a migrated Diffpane preference.', cause);
      }
    }
  }

  function get<Key extends UiPreferenceKey>(key: Key): UiPreferences[Key] {
    const pending = queued.get(key);
    const active = writing.get(key);
    const patch = pending ? mergePatches(active, pending) : active;
    const value = saved[key];
    return patch ? (preferenceValue(applyUiPreferencePatch(patch, value))[key] ?? value) : value;
  }

  function persist(key: UiPreferenceKey) {
    const operation = operations.get(key);
    if (operation) return operation;
    async function writePending() {
      try {
        while (true) {
          if (disposed) break;
          const patch = queued.get(key);
          if (!patch) break;
          queued.delete(key);
          writing.set(key, patch);
          if (!bridge) throw new Error('Local settings storage is unavailable.');
          // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve write order and coalesce edits during each write.
          accept(await bridge.set(patch.key, patch.value));
          writing.delete(key);
          if (failures.delete(key)) reportFailure?.(key);
          notify(key);
        }
      } catch (cause) {
        const active = writing.get(key);
        if (active) {
          const pending = queued.get(key);
          queued.set(key, pending ? mergePatches(active, pending) : active);
          writing.delete(key);
        }
        failures.add(key);
        if (!disposed) {
          reportFailure?.(key, {
            message: `Couldn’t save ${LABELS[key]}. ${errorMessage(cause)}`,
            retry: () => void persist(key),
          });
          notify(key);
        }
      } finally {
        operations.delete(key);
      }
    }
    const started = Promise.resolve().then(() => writePending());
    operations.set(key, started);
    return started;
  }

  async function reload() {
    try {
      await load();
      if (!disposed) reportFailure?.('load');
    } catch (cause) {
      if (!disposed)
        reportFailure?.('load', {
          message: `Couldn’t load local settings. ${errorMessage(cause)}`,
          retry: () => void reload(),
        });
    }
  }

  if (bridge) void reload();

  return {
    get,
    set<Key extends UiPreferenceKey>(key: Key, value: UiPreferencePatches[Key]) {
      const patch = parseUiPreferencePatch(key, value);
      queued.set(key, mergePatches(queued.get(key), patch));
      notify(key);
      void persist(key);
    },
    onChange<Key extends UiPreferenceKey>(key: Key, callback: (value: UiPreferences[Key]) => void) {
      const listener = (changed: UiPreferenceKey) => {
        if (changed === key) callback(get(key));
      };
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async settled() {
      while (operations.size) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- A listener can enqueue another write while an earlier batch settles.
        await Promise.all(operations.values());
      }
    },
    dispose() {
      disposed = true;
      unsubscribe?.();
      listeners.clear();
      queued.clear();
    },
  };
}

export type UiPreferenceController = ReturnType<typeof createUiPreferences>;
