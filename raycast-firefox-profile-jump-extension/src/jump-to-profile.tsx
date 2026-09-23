import {
  Action,
  ActionPanel,
  Icon,
  List,
  Toast,
  closeMainWindow,
  showHUD,
  showToast,
  Keyboard,
} from "@raycast/api";
import { useCallback, useEffect, useState } from "react";
import {
  FirefoxProcess,
  FirefoxWindow,
  activateFirefoxWindow,
  launchFirefoxProfile,
  readFirefoxState,
} from "./lib/firefox";
import { updateProfileCache } from "./lib/cache";
import { recordJump } from "./lib/history";
import {
  ProfileMapping,
  detectProfiles,
  getProcessName,
  getTitleFormat,
  jumpDeeplink,
  preferredWindow,
  windowsForProfile,
} from "./lib/profiles";
import { loadMappings } from "./lib/storage";
import ManageProfiles from "./manage-profiles";

interface ProfileRow {
  key: string;
  displayName: string;
  profileName: string;
  profilePath?: string;
  keywords: string[];
  windows: FirefoxWindow[];
  mapped: boolean;
}

function windowLabel(window: FirefoxWindow, position: number): string {
  const title = window.title.trim();
  return title.length > 0 ? title : `Window ${position + 1}`;
}

/** Report a failure after the Raycast window is closed. A toast would not be visible then. */
async function reportFailure(error: unknown): Promise<void> {
  await showHUD(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
}

export default function Command() {
  const [rows, setRows] = useState<ProfileRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const reload = useCallback(async () => {
    setIsLoading(true);

    const mappings = await loadMappings();
    const format = getTitleFormat();

    let windows: FirefoxWindow[] = [];
    let processes: FirefoxProcess[] = [];
    try {
      ({ windows, processes } = await readFirefoxState(getProcessName()));
      // The list command is the main place that keeps the jump cache warm.
      updateProfileCache(windows, processes, format);
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not read Firefox windows",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const pathByPid = new Map(
      processes.map((process) => [process.pid, process.profilePath]),
    );
    const pathOf = (profileWindows: FirefoxWindow[]) =>
      profileWindows
        .map((window) => pathByPid.get(window.pid))
        .find((path) => Boolean(path));

    const mappedRows: ProfileRow[] = mappings.map((mapping: ProfileMapping) => {
      const profileWindows = windowsForProfile(
        windows,
        mapping.profileName,
        format,
      );
      return {
        key: mapping.id,
        displayName: mapping.displayName,
        profileName: mapping.profileName,
        profilePath: mapping.profilePath ?? pathOf(profileWindows),
        keywords: [mapping.profileName, ...(mapping.keywords ?? [])],
        windows: profileWindows,
        mapped: true,
      };
    });

    const mappedProfileNames = new Set(
      mappings.map((mapping) => mapping.profileName.toLowerCase()),
    );
    const detectedRows: ProfileRow[] = Array.from(
      detectProfiles(windows, format).entries(),
    )
      .filter(
        ([profileName]) => !mappedProfileNames.has(profileName.toLowerCase()),
      )
      .map(([profileName, profileWindows]) => ({
        key: `detected-${profileName}`,
        displayName: profileName,
        profileName,
        profilePath: pathOf(profileWindows),
        keywords: [],
        windows: profileWindows,
        mapped: false,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    setRows([...mappedRows, ...detectedRows]);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const jumpToWindow = useCallback(
    async (window: FirefoxWindow, profileName: string) => {
      await closeMainWindow({ clearRootSearch: true });
      try {
        await activateFirefoxWindow(window.pid, window.index);
        // "Jump to Last Firefox Profile" reads this history.
        await recordJump(profileName);
      } catch (error) {
        await reportFailure(error);
      }
    },
    [],
  );

  const jumpToRow = useCallback(
    async (row: ProfileRow) => {
      const target = preferredWindow(row.windows);
      if (!target) {
        await showToast({
          style: Toast.Style.Failure,
          title: `"${row.profileName}" has no window`,
          message: row.profilePath
            ? "Use Launch Profile to start it."
            : "Start Firefox with this profile first.",
        });
        return;
      }
      await jumpToWindow(target, row.profileName);
    },
    [jumpToWindow],
  );

  const launch = useCallback(async (row: ProfileRow) => {
    if (!row.profilePath) {
      await showToast({
        style: Toast.Style.Failure,
        title: "No profile directory stored",
        message: "Add the profile directory in Manage Firefox Profiles.",
      });
      return;
    }

    await closeMainWindow({ clearRootSearch: true });
    try {
      await launchFirefoxProfile(row.profilePath);
    } catch (error) {
      await reportFailure(error);
    }
  }, []);

  const mapped = rows.filter((row) => row.mapped);
  const detected = rows.filter((row) => !row.mapped);

  function renderRow(row: ProfileRow) {
    const windowCount = row.windows.length;
    const running = windowCount > 0;

    return (
      <List.Item
        key={row.key}
        icon={running ? Icon.AppWindow : Icon.AppWindowGrid2x2}
        title={row.displayName}
        subtitle={
          row.displayName === row.profileName ? undefined : row.profileName
        }
        keywords={row.keywords}
        accessories={[
          running
            ? { text: `${windowCount} window${windowCount === 1 ? "" : "s"}` }
            : { icon: Icon.Circle, text: "Not running" },
        ]}
        actions={
          <ActionPanel>
            <ActionPanel.Section>
              <Action
                title="Jump to Profile"
                icon={Icon.ArrowRight}
                onAction={() => jumpToRow(row)}
              />
              {windowCount > 1 ? (
                <ActionPanel.Submenu
                  title="Jump to Window"
                  icon={Icon.AppWindowList}
                >
                  {row.windows.map((window, position) => (
                    <Action
                      key={`${window.pid}-${window.index}`}
                      title={windowLabel(window, position)}
                      icon={window.minimized ? Icon.Download : Icon.AppWindow}
                      onAction={() => jumpToWindow(window, row.profileName)}
                    />
                  ))}
                </ActionPanel.Submenu>
              ) : null}
              {!running ? (
                <Action
                  title="Launch Profile"
                  icon={Icon.Rocket}
                  onAction={() => launch(row)}
                />
              ) : null}
            </ActionPanel.Section>

            <ActionPanel.Section title="Hotkey">
              <Action.CreateQuicklink
                title="Create Quicklink for Hotkey"
                icon={Icon.Link}
                quicklink={{
                  name: `Firefox: ${row.displayName}`,
                  link: jumpDeeplink(row.displayName),
                }}
              />
              <Action.CopyToClipboard
                title="Copy Deeplink"
                icon={Icon.Link}
                content={jumpDeeplink(row.displayName)}
                shortcut={Keyboard.Shortcut.Common.Copy}
              />
            </ActionPanel.Section>

            <ActionPanel.Section>
              <Action.Push
                title="Manage Firefox Profiles"
                icon={Icon.Gear}
                shortcut={{ modifiers: ["cmd"], key: "m" }}
                target={<ManageProfiles />}
                onPop={reload}
              />
              <Action
                title="Refresh"
                icon={Icon.ArrowClockwise}
                shortcut={Keyboard.Shortcut.Common.Refresh}
                onAction={reload}
              />
            </ActionPanel.Section>
          </ActionPanel>
        }
      />
    );
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search Firefox profiles…">
      {!isLoading && rows.length === 0 ? (
        <List.EmptyView
          icon={Icon.AppWindow}
          title="No Profiles Configured"
          description="Open Manage Firefox Profiles and press Cmd+D to detect the running profiles."
          actions={
            <ActionPanel>
              <Action.Push
                title="Manage Firefox Profiles"
                icon={Icon.Gear}
                target={<ManageProfiles />}
                onPop={reload}
              />
            </ActionPanel>
          }
        />
      ) : null}

      <List.Section
        title="Profiles"
        subtitle={mapped.length > 0 ? String(mapped.length) : undefined}
      >
        {mapped.map(renderRow)}
      </List.Section>

      <List.Section
        title="Running, Not Mapped"
        subtitle={detected.length > 0 ? String(detected.length) : undefined}
      >
        {detected.map(renderRow)}
      </List.Section>
    </List>
  );
}
