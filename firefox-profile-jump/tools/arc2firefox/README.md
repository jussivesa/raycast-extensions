# arc2firefox

Migrate Arc spaces to Firefox profiles on macOS. One Arc space becomes one
Firefox profile.

This is a one-off migration tool. It is kept in the [Firefox Profile
Jump](../../README.md) extension because it creates the profiles that the
extension then switches between. The extension does not call the script, and
the script does not need the extension.

| Arc | Firefox |
| --- | --- |
| Favourites row of the space (the icon tiles at the top) | Pinned tabs, icons only |
| Folder in the pinned list, such as "Recipes" | Tab group with the folder name |
| Single tab in the pinned list | Ordinary tab |

The Arc order is kept. A tab group sits where its folder sat in the Arc list.
Firefox tab groups cannot hold another group, so the contents of a sub folder
join the group of the folder above it.

Firefox keeps pinned tabs and tab groups in the session file of the profile,
so both come back after a tab close and after a Firefox quit.

There is one fixed behaviour. The script has no layout options.

## What the script reads and writes

| Item | Path |
| --- | --- |
| Arc source data (read only) | `~/Library/Application Support/Arc/StorableSidebar.json` |
| Bookmark HTML backup | `~/arc-export/` |
| Firefox profile list | `~/Library/Application Support/Firefox/profiles.ini` |
| Firefox profile group data | `~/Library/Application Support/Firefox/Profile Groups/<id>.sqlite` |

`migrate` copies `profiles.ini` and the profile group database to
`*.arc2firefox-backup` before it changes anything.

## How it works

1. The script reads the Arc sidebar file and splits each space into the top
   pinned tabs and everything else.
2. It writes one Netscape bookmark HTML file per space as a backup. The
   migration does not use these files.
3. It starts Firefox headless with the Marionette remote-control server.
4. It calls `SelectableProfileService.createNewProfile()` inside Firefox, so
   Firefox creates the profile directory, the `profiles.ini` entry and the
   profile group record itself.
5. It starts each profile headless, installs the extensions, applies the
   settings, and writes the pinned tabs and the tab group through
   `SessionStore.setBrowserState()`.
6. It runs the icon warm-up pass. See below.

The script needs no Python packages. Python 3.9 or later is required.

## Commands

Run the script from its own directory. It reads `profile-defaults.json` and
the extension store from the directory that holds `arc2firefox.py`.

    cd firefox-profile-jump/tools/arc2firefox

    python3 arc2firefox.py export     # write the HTML backup files only
    python3 arc2firefox.py plan       # show the mapping and the settings summary
    python3 arc2firefox.py capture    # read the settings of a template profile
    python3 arc2firefox.py migrate    # create the profiles and fill them

Close Firefox before you run `capture` and `migrate`. The script stops if
Firefox runs. Firefox writes `prefs.js` when it closes, so `capture` reads an
old file if Firefox still runs.

### Options

| Option | Effect |
| --- | --- |
| `--only NAME` | Process this space only. Repeatable. |
| `--skip NAME` | Leave out this space. Repeatable. |
| `--force` | Write again into a profile the script already filled. |
| `--no-favorites` | Leave out the Arc favourites row. |
| `--template NAME` | Profile that `capture` reads. |
| `--defaults FILE` | Settings file that `migrate` applies. |
| `--no-defaults` | Apply the built-in prefs only. |
| `--warm-seconds N` | Seconds of the icon warm-up pass. Default 60. `0` turns it off. |
| `--screenshot-dir DIR` | Save a picture of each finished profile window. |
| `--outdir DIR` | Change the HTML backup directory. |

The script writes the pref `arc2firefox.space` into each profile it fills. A
second `migrate` run skips such a profile unless you give `--force`.

`migrate` rebuilds the window of a profile from the Arc data every time. A
second run gives the same result and leaves no stale tab behind. Tabs you
opened yourself in that profile are lost, so use `--force` with care.

## Default settings for new profiles

`migrate` applies the settings in `profile-defaults.json` to every profile it
touches. Run `capture` to build that file from a profile you already set up by
hand, then edit the file. It is plain JSON.

    python3 arc2firefox.py capture --template "Personal"

| Section | Content |
| --- | --- |
| `prefs` | Prefs read from the template profile, plus the built-in set. |
| `extensions` | Paths to the XPI files of the template profile. |
| `_available_extensions` | Extensions found in your other profiles. Move a path into `extensions` to install it as well. |
| `_exclude_extensions` | Text rules. An XPI whose path contains one of them is never installed, also after a new `capture`. |
| `copy_files` | `search.json.mozlz4`, `containers.json`, `handlers.json` and `chrome/`, copied before the profile first starts. |

`capture` reads only known settings prefs. It leaves out telemetry
identifiers, migration flags, server-driven values, sync accounts, logins and
cookies.

### The extension store

`capture` copies each XPI into `extensions/` next to the script and points
`profile-defaults.json` at the copy. The default set then still works after
the profile it came from is deleted.

`extensions/` and `profile-defaults.json` are not in Git. They hold
third-party binaries and absolute paths of one machine. Run `capture` to
build them again on another machine.

To add an extension by hand, install it in any profile, find the file, and
copy it into the store:

    find ~/Library/Application\\ Support/Firefox/Profiles -name "<addon-id>.xpi"
    cp "<path>" ./extensions/

Then add the stored path to `extensions` in `profile-defaults.json`. A later
`capture` keeps entries that are already in the file.

