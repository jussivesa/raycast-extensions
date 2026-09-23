/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Seed Profile Mappings (optional) - Initial mappings. Use one 'Display Name = Exact Profile Name' per line, or a JSON array of { displayName, profileName, profilePath }. Read only while no mappings are stored yet. */
  "profiles_seed"?: string,
  /** Firefox Process Name - Name of the Firefox process as macOS reports it. Change this only for a non-standard build. */
  "process_name": string,
  /** Window Title Separator - Character that Firefox puts between the parts of the window title. Firefox uses an em dash. */
  "title_separator": string,
  /** Window Title Suffixes - Comma-separated title parts that are not a profile name. Firefox appends these after the profile name. Translate them if your Firefox is not in English. */
  "title_suffixes": string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `jump-to-profile` command */
  export type JumpToProfile = ExtensionPreferences & {}
  /** Preferences accessible in the `jump-to-profile-by-name` command */
  export type JumpToProfileByName = ExtensionPreferences & {}
  /** Preferences accessible in the `jump-to-last-profile` command */
  export type JumpToLastProfile = ExtensionPreferences & {}
  /** Preferences accessible in the `refresh-window-cache` command */
  export type RefreshWindowCache = ExtensionPreferences & {}
  /** Preferences accessible in the `manage-profiles` command */
  export type ManageProfiles = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `jump-to-profile` command */
  export type JumpToProfile = {}
  /** Arguments passed to the `jump-to-profile-by-name` command */
  export type JumpToProfileByName = {
  /** Display name (e.g. Work) */
  "profile": string
}
  /** Arguments passed to the `jump-to-last-profile` command */
  export type JumpToLastProfile = {}
  /** Arguments passed to the `refresh-window-cache` command */
  export type RefreshWindowCache = {}
  /** Arguments passed to the `manage-profiles` command */
  export type ManageProfiles = {}
}

