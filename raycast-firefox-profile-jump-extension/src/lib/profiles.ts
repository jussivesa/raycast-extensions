import { getPreferenceValues } from "@raycast/api";
import { FirefoxWindow } from "./firefox";

/** A display name that you select in Raycast, and the Firefox profile it points to. */
export interface ProfileMapping {
  id: string;
  /** Name shown and searched in Raycast. */
  displayName: string;
  /** Exact profile name that Firefox writes into the window title. */
  profileName: string;
  /** Profile directory. Optional. Used to start the profile when it has no window. */
  profilePath?: string;
  /** Extra search terms. */
  keywords?: string[];
}

export interface Preferences {
  profiles_seed?: string;
  process_name?: string;
  title_separator?: string;
  title_suffixes?: string;
}

export interface TitleFormat {
  separator: string;
  /** Title parts that Firefox appends after the profile name, for example the brand name. */
  suffixes: string[];
}

const DEFAULT_PROCESS_NAME = "firefox";
const DEFAULT_SEPARATOR = "—";
const DEFAULT_SUFFIXES = ["Mozilla Firefox", "Private Browsing"];

export function getProcessName(): string {
  const preferences = getPreferenceValues<Preferences>();
  return preferences.process_name?.trim() || DEFAULT_PROCESS_NAME;
}

export function getTitleFormat(): TitleFormat {
  const preferences = getPreferenceValues<Preferences>();

  const suffixes = (preferences.title_suffixes ?? "")
    .split(",")
    .map((suffix) => suffix.trim())
    .filter((suffix) => suffix.length > 0);

  return {
    separator: preferences.title_separator?.trim() || DEFAULT_SEPARATOR,
    suffixes: suffixes.length > 0 ? suffixes : DEFAULT_SUFFIXES,
  };
}

/** Split a window title into its parts and drop empty ones. */
function titleParts(title: string, format: TitleFormat): string[] {
  return title
    .split(format.separator)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Read the profile name out of a Firefox window title.
 *
 * Firefox on macOS builds the title from the page title, the profile name and a suffix:
 *   page title present: "<page title> — <profile>"
 *   page title empty:   "<profile> — Mozilla Firefox"
 * Firefox adds the profile name only when more than one profile exists, so this returns
 * null for a single-profile installation.
 */
export function profileNameFromTitle(
  title: string,
  format: TitleFormat,
): string | null {
  const parts = titleParts(title, format);
  const suffixes = format.suffixes.map((suffix) => suffix.toLowerCase());

  let suffixRemoved = false;
  while (
    parts.length > 0 &&
    suffixes.includes(parts[parts.length - 1].toLowerCase())
  ) {
    parts.pop();
    suffixRemoved = true;
  }

  if (parts.length === 0) {
    return null;
  }
  // "<profile> — Mozilla Firefox" leaves one part, and that part is the profile name.
  if (suffixRemoved) {
    return parts[parts.length - 1];
  }
  // "<page title> — <profile>" leaves two parts. A single part is a page title alone.
  return parts.length >= 2 ? parts[parts.length - 1] : null;
}

function equalsIgnoreCase(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Find the windows of one profile.
 * The profile position in the title is used first. If no window matches there, any title
 * part that equals the profile name is accepted.
 */
export function windowsForProfile(
  windows: FirefoxWindow[],
  profileName: string,
  format: TitleFormat,
): FirefoxWindow[] {
  const wanted = profileName.trim();
  if (!wanted) {
    return [];
  }

  const exact = windows.filter((window) => {
    const found = profileNameFromTitle(window.title, format);
    return found !== null && equalsIgnoreCase(found, wanted);
  });
  if (exact.length > 0) {
    return exact;
  }

  return windows.filter((window) =>
    titleParts(window.title, format).some((part) =>
      equalsIgnoreCase(part, wanted),
    ),
  );
}

/** Pick the window to activate: the front window that is not in the Dock, otherwise the front window. */
export function preferredWindow(
  windows: FirefoxWindow[],
): FirefoxWindow | undefined {
  return windows.find((window) => !window.minimized) ?? windows[0];
}

/** Group every Firefox window by the profile name in its title. */
export function detectProfiles(
  windows: FirefoxWindow[],
  format: TitleFormat,
): Map<string, FirefoxWindow[]> {
  const byProfile = new Map<string, FirefoxWindow[]>();

  for (const window of windows) {
    const profileName = profileNameFromTitle(window.title, format);
    if (!profileName) continue;

    const existing = byProfile.get(profileName);
    if (existing) {
      existing.push(window);
    } else {
      byProfile.set(profileName, [window]);
    }
  }

  return byProfile;
}

/**
 * Resolve the text typed as a command argument to one mapping.
 * The display name is matched first, then the profile name, then a prefix of either.
 */
export function resolveMapping(
  mappings: ProfileMapping[],
  query: string,
): ProfileMapping | undefined {
  const wanted = query.trim().toLowerCase();
  if (!wanted) {
    return undefined;
  }

  return (
    mappings.find(
      (mapping) => mapping.displayName.trim().toLowerCase() === wanted,
    ) ??
    mappings.find(
      (mapping) => mapping.profileName.trim().toLowerCase() === wanted,
    ) ??
    mappings.find((mapping) =>
      mapping.keywords?.some(
        (keyword) => keyword.trim().toLowerCase() === wanted,
      ),
    ) ??
    mappings.find((mapping) =>
      mapping.displayName.trim().toLowerCase().startsWith(wanted),
    ) ??
    mappings.find((mapping) =>
      mapping.profileName.trim().toLowerCase().startsWith(wanted),
    )
  );
}

/** Build the Raycast deeplink that jumps to one profile. Use it to create a Quicklink for a hotkey. */
export function jumpDeeplink(displayName: string): string {
  const args = encodeURIComponent(JSON.stringify({ profile: displayName }));
  return `raycast://extensions/jussivesa/raycast-firefox-profile-jump-extension/jump-to-profile-by-name?arguments=${args}`;
}
