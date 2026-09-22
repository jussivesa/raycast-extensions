import { environment, showHUD } from "@raycast/api";
import { updateProfileCache } from "./lib/cache";
import { readFirefoxState } from "./lib/firefox";
import { getProcessName, getTitleFormat } from "./lib/profiles";

/**
 * Read the Firefox windows and store the profile-to-process map.
 *
 * Raycast runs this command in the background on the interval set in the manifest, so
 * that "Jump to Firefox Profile by Name" stays on its fast path after Firefox restarts.
 * It also runs on request, and then reports the result.
 */
export default async function Command() {
  try {
    const { windows, processes } = await readFirefoxState(getProcessName());
    const entries = updateProfileCache(windows, processes, getTitleFormat());

    if (environment.launchType === "userInitiated") {
      const names = Object.keys(entries);
      await showHUD(
        names.length > 0
          ? `Cached ${names.length} Firefox profile${names.length === 1 ? "" : "s"}`
          : "No Firefox profile found",
      );
    }
  } catch (error) {
    if (environment.launchType === "userInitiated") {
      await showHUD(
        `⚠️ ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
