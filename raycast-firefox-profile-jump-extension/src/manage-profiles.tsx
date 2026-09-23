import {
  Action,
  ActionPanel,
  Alert,
  Clipboard,
  Form,
  Icon,
  List,
  Toast,
  confirmAlert,
  showToast,
  useNavigation,
  Keyboard,
} from "@raycast/api";
import { useCallback, useEffect, useState } from "react";
import { FirefoxProcess, FirefoxWindow, readFirefoxState } from "./lib/firefox";
import { updateProfileCache } from "./lib/cache";
import {
  ProfileMapping,
  detectProfiles,
  getProcessName,
  getTitleFormat,
  jumpDeeplink,
} from "./lib/profiles";
import {
  addMapping,
  deleteMapping,
  exportMappingsJSON,
  loadMappings,
  moveMapping,
  updateMapping,
} from "./lib/storage";

interface DetectedProfile {
  profileName: string;
  windows: FirefoxWindow[];
  profilePath?: string;
}

/** Read the running profiles and the directory each one uses. */
function collectDetected(
  windows: FirefoxWindow[],
  processes: FirefoxProcess[],
): DetectedProfile[] {
  const pathByPid = new Map(
    processes.map((process) => [process.pid, process.profilePath]),
  );

  return Array.from(detectProfiles(windows, getTitleFormat()).entries())
    .map(([profileName, profileWindows]) => ({
      profileName,
      windows: profileWindows,
      profilePath: profileWindows
        .map((window) => pathByPid.get(window.pid))
        .find((path) => Boolean(path)),
    }))
    .sort((a, b) => a.profileName.localeCompare(b.profileName));
}

function MappingForm(props: {
  /** Set to edit an existing mapping. Leave empty to add a new one. */
  mapping?: ProfileMapping;
  /** Field values for a new mapping. */
  defaults?: Partial<ProfileMapping>;
  detected: DetectedProfile[];
  onSaved: () => void;
}) {
  const { pop } = useNavigation();
  const [displayNameError, setDisplayNameError] = useState<
    string | undefined
  >();
  const [profileNameError, setProfileNameError] = useState<
    string | undefined
  >();
  const initial = props.mapping ?? props.defaults ?? {};

  async function handleSubmit(values: {
    displayName: string;
    profileName: string;
    profilePath: string;
    keywords: string;
  }) {
    const displayName = values.displayName.trim();
    const profileName = values.profileName.trim();

    if (!displayName) {
      setDisplayNameError("Required");
      return;
    }
    if (!profileName) {
      setProfileNameError("Required");
      return;
    }

    const existing = await loadMappings();
    const duplicate = existing.find(
      (mapping) =>
        mapping.id !== props.mapping?.id &&
        mapping.displayName.toLowerCase() === displayName.toLowerCase(),
    );
    if (duplicate) {
      setDisplayNameError("Already used by another mapping");
      return;
    }

    const payload = {
      displayName,
      profileName,
      profilePath: values.profilePath.trim() || undefined,
      keywords: values.keywords
        .split(",")
        .map((keyword) => keyword.trim())
        .filter((keyword) => keyword.length > 0),
    };

    if (props.mapping) {
      await updateMapping({ ...props.mapping, ...payload });
      await showToast({
        style: Toast.Style.Success,
        title: "Mapping updated",
        message: displayName,
      });
    } else {
      await addMapping(payload);
      await showToast({
        style: Toast.Style.Success,
        title: "Mapping added",
        message: displayName,
      });
    }

    props.onSaved();
    pop();
  }

  const detectedHint =
    props.detected.length > 0
      ? props.detected.map((profile) => `"${profile.profileName}"`).join(", ")
      : "No Firefox window shows a profile name. Firefox writes the profile name into the title only when more than one profile exists.";

  return (
    <Form
      navigationTitle={props.mapping ? "Edit Mapping" : "Add Mapping"}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save"
            icon={Icon.Check}
            onSubmit={handleSubmit}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="displayName"
        title="Display Name"
        placeholder="Work"
        info="The name you search for in Raycast, and the argument of the 'Jump to Firefox Profile by Name' command."
        defaultValue={initial.displayName}
        error={displayNameError}
        onChange={() => setDisplayNameError(undefined)}
      />
      <Form.TextField
        id="profileName"
        title="Firefox Profile Name"
        placeholder="Original profile"
        info="The exact profile name that Firefox shows in the window title."
        defaultValue={initial.profileName}
        error={profileNameError}
        onChange={() => setProfileNameError(undefined)}
      />
      <Form.Description title="Profiles Found Now" text={detectedHint} />
      <Form.TextField
        id="profilePath"
        title="Profile Directory"
        placeholder="/Users/you/Library/Application Support/Firefox/Profiles/xxxx.Profile 1"
        info="Optional. Used to start this profile when it has no window."
        defaultValue={initial.profilePath ?? ""}
      />
      <Form.TextField
        id="keywords"
        title="Keywords"
        placeholder="mail, calendar"
        info="Optional. Comma-separated extra search terms."
        defaultValue={(initial.keywords ?? []).join(", ")}
      />
    </Form>
  );
}

