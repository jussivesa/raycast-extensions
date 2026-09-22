#!/usr/bin/env python3
"""Migrate Arc spaces to Firefox profiles on macOS.

Each Arc space becomes one Firefox profile.

| Arc                                   | Firefox                          |
| ------------------------------------- | -------------------------------- |
| Top pinned tabs of the space          | Pinned tabs                      |
| Everything else: folder contents,     | One tab group named after the    |
| sub folders, the favourites row       | profile                          |

Firefox keeps pinned tabs and tab groups in the session file, so both survive
a tab close and a Firefox quit.

The script has no Python dependencies. It drives Firefox through the
Marionette remote-control protocol, so Firefox does its own bookkeeping.

Subcommands
  export    Read the Arc sidebar and write one bookmark HTML file per space.
            The files are a backup. The migration does not use them.
  plan      Show which profiles exist and which the script will create.
  capture   Copy the settings of an existing profile into profile-defaults.json.
  prune     Remove the excluded extensions from the profiles already migrated.
  migrate   Create the missing profiles, apply the settings and write the
            pinned tabs and the tab group.

Firefox must be closed before "capture" and "migrate" run.
"""

import argparse
import base64
import configparser
import html
import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import concurrent.futures
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox"
ARC_SIDEBAR = os.path.expanduser(
    "~/Library/Application Support/Arc/StorableSidebar.json"
)
FF_ROOT = os.path.expanduser("~/Library/Application Support/Firefox")
FF_PROFILES_INI = os.path.join(FF_ROOT, "profiles.ini")
FF_GROUPS_DIR = os.path.join(FF_ROOT, "Profile Groups")
DEFAULT_EXPORT = os.path.expanduser("~/arc-export")
DEFAULTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "profile-defaults.json")
# Copies of the extensions to install. A copy here keeps the default set
# usable after the profile it came from is deleted.
EXTENSION_STORE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "extensions")
APPLE_EPOCH = 978307200  # Arc stores seconds since 2001-01-01 UTC.
# Profile name for an Arc space with an empty title. Arc titles its own
# untitled space "~", and that title is kept as the profile name.
UNTITLED_PROFILE_NAME = "~"

# Settings the migration depends on. These win over a captured template.
REQUIRED_PREFS = {
    "sidebar.revamp": True,                          # needed for vertical tabs
    "sidebar.verticalTabs": True,                    # tabs on the side, like Arc
    "sidebar.visibility": "always-show",
    "browser.startup.page": 3,                       # reopen the last session
}

# Settings every new profile gets. A profile-defaults.json file overrides them.
BUILTIN_PREFS = {
    "sidebar.verticalTabs.dragToPinPromo.dismissed": True,
    "browser.toolbars.bookmarks.visibility": "newtab",  # only on a new tab
    "browser.shell.checkDefaultBrowser": False,
    "browser.aboutwelcome.enabled": False,
    "browser.profiles.profile-name.updated": True,   # no "name this profile" nag
    "browser.warnOnQuit": False,
    "browser.tabs.warnOnClose": False,
    "network.http.microsoft-entra-sso.enabled": True,  # macOS single sign-on
}

# Prefs that "capture" reads from a template profile. Prefix match.
CAPTURE_PREFIXES = (
    "sidebar.",
    "browser.uiCustomization.",
    "browser.startup.page",
    "browser.startup.homepage",
    "browser.toolbars.bookmarks.",
    "browser.tabs.",
    "browser.uidensity",
    "browser.compactmode.",
    "browser.newtabpage.",
    "browser.download.",
    "browser.urlbar.",
    "browser.search.suggest.",
    "browser.contentblocking.category",
    "browser.translations.",
    "browser.theme.",
    "browser.link.open_newwindow",
    "browser.aboutConfig.showWarning",
    "browser.warnOnQuit",
    "browser.formfill.enable",
    "extensions.pocket.enabled",
    "privacy.trackingprotection.",
    "privacy.donottrackheader.",
    "privacy.globalprivacycontrol",
    "signon.rememberSignons",
    "intl.accept_languages",
    "general.autoScroll",
    "layout.css.prefers-color-scheme.content-override",
)

# Prefs that belong to one profile only and must never be copied.
CAPTURE_EXCLUDE = (
    "sidebar.backupState",
    "sidebar.nimbus",
    "sidebar.new-sidebar.has-used",
    "browser.newtabpage.storageVersion",
    "browser.download.lastDir",
    "browser.urlbar.quicksuggest.migrationVersion",
    "browser.urlbar.tipShownCount.",
    "browser.startup.homepage_override.",
    "browser.tabs.inTitlebar",
)

# Prefs that hold per-profile state or server-driven values. Substring match.
CAPTURE_EXCLUDE_PARTS = (
    "impressionId",     # telemetry identifier of one profile
    "trainhop",         # built-in add-on deployment state
    "typeWasRegistered",
    "discoverystream",  # server-driven new tab content
    "pollLiveMs",
    "lastUrlbarSearch",
    "timesShown",
    "hasMigrated",
    ".migrated",
    "migrationVersion",
    "storageVersion",
    "lastDir",
    "Count",
)

# Files "capture" copies from the template profile into each new profile.
# They are copied before the profile first starts.
TEMPLATE_FILES = (
    "search.json.mozlz4",   # default and custom search engines
    "containers.json",      # container tabs
    "handlers.json",        # file type and protocol handlers
    "chrome",               # userChrome.css and userContent.css
)
AVATARS = [
    "book", "briefcase", "flower", "heart", "shopping", "star", "barbell",
    "bike", "canvas", "craft", "diamond", "folder", "hammer", "heart-rate",
    "history", "leaf", "lightbulb", "makeup", "message", "musical-note",
    "palette", "paw-print", "plane", "present", "soccer", "sparkle-single",
    "video-game-controller",
]


# --------------------------------------------------------------------------
# Arc side
# --------------------------------------------------------------------------

def apple_to_unix_ms(ts):
    if ts is None:
        return int(datetime.now(timezone.utc).timestamp() * 1000)
    return int((ts + APPLE_EPOCH) * 1000)


def objects(flat_list):
    """Arc stores [id, object, id, object, ...]. Keep the objects."""
    return [entry for entry in flat_list if isinstance(entry, dict)]


def pair_labels(container_ids):
    result = {}
    for index in range(0, len(container_ids) - 1, 2):
        label, value = container_ids[index], container_ids[index + 1]
        if isinstance(label, str) and isinstance(value, str):
            result.setdefault(label, []).append(value)
    return result


def node_kind(item):
    data = item.get("data") or {}
    for key in ("tab", "list", "itemContainer", "splitView"):
        if key in data:
            return key
    return next(iter(data), "unknown")


