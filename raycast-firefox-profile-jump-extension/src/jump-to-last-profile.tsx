import { closeMainWindow, showHUD } from "@raycast/api";
import { cachedProfileOfProcess, updateProfileCache } from "./lib/cache";
import {
  FirefoxControlError,
  FirefoxProcess,
  FirefoxWindow,
  frontmostProcessId,
  listFirefoxProcesses,
  listWindowsOfProcesses,
} from "./lib/firefox";
import { readHistory, recordJump } from "./lib/history";
import { jumpToProfile } from "./lib/jump";
import { getProcessName, getTitleFormat } from "./lib/profiles";

/**
 * Profile of the Firefox window that has the keyboard focus, in lower case.
 *
 * The profile-to-process map answers this without a window read. Only a process that
 * the map does not know costs one, and those windows are given back to the caller.
 */
async function frontProfile(
  frontPid: number | undefined,
  processes: FirefoxProcess[],
): Promise<{ name?: string; windows?: FirefoxWindow[] }> {
  if (
    frontPid === undefined ||
    !processes.some((process) => process.pid === frontPid)
  ) {
    return {};
  }

  const cached = cachedProfileOfProcess(frontPid);
  if (cached) {
    return { name: cached };
  }

  // The map is older than this Firefox process. Read the titles once and store a new map.
  const windows = await listWindowsOfProcesses(
    processes.map((process) => process.pid),
  );
  updateProfileCache(windows, processes, getTitleFormat());
  return { name: cachedProfileOfProcess(frontPid), windows };
}

/**
 * Jump to the profile that was used before the profile in front.
 *
 * From another application the jump goes to the profile used last. From a Firefox
 * window it goes to the profile used before that one, so a second press of the hotkey
 * goes back. The two profiles you use most alternate with one key.
 */
export default async function Command() {
  // Read the front application first. A launch from the Raycast root search makes
  // Raycast the front application, and closing its window does not restore the order
  // in time to read it afterwards.
  const frontPid = await frontmostProcessId();
  await closeMainWindow({ clearRootSearch: true });

  try {
    const history = await readHistory();
    if (history.length === 0) {
      await showHUD("⚠️ No profile jumped to yet.");
      return;
    }

    const processes = await listFirefoxProcesses(getProcessName());
    if (processes.length === 0) {
      throw new FirefoxControlError("Firefox is not running.");
    }

    const front = await frontProfile(frontPid, processes);
    const candidates = history.filter(
      (name) => name.toLowerCase() !== front.name,
    );
    if (candidates.length === 0) {
      await showHUD("⚠️ Only this profile is in the history.");
      return;
    }

    // A profile in the history can have no window any more, because that Firefox
    // stopped. Take the next profile of the history then.
    let failure: unknown;
    for (const candidate of candidates) {
      try {
        await jumpToProfile(candidate, { processes, windows: front.windows });
        await recordJump(candidate);
        return;
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  } catch (error) {
    await showHUD(
      `⚠️ ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
