import { LocalStorage } from "@raycast/api";

const STORAGE_KEY = "firefox_profile_history";
/**
 * Profiles kept. Two are enough to alternate. The rest are a reserve for the case
 * that a profile in the history has no window any more.
 */
const LIMIT = 5;

/** Profile names of the last jumps, most recent first. */
export async function readHistory(): Promise<string[]> {
  const raw = await LocalStorage.getItem<string>(STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (name): name is string =>
            typeof name === "string" && name.trim().length > 0,
        )
      : [];
  } catch {
    return [];
  }
}

/** Move one profile to the front of the history. Call it after a jump succeeded. */
export async function recordJump(profileName: string): Promise<void> {
  const name = profileName.trim();
  if (!name) {
    return;
  }

  const rest = (await readHistory()).filter(
    (entry) => entry.toLowerCase() !== name.toLowerCase(),
  );
  await LocalStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([name, ...rest].slice(0, LIMIT)),
  );
}
