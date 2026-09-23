import { closeMainWindow, showHUD } from "@raycast/api";
import { readHistory, recordJump } from "./lib/history";
import { jumpToProfiles } from "./lib/jump";

/**
 * Jump to the profile that was used before the profile in front.
 *
 * From another application the jump goes to the profile used last. From a Firefox
 * window it goes to the profile used before that one, so a second press of the hotkey
 * goes back. The two profiles you use most alternate with one key.
 *
 * The whole jump is one automation call. That call reads the front application, walks
 * the history, and brings the first profile to the front whose stored process still
 * runs. The window titles are read only when no stored process works.
 */
export default async function Command() {
  await closeMainWindow({ clearRootSearch: true });

  try {
    const history = await readHistory();
    if (history.length === 0) {
      await showHUD("⚠️ No profile jumped to yet.");
      return;
    }

    const result = await jumpToProfiles(history, { skipFrontmost: true });
    await recordJump(result.profileName);
  } catch (error) {
    await showHUD(
      `⚠️ ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