def build_tree(item_id, items, seen):
    if item_id in seen:
        return None
    item = items.get(item_id)
    if item is None:
        return None
    seen.add(item_id)
    kind = node_kind(item)

    if kind == "tab":
        tab = item["data"]["tab"]
        url = tab.get("savedURL")
        if not url or len(url) > 65000:
            return None
        title = item.get("title") or tab.get("savedTitle") or url
        return {"type": "link", "url": url, "title": title,
                "added": apple_to_unix_ms(item.get("createdAt"))}

    children = []
    for child_id in item.get("childrenIds") or []:
        child = build_tree(child_id, items, seen)
        if child:
            children.append(child)

    if kind == "splitView":
        return {"type": "group", "children": children}
    if kind not in ("list", "itemContainer"):
        return None
    return {"type": "folder", "title": item.get("title") or "(untitled)",
            "added": apple_to_unix_ms(item.get("createdAt")),
            "children": children}


def flatten_groups(nodes):
    """A split view is a set of tabs, not a folder. Inline its members."""
    out = []
    for node in nodes:
        if node["type"] == "group":
            out.extend(flatten_groups(node["children"]))
        else:
            if node["type"] == "folder":
                node["children"] = flatten_groups(node["children"])
            out.append(node)
    return out


def container_children(container_id, items, seen):
    container = items.get(container_id)
    if container is None:
        return []
    children = []
    for child_id in container.get("childrenIds") or []:
        node = build_tree(child_id, items, seen)
        if node:
            children.append(node)
    return flatten_groups(children)


def rgb_of(color):
    if not isinstance(color, dict):
        return None
    try:
        parts = [int(round(max(0.0, min(1.0, color[k])) * 255))
                 for k in ("red", "green", "blue")]
    except (KeyError, TypeError):
        return None
    return "rgb({},{},{})".format(*parts)


def space_colors(space):
    """Map the Arc space colour to Firefox profile card colours."""
    palette = (((space.get("customInfo") or {}).get("windowTheme") or {})
               .get("primaryColorPalette") or {})
    background = rgb_of(palette.get("midTone")) or "rgb(240,240,244)"
    foreground = rgb_of(palette.get("shadedDark")) or "rgb(21,20,26)"
    return foreground, background


def count_links(nodes):
    total = 0
    for node in nodes:
        total += 1 if node["type"] == "link" else count_links(node["children"])
    return total


def safe_stem(title, index):
    name = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-") or "space"
    return f"{index:02d}-{name}"


def profile_name_for(title, index):
    """Firefox profile name. Arc's untitled space keeps its '~' title."""
    return title.strip() or UNTITLED_PROFILE_NAME


def read_spaces(sidebar_path, include_favorites=True):
    with open(sidebar_path, "r", encoding="utf-8") as fh:
        sidebar = json.load(fh)
    container = None
    for entry in sidebar["sidebar"]["containers"]:
        if "items" in entry and "spaces" in entry:
            container = entry
            break
    if container is None:
        raise SystemExit("No Arc container with items and spaces found.")

    items = {item["id"]: item for item in objects(container["items"])}
    top_apps = {}
    flat = container.get("topAppsContainerIDs") or []
    for index in range(0, len(flat) - 1, 2):
        key, value = flat[index], flat[index + 1]
        if isinstance(key, dict) and isinstance(value, str):
            top_apps[json.dumps(key, sort_keys=True)] = value

    spaces = []
    for index, space in enumerate(objects(container["spaces"]), start=1):
        title = space.get("title") or f"Space {index}"
        groups = pair_labels(space.get("containerIDs") or [])
        seen = set()
        nodes = []
        for cid in groups.get("pinned", []):
            nodes.extend(container_children(cid, items, seen))

        favorites = []
        if include_favorites:
            key = json.dumps(space.get("profile") or {}, sort_keys=True)
            fav_container = top_apps.get(key)
            if fav_container:
                favorites = container_children(fav_container, items, set())

        foreground, background = space_colors(space)
        spaces.append({
            "index": index,
            "title": title,
            "profile_name": profile_name_for(title, index),
            "stem": safe_stem(title, index),
            "avatar": AVATARS[(index - 1) % len(AVATARS)],
            "theme_fg": foreground,
            "theme_bg": background,
            "nodes": nodes,
            "favorites": favorites,
            "count": count_links(nodes),
            "favorites_count": count_links(favorites),
        })
    return spaces


# --------------------------------------------------------------------------
# Netscape bookmark HTML (portable artifact and manual fallback)
# --------------------------------------------------------------------------

def render_nodes(nodes, depth, out):
    pad = " " * (4 * depth)
    out.append(f"{pad}<DL><p>")
    for node in nodes:
        inner = " " * (4 * (depth + 1))
        seconds = node["added"] // 1000
        if node["type"] == "link":
            out.append(f'{inner}<DT><A HREF="{html.escape(node["url"], quote=True)}"'
                       f' ADD_DATE="{seconds}">{html.escape(node["title"])}</A>')
        else:
            out.append(f'{inner}<DT><H3 ADD_DATE="{seconds}">'
                       f"{html.escape(node['title'])}</H3>")
            render_nodes(node["children"], depth + 1, out)
    out.append(f"{pad}</DL><p>")


def render_html(nodes):
    out = ["<!DOCTYPE NETSCAPE-Bookmark-file-1>",
           "<!-- Exported from Arc by arc2firefox. -->",
           '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
           "<TITLE>Bookmarks</TITLE>", "<H1>Bookmarks</H1>"]
    render_nodes(nodes, 0, out)
    return "\n".join(out) + "\n"


def bookmark_roots(space):
    """Top-level nodes to place on the bookmarks toolbar."""
    roots = []
    if space["favorites"]:
        roots.append({"type": "folder", "title": "Favorites",
                      "added": apple_to_unix_ms(None),
                      "children": space["favorites"]})
    roots.extend(space["nodes"])
    return roots