export default function Command() {
  const [mappings, setMappings] = useState<ProfileMapping[]>([]);
  const [detected, setDetected] = useState<DetectedProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const reload = useCallback(async () => {
    setIsLoading(true);
    setMappings(await loadMappings());

    try {
      const { windows, processes } = await readFirefoxState(getProcessName());
      updateProfileCache(windows, processes, getTitleFormat());
      setDetected(collectDetected(windows, processes));
    } catch (error) {
      setDetected([]);
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not read Firefox windows",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    setIsLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleDelete = useCallback(
    async (mapping: ProfileMapping) => {
      const confirmed = await confirmAlert({
        title: `Delete "${mapping.displayName}"?`,
        message: "The mapping is removed. Firefox is not changed.",
        primaryAction: {
          title: "Delete",
          style: Alert.ActionStyle.Destructive,
        },
      });
      if (!confirmed) return;

      await deleteMapping(mapping.id);
      await reload();
    },
    [reload],
  );

  const handleMove = useCallback(
    async (mapping: ProfileMapping, offset: number) => {
      await moveMapping(mapping.id, offset);
      await reload();
    },
    [reload],
  );

  const handleImportDetected = useCallback(async () => {
    const known = new Set(
      mappings.map((mapping) => mapping.profileName.toLowerCase()),
    );
    const missing = detected.filter(
      (profile) => !known.has(profile.profileName.toLowerCase()),
    );

    if (missing.length === 0) {
      await showToast({
        style: Toast.Style.Success,
        title: "Every running profile is already mapped",
      });
      return;
    }

    for (const profile of missing) {
      await addMapping({
        displayName: profile.profileName,
        profileName: profile.profileName,
        profilePath: profile.profilePath,
        keywords: [],
      });
    }

    await reload();
    await showToast({
      style: Toast.Style.Success,
      title: `Added ${missing.length} mapping${missing.length === 1 ? "" : "s"}`,
      message: missing.map((profile) => profile.profileName).join(", "),
    });
  }, [detected, mappings, reload]);

  const unmapped = detected.filter(
    (profile) =>
      !mappings.some(
        (mapping) =>
          mapping.profileName.toLowerCase() ===
          profile.profileName.toLowerCase(),
      ),
  );

  // Returned as an array, because ActionPanel reads its children as a flat list.
  function sharedActions() {
    return [
      <Action.Push
        key="add"
        title="Add Mapping"
        icon={Icon.Plus}
        shortcut={Keyboard.Shortcut.Common.New}
        target={<MappingForm detected={detected} onSaved={reload} />}
      />,
      <Action
        key="detect"
        title="Detect Running Profiles"
        icon={Icon.MagnifyingGlass}
        shortcut={{ modifiers: ["cmd"], key: "d" }}
        onAction={handleImportDetected}
      />,
      <Action
        key="refresh"
        title="Refresh"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={reload}
      />,
      <Action
        key="export"
        title="Copy All as JSON"
        icon={Icon.Clipboard}
        shortcut={Keyboard.Shortcut.Common.Copy}
        onAction={async () => {
          await Clipboard.copy(exportMappingsJSON(mappings));
          await showToast({
            style: Toast.Style.Success,
            title: "Copied mappings as JSON",
          });
        }}
      />,
    ];
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search mappings…">
      {mappings.length === 0 && unmapped.length === 0 ? (
        <List.EmptyView
          icon={Icon.Plus}
          title="No Mappings Yet"
          description="Start Firefox with more than one profile, then press Cmd+D to detect them."
          actions={<ActionPanel>{sharedActions()}</ActionPanel>}
        />
      ) : null}

      <List.Section
        title="Mappings"
        subtitle={mappings.length > 0 ? String(mappings.length) : undefined}
      >
        {mappings.map((mapping, position) => {
          const running = detected.find(
            (profile) =>
              profile.profileName.toLowerCase() ===
              mapping.profileName.toLowerCase(),
          );

          return (
            <List.Item
              key={mapping.id}
              icon={Icon.AppWindow}
              title={mapping.displayName}
              subtitle={mapping.profileName}
              keywords={mapping.keywords}
              accessories={[
                running
                  ? {
                      icon: Icon.CheckCircle,
                      text: `${running.windows.length} window${running.windows.length === 1 ? "" : "s"}`,
                    }
                  : { icon: Icon.Circle, text: "Not running" },
              ]}
              actions={
                <ActionPanel>
                  <ActionPanel.Section>
                    <Action.Push
                      title="Edit Mapping"
                      icon={Icon.Pencil}
                      target={
                        <MappingForm
                          mapping={mapping}
                          detected={detected}
                          onSaved={reload}
                        />
                      }
                    />
                    <Action
                      title="Delete Mapping"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      shortcut={{ modifiers: ["ctrl"], key: "x" }}
                      onAction={() => handleDelete(mapping)}
                    />
                  </ActionPanel.Section>

                  <ActionPanel.Section>{sharedActions()}</ActionPanel.Section>

                  <ActionPanel.Section title="Order">
                    <Action
                      title="Move up"
                      icon={Icon.ArrowUp}
                      shortcut={Keyboard.Shortcut.Common.MoveUp}
                      onAction={() => handleMove(mapping, -1)}
                    />
                    <Action
                      title="Move Down"
                      icon={Icon.ArrowDown}
                      shortcut={Keyboard.Shortcut.Common.MoveDown}
                      onAction={() => handleMove(mapping, 1)}
                    />
                  </ActionPanel.Section>

                  <ActionPanel.Section>
                    <Action.CreateQuicklink
                      title="Create Quicklink for Hotkey"
                      icon={Icon.Link}
                      quicklink={{
                        name: `Firefox: ${mapping.displayName}`,
                        link: jumpDeeplink(mapping.displayName),
                      }}
                    />
                    <Action.CopyToClipboard
                      title="Copy Profile Name"
                      content={mapping.profileName}
                      shortcut={{ modifiers: ["cmd"], key: "c" }}
                    />
                  </ActionPanel.Section>
                  <ActionPanel.Section>
                    <Action.CopyToClipboard
                      title="Copy Position"
                      content={String(position + 1)}
                    />
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>

      <List.Section
        title="Running, Not Mapped"
        subtitle={unmapped.length > 0 ? String(unmapped.length) : undefined}
      >
        {unmapped.map((profile) => (
          <List.Item
            key={`detected-${profile.profileName}`}
            icon={Icon.QuestionMarkCircle}
            title={profile.profileName}
            subtitle={profile.profilePath}
            accessories={[
              {
                text: `${profile.windows.length} window${profile.windows.length === 1 ? "" : "s"}`,
              },
            ]}
            actions={
              <ActionPanel>
                <Action.Push
                  title="Add Mapping"
                  icon={Icon.Plus}
                  target={
                    <MappingForm
                      detected={detected}
                      onSaved={reload}
                      defaults={{
                        displayName: profile.profileName,
                        profileName: profile.profileName,
                        profilePath: profile.profilePath,
                      }}
                    />
                  }
                />
                <ActionPanel.Section>{sharedActions()}</ActionPanel.Section>
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
