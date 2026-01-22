# Arc Workspace Switcher

A Raycast extension to quickly switch between Arc browser workspaces (spaces) and select specific tabs by their position using keyboard shortcuts.

## Features

- **Quick Workspace Switching**: Switch to any Arc workspace by name
- **Tab Selection by Index**: Select tabs by their position using configurable keyboard shortcuts
- **Manage Shortcuts**: Create, edit, and organize workspace-tab shortcuts
- **Search & Filter**: Quickly find shortcuts by alias, workspace name, or keywords
- **Import/Export**: Share shortcuts between machines via JSON

## Commands

### Open Workspace Tab
Search and open configured workspace-tab shortcuts. Type to filter by alias, workspace name, or keywords, then press Enter to switch to the workspace and select the tab.

### Open by Alias
Quickly open a workspace-tab by typing its alias. Ideal for creating custom Raycast hotkeys or using with Raycast's quicklinks feature.

**Usage**: `open-by-alias <alias>`

### Manage Arc Shortcuts
Add, edit, delete, import, and export workspace-tab shortcuts through an intuitive UI.

## Setup

1. Install the extension in Raycast
2. Grant **Accessibility permissions** to Raycast in System Settings → Privacy & Security → Accessibility (required for UI scripting)
3. Use "Manage Arc Shortcuts" to add your first shortcut

## Creating a Shortcut

Each shortcut consists of:
- **Alias**: A unique name for the shortcut (e.g., "Work Email", "Personal Tab 1")
- **Workspace Name**: The exact name of your Arc workspace/space
- **Tab Index**: The position of the tab (1 for first tab, 2 for second, etc.)
- **Keywords** (optional): Additional search terms to help find the shortcut e.g. to group all email tabs

## How It Works

1. **Workspace Switching**: Uses AppleScript to switch to the specified Arc workspace
2. **Tab Selection**: Uses AppleScript to send keyboard shortcuts (default: Cmd+Number) to select the tab by its position

Arc's pinned tabs and favorites in the sidebar are accessed by their position (index) using keyboard shortcuts like Cmd+1, Cmd+2, etc.

## Configuration

### Preferences

- **Use UI Scripting**: Enable to switch workspaces via Arc's menu (recommended, requires Accessibility permissions)
- **Tab Selection Modifier**: Keyboard modifier for tab selection (default: "command")
  - Use "command" for Cmd+Number
  - Use "command+shift" for Cmd+Shift+Number
  - Customize based on your Arc keyboard shortcut settings

## Example Shortcuts

```json
[
  {
    "alias": "Work Gmail",
    "workspaceName": "Work",
    "tab": {
      "selector": { "index": 1 }
    },
    "keywords": ["email", "mail"]
  },
  {
    "alias": "Personal Calendar",
    "workspaceName": "Personal",
    "tab": {
      "selector": { "index": 3 }
    },
    "keywords": ["schedule", "events"]
  },
  {
    "alias": "Customer Xyz JIRA",
    "workspaceName": "Customer Xyz",
    "tab": {
      "selector": { "index": 2 }
    },
    "keywords": ["jira"]
  }
]
```

## Tips

- **Sorted Display**: Shortcuts are automatically sorted by workspace name, then by tab index
- **Quick Access**: Assign Raycast hotkeys to "Open Workspace Tab" for instant access
- **Alias Shortcuts**: Use "Open by Alias" with Raycast quicklinks for direct navigation
- **Backup**: Use Import/Export in "Manage Arc Shortcuts" to backup or share your configuration

## Troubleshooting

### Workspace doesn't switch
- Ensure Raycast has Accessibility permissions
- Verify the workspace name exactly matches your Arc space name
- Try disabling "Use UI Scripting" in preferences to use AppleScript method

### Tab doesn't select
- Check that the tab index matches the actual position of your tab
- Verify the "Tab Selection Modifier" matches your Arc keyboard shortcut settings
- Ensure Arc is the active application when the command runs

### Welcome screen appears
- Make sure preferences have default values set
- Try reloading the extension (Cmd+R in Raycast)

## Privacy

All shortcuts are stored locally using Raycast's LocalStorage API. No data is sent to external servers.

## License

MIT