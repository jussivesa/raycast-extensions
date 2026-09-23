import { Cache } from "@raycast/api";
import { ActivationCandidate, FirefoxProcess, FirefoxWindow } from "./firefox";
import { TitleFormat, detectProfiles, preferredWindow } from "./profiles";

const cache = new Cache({
  namespace: "raycast-firefox-profile-jump-extension",
});
const CACHE_KEY = "profile-processes";

/** The process that served one profile the last time the windows were read. */
export interface CachedProfile {
  pid: number;
  /** Profile directory of that process, when Firefox was started with one. */
  profilePath?: string;
  /** Start time of that process. It rejects a process ID that macOS gave to another program. */
  launchTime?: number;
  /** Number of windows the profile had. */
  windowCount: number;
  /** True when every window of the profile was in the Dock. */
  allMinimized?: boolean;
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
  const processByPid = new Map(
    processes.map((process) => [process.pid, process]),
  );
  const entries: ProfileCache = {};

  for (const [profileName, profileWindows] of detectProfiles(windows, format)) {
    // The window that a jump lands on decides which process the entry names.
    const target = preferredWindow(profileWindows) ?? profileWindows[0];
    const process = processByPid.get(target.pid);

    entries[profileName.toLowerCase()] = {
      pid: target.pid,
      profilePath: process?.profilePath,
      launchTime: process?.launchTime,
      windowCount: profileWindows.length,
      allMinimized: profileWindows.every((window) => window.minimized),
    };
  }

  writeProfileCache(entries);
  return entries;
}

/**
 * Turn one stored profile into an activation candidate.
 *
 * The candidate carries the start time, so the activation call rejects a stale entry by
 * itself. No caller has to read the process list first.
 */
export function cachedCandidate(
  profileName: string,
  entries: ProfileCache = readProfileCache(),
): ActivationCandidate | undefined {
  const name = profileName.trim();
  const entry = entries[name.toLowerCase()];
  if (!entry || !Number.isInteger(entry.pid)) {
    return undefined;
  }

  return {
    pid: entry.pid,
    key: name,
    launchTime: entry.launchTime,
    // Window 1 is the window the profile used last, and "activate" raises it on its own.
    windowIndex: 1,
    // Only a profile whose windows were all in the Dock needs the Accessibility call.
    restore: entry.allMinimized === true,
  };
}
