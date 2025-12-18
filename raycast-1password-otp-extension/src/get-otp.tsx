import { Action, ActionPanel, Clipboard, List, Toast, showToast, getPreferenceValues } from "@raycast/api";
import { useEffect, useState } from "react";
import type { OtpPair } from "./lib/storage";
import { loadPairs } from "./lib/storage";
import { execFile } from "child_process";
import { promisify } from "util";
import { access } from "fs/promises";

const execFileAsync = promisify(execFile);

async function runOpVersion(opPath: string): Promise<string> {
  const { stdout } = await execFileAsync(opPath, ["--version"]);
  return stdout.toString().trim();
}

async function readOtp(opPath: string, ref: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(opPath, ["read", ref]);
    return stdout.toString().trim();
  } catch (e: any) {
    const stderr = e?.stderr?.toString?.().trim?.();
    throw new Error(stderr || e?.message || String(e));
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function getOpPath(): Promise<string> {
  const prefs = getPreferenceValues<{ op_path?: string }>();
  if (prefs?.op_path) {
    if (await fileExists(prefs.op_path)) return prefs.op_path;
  }
  const candidates = [
    "/opt/homebrew/bin/op",
    "/usr/local/bin/op",
    "/usr/bin/op",
  ];
  for (const c of candidates) {
    if (await fileExists(c)) return c;
  }
  return "op";
}

export default function Command() {
  const [pairs, setPairs] = useState<OtpPair[] | null>(null);
  const [checkingOp, setCheckingOp] = useState(true);
  const [opOk, setOpOk] = useState<boolean>(false);
  const [opPath, setOpPath] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const p = await getOpPath();
        setOpPath(p);
        var version = await runOpVersion(p);
        await showToast({ style: Toast.Style.Success, title: "1Password CLI", message: `Version: ${version}` });
        setOpOk(true);
      } catch (e: any) {
        setOpOk(false);
        await showToast({ style: Toast.Style.Failure, title: "1Password CLI not found or not available", message: "Install via Homebrew or set Preferences → 1Password CLI Path" });
      } finally {
        setCheckingOp(false);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const data = await loadPairs();
      setPairs(data);
    })();
  }, []);

  const isLoading = pairs === null || checkingOp;

  async function handleCopy(pair: OtpPair) {
    try {
      if (!opOk || !opPath) throw new Error("1Password CLI not available");
      const code = await readOtp(opPath, pair.ref);
      await Clipboard.copy(code);
      await showToast({ style: Toast.Style.Success, title: "OTP copied", message: pair.label });
    } catch (e: any) {
      await showToast({ style: Toast.Style.Failure, title: "Failed to get OTP", message: e?.message ?? String(e) });
    }
  }

  async function handlePaste(pair: OtpPair) {
    try {
      if (!opOk || !opPath) throw new Error("1Password CLI not available");
      const code = await readOtp(opPath, pair.ref);
      await Clipboard.paste(code);
      await showToast({ style: Toast.Style.Success, title: "OTP pasted", message: pair.label });
    } catch (e: any) {
      await showToast({ style: Toast.Style.Failure, title: "Failed to paste OTP", message: e?.message ?? String(e) });
    }
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search labels...">
      {Array.isArray(pairs) && pairs.length === 0 ? (
        <List.EmptyView title="No OTP pairs configured" description="Use Manage OTP Pairs to add label/ref entries." actions={<EmptyActions />} />
      ) : (
        pairs?.map((p) => (
          <List.Item
            key={p.id}
            title={p.label}
            subtitle={p.ref}
            actions={
              <ActionPanel>
                <Action title="Copy OTP" onAction={() => handleCopy(p)} />
                <Action title="Paste OTP to App" onAction={() => handlePaste(p)} />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}

function EmptyActions() {
  return (
    <ActionPanel>
      <Action title="Open Manage OTP Pairs" onAction={() => { }} />
    </ActionPanel>
  );
}
