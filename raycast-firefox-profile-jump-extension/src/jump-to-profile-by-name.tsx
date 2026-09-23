import { LaunchProps, closeMainWindow, showHUD } from "@raycast/api";
import { updateProfileCache } from "./lib/cache";
import { readFirefoxState } from "./lib/firefox";
import { jumpToProfile } from "./lib/jump";
import {
  detectProfiles,
  getProcessName,
  getTitleFormat,
  resolveMapping,
} from "./lib/profiles";
import { loadMappings } from "./lib/storage";

interface Arguments {
  /** Display name of a mapping, or an exact Firefox profile name. */
  profile: string;
}

export default async function Command(
  props: LaunchProps<{ arguments: Arguments }>,
) {
  const query = props.arguments.profile.trim();
  await closeMainWindow({ clearRootSearch: true });

  if (!query) {
    await showHUD("⚠️ Give a profile name.");
    return;
  }

  try {
    const mapping = resolveMapping(await loadMappings(), query);

    // A mapped profile takes the fast path: it needs no window titles when the
    // profile-to-process map from the last read still holds.
    if (mapping) {
      await jumpToProfile(mapping.profileName);
      return;
    }

    // Without a mapping the profile name is only known from the window titles.
    const format = getTitleFormat();
    const { windows, processes } = await readFirefoxState(getProcessName());
    updateProfileCache(windows, processes, format);

    const running = Array.from(detectProfiles(windows, format).keys());
    const profileName =
      running.find((name) => name.toLowerCase() === query.toLowerCase()) ??
      running.find((name) =>
        name.toLowerCase().startsWith(query.toLowerCase()),
      );

    if (!profileName) {
      await showHUD(`⚠️ No Firefox profile matches "${query}".`);
      return;
    }

    await jumpToProfile(profileName, { windows, format });
  } catch (error) {
    await showHUD(
      `⚠️ ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
