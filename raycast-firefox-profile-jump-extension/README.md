# Firefox Profile Jump

Raycast extension for macOS. It brings the Firefox window of a given profile to the front.
You map a short display name to the exact Firefox profile name, then select the profile from a
list or from a hotkey.

## Why a profile needs a mapping

Every Firefox profile runs its own process, but all processes use the same application name and
the same bundle identifier. macOS cannot tell them apart by application. This extension reads the
window titles to find the profile, and activates the window by process ID.

Firefox writes the profile name into the window title only when more than one profile exists.
On macOS the title has one of these two forms:

```
<page title> — <profile name>
<profile name> — Mozilla Firefox      (when the page has no title)
```

## Commands

| Command | Mode | Purpose |
| --- | --- | --- |
| Jump to Firefox Profile | List | Select a profile and bring its window to the front. |
| Jump to Firefox Profile by Name | Argument | Same action for one named profile. Use it for a hotkey. |
| Jump to Last Firefox Profile | Hotkey | Alternate between the two profiles you use most. |
| Manage Firefox Profiles | List | Add, edit, delete, and reorder the mappings. |
| Refresh Firefox Window Cache | Background | Store which process serves each profile. Runs every 10 minutes. |

## Speed

Reading every Firefox window title costs about 0.6 s, which is too slow for a hotkey. The
extension therefore stores which process serves each profile.

| Step | Time |
| --- | --- |
| Jump by name, cache usable | about 0.6 s |
| Jump to last profile, cache usable | about 0.7 s |
| Jump by name, cache not usable | about 1.2 s |
| Read every window title | about 0.6 s |

A jump by name first reads the process list, which costs about 50 ms, and checks that the
cached process still runs Firefox with the same profile directory. Only when that check
fails does it read the window titles again and store a new map.

The cache is written by every command that reads the windows: both list commands, a jump
that had to read the titles, and the background refresh. Delete the background command's
interval in Raycast Settings if you do not want it. The only effect is that the first jump
after a Firefox restart is slower.

## First use

1. Start Firefox with each profile you want to reach.
2. Open **Manage Firefox Profiles**.
3. Press `Cmd+D`. Every running profile that has no mapping is added. The display name is set to
   the profile name.
4. Edit a mapping with `Enter` to give it a shorter display name.

## Jump back with one key

**Jump to Last Firefox Profile** needs no name and no list. Give it a hotkey in
Raycast Settings, for example `Cmd+Shift+B`. What it does depends on the window you
are in:

| You are in | The jump goes to |
| --- | --- |
| Any application that is not Firefox | The profile you used last |
| A Firefox profile | The profile you used before that one |

A second press of the hotkey goes back, so the two profiles you use most alternate
with one key. Raycast has no chord hotkey, so this is a command of its own. It does
not change what your existing hotkey for **Jump to Firefox Profile by Name** does.

The history holds the last 5 profiles. Every jump of every command writes to it: the
list command, the jump by name, and this command. A profile that is not in the
history yet cannot be reached this way, so jump to it once by name or from the list.

The command reads which application is in front. That costs about 60 ms and it uses
AppKit, not the window titles, so the speed of the jump does not change.

## One hotkey per profile

Raycast assigns one hotkey per command. To get one hotkey for each profile, create a Quicklink:

1. Open **Jump to Firefox Profile**.
2. Select the profile.
3. Open the action panel and run **Create Quicklink for Hotkey**.
4. Save the Quicklink.
5. In Raycast Settings > Extensions, find the Quicklink and assign a hotkey to it.

Repeat for each profile. The Quicklink opens this deeplink:

```
raycast://extensions/jussivesa/raycast-firefox-profile-jump-extension/jump-to-profile-by-name?arguments=%7B%22profile%22%3A%22Work%22%7D
```

## Actions

**Jump to Firefox Profile**

| Action | Shortcut |
| --- | --- |
| Jump to Profile | `Enter` |
| Jump to Window (more than one window) | action panel |
| Launch Profile (profile not running) | action panel |
| Create Quicklink for Hotkey | action panel |
| Copy Deeplink | `Cmd+Shift+C` |
| Manage Firefox Profiles | `Cmd+M` |
| Refresh | `Cmd+R` |

**Manage Firefox Profiles**

| Action | Shortcut |
| --- | --- |
| Edit Mapping | `Enter` |
| Add Mapping | `Cmd+N` |
| Delete Mapping | `Ctrl+X` |
| Detect Running Profiles | `Cmd+D` |
| Move Up / Move Down | `Cmd+Shift+Up` / `Cmd+Shift+Down` |
| Copy All as JSON | `Cmd+Shift+C` |
| Refresh | `Cmd+R` |

## Preferences

| Preference | Default | Purpose |
| --- | --- | --- |
| Seed Profile Mappings | empty | Initial mappings. Read only while no mapping is stored. |
| Firefox Process Name | `firefox` | Process name that macOS reports. Change it for a non-standard build. |
| Window Title Separator | `—` | Character between the title parts. Firefox uses an em dash. |
| Window Title Suffixes | `Mozilla Firefox, Private Browsing` | Title parts that are not a profile name. Translate them if Firefox is not in English. |

The seed accepts one mapping per line:

```
Work = Original profile
Test = asd
```

It also accepts a JSON array:

```json
[{ "displayName": "Work", "profileName": "Original profile" }]
```

## Arc migration

`tools/arc2firefox/` holds `arc2firefox.py`, a separate one-off script that
creates the Firefox profiles this extension switches between. It reads the Arc
sidebar file and turns each Arc space into one Firefox profile, with the pinned
tabs and the tab group of that space.

    cd tools/arc2firefox
    python3 arc2firefox.py plan       # show what it would create
    python3 arc2firefox.py migrate    # create the profiles and fill them

The script needs Python 3.9 or later and no Python packages. It drives a
headless Firefox over the Marionette protocol. Close Firefox before you run it.

The extension does not call the script, and the script does not need the
extension. After a migration, open **Manage Firefox Profiles** and press
`Cmd+D` to map the new profiles.

See [tools/arc2firefox/README.md](tools/arc2firefox/README.md) for the
commands, the options, the default settings, and the repair of `profiles.ini`.

## Requirements

- macOS.
- Raycast must be allowed in System Settings > Privacy & Security > Accessibility. Without it the
  extension cannot read window titles or activate a window.
- Firefox 138 or later, with more than one profile. Firefox adds the profile name to the window
  title only from that version and only with two or more profiles.

## Install

```bash
npm install
npm run install-local
```

`install-local` builds the extension and copies the result to
`~/.config/raycast/extensions/raycast-firefox-profile-jump-extension`. Reload Raycast after the copy.

For development with hot reload:

```bash
npm run dev
```

## Notes

- A profile with no window shows **Not running**. **Launch Profile** starts it, but only when the
  profile directory is known. The directory is read from the command line of a running Firefox
  process, so start the profile once by hand before the action can work.
- Windows are matched by the profile name in the title. A page whose title part equals a profile
  name can match as well. This is rare and only affects which window is chosen inside one profile.
- A cached jump goes to the front window of the profile, which is the window you used last. To
  pick another window, use **Jump to Firefox Profile** and the **Jump to Window** action.
- Every profile runs an application with the same name and the same bundle identifier. The
  extension addresses the process by process ID. AppleScript degrades a stored process or window
  reference to one that names the application, so every specifier in the scripts is written out in
  full or wrapped in a `tell` block. Do not refactor those scripts into variables.
