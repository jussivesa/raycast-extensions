import {
  LaunchProps,
  getPreferenceValues,
  showToast,
  Toast,
  closeMainWindow,
} from "@raycast/api";
import { findMappingByAlias, openWorkspaceTab } from "./lib/arc";
import { loadShortcuts } from "./lib/storage";

interface Preferences {
  use_ui_scripting: boolean;
  tab_modifier_key: string;
}

interface CommandArguments {
  alias: string;
}

export default async function Command(
  props: LaunchProps<{ arguments: CommandArguments }>,
) {
  const preferences = getPreferenceValues<Preferences>();
  const { alias } = props.arguments;

  if (!alias || !alias.trim()) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Error",
      message: "Please provide an alias",
    });
    return;
  }

  // Load shortcuts from storage
  const mappings = await loadShortcuts();

  if (mappings.length === 0) {
    await showToast({
      style: Toast.Style.Failure,
      title: "No Shortcuts",
      message: "Add workspace-tab shortcuts using Manage Arc Shortcuts",
    });
    return;
  }

  // Find the mapping by alias
  const mapping = findMappingByAlias(mappings, alias);

  if (!mapping) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Not Found",
      message: `No mapping found for alias: ${alias}`,
    });
    return;
  }

  // Close window immediately
  await closeMainWindow();

  // Open the workspace and tab
  await openWorkspaceTab(
    mapping,
    preferences.use_ui_scripting,
    preferences.tab_modifier_key,
  );
}
