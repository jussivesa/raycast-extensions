import { updateProfileCache, validCachedProfile } from "./cache";
import {
  FirefoxControlError,
  FirefoxWindow,
  activateFirefoxWindow,
  listFirefoxProcesses,
  listWindowsOfProcesses,
} from "./firefox";
import {
  TitleFormat,
  getProcessName,
  getTitleFormat,
  preferredWindow,
  windowsForProfile,
} from "./profiles";

/**
 * Bring the front window of one Firefox profile to the front of the screen.
 *
 * Reading every window title costs about one second, so the profile-to-process map from
 * the last read is used first. Reading the process list to check that map costs about
 * 50 ms. Every window title is read only when the map has no usable entry.
 */
export async function jumpToProfile(
  profileName: string,
  options?: { windows?: FirefoxWindow[]; format?: TitleFormat },
): Promise<{ pid: number; windowIndex: number; fromCache: boolean }> {
  const format = options?.format ?? getTitleFormat();
  const processName = getProcessName();

  // The caller already read the windows, so there is nothing to gain from the cache.
  if (options?.windows) {
    const target = selectWindow(options.windows, profileName, format);
    await activateFirefoxWindow(target.pid, target.windowIndex);
    return { ...target, fromCache: false };
  }

  const processes = await listFirefoxProcesses(processName);
  if (processes.length === 0) {
    throw new FirefoxControlError("Firefox is not running.");
  }

  const cached = validCachedProfile(profileName, processes);
  if (cached) {
    try {
      // Window 1 is the front window of that process, which is the window last used.
      await activateFirefoxWindow(cached.pid, 1);
      return { pid: cached.pid, windowIndex: 1, fromCache: true };
    } catch {
      // The window list changed. Fall through and read the titles again.
    }
  }

  const windows = await listWindowsOfProcesses(
    processes.map((process) => process.pid),
  );
  updateProfileCache(windows, processes, format);

  const target = selectWindow(windows, profileName, format);
  await activateFirefoxWindow(target.pid, target.windowIndex);
  return { ...target, fromCache: false };
}

function selectWindow(
  windows: FirefoxWindow[],
  profileName: string,
  format: TitleFormat,
): { pid: number; windowIndex: number } {
  const target = preferredWindow(
    windowsForProfile(windows, profileName, format),
  );
  if (!target) {
    throw new FirefoxControlError(
      `No Firefox window found for profile "${profileName}".`,
    );
  }
  return { pid: target.pid, windowIndex: target.index };
}
