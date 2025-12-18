/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Seed OTP Pairs (optional) - Initial pairs seed. Accepts JSON array of { label, ref } or line-based format where each line is 'Label = op://.../field?attribute=otp'. Used only if no pairs are stored yet. */
  "otp_pairs_seed"?: string,
  /** 1Password CLI Path (optional) - Optional. Absolute path to the 'op' binary if Raycast can't find it in PATH (e.g., /opt/homebrew/bin/op or /usr/local/bin/op). */
  "op_path"?: string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `get-otp` command */
  export type GetOtp = ExtensionPreferences & {}
  /** Preferences accessible in the `manage-otp-pairs` command */
  export type ManageOtpPairs = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `get-otp` command */
  export type GetOtp = {}
  /** Arguments passed to the `manage-otp-pairs` command */
  export type ManageOtpPairs = {}
}

