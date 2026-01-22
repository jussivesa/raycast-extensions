import { LocalStorage, getPreferenceValues } from "@raycast/api";
import { randomUUID } from "crypto";
import { WorkspaceTabMapping } from "./arc";

const STORAGE_KEY = "arc_shortcuts";

interface Preferences {
  mappings_json?: string;
}

/**
 * Generate a unique ID for a shortcut
 */
function generateId(): string {
  return randomUUID();
}

/**
 * Load shortcuts from LocalStorage, with fallback to preferences
 */
export async function loadShortcuts(): Promise<WorkspaceTabMapping[]> {
  // Try loading from LocalStorage first
  const raw = await LocalStorage.getItem<string>(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as WorkspaceTabMapping[];
      return parsed.filter((s) => s && s.alias && s.workspaceName && s.tab);
    } catch {
      return [];
    }
  }

  // Fallback to preferences if no local storage data
  const prefs = getPreferenceValues<Preferences>();
  const mappingsJson = prefs.mappings_json?.trim();
  if (!mappingsJson) return [];

  try {
    const parsed = JSON.parse(mappingsJson) as Array<Partial<WorkspaceTabMapping>>;
    if (Array.isArray(parsed)) {
      // Migrate from preferences to LocalStorage with IDs
      const shortcuts = parsed
        .filter((s) => s && s.alias && s.workspaceName && s.tab)
        .map((s) => ({
          ...s,
          id: generateId(),
        })) as WorkspaceTabMapping[];

      if (shortcuts.length > 0) {
        await saveShortcuts(shortcuts);
        return shortcuts;
      }
    }
  } catch {
    return [];
  }

  return [];
}

/**
 * Save shortcuts to LocalStorage
 */
export async function saveShortcuts(
  shortcuts: WorkspaceTabMapping[],
): Promise<void> {
  const normalized = shortcuts.map((s) => ({
    id: s.id || generateId(),
    alias: s.alias.trim(),
    workspaceName: s.workspaceName.trim(),
    tab: s.tab,
    keywords: s.keywords || [],
  }));
  await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
}

/**
 * Add a new shortcut
 */
export async function addShortcut(
  shortcut: Omit<WorkspaceTabMapping, "id">,
): Promise<WorkspaceTabMapping> {
  const shortcuts = await loadShortcuts();
  const newShortcut: WorkspaceTabMapping = {
    ...shortcut,
    id: generateId(),
    alias: shortcut.alias.trim(),
    workspaceName: shortcut.workspaceName.trim(),
    keywords: shortcut.keywords || [],
  };
  shortcuts.push(newShortcut);
  await saveShortcuts(shortcuts);
  return newShortcut;
}

/**
 * Update an existing shortcut
 */
export async function updateShortcut(
  updated: WorkspaceTabMapping,
): Promise<void> {
  const shortcuts = await loadShortcuts();
  const idx = shortcuts.findIndex((s) => s.id === updated.id);
  if (idx >= 0) {
    shortcuts[idx] = {
      ...updated,
      alias: updated.alias.trim(),
      workspaceName: updated.workspaceName.trim(),
      keywords: updated.keywords || [],
    };
    await saveShortcuts(shortcuts);
  }
}

/**
 * Delete a shortcut by ID
 */
export async function deleteShortcut(id: string): Promise<void> {
  const shortcuts = await loadShortcuts();
  const filtered = shortcuts.filter((s) => s.id !== id);
  await saveShortcuts(filtered);
}

/**
 * Export shortcuts as JSON
 */
export function exportShortcutsJSON(shortcuts: WorkspaceTabMapping[]): string {
  const minimal = shortcuts.map((s) => ({
    alias: s.alias,
    workspaceName: s.workspaceName,
    tab: s.tab,
    keywords: s.keywords,
  }));
  return JSON.stringify(minimal, null, 2);
}

/**
 * Parse shortcuts from JSON string or text format
 */
export function parseShortcuts(text: string): Array<Omit<WorkspaceTabMapping, "id">> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed
        .filter(
          (s) =>
            s &&
            typeof s.alias === "string" &&
            typeof s.workspaceName === "string" &&
            s.tab &&
            typeof s.tab.type === "string" &&
            s.tab.selector,
        )
        .map((s) => ({
          alias: s.alias.trim(),
          workspaceName: s.workspaceName.trim(),
          tab: s.tab,
          keywords: Array.isArray(s.keywords) ? s.keywords : [],
        }));
    }
  } catch {
    // If JSON parsing fails, return empty array
    return [];
  }

  return [];
}

/**
 * Merge shortcuts, preferring existing entries by alias (case-insensitive)
 */
export function mergeShortcuts(
  existing: WorkspaceTabMapping[],
  incoming: Array<Omit<WorkspaceTabMapping, "id">>,
): WorkspaceTabMapping[] {
  const byAlias = new Map(
    existing.map((s) => [s.alias.toLowerCase(), s] as const),
  );

  for (const s of incoming) {
    const key = s.alias.toLowerCase();
    if (byAlias.has(key)) {
      // Update existing
      const existingShortcut = byAlias.get(key)!;
      byAlias.set(key, {
        ...existingShortcut,
        ...s,
        id: existingShortcut.id, // Keep existing ID
      });
    } else {
      // Add new with generated ID
      byAlias.set(key, { ...s, id: generateId() });
    }
  }

  return Array.from(byAlias.values());
}

/**
 * Deduplicate shortcuts by alias (case-insensitive), keeping first occurrence
 */
export function dedupeByAlias(
  shortcuts: WorkspaceTabMapping[],
): WorkspaceTabMapping[] {
  const seen = new Set<string>();
  const result: WorkspaceTabMapping[] = [];

  for (const shortcut of shortcuts) {
    const key = shortcut.alias.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(shortcut);
    }
  }

  return result;
}
