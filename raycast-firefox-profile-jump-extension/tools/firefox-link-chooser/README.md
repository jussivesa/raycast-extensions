# Firefox Link Chooser

A small macOS app that asks which Firefox profile opens a link. You set it as the
default browser. When you click a link in another app, for example Slack, the
app shows your Firefox profiles. The link then opens in the profile you select.

The app is kept in the [Firefox Profile Jump](../../README.md) extension because
both work with the same profiles. The extension does not call the app, and the
app does not need the extension.

## Why Firefox cannot do this alone

Firefox has a setting that shows the profile selector at startup
(`ShowSelector=1` in `profiles.ini`). Firefox shows the selector only when all
of these conditions are true:

- A new Firefox process starts.
- No profile is given on the command line.
- The default profile is not running.

When the default profile runs, Firefox sends every link to it and shows no
selector. The check is in `toolkit/xre/nsAppRunner.cpp` of the Firefox source.
The setting therefore seems to have no effect while you use the default
profile.

This app receives the link before Firefox does. It asks for the profile every
time, and a Firefox update does not change this behaviour.

## What the app does

1. macOS sends a web link or an HTML file to the app.
2. The app reads the profiles and shows them in a window.
3. You select a profile.
4. The app gives the link to Firefox:
   - **Profile runs:** the app sends the link to the message port of that
     Firefox instance. Firefox opens the link in a new tab and brings the
     window to the front.
   - **Profile does not run:** the app starts Firefox with
     `--profile <profile folder>` and gives the link in an Apple event. Firefox
     reads the Apple event at startup and opens the link.
5. The app quits.

### Message port of a running profile

A running Firefox instance listens on a Core Foundation message port with the
name `Mozilla_firefox_<profile folder>_RemoteWindow`. A second Firefox process
uses this port to give its command line to the running instance
(`toolkit/components/remote/nsMacRemoteClient.mm`). The app sends the same
message: a dictionary with the keys `args` and `raise`, archived with
`NSKeyedArchiver`. The port exists only while the profile runs, so the app
also uses it to find out whether the profile runs.

The app cannot use the two simpler methods:

- **A new Firefox process with the link as an argument.** The link is then on a
  command line. See [Security](#security).
- **A "get URL" Apple event to the running instance.** Firefox redirects such a
  link to the default profile of the profile group, not to the profile that
  received it (`redirectCommandLine` in
  `browser/components/profiles/SelectableProfileService.sys.mjs`).

The message format is internal to Firefox. If a Firefox update changes it, the
link can fail to open. See [After a Firefox update](#after-a-firefox-update).

## Security

A link can contain a token or other secret data, for example a sign-in link.

- **No command line.** The app never puts a link on a command line. On macOS,
  every local process, including processes of other users, can read the
  command line of every process with `ps`. The profile folder is the only
  argument that the app gives to Firefox.
- **Local channels only.** The message port is in the bootstrap namespace of
  your login session. Only processes in your session can connect to it. Apple
  events also stay on the computer.
- **No log, no file, no network.** The app writes no log, no temporary file and
  no history, and it makes no network connection. It stores one value: the
  profile you selected last (see [What the app reads](#what-the-app-reads)).
- **No link in messages.** The error alert does not show the link. The only
  text output goes to standard error during `--set-default`, and it contains
  no link.
- **Read only.** The app opens the Firefox files read only.
- **Screen.** The chooser window shows the link, so that you can check it before
  you select a profile. Someone who can see your screen can read it.

Firefox itself can still put a link on a command line. When Firefox gets a link
in an Apple event and the default profile of the group is not running, Firefox
starts that profile again with `-url <link>` as an argument. This happens only
when macOS gives a link to Firefox directly, so it does not happen while this
app is the default browser.

## What the app reads

The app reads these files and does not write to them.

| Item | Path |
| --- | --- |
| Profile list, names and colours | `~/Library/Application Support/Firefox/Profile Groups/<StoreID>.sqlite`, table `Profiles` |
| Profile group ID (`StoreID`) and fallback profile list | `~/Library/Application Support/Firefox/profiles.ini` |
| Default profile | `~/Library/Application Support/Firefox/installs.ini`, key `Default` |

The app opens the database read only, because Firefox keeps the database
open. It reads the profiles each time it starts, so a new profile shows
without a change to the app. If the database cannot be read, the app uses
the entries of `profiles.ini`. If there are no profiles at all, the app gives
the link to Firefox as it is.

The app keeps one value of its own: the profile you selected last
(`lastProfilePath` in the defaults of `com.jussivesa.firefox-link-chooser`).

## Chooser window

The default profile is first and has the label "default". The other profiles
keep the Firefox order. The profile you selected last is selected when the
window opens.

| Key | Action |
| --- | --- |
| Type text | Show only the profiles whose name contains the text. |
| `↑` / `↓` | Select the previous or next profile. |
| `↩` | Open the link in the selected profile. |
| `⌘1` to `⌘9` | Open the link in the profile at that position. |
| `esc` | Close the window. The link does not open. |

A double click on a profile also opens the link.

If you start the app from Finder, it has no link. It then opens the selected
profile without a link.

## Requirements

- macOS 13 or later
- Xcode Command Line Tools, for `swiftc` (`xcode-select --install`)
- Firefox in a location that macOS finds by the bundle ID `org.mozilla.firefox`

## Build and install

    ./build.sh

The script:

1. compiles `main.swift` into `build/Firefox Link Chooser.app`,
2. signs the app with an ad hoc signature,
3. copies the app to `~/Applications/Firefox Link Chooser.app`,
4. registers the app with Launch Services, so that macOS lists it as a browser.

Run the script again after each change to `main.swift` or `Info.plist`.

## Set as default browser

    open ~/Applications/"Firefox Link Chooser.app" --args --set-default

macOS shows a confirmation dialog. Select **Use "Firefox Link Chooser"**. The
command makes the app the handler for `http`, `https` and `public.html`.

You can also select the app in **System Settings > Desktop & Dock > Default web
browser**.

To check the result:

    plutil -convert json -o - ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist \
      | grep -o '"LSHandlerRoleAll":"[^"]*","LSHandlerURLScheme":"https\?"'

## After a Firefox update

Firefox can ask to become the default browser again. If you accept, macOS sends
the links to Firefox, and the chooser does not open. To fix it, run the command
in [Set as default browser](#set-as-default-browser) again.

To stop the question, keep `browser.shell.checkDefaultBrowser` set to `false`
in Firefox (`about:config`).

The app uses the internal message format of Firefox for a running profile (see
[Message port of a running profile](#message-port-of-a-running-profile)). After
a Firefox update, do this test:

1. Click a link for a profile that runs. Make sure that the link opens in that
   profile.
2. Click a link for a profile that does not run. Make sure that the profile
   starts with the link.

If step 1 fails, compare `nsMacRemoteClient.mm` and `RemoteUtils.h` in
`toolkit/components/remote/` of the Firefox source with `Firefox.open` and
`Firefox.remotePortName` in `main.swift`.

## Remove

1. Select Firefox as the default browser in **System Settings > Desktop & Dock
   > Default web browser**.
2. Delete `~/Applications/Firefox Link Chooser.app`.

## Known limitations

- The port name contains the profile folder exactly as Firefox resolved it. The
  app uses the path from the profile database. If a profile folder is reached
  through a symbolic link, the names can differ. The app then finds no running
  instance and starts a second Firefox process for the profile. That process
  gives only its command line to the running instance, so the link does not
  open.
- `mailto:` and other schemes are not handled. They go to their own default
  apps.
