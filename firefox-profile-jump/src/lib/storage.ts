import { LocalStorage, getPreferenceValues } from "@raycast/api";
import { randomUUID } from "crypto";
import { Preferences, ProfileMapping } from "./profiles";

const STORAGE_KEY = "firefox_profile_mappings";

function generateId(): string {
  return randomUUID();
}

function normalize(mapping: ProfileMapping): ProfileMapping {
  return {
    id: mapping.id || generateId(),
    displayName: mapping.displayName.trim(),
    profileName: mapping.profileName.trim(),
    profilePath: mapping.profilePath?.trim() || undefined,
    keywords: (mapping.keywords ?? [])
      .map((keyword) => keyword.trim())
      .filter((keyword) => keyword.length > 0),
  };
}

function isUsable(mapping: Partial<ProfileMapping>): boolean {
  return (
    typeof mapping?.displayName === "string" &&
    typeof mapping?.profileName === "string"
  );
}

/**
 * Parse the seed preference.
 * Two formats are accepted: a JSON array of objects, or one "Display Name = Profile Name" per line.
 */
export function parseMappings(text: string): Array<Omit<ProfileMapping, "id">> {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(isUsable).map((entry) => ({
        displayName: String(entry.displayName).trim(),
        profileName: String(entry.profileName).trim(),
        profilePath: entry.profilePath
          ? String(entry.profilePath).trim()
          : undefined,
        keywords: Array.isArray(entry.keywords)
          ? entry.keywords.map(String)
          : [],
      }));
    } catch {
      return [];
    }
  }

  const result: Array<Omit<ProfileMapping, "id">> = [];
  for (const line of trimmed.split("\n")) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 0) continue;

    const displayName = line.slice(0, separatorIndex).trim();
    const profileName = line.slice(separatorIndex + 1).trim();
    if (displayName && profileName) {
      result.push({ displayName, profileName, keywords: [] });
    }
  }
  return result;
}

/** Read the mappings. The seed preference is used only while nothing is stored yet. */
export async function loadMappings(): Promise<ProfileMapping[]> {
  const raw = await LocalStorage.getItem<string>(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ProfileMapping[];
      return Array.isArray(parsed)
        ? parsed.filter(isUsable).map(normalize)
        : [];
    } catch {
      return [];
    }
  }

  const preferences = getPreferenceValues<Preferences>();
  const seeded = parseMappings(preferences.profiles_seed ?? "");
  if (seeded.length === 0) {
    return [];
  }

  const mappings = seeded.map((mapping) =>
    normalize({ ...mapping, id: generateId() }),
  );
  await saveMappings(mappings);
  return mappings;
}

export async function saveMappings(mappings: ProfileMapping[]): Promise<void> {
  await LocalStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(mappings.map(normalize)),
  );
}

export async function addMapping(
  mapping: Omit<ProfileMapping, "id">,
): Promise<ProfileMapping> {
  const mappings = await loadMappings();
  const created = normalize({ ...mapping, id: generateId() });
  mappings.push(created);
  await saveMappings(mappings);
  return created;
}

export async function updateMapping(updated: ProfileMapping): Promise<void> {
  const mappings = await loadMappings();
  const index = mappings.findIndex((mapping) => mapping.id === updated.id);
  if (index < 0) {
    return;
  }
  mappings[index] = normalize(updated);
  await saveMappings(mappings);
}

export async function deleteMapping(id: string): Promise<void> {
  const mappings = await loadMappings();
  await saveMappings(mappings.filter((mapping) => mapping.id !== id));
}

/** Move one mapping up or down. The order of this list is the order shown in the commands. */
export async function moveMapping(id: string, offset: number): Promise<void> {
  const mappings = await loadMappings();
  const index = mappings.findIndex((mapping) => mapping.id === id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= mappings.length) {
    return;
  }

  const [moved] = mappings.splice(index, 1);
  mappings.splice(target, 0, moved);
  await saveMappings(mappings);
}

export function exportMappingsJSON(mappings: ProfileMapping[]): string {
  const minimal = mappings.map((mapping) => ({
    displayName: mapping.displayName,
    profileName: mapping.profileName,
    profilePath: mapping.profilePath,
    keywords: mapping.keywords,
  }));
  return JSON.stringify(minimal, null, 2);
}