def do_export(spaces, outdir):
    os.makedirs(outdir, exist_ok=True)
    manifest = []
    combined = []
    for space in spaces:
        roots = bookmark_roots(space)
        path = os.path.join(outdir, space["stem"] + ".html")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(render_html(roots))
        manifest.append({k: space[k] for k in
                         ("index", "title", "profile_name", "stem", "avatar",
                          "theme_fg", "theme_bg", "count", "favorites_count")}
                        | {"html": path})
        combined.append({"type": "folder", "title": space["title"],
                         "added": apple_to_unix_ms(None), "children": roots})
        print(f'{space["index"]:2d}  {space["profile_name"]:<18} '
              f'pins={space["count"]:4d} favorites={space["favorites_count"]:3d}'
              f'  -> {os.path.basename(path)}')

    with open(os.path.join(outdir, "00-all-spaces.html"), "w", encoding="utf-8") as fh:
        fh.write(render_html(combined))
    with open(os.path.join(outdir, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, ensure_ascii=False)
    total = sum(m["count"] + m["favorites_count"] for m in manifest)
    print(f"\n{len(manifest)} spaces, {total} bookmarks, written to {outdir}")


GROUP_COLORS = ("blue", "purple", "cyan", "orange", "yellow", "pink",
                "green", "gray", "red")

# Hue in degrees -> Firefox tab group colour.
HUE_COLORS = ((20, "red"), (45, "orange"), (65, "yellow"), (160, "green"),
              (200, "cyan"), (255, "blue"), (290, "purple"), (335, "pink"),
              (360, "red"))


GROUP_COLORS = ("blue", "purple", "cyan", "orange", "yellow", "pink",
                "green", "red", "gray")


def collect_links(nodes):
    """Every link under these nodes, in order, sub folder contents included."""
    found = []
    for node in nodes:
        if node["type"] == "link":
            found.append(node)
        else:
            found.extend(collect_links(node["children"]))
    return found


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "item"


def space_layout(space):
    """Turn one Arc space into the Firefox sidebar layout.

    | Arc                          | Firefox                          |
    | ---------------------------- | -------------------------------- |
    | favourites row (top apps)    | pinned tabs, icon only           |
    | folder in the pinned list    | tab group with the folder name   |
    | single tab in the pinned list| ordinary tab                     |

    Firefox tab groups cannot hold another group, so the contents of a sub
    folder join the group of the folder above it. The Arc order is kept, so a
    group sits where its folder sat in the Arc list.
    """
    pinned, seen = [], set()
    for link in collect_links(space["favorites"]):
        if link["url"] in seen:
            continue
        seen.add(link["url"])
        pinned.append({"url": link["url"], "title": link["title"]})

    items, index = [], 0
    for node in space["nodes"]:
        if node["type"] == "link":
            items.append({"kind": "tab", "url": node["url"],
                          "title": node["title"]})
            continue
        links = collect_links(node["children"])
        if not links:
            continue
        items.append({
            "kind": "group",
            "id": f"arc-{slug(space['profile_name'])}-{slug(node['title'])}",
            "name": node["title"],
            "color": GROUP_COLORS[index % len(GROUP_COLORS)],
            "tabs": [{"url": link["url"], "title": link["title"]}
                     for link in links],
        })
        index += 1
    return {"pinned": pinned, "items": items}


def layout_counts(layout):
    groups = [item for item in layout["items"] if item["kind"] == "group"]
    tabs = [item for item in layout["items"] if item["kind"] == "tab"]
    grouped = sum(len(group["tabs"]) for group in groups)
    return len(layout["pinned"]), len(groups), grouped, len(tabs)


def origin_of(url):
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    return f"{parts.scheme}://{parts.netloc}"


# --------------------------------------------------------------------------
# Marionette client
# --------------------------------------------------------------------------

class Marionette:
    def __init__(self, port, host="127.0.0.1", timeout=180):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        self.buffer = b""
        self.msgid = 0
        self._read_packet()

    def _read_packet(self):
        while b":" not in self.buffer:
            self._fill()
        length, _, rest = self.buffer.partition(b":")
        size = int(length)
        self.buffer = rest
        while len(self.buffer) < size:
            self._fill()
        payload, self.buffer = self.buffer[:size], self.buffer[size:]
        return json.loads(payload)

    def _fill(self):
        chunk = self.sock.recv(8192)
        if not chunk:
            raise ConnectionError("Marionette closed the connection.")
        self.buffer += chunk

    def command(self, name, params=None):
        self.msgid += 1
        body = json.dumps([0, self.msgid, name, params or {}]).encode("utf-8")
        self.sock.sendall(str(len(body)).encode("ascii") + b":" + body)
        while True:
            packet = self._read_packet()
            if packet[0] == 1 and packet[1] == self.msgid:
                _, _, error, result = packet
                if error:
                    raise RuntimeError(f"{name} failed: {error}")
                return result

    def script(self, source, args, timeout_ms=300000):
        self.command("WebDriver:SetTimeouts", {"script": timeout_ms})
        result = self.command("WebDriver:ExecuteAsyncScript",
                              {"script": source, "args": args,
                               "sandbox": "system"})
        value = result.get("value") if isinstance(result, dict) else result
        if isinstance(value, str) and value.startswith("ARC_ERROR:"):
            raise RuntimeError(value)
        return value

    def quit(self):
        try:
            self.command("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


def toolkit_profile_name(profile_dir):
    """Name of this profile in profiles.ini, if it is registered there."""
    parser = configparser.ConfigParser()
    parser.optionxform = str
    parser.read(FF_PROFILES_INI, encoding="utf-8")
    target = os.path.normpath(profile_dir)
    for section in parser.sections():
        if not section.startswith("Profile"):
            continue
        path = parser.get(section, "Path", fallback="")
        if path and os.path.normpath(absolute_profile_path(path)) == target:
            return parser.get(section, "Name", fallback=None)
    return None


class FirefoxSession:
    """Run Firefox headless on one profile with Marionette enabled."""

    def __init__(self, profile_dir, port):
        self.profile_dir = profile_dir
        self.port = port
        self.user_js = os.path.join(profile_dir, "user.js")
        self.user_js_backup = self.user_js + ".arc2firefox-backup"
        self.process = None
        self.client = None

    def __enter__(self):
        if os.path.exists(self.user_js):
            shutil.copy2(self.user_js, self.user_js_backup)
        with open(self.user_js, "a", encoding="utf-8") as fh:
            fh.write(f'\nuser_pref("marionette.port", {self.port});\n')
        # --profile is the only form that starts Marionette reliably. With
        # the profile selector enabled, -P <name> stops at the selector window
        # and never opens the port. The cost of --profile is that Firefox
        # repoints the install default and drops the previous profiles.ini
        # entry, so repair_profiles_ini() runs after the migration.
        self.process = subprocess.Popen(
            [FIREFOX, "--profile", self.profile_dir, "--no-remote",
             "--headless", "--marionette", "--remote-allow-system-access"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 120
        while time.time() < deadline:
            if self.process.poll() is not None:
                self._restore_user_js()
                raise SystemExit(
                    f"Firefox exited with code {self.process.returncode}. "
                    "Close all Firefox windows and try again.")
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=1):
                    break
            except OSError:
                time.sleep(0.3)
        else:
            self._restore_user_js()
            raise SystemExit("Marionette did not start.")
        self.client = Marionette(self.port)
        self.client.command("WebDriver:NewSession", {})
        self.client.command("Marionette:SetContext", {"value": "chrome"})
        return self.client

    def __exit__(self, *exc):
        if self.client is not None:
            self.client.quit()
        if self.process is not None:
            try:
                self.process.wait(timeout=60)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self._restore_user_js()
        return False

    def _restore_user_js(self):
        if os.path.exists(self.user_js_backup):
            shutil.move(self.user_js_backup, self.user_js)
        elif os.path.exists(self.user_js):
            os.remove(self.user_js)


# --------------------------------------------------------------------------
# Chrome scripts that run inside Firefox
# --------------------------------------------------------------------------

APPLY_SETTINGS = """
const [payload, resolve] = arguments;
(async () => {
  const job = JSON.parse(payload);
  const report = { prefs: 0 };
  for (const [name, value] of Object.entries(job.prefs)) {
    if (typeof value === "boolean") {
      Services.prefs.setBoolPref(name, value);
    } else if (typeof value === "number") {
      Services.prefs.setIntPref(name, value);
    } else {
      Services.prefs.setStringPref(name, value);
    }
    report.prefs += 1;
  }
  Services.prefs.savePrefFile(null);
  resolve(JSON.stringify(report));
})().catch(e => resolve("ARC_ERROR: " + e));
"""

SET_SESSION = """
const [payload, resolve] = arguments;
(async () => {
  // Firefox 156 moved SessionStore from resource:/// to moz-src:///.
  const importAny = (...uris) => {
    for (const uri of uris) {
      try {
        return ChromeUtils.importESModule(uri);
      } catch (e) {
        continue;
      }
    }
    throw new Error("cannot load any of: " + uris.join(" "));
  };
  const { SessionStore } = importAny(
    "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
    "resource:///modules/sessionstore/SessionStore.sys.mjs");
  const { E10SUtils } = importAny(
    "resource://gre/modules/E10SUtils.sys.mjs",
    "moz-src:///toolkit/modules/E10SUtils.sys.mjs");
  const job = JSON.parse(payload);
  const principal = E10SUtils.serializePrincipal(
    Services.scriptSecurityManager.createNullPrincipal({}));
  const now = Date.now();

  const make = (item, pinned, groupId) => {
    const tab = {
      entries: [{ url: item.url, title: item.title || item.url,
                  triggeringPrincipal_base64: principal }],
      index: 1, pinned, hidden: false, lastAccessed: now,
    };
    if (groupId) { tab.groupId = groupId; }
    return tab;
  };

  const state = JSON.parse(SessionStore.getBrowserState());
  if (!state.windows || !state.windows.length) {
    state.windows = [{ tabs: [], groups: [], selected: 1, _closedTabs: [] }];
  }
  const win = state.windows[0];

  // The window is rebuilt from the Arc content every time. A second run then
  // gives the same result, leaves no stale tab behind, and drops the welcome
  // page that an extension opens when it is installed.
  const tabs = job.pinned.map(t => make(t, true, null));
  const groups = [];
  for (const item of job.items) {
    if (item.kind === "tab") {
      tabs.push(make(item, false, null));
      continue;
    }
    // Firefox needs the tabs of one group to sit next to each other.
    for (const tab of item.tabs) {
      tabs.push(make(tab, false, item.id));
    }
    groups.push({ id: item.id, name: item.name, color: item.color,
                  collapsed: true });
  }
  tabs.push(make({ url: "about:newtab", title: "New Tab" }, false, null));

  win.tabs = tabs;
  win.groups = groups;
  win.selected = win.tabs.length;
  state.selectedWindow = 1;
  SessionStore.setBrowserState(JSON.stringify(state));

  // The restore runs in the background. Wait, then count the real tabs.
  const anyWindow = Services.wm.getMostRecentBrowserWindow();
  await new Promise(done => anyWindow.setTimeout(done, 2500));
  const browser = Services.wm.getMostRecentBrowserWindow().gBrowser;
  resolve(JSON.stringify({
    pinned: browser.pinnedTabCount,
    total: browser.tabs.length,
    groups: browser.tabGroups.map(g => g.label + " (" + g.tabs.length + ")"),
  }));
})().catch(e => resolve("ARC_ERROR: " + e));
"""

READ_MARKER = """
const [resolve] = arguments;
(async () => {
  resolve(JSON.stringify({
    space: Services.prefs.getStringPref("arc2firefox.space", ""),
  }));
})().catch(e => resolve("ARC_ERROR: " + e));
"""

WRITE_MARKER = """
const [payload, resolve] = arguments;
(async () => {
  const job = JSON.parse(payload);
  Services.prefs.setStringPref("arc2firefox.space", job.space);
  Services.prefs.savePrefFile(null);
  resolve("ok");
})().catch(e => resolve("ARC_ERROR: " + e));
"""

CLEAN_TABS = """
const [resolve] = arguments;
(async () => {
  const win = Services.wm.getMostRecentBrowserWindow();
  const browser = win.gBrowser;
  const spec = tab => (tab.linkedBrowser && tab.linkedBrowser.currentURI)
    ? tab.linkedBrowser.currentURI.spec : "";
  const blank = ["about:blank", "about:newtab", "about:home", ""];

  // An extension opens a welcome page when it is installed, and every start
  // of this profile adds one empty tab. Neither belongs in the saved session.
  const closable = [...browser.tabs].filter(
    tab => !tab.pinned && !tab.group);
  const noise = closable.filter(tab => spec(tab).startsWith("moz-extension://"));
  const empty = closable.filter(tab => blank.includes(spec(tab)));
  const drop = noise.concat(empty.slice(1));

  if (!empty.length) {
    browser.addTab("about:newtab", {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  }
  for (const tab of drop) {
    browser.removeTab(tab);
  }
  resolve(JSON.stringify({ closed: drop.length, tabs: browser.tabs.length }));
})().catch(e => resolve("ARC_ERROR: " + e));
"""

TAB_ICON_STATUS = """
const [resolve] = arguments;
(async () => {
  const win = Services.wm.getMostRecentBrowserWindow();
  const tabs = [...win.gBrowser.tabs];
  const withIcon = tabs.filter(t => {
    const icon = t.getAttribute("image");
    return icon && icon.length;
  }).length;
  resolve(JSON.stringify({ total: tabs.length, withIcon }));
})().catch(e => resolve("ARC_ERROR: " + e));
"""

UNINSTALL_ADDONS = """
const [payload, resolve] = arguments;
(async () => {
  const { AddonManager } = ChromeUtils.importESModule(
    "resource://gre/modules/AddonManager.sys.mjs");
  const rules = JSON.parse(payload).map(r => r.toLowerCase());
  const all = await AddonManager.getAddonsByTypes(["extension"]);
  const removed = [];
  for (const addon of all) {
    if (addon.isBuiltin || addon.signedState == null) { continue; }
    const id = (addon.id || "").toLowerCase();
    const name = (addon.name || "").toLowerCase();
    if (!rules.some(rule => id.includes(rule) || name.includes(rule))) {
      continue;
    }
    await addon.uninstall();
    removed.push(addon.name || addon.id);
  }
  resolve(JSON.stringify({ removed }));
})().catch(e => resolve("ARC_ERROR: " + e));
"""

LIST_ADDONS = """
const [resolve] = arguments;
(async () => {
  const { AddonManager } = ChromeUtils.importESModule(
    "resource://gre/modules/AddonManager.sys.mjs");
  const all = await AddonManager.getAddonsByTypes(["extension"]);
  resolve(JSON.stringify(all
    .filter(a => a.signedState != null && !a.isBuiltin)
    .map(a => ({ id: a.id, name: a.name, active: a.isActive }))));
})().catch(e => resolve("ARC_ERROR: " + e));
"""

LIST_PROFILES = """
const [resolve] = arguments;
(async () => {
  const { SelectableProfileService } = ChromeUtils.importESModule(
    "resource:///modules/profiles/SelectableProfileService.sys.mjs");
  await SelectableProfileService.init();
  const all = await SelectableProfileService.getAllProfiles();
  resolve(JSON.stringify(all.map(p => ({ id: p.id, name: p.name, path: p.path }))));
})().catch(e => resolve("ARC_ERROR: " + e));
"""

CREATE_PROFILES = """
const [payload, resolve] = arguments;
(async () => {
  const { SelectableProfileService } = ChromeUtils.importESModule(
    "resource:///modules/profiles/SelectableProfileService.sys.mjs");
  await SelectableProfileService.init();
  const wanted = JSON.parse(payload);
  const created = [];
  // Best effort: started with --profile, Firefox has no registered toolkit
  // profile for this run, so this call can fail. profiles.ini is set instead.
  try {
    await SelectableProfileService.setShowProfileSelectorWindow(true);
  } catch (e) {
    // ignored on purpose
  }
  for (const item of wanted) {
    const existing = await SelectableProfileService.getAllProfiles();
    let profile = existing.find(p => p.name === item.name);
    if (!profile) {
      profile = await SelectableProfileService.createNewProfile(
        false, null, "arc2firefox");
      await profile.setNameAsync(item.name);
      created.push(item.name);
    }
    await profile.setAvatar(item.avatar);
    await profile.setThemeAsync({
      themeId: "default-theme@mozilla.org",
      themeFg: item.themeFg,
      themeBg: item.themeBg,
    });
    item.path = profile.path;
    item.created = created.includes(item.name);
  }
  resolve(JSON.stringify(wanted));
})().catch(e => resolve("ARC_ERROR: " + e));
"""

# --------------------------------------------------------------------------
# Firefox profile discovery
# --------------------------------------------------------------------------

def firefox_is_running():
    result = subprocess.run(["pgrep", "-x", "firefox"], capture_output=True)
    return result.returncode == 0


def group_store_id():
    parser = configparser.ConfigParser()
    parser.optionxform = str
    parser.read(FF_PROFILES_INI, encoding="utf-8")
    for section in parser.sections():
        if parser.has_option(section, "StoreID"):
            return parser.get(section, "StoreID")
    return None


def group_profiles():
    """Read the profile group database directly. Read only."""
    store = group_store_id()
    if not store:
        return []
    db_path = os.path.join(FF_GROUPS_DIR, f"{store}.sqlite")
    if not os.path.exists(db_path):
        return []
    uri = "file:" + db_path.replace("?", "%3f").replace("#", "%23") + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    try:
        rows = connection.execute(
            "SELECT id, path, name FROM Profiles ORDER BY id").fetchall()
    finally:
        connection.close()
    return [{"id": r[0], "path": r[1], "name": r[2]} for r in rows]


def absolute_profile_path(relative):
    return relative if os.path.isabs(relative) else os.path.join(FF_ROOT, relative)


PREF_LINE = re.compile(r'^user_pref\(\s*"([^"]+)"\s*,\s*(.+?)\s*\);\s*$')


def read_prefs_js(profile_dir):
    path = os.path.join(profile_dir, "prefs.js")
    prefs = {}
    if not os.path.exists(path):
        return prefs
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            match = PREF_LINE.match(line.strip())
            if not match:
                continue
            name, raw = match.group(1), match.group(2)
            try:
                prefs[name] = json.loads(raw)
            except ValueError:
                continue
    return prefs


def wanted_pref(name):
    if any(name.startswith(bad) for bad in CAPTURE_EXCLUDE):
        return False
    if any(part in name for part in CAPTURE_EXCLUDE_PARTS):
        return False
    return any(name.startswith(good) for good in CAPTURE_PREFIXES)


def drop_import_button(prefs):
    """Firefox puts an "Import bookmarks" button on the toolbar of a new
    profile. This script fills the toolbar itself, so the button is removed."""
    name = "browser.uiCustomization.state"
    raw = prefs.get(name)
    if not isinstance(raw, str):
        return prefs
    try:
        state = json.loads(raw)
    except ValueError:
        return prefs
    placements = state.get("placements", {})
    for area, widgets in placements.items():
        if isinstance(widgets, list) and "import-button" in widgets:
            placements[area] = [w for w in widgets if w != "import-button"]
    prefs[name] = json.dumps(state, separators=(",", ":"))
    return prefs


def profile_extensions(profile_dir):
    """XPI files of the normal extensions in a profile. Themes are left out."""
    ext_dir = os.path.join(profile_dir, "extensions")
    if not os.path.isdir(ext_dir):
        return []
    themes = set()
    manifest = os.path.join(profile_dir, "extensions.json")
    if os.path.exists(manifest):
        try:
            with open(manifest, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except ValueError:
            data = {}
        for addon in data.get("addons", []):
            if addon.get("type") == "theme":
                themes.add(addon.get("id"))
    found = []
    for entry in sorted(os.listdir(ext_dir)):
        if not entry.endswith(".xpi"):
            continue
        addon_id = entry[:-4]
        if addon_id in themes or addon_id.endswith("@mozilla.org"):
            continue
        found.append(os.path.join(ext_dir, entry))
    return found


def template_profile_path(name_or_path):
    if os.path.isdir(name_or_path):
        return os.path.abspath(name_or_path)
    for profile in group_profiles():
        if profile["name"].lower() == name_or_path.lower():
            return absolute_profile_path(profile["path"])
    known = ", ".join(p["name"] for p in group_profiles()) or "none"
    raise SystemExit(f'Template profile "{name_or_path}" not found. '
                     f"Known profiles: {known}")


def store_extension(xpi_path):
    """Copy an XPI into the local store and return the stored path."""
    os.makedirs(EXTENSION_STORE, exist_ok=True)
    target = os.path.join(EXTENSION_STORE, os.path.basename(xpi_path))
    if os.path.abspath(xpi_path) == os.path.abspath(target):
        return target
    shutil.copy2(xpi_path, target)
    return target


def previous_extensions(defaults_path):
    if not os.path.exists(defaults_path):
        return []
    try:
        with open(defaults_path, "r", encoding="utf-8") as fh:
            return json.load(fh).get("extensions", [])
    except ValueError:
        return []


def do_capture(template, defaults_path, force=False):
    if firefox_is_running() and not force:
        raise SystemExit("Firefox is running. Quit Firefox, then run capture. "
                         "Firefox writes prefs.js when it closes, so a running "
                         "Firefox can hide your latest settings. Add --force to "
                         "read the file as it is now.")
    path = template_profile_path(template)
    prefs = {name: value for name, value in read_prefs_js(path).items()
             if wanted_pref(name)}

    prefs = drop_import_button(prefs)

    # Keep the exclusions of an earlier defaults file. Without this, every
    # capture puts an extension back that you took out by hand.
    excluded = []
    if os.path.exists(defaults_path):
        try:
            with open(defaults_path, "r", encoding="utf-8") as fh:
                excluded = json.load(fh).get("_exclude_extensions", [])
        except ValueError:
            excluded = []
    blocked = lambda item: any(rule.lower() in item.lower() for rule in excluded)

    wanted = [xpi for xpi in profile_extensions(path) if not blocked(xpi)]
    skipped = [xpi for xpi in profile_extensions(path) if blocked(xpi)]
    extensions = [store_extension(xpi) for xpi in wanted]

    # Keep extensions that an earlier defaults file added by hand.
    for xpi in previous_extensions(defaults_path):
        if blocked(xpi):
            continue
        if os.path.basename(xpi) in {os.path.basename(k) for k in extensions}:
            continue
        if os.path.exists(xpi):
            extensions.append(store_extension(xpi))
    chosen = {os.path.basename(name) for name in extensions}
    available = []
    for profile in group_profiles():
        other = absolute_profile_path(profile["path"])
        if os.path.normpath(other) == os.path.normpath(path):
            continue
        for xpi in profile_extensions(other):
            if os.path.basename(xpi) not in chosen:
                available.append(xpi)
                chosen.add(os.path.basename(xpi))
    for xpi in skipped:
        if os.path.basename(xpi) not in chosen:
            available.append(xpi)
            chosen.add(os.path.basename(xpi))

    files = [name for name in TEMPLATE_FILES
             if os.path.exists(os.path.join(path, name))]

    document = {
        "_source_profile": path,
        "_note": "Edit this file to change what every new profile gets. "
                 "Remove a pref to keep the Firefox default. Move a path from "
                 "_available_extensions into extensions to install it too.",
        "prefs": BUILTIN_PREFS | prefs | REQUIRED_PREFS,
        "extensions": extensions,
        "_available_extensions": available,
        "_exclude_extensions": excluded,
        "copy_files": files,
    }
    with open(defaults_path, "w", encoding="utf-8") as fh:
        json.dump(document, fh, indent=2, ensure_ascii=False)

    print(f"Template profile: {path}")
    print(f"  prefs captured : {len(prefs)} (plus {len(BUILTIN_PREFS) + len(REQUIRED_PREFS)} built in)")
    for name in extensions:
        print(f"  extension      : {os.path.basename(name)}")
    for name in available:
        reason = "excluded" if blocked(name) else "not selected"
        print(f"  {reason:<15}: {os.path.basename(name)} "
              f"(in {os.path.basename(os.path.dirname(os.path.dirname(name)))})")
    for name in files:
        print(f"  file to copy   : {name}")
    print(f"\nWritten to {defaults_path}")
    print("Check the file, then run: python3 arc2firefox.py migrate")


def load_defaults(defaults_path):
    if not os.path.exists(defaults_path):
        return {"prefs": BUILTIN_PREFS | REQUIRED_PREFS, "extensions": [],
                "copy_files": [], "_source_profile": None}
    with open(defaults_path, "r", encoding="utf-8") as fh:
        document = json.load(fh)
    document.setdefault("prefs", {})
    document["prefs"] = BUILTIN_PREFS | document["prefs"] | REQUIRED_PREFS
    document.setdefault("extensions", [])
    document.setdefault("copy_files", [])
    return document


def copy_template_files(source_profile, target_profile, names):
    copied = []
    for name in names:
        source = os.path.join(source_profile, name)
        target = os.path.join(target_profile, name)
        if not os.path.exists(source) or os.path.exists(target):
            continue
        if os.path.isdir(source):
            shutil.copytree(source, target)
        else:
            shutil.copy2(source, target)
        copied.append(name)
    return copied


def repair_profiles_ini():
    """Rewrite profiles.ini so Firefox can read every profile.

    Firefox reads the sections Profile0, Profile1, ... and stops at the first
    number that is missing. A gap therefore hides every later profile, and
    Firefox reports "Your Firefox profile cannot be loaded". This function
    rebuilds the file:

    - it drops an entry whose directory is gone,
    - it writes back a profile that is in the profile group but not in the file,
    - it numbers the entries from Profile0 without a gap,
    - it points the install default at a profile that exists.
    """
    parser = configparser.ConfigParser()
    parser.optionxform = str
    parser.read(FF_PROFILES_INI, encoding="utf-8")

    entries, removed, names = [], [], set()
    for section in parser.sections():
        if not section.startswith("Profile"):
            continue
        fields = dict(parser.items(section))
        path = fields.get("Path", "")
        if path and not os.path.isdir(absolute_profile_path(path)):
            removed.append(fields.get("Name", section))
            continue
        entries.append(fields)
        names.add(fields.get("Name", ""))

    store = group_store_id()
    listed = {entry.get("Path", "") for entry in entries}
    added = []
    for profile in group_profiles():
        if profile["path"] in listed:
            continue
        name, suffix = profile["name"], 1
        while name in names:
            suffix += 1
            name = f"{profile['name']} {suffix}"
        names.add(name)
        fields = {"Name": name, "IsRelative": "1", "Path": profile["path"]}
        if store:
            fields["StoreID"] = store
        entries.append(fields)
        added.append(name)

    # Show the profile selector at startup. With several profiles you must pick.
    selector = []
    for entry in entries:
        if "StoreID" in entry and entry.get("ShowSelector") != "1":
            entry["ShowSelector"] = "1"
            selector.append(entry.get("Name", "?"))

    available = {entry.get("Path", "") for entry in entries}
    fallback = ""
    for profile in group_profiles():
        if profile["path"] in available:
            fallback = profile["path"]
            break
    if not fallback and entries:
        fallback = entries[0].get("Path", "")

    repointed = []
    for section in parser.sections():
        if not section.startswith("Install"):
            continue
        current = parser.get(section, "Default", fallback="")
        if current in available or not fallback:
            continue
        parser.set(section, "Default", fallback)
        repointed.append(f"{section} -> {fallback}")

    rebuilt = configparser.ConfigParser()
    rebuilt.optionxform = str
    if parser.has_section("General"):
        rebuilt.add_section("General")
        for key, value in parser.items("General"):
            rebuilt.set("General", key, value)
    for index, entry in enumerate(entries):
        section = f"Profile{index}"
        rebuilt.add_section(section)
        for key in ("Name", "IsRelative", "Path", "StoreID", "ShowSelector",
                    "Default"):
            if key in entry:
                rebuilt.set(section, key, entry[key])
    for section in parser.sections():
        if not section.startswith("Install"):
            continue
        rebuilt.add_section(section)
        for key, value in parser.items(section):
            rebuilt.set(section, key, value)

    with open(FF_PROFILES_INI, "w", encoding="utf-8") as fh:
        rebuilt.write(fh, space_around_delimiters=False)
    if repointed:
        write_installs_ini(fallback)
    return {"added": added, "removed": removed,
            "repointed": repointed, "selector": selector}


def write_installs_ini(default_path):
    """installs.ini names the default too. Keep it in step with profiles.ini."""
    path = os.path.join(FF_ROOT, "installs.ini")
    if not default_path or not os.path.exists(path):
        return
    parser = configparser.ConfigParser()
    parser.optionxform = str
    parser.read(path, encoding="utf-8")
    changed = False
    for section in parser.sections():
        if parser.has_option(section, "Default"):
            parser.set(section, "Default", default_path)
            changed = True
    if changed:
        with open(path, "w", encoding="utf-8") as fh:
            parser.write(fh, space_around_delimiters=False)


def driver_profile_path():
    """Any profile that belongs to the group can create new profiles."""
    profiles = group_profiles()
    if not profiles:
        raise SystemExit(
            "No Firefox profile group found. Open Firefox, create one profile "
            "through the profile manager, then run this script again.")
    return absolute_profile_path(profiles[0]["path"])


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------

def select_spaces(spaces, only, skip):
    chosen = spaces
    if only:
        wanted = {name.lower() for name in only}
        chosen = [s for s in chosen
                  if s["title"].lower() in wanted
                  or s["profile_name"].lower() in wanted]
    if skip:
        unwanted = {name.lower() for name in skip}
        chosen = [s for s in chosen
                  if s["title"].lower() not in unwanted
                  and s["profile_name"].lower() not in unwanted]
    if not chosen:
        raise SystemExit("No spaces selected.")
    return chosen


def do_plan(spaces):
    existing = {p["name"]: p for p in group_profiles()}
    print(f"{'Arc space':<20} {'Firefox profile':<20} {'pinned':>7}"
          f"{'groups':>7}{'in groups':>10}{'tabs':>6}  action")
    print("-" * 82)
    for space in spaces:
        pinned, groups, grouped, loose = layout_counts(space_layout(space))
        action = "reuse existing" if space["profile_name"] in existing else "create"
        print(f'{space["title"]:<20} {space["profile_name"]:<20} '
              f'{pinned:>7}{groups:>7}{grouped:>10}{loose:>6}  {action}')
    print("\nExisting Firefox profiles in the group:")
    for profile in existing.values():
        print(f'  {profile["name"]:<20} {profile["path"]}')


def warm_tabs(profile_path, port, seconds):
    """Load the tabs once so Firefox stores their site icons.

    Firefox shows a plain globe for a tab it has never loaded. One pass fixes
    that for good. Afterwards the profile loads a tab only when you click it.
    """
    seen, total = 0, 0
    with FirefoxSession(profile_path, port) as client:
        client.script(CLEAN_TABS, [])
        deadline = time.time() + seconds
        while time.time() < deadline:
            time.sleep(5)
            status = json.loads(client.script(TAB_ICON_STATUS, []))
            seen, total = status["withIcon"], status["total"]
            if seen >= total - 1:
                break
        client.script(APPLY_SETTINGS, [json.dumps({"prefs": {
            "browser.sessionstore.restore_on_demand": True,
            "browser.sessionstore.restore_pinned_tabs_on_demand": True}})])
        client.script(CLEAN_TABS, [])
    return seen, total


def do_migrate(spaces, port, force, defaults, screenshot_dir,
               outdir=DEFAULT_EXPORT, warm_seconds=60):
    if firefox_is_running():
        raise SystemExit("Firefox is running. Quit Firefox, then run migrate.")

    shutil.copy2(FF_PROFILES_INI, FF_PROFILES_INI + ".arc2firefox-backup")
    store = group_store_id()
    if store:
        db = os.path.join(FF_GROUPS_DIR, f"{store}.sqlite")
        if os.path.exists(db):
            shutil.copy2(db, db + ".arc2firefox-backup")
    print("Backed up profiles.ini and the profile group database.")

    wanted = [{"name": s["profile_name"], "avatar": s["avatar"],
               "themeFg": s["theme_fg"], "themeBg": s["theme_bg"]}
              for s in spaces]

    driver = driver_profile_path()
    print(f"Creating profiles with driver profile: {os.path.basename(driver)}")
    with FirefoxSession(driver, port) as client:
        result = json.loads(client.script(CREATE_PROFILES, [json.dumps(wanted)]))
    by_name = {item["name"]: item for item in result}
    for item in result:
        state = "created" if item.get("created") else "existing"
        print(f'  {item["name"]:<20} {state:<9} {item["path"]}')
    fixed = repair_profiles_ini()
    for name in fixed["added"]:
        print(f"  {name:<20} entry put back into profiles.ini")
    for name in fixed["removed"]:
        print(f"  {name:<20} stale entry removed from profiles.ini")
    for note in fixed["repointed"]:
        print(f"  default profile repointed: {note}")

    template = defaults.get("_source_profile")
    extensions = [path for path in defaults["extensions"] if os.path.exists(path)]
    for path in defaults["extensions"]:
        if not os.path.exists(path):
            print(f"  warning: extension file not found, skipped: {path}")

    prefs = dict(defaults["prefs"])
    # The warm-up pass needs every tab to load once. It turns both prefs back
    # on when it finishes, so the profile then loads a tab only on a click.
    prefs["browser.sessionstore.restore_on_demand"] = warm_seconds <= 0
    prefs["browser.sessionstore.restore_pinned_tabs_on_demand"] = warm_seconds <= 0

    print("\nWriting profiles")
    for space in spaces:
        target = by_name[space["profile_name"]]
        path = absolute_profile_path(target["path"])
        name = space["profile_name"]

        copied = []
        if template and os.path.isdir(template) and defaults["copy_files"]:
            copied = copy_template_files(template, path, defaults["copy_files"])

        job = space_layout(space)

        with FirefoxSession(path, port) as client:
            marker = json.loads(client.script(READ_MARKER, []))
            if marker["space"] and not force:
                print(f'  {name:<20} skipped, already holds '
                      f'"{marker["space"]}" (use --force to write it again)')
                continue
            installed = []
            for xpi in extensions:
                try:
                    client.command("Addon:Install",
                                   {"path": xpi, "temporary": False})
                    installed.append(os.path.basename(xpi))
                except RuntimeError as error:
                    print(f"  {name:<20} extension failed: "
                          f"{os.path.basename(xpi)} ({error})")
            settings = json.loads(
                client.script(APPLY_SETTINGS, [json.dumps({"prefs": prefs})]))
            outcome = json.loads(client.script(SET_SESSION, [json.dumps(job)]))
            client.script(WRITE_MARKER, [json.dumps({"space": space["title"]})])
            client.script(CLEAN_TABS, [])

        print(f"  {name:<20} {settings['prefs']} prefs, "
              f"{len(installed)} extensions, {len(copied)} files, "
              f"{outcome['pinned']} pinned tabs, {outcome['total']} tabs")
        for label in outcome["groups"]:
            print(f"  {'':<20} group {label}")

        if warm_seconds > 0:
            seen, total = warm_tabs(path, port, warm_seconds)
            print(f"  {name:<20} warm-up: {seen} of {total} tabs "
                  f"show their site icon")

        if screenshot_dir:
            os.makedirs(screenshot_dir, exist_ok=True)
            shot = os.path.join(screenshot_dir, f"{space['stem']}.png")
            with FirefoxSession(path, port) as client:
                time.sleep(3)
                client.script(CLEAN_TABS, [])
                data = client.command("WebDriver:TakeScreenshot",
                                      {"full": True, "hash": False})
                raw = data.get("value") if isinstance(data, dict) else data
                with open(shot, "wb") as fh:
                    fh.write(base64.b64decode(raw))
            print(f"  {name:<20} screenshot: {shot}")

    fixed = repair_profiles_ini()
    for name in fixed["added"]:
        print(f"\nprofiles.ini: entry put back for {name}")
    for name in fixed["removed"]:
        print(f"profiles.ini: stale entry removed for {name}")
    for note in fixed["repointed"]:
        print(f"profiles.ini: default profile repointed, {note}")

    print("\nDone. Start Firefox and pick a profile.")


def migrated_profiles():
    """Group profiles that this script has filled, by the marker pref."""
    found = []
    for profile in group_profiles():
        path = absolute_profile_path(profile["path"])
        space = read_prefs_js(path).get("arc2firefox.space")
        if space:
            found.append({"name": profile["name"], "path": path, "space": space})
    return found


def do_prune(defaults, port):
    """Remove the excluded extensions from every profile already migrated."""
    if firefox_is_running():
        raise SystemExit("Firefox is running. Quit Firefox, then run prune.")
    rules = defaults.get("_exclude_extensions") or []
    if not rules:
        raise SystemExit('No rules in "_exclude_extensions" of the settings file.')
    targets = migrated_profiles()
    if not targets:
        raise SystemExit("No migrated profile found.")

    print(f"Rules: {', '.join(rules)}")
    for target in targets:
        with FirefoxSession(target["path"], port) as client:
            before = json.loads(client.script(LIST_ADDONS, []))
            result = json.loads(client.script(UNINSTALL_ADDONS, [json.dumps(rules)]))
            client.script(CLEAN_TABS, [])
            after = json.loads(client.script(LIST_ADDONS, []))
        removed = ", ".join(result["removed"]) or "nothing to remove"
        print(f'  {target["name"]:<20} removed: {removed}')
        print(f'  {"":<20} left: '
              f'{", ".join(a["name"] for a in after) or "no extensions"}'
              f' (was {len(before)})')
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command",
                        choices=["export", "plan", "capture", "migrate",
                                 "prune"])
    parser.add_argument("--sidebar", default=ARC_SIDEBAR)
    parser.add_argument("--outdir", default=DEFAULT_EXPORT)
    parser.add_argument("--only", action="append",
                        help="Migrate this space only. Repeatable.")
    parser.add_argument("--skip", action="append",
                        help="Do not migrate this space. Repeatable.")
    parser.add_argument("--no-favorites", action="store_true",
                        help="Leave out the Arc favourites row.")
    parser.add_argument("--port", type=int, default=2830)
    parser.add_argument("--force", action="store_true",
                        help="Write again into a profile that was already filled.")
    parser.add_argument("--template", default="Sitowise",
                        help="Profile that capture reads the settings from. "
                             "Give a profile name or a directory path.")
    parser.add_argument("--defaults", default=DEFAULTS_FILE,
                        help="Settings file that migrate applies.")
    parser.add_argument("--no-defaults", action="store_true",
                        help="Apply the built-in prefs only. No extensions, "
                             "no template files.")
    parser.add_argument("--screenshot-dir",
                        help="Save a picture of each finished profile window.")
    parser.add_argument("--warm-seconds", type=int, default=60,
                        help="Seconds to load the tabs once, so they show "
                             "their site icon. 0 turns the pass off.")
    args = parser.parse_args()

    if not os.path.exists(FIREFOX):
        raise SystemExit(f"Firefox not found at {FIREFOX}")

    if args.command == "capture":
        do_capture(args.template, args.defaults, args.force)
        return 0

    if args.command == "prune":
        return do_prune(load_defaults(args.defaults), args.port)

    spaces = read_spaces(args.sidebar, include_favorites=not args.no_favorites)
    spaces = select_spaces(spaces, args.only, args.skip)

    if args.command == "export":
        do_export(spaces, args.outdir)
    elif args.command == "plan":
        do_plan(spaces)
        defaults = load_defaults(args.defaults)
        source = defaults.get("_source_profile")
        print(f"\nSettings file: {args.defaults}"
              f"{'' if os.path.exists(args.defaults) else ' (missing, built-in prefs only)'}")
        print(f"  template profile : {source or 'none'}")
        print(f"  prefs to apply   : {len(defaults['prefs'])}")
        print(f"  extensions       : {len(defaults['extensions'])}")
        print(f"  files to copy    : {len(defaults['copy_files'])}")
    else:
        defaults = ({"prefs": BUILTIN_PREFS | REQUIRED_PREFS, "extensions": [],
                     "copy_files": [], "_source_profile": None}
                    if args.no_defaults else load_defaults(args.defaults))
        do_export(spaces, args.outdir)
        print()
        do_migrate(spaces, args.port, args.force, defaults,
                   args.screenshot_dir, args.outdir, args.warm_seconds)
    return 0


if __name__ == "__main__":
    sys.exit(main())
