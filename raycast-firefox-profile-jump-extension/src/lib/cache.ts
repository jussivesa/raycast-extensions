import { Cache } from "@raycast/api";
import { FirefoxProcess, FirefoxWindow } from "./firefox";
import { TitleFormat, detectProfiles } from "./profiles";

const cache = new Cache({
  namespace: "raycast-firefox-profile-jump-extension",
});
const CACHE_KEY = "profile-processes";

/** The process that served one profile the last time the windows were read. */
export interface CachedProfile {
  pid: number;
  /** Profile directory of that process, when Firefox was started with one. */
  profilePath?: string;
  /** Number of windows the profile had. */
  windowCount: number;
}

/** Profile name in lower case, mapped to the process that served it. */
export type ProfileCache = Record<string, CachedProfile>;

export function readProfileCache(): ProfileCache {
  const raw = cache.get(CACHE_KEY);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as ProfileCache;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeProfileCache(entries: ProfileCache): void {
  cache.set(CACHE_KEY, JSON.stringify(entries));
}

export function clearProfileCache(): void {
  cache.remove(CACHE_KEY);
}

/** Store the profile-to-process map that a window read produced. */
export function updateProfileCache(
  windows: FirefoxWindow[],
  processes: FirefoxProcess[],
  format: TitleFormat,
): ProfileCache {
  const pathByPid = new Map(
    processes.map((process) => [process.pid, process.profilePath]),
  );
  const entries: ProfileCache = {};

  for (const [profileName, profileWindows] of detectProfiles(windows, format)) {
    entries[profileName.toLowerCase()] = {
      pid: profileWindows[0].pid,
      profilePath: pathByPid.get(profileWindows[0].pid),
      windowCount: profileWindows.length,
    };
  }

  writeProfileCache(entries);
  return entries;
}

/**
 * Return the cached process of one profile, but only while that process still runs
 * Firefox with the same profile directory. The check guards against a process ID that
 * macOS gave to another program after Firefox stopped.
 */
export function validCachedProfile(
  profileName: string,
  processes: FirefoxProcess[],
): CachedProfile | undefined {
  const entry = readProfileCache()[profileName.trim().toLowerCase()];
  if (!entry) {
    return undefined;
  }

  const live = processes.find((process) => process.pid === entry.pid);
  if (!live) {
    return undefined;
  }
  if (
    entry.profilePath &&
    live.profilePath &&
    entry.profilePath !== live.profilePath
  ) {
    return undefined;
  }

  return entry;
}
