## 1Password OTP (Raycast Extension)

Get One-Time Passwords (OTPs) from 1Password using known field references. Useful when a single 1Password item contains multiple OTP fields (guest access, multiple accounts, etc.).

You manage pairs of `Label` ↔ `op:// reference` in Raycast and retrieve OTPs via the 1Password CLI.

### Requirements
- 1Password CLI v2 installed and signed in
- Raycast installed
- Node.js LTS (for local typechecking)

Install 1Password CLI and sign in:

```zsh
brew install 1password-cli
op signin
```

### Commands
- Get OTP: Select a label and copy or paste its OTP
- Manage OTP Pairs: Add, edit, delete, import, and export pairs

### OTP Reference Format
Use the 1Password secret reference for your OTP field, for example:

- `op://Employee/Abc Password/Microsoft Label/one-time password label?attribute=otp`
- `op://Employee/Abc Password/Google Label/one-time password label?attribute=otp`

### Configuration
Pairs are stored in Raycast LocalStorage. You can seed them initially via a preference or import/export via the manager.

Preference seed accepts either:
1) JSON array of objects `{ label, ref }`
2) Line-based entries: `Label = op://.../field?attribute=otp`

Example (JSON):
```json
[
	{ "label": "MS Abc Ltd", "ref": "op://Employee/Abc Password/Microsoft Label/one-time password label?attribute=otp" },
	{ "label": "Google Abc Ltd", "ref": "op://Employee/Abc Password/Google Label/one-time password label?attribute=otp" }
]
```

Example (lines):
```
MS Abc Ltd = op://Employee/Abc Password/Microsoft Label/one-time password label?attribute=otp
Google Abc Ltd = op://Employee/Abc Password/Google Label/one-time password label?attribute=otp
```

### Usage
1. Open "Manage OTP Pairs" to add your pairs
2. Open "Get OTP", select a label
3. Use actions to Copy or Paste the OTP

Errors are surfaced if the `op` CLI is not installed or not signed in.

### Export / Dotfiles
From "Manage OTP Pairs" you can export current pairs as JSON to clipboard. Save it into your dotfiles and paste back to import on a new machine.

## Publishing & Store Release

### Prepare the Extension
- Update metadata in `package.json`:
	- `name`, `version`, `description`, `license`, `repository`.
	- `raycast.title`, `raycast.description`, `raycast.author`, `raycast.categories`.
	- Ensure both commands are listed in `raycast.commands` with clear titles.
- Optional assets: add icons/screenshots (e.g., in an `assets/` folder) and reference them from the README.
- Verify dev setup:
	- `npm install`
	- `npm run build`
	- Load locally in Raycast via Extensions → Developer → Add Local Extension and test both commands.

### Pre-Submission Checklist
- Handles missing or unauthenticated `op` gracefully with clear errors.
- No secrets or personal references committed to the repo.
- Clear README with setup, configuration examples, and usage.
- `@raycast/api` and `typescript` versions are up to date.
- Commands have concise names and descriptions.

### Submit to the Raycast Store (Public)
Raycast community extensions are submitted via the Raycast Extensions repository.
1) Create a public GitHub repository for your extension code and ensure it builds and runs locally.
2) Follow the publishing guide in the Raycast docs and the contribution guidelines in the Raycast Extensions repo.
3) Fork the `raycast/extensions` monorepo, add your extension under their required structure, and open a Pull Request.
4) Address review feedback; once merged, your extension will appear in the Raycast Store.

References:
- Raycast Developers: Publish an Extension (Store submission guide)
- Raycast Extensions GitHub repository (contribution and folder structure)

### Private / Team Distribution
- Keep it as a Local Extension within your team’s machines; share the repo and instruct teammates to Add Local Extension.
- If your organization uses Raycast for Teams/Private Store, follow your internal distribution process and point to this repository.

### Versioning & Releases
- Bump `version` in `package.json` for each release.
- Optionally keep a `CHANGELOG.md` summarizing user-visible changes.
- Tag releases in Git for traceability.