### Prefs the migration sets itself

These win over the template, because the result depends on them.

| Pref | Value | Effect |
| --- | --- | --- |
| `sidebar.verticalTabs` | `true` | Tabs run down the side, like the Arc sidebar. |
| `sidebar.revamp` | `true` | Required for vertical tabs. |
| `sidebar.visibility` | `always-show` | The sidebar stays open. |
| `browser.startup.page` | `3` | Firefox reopens the tabs of that profile after a close. |

The built-in defaults below can be overridden by the template file.

| Pref | Value |
| --- | --- |
| `browser.toolbars.bookmarks.visibility` | `newtab` (bookmarks bar shows on the new tab page only) |
| `browser.shell.checkDefaultBrowser` | `false` |
| `browser.aboutwelcome.enabled` | `false` |
| `browser.profiles.profile-name.updated` | `true` |
| `browser.warnOnQuit`, `browser.tabs.warnOnClose` | `false` |
| `network.http.microsoft-entra-sso.enabled` | `true` (macOS single sign-on with a Microsoft Entra work account) |

### What is not copied

Cookies, logins, history, certificates and Firefox Sync accounts stay in the
template profile. Themes are not copied. Each profile gets its own colour on
the profile card instead, taken from the Arc space colour.

## The icon warm-up pass

Firefox shows a plain globe for a tab it has never loaded. The site icon is
not in the profile yet. Setting the icon in the session data does not work,
because Firefox drops that field.

So after writing the session, the script starts the profile once with tab
loading turned on, waits, then turns it back off. Firefox stores the icons
during that pass and they stay correct. The pass costs about 60 seconds per
profile and loads every tab once.

Use `--warm-seconds 0` to skip it. The icons then appear one by one as you
open the tabs yourself.

Afterwards the profile has `browser.sessionstore.restore_on_demand` and
`browser.sessionstore.restore_pinned_tabs_on_demand` set to `true`, so a tab
loads when you click it, not at every start.

## How long the content lives

| Event | Pinned tabs | Tab group |
| --- | --- | --- |
| Quit Firefox | Restored | Restored, still collapsed |
| Close one tab | The other tabs are not touched | The other tabs are not touched |
| Close one tab by mistake | `History > Recently closed tabs` | `History > Recently closed tabs` |
| Close the whole group | Not applicable | Use "Save and close group" in the group menu. Firefox then lists it under saved tab groups. "Delete group" removes it for good. |

Firefox does not keep a group both open and saved at the same time. A saved
copy written while the group is open is dropped at the next start. The
bookmark HTML files in `~/arc-export/` are the copy that does not depend on
Firefox.

## Repair of profiles.ini

Firefox rewrites `profiles.ini` when it creates a profile. Started with
`--profile`, as this script must, it points the install default at the new
profile and drops the entry of the previous one. `-P <name>` would avoid this,
but with the profile selector enabled Firefox stops at the selector window and
never opens the Marionette port, so the script cannot use it.

The script therefore repairs `profiles.ini` after the profile creation step
and again at the end of the run. The repair:

- writes back the entry of any profile that is in the profile group but not in
  `profiles.ini`,
- removes an entry whose directory no longer exists,
- points the install default in `profiles.ini` and `installs.ini` at a profile
  that exists.

**Symptom of a stale file:** Firefox reports

    Your Firefox profile cannot be loaded. It may be missing or inaccessible.

This means the install default names a directory that is gone, usually after
you deleted a profile by hand. Run the repair:

    python3 -c "import sys; sys.path.insert(0,'.'); import arc2firefox; print(arc2firefox.repair_profiles_ini())"

## Launch a profile

Firefox shows the profile selector at startup after the migration. You can
also start one profile directly:

    /Applications/Firefox.app/Contents/MacOS/firefox --profile "<profile path>"

`plan` prints the profile paths.

## Restore after a failed run

    cd ~/Library/Application\\ Support/Firefox
    cp profiles.ini.arc2firefox-backup profiles.ini
    cp "Profile Groups/<id>.sqlite.arc2firefox-backup" "Profile Groups/<id>.sqlite"

Delete the unwanted profile directories in `Profiles/`.

## Firefox version changes

The script calls Firefox internal modules, so a Firefox update can move a
module and break a run. Firefox 156 moved `SessionStore.sys.mjs` from
`resource:///modules/sessionstore/` to
`moz-src:///browser/components/sessionstore/`. The script now tries both.

The symptom is a run that stops with:

    RuntimeError: ARC_ERROR: Error: Failed to load <module uri>

Find the new path and add it to the list in the script:

    unzip -l /Applications/Firefox.app/Contents/Resources/omni.ja | grep <module>
    unzip -l /Applications/Firefox.app/Contents/Resources/browser/omni.ja | grep <module>

A path `moz-src/x/y/Z.sys.mjs` in the archive is the URI `moz-src:///x/y/Z.sys.mjs`.

## Limits

- Open (unpinned) Arc tabs are not migrated. Arc clears them from the sidebar
  file after they auto-archive.
- Arc folders have no equivalent in the Firefox tab strip. The links inside a
  folder go into the tab group, the folder itself is not kept. The bookmark
  HTML backup keeps the folder structure.
- A top pin that is an Arc folder cannot be a pinned tab. Its contents go into
  the tab group.
- An Arc split view becomes separate tabs.
- Cookies, logins, history and extensions of Arc are not migrated.
