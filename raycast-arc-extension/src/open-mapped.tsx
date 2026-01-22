import {
  List,
  ActionPanel,
  Action,
  getPreferenceValues,
  Icon,
  closeMainWindow,
} from "@raycast/api";
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  openWorkspaceTab,
  WorkspaceTabMapping,
} from "./lib/arc";
import { loadShortcuts } from "./lib/storage";

interface Preferences {
  use_ui_scripting: boolean;
  tab_modifier_key: string;
}

export default function Command() {
  const preferences = getPreferenceValues<Preferences>();
  const [searchText, setSearchText] = useState("");
  const [allMappings, setAllMappings] = useState<WorkspaceTabMapping[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const isOpeningRef = useRef(false);

  // Load shortcuts from storage
  useEffect(() => {
    (async () => {
      const shortcuts = await loadShortcuts();
      setAllMappings(shortcuts);
      setIsLoading(false);
    })();
  }, []);

  // Filter and sort mappings based on search text
  const filteredMappings = useMemo(() => {
    let filtered = allMappings;
    
    if (searchText.trim()) {
      const searchLower = searchText.toLowerCase();
      filtered = allMappings.filter((mapping) => {
        const aliasMatch = mapping.alias.toLowerCase().includes(searchLower);
        const workspaceMatch = mapping.workspaceName
          .toLowerCase()
          .includes(searchLower);
        const tabMatch = String(mapping.tab.selector.index)
          .toLowerCase()
          .includes(searchLower);
        const keywordsMatch = mapping.keywords?.some((kw) =>
          kw.toLowerCase().includes(searchLower),
        );

        return aliasMatch || workspaceMatch || tabMatch || keywordsMatch;
      });
    }
    
    // Sort by workspace name, then by tab index
    return filtered.sort((a, b) => {
      const workspaceCompare = a.workspaceName.localeCompare(b.workspaceName);
      if (workspaceCompare !== 0) {
        return workspaceCompare;
      }
      return a.tab.selector.index - b.tab.selector.index;
    });
  }, [allMappings, searchText]);

  const handleOpen = useCallback(async (mapping: WorkspaceTabMapping) => {
    if (isOpeningRef.current) {
      return;
    }
    
    isOpeningRef.current = true;
    await closeMainWindow();
    
    await openWorkspaceTab(
      mapping,
      preferences.use_ui_scripting,
      preferences.tab_modifier_key,
    );
    
    isOpeningRef.current = false;
  }, [preferences.use_ui_scripting, preferences.tab_modifier_key]);

  return (
    <List
      isLoading={isLoading}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Search workspace-tab mappings..."
      throttle
    >
      {Array.isArray(allMappings) && allMappings.length === 0 ? (
        <List.EmptyView 
          title="No Shortcuts Configured"
          description="Use 'Manage Arc Shortcuts' command to add shortcuts"
          icon={Icon.QuestionMarkCircle}
        />
      ) : (
        filteredMappings.map((mapping) => (
          <List.Item
            key={mapping.id || mapping.alias}
            title={mapping.alias}
            subtitle={`${mapping.workspaceName} → Tab #${mapping.tab.selector.index}`}
            keywords={mapping.keywords}
            actions={
              <ActionPanel>
                <Action
                  title="Open Workspace Tab"
                  icon={Icon.Globe}
                  onAction={() => handleOpen(mapping)}
                />
                <Action.CopyToClipboard
                  title="Copy Alias"
                  content={mapping.alias}
                  shortcut={{ modifiers: ["cmd"], key: "c" }}
                />
                <Action.OpenInBrowser
                  title="Open Extension Preferences"
                  url="raycast://extensions/raycast-arc-extension/preferences"
                  shortcut={{ modifiers: ["cmd", "shift"], key: "," }}
                />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
