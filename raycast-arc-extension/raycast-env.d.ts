/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Tab Selection Modifier - Modifier key for tab selection shortcuts (e.g., 'command' for Cmd+Number). */
  "tab_modifier_key": string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `open-mapped` command */
  export type OpenMapped = ExtensionPreferences & {}
  /** Preferences accessible in the `open-by-alias` command */
  export type OpenByAlias = ExtensionPreferences & {}
  /** Preferences accessible in the `manage-arc-shortcuts` command */
  export type ManageArcShortcuts = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `open-mapped` command */
  export type OpenMapped = {}
  /** Arguments passed to the `open-by-alias` command */
  export type OpenByAlias = {
  /** Alias (e.g., Abc Ltd Gmail) */
  "alias": string
}
  /** Arguments passed to the `manage-arc-shortcuts` command */
  export type ManageArcShortcuts = {}
}

