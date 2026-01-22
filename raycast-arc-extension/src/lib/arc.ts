import { runAppleScript } from "@raycast/utils";
import { showToast, Toast } from "@raycast/api";

/**
 * Type definitions for Arc workspace-tab mappings
 */
export interface TabSelector {
  index: number;
}

export interface TabMapping {
  selector: TabSelector;
}

export interface WorkspaceTabMapping {
  id?: string;
  alias: string;
  workspaceName: string;
  tab: TabMapping;
  keywords?: string[];
}

/**
 * Parse mappings from JSON string
 */
export function parseMappings(jsonString: string): WorkspaceTabMapping[] {
  try {
    const parsed = JSON.parse(jsonString);
    if (!Array.isArray(parsed)) {
      throw new Error("Mappings must be an array");
    }
    return parsed as WorkspaceTabMapping[];
  } catch (error) {
    console.error("Failed to parse mappings:", error);
    return [];
  }
}

/**
 * Switch to an Arc workspace by name using UI scripting
 */
async function switchWorkspaceViaUI(workspaceName: string): Promise<boolean> {
  const script = `
    tell application "System Events"
      tell process "Arc"
        set frontmost to true

        -- Find and click the workspace in the Spaces submenu
        try
          click menu item "${workspaceName}" of menu 1 of menu bar item 6 of menu bar 1
          return true
        on error
          return false
        end try
      end tell
    end tell
  `;

  try {
    const result = await runAppleScript(script);
    return result.trim() === "true";
  } catch (error) {
    console.error("Failed to switch workspace via UI:", error);
    return false;
  }
}

/**
 * Switch to an Arc workspace by name using AppleScript
 */
async function switchWorkspaceViaAppleScript(
  workspaceName: string,
): Promise<boolean> {
  const script = `
    tell application "Arc"
      activate
      tell front window
        try
          set targetSpace to first space whose title is "${workspaceName}"
          tell targetSpace to focus
          return true
        on error
          return false
        end try
      end tell
    end tell
  `;

  try {
    const result = await runAppleScript(script);
    return result.trim() === "true";
  } catch (error) {
    console.error("Failed to switch workspace via AppleScript:", error);
    return false;
  }
}

/**
 * Open a tab by index using keyboard shortcut with configurable modifier
 */
async function openTabByIndex(index: number, modifierKey: string): Promise<boolean> {
  const modifierString = `${modifierKey.toLocaleLowerCase()} down`;
  
  const script = `
    tell application "System Events"
      tell process "Arc"
        set frontmost to true
        delay 0.1
        keystroke "${index}" using {${modifierString}}
        return true
      end tell
    end tell
  `;

  try {
    await runAppleScript(script);
    return true;
  } catch (error) {
    console.error("Failed to open tab by index:", error);
    return false;
  }
}

/**
 * Main function to open a workspace and tab based on mapping
 */
export async function openWorkspaceTab(
  mapping: WorkspaceTabMapping,
  useUIScripting: boolean,
  modifierKey: string,
): Promise<void> {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: "Opening...",
    message: `${mapping.workspaceName} → Tab #${mapping.tab.selector.index}`,
  });

  try {
    // Step 1: Switch to the workspace
    let workspaceSwitched = false;

    if (useUIScripting) {
      workspaceSwitched = await switchWorkspaceViaUI(mapping.workspaceName);
    }

    if (!workspaceSwitched) {
      workspaceSwitched = await switchWorkspaceViaAppleScript(
        mapping.workspaceName,
      );
    }

    if (!workspaceSwitched) {
      toast.style = Toast.Style.Failure;
      toast.title = "Failed";
      toast.message = `Could not switch to workspace: ${mapping.workspaceName}`;
      return;
    }

    // Wait a bit for the workspace to switch
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Step 2: Open the tab by index using keyboard shortcut
    const tabOpened = await openTabByIndex(mapping.tab.selector.index, modifierKey);

    if (tabOpened) {
      toast.style = Toast.Style.Success;
      toast.title = "Opened";
      toast.message = `${mapping.workspaceName} → Tab #${mapping.tab.selector.index}`;
    } else {
      toast.style = Toast.Style.Failure;
      toast.title = "Workspace switched";
      toast.message = `Could not open tab #${mapping.tab.selector.index}`;
    }
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = "Error";
    toast.message = String(error);
  }
}

/**
 * Find a mapping by alias (case-insensitive)
 */
export function findMappingByAlias(
  mappings: WorkspaceTabMapping[],
  alias: string,
): WorkspaceTabMapping | undefined {
  const normalizedAlias = alias.toLowerCase().trim();
  return mappings.find((m) => m.alias.toLowerCase().trim() === normalizedAlias);
}
