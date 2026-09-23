import { cachedCandidate, updateProfileCache } from "./cache";
import {
  ActivationCandidate,
  FirefoxControlError,
  FirefoxWindow,
  activateFirefoxCandidates,
  readFirefoxState,
} from "./firefox";
import {
  TitleFormat,
  getProcessName,
  getTitleFormat,
  preferredWindow,
  windowsForProfile,
} from "./profiles";

export interface JumpResult {
  /** Profile that was brought to the front. */
  profileName: string;
  pid: number;
  /** True when the stored profile-to-process map was enough. */
  fromCache: boolean;
}

/**
 * Bring the first profile of the list to the front that still has a running process.
 *
 * The stored profile-to-process map answers the whole request in one automation call of
 * about 90 ms. Nothing else runs first: the call checks the process itself and rejects an
 * entry whose process stopped or whose process ID went to another program.
 *
 * Every window title is read only when no stored entry works. That read costs about
 * 350 ms and it also stores a new map.
 */
export async function jumpToProfiles(
  profileNames: string[],
  options: {
    /** Leave the profile that has the keyboard focus out of the list. */
    skipFrontmost?: boolean;
    /** Window data the caller already read. It skips both the cache and a new read. */
    windows?: FirefoxWindow[];
    format?: TitleFormat;
  } = {},
): Promise<JumpResult> {
  const processName = getProcessName();
  const wanted = profileNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (wanted.length === 0) {
    throw new FirefoxControlError("No profile given.");
  }

  if (!options.windows) {
    const candidates = wanted
      .map((name) => cachedCandidate(name))
      .filter((candidate): candidate is ActivationCandidate =>
        Boolean(candidate),
      );

    const cached = await activateFirefoxCandidates(candidates, {
      processName,
      skipFrontmost: options.skipFrontmost,
    });
    if (cached.key !== undefined && cached.pid !== undefined) {
      return { profileName: cached.key, pid: cached.pid, fromCache: true };
    }
  }

  // No stored entry worked. Read every window title once and store a new map.
  const format = options.format ?? getTitleFormat();
  let windows = options.windows;
  if (!windows) {
    const state = await readFirefoxState(processName);
    if (state.processes.length === 0) {
      throw new FirefoxControlError("Firefox is not running.");
    }
    updateProfileCache(state.windows, state.processes, format);
    windows = state.windows;
  }

  const candidates: ActivationCandidate[] = [];
  for (const name of wanted) {
    const target = preferredWindow(windowsForProfile(windows, name, format));
    if (target) {
      candidates.push({
        pid: target.pid,
        key: name,
        windowIndex: target.index,
        restore: target.minimized,
      });
    }
  }

  if (candidates.length === 0) {
    throw new FirefoxControlError(
      wanted.length === 1
        ? `No Firefox window found for profile "${wanted[0]}".`
        : "No Firefox window found for these profiles.",
    );
  }

  const result = await activateFirefoxCandidates(candidates, {
    processName,
    skipFrontmost: options.skipFrontmost,
  });
  if (result.key === undefined || result.pid === undefined) {
    throw new FirefoxControlError(
      `No Firefox window found for profile "${wanted[0]}".`,
    );
  }

  return { profileName: result.key, pid: result.pid, fromCache: false };
}

/** Bring the front window of one Firefox profile to the front of the screen. */
export async function jumpToProfile(
  profileName: string,
  options: { windows?: FirefoxWindow[]; format?: TitleFormat } = {},
): Promise<JumpResult> {
  return jumpToProfiles([profileName], options);
}
