import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Field and record delimiters used by the automation helpers. Window titles cannot contain them. */
const FIELD_SEPARATOR = "\u001F";
const RECORD_SEPARATOR = "\u001E";

/** One macOS window of one Firefox process. */
export interface FirefoxWindow {
  /** Process ID of the Firefox instance that owns the window. */
  pid: number;
  /** 1-based position of the window inside its process. Position 1 is the front window. */
  index: number;
  /** Window title as macOS reports it. */
  title: string;
  /** True if the window is in the Dock. */
  minimized: boolean;
}

/** One running Firefox instance. */
export interface FirefoxProcess {
  pid: number;
  /** Value of the -profile or --profile argument. Absent if Firefox started with the default profile. */
  profilePath?: string;
  /**
   * Start time of the process, in whole seconds since 1970.
   *
   * macOS gives the process ID of a stopped program to a new one. The start time tells
   * the two apart, so a stored process ID is trusted only while this value still matches.
   */
  launchTime?: number;
}

/** One process to bring to the front. The first usable candidate wins. */
export interface ActivationCandidate {
  pid: number;
  /** Value returned when this candidate is used. The caller maps it back to a profile. */
  key: string;
  /** Start time stored with the candidate. The candidate is rejected when it differs. */
  launchTime?: number;
  /** 1-based window to raise. Leave at 1 to raise the window the profile used last. */
  windowIndex?: number;
  /** Set when the window can be in the Dock. It costs one extra Accessibility read. */
  restore?: boolean;
}

export interface ActivationResult {
  /** Key of the candidate that was brought to the front. Absent when none was usable. */
  key?: string;
  pid?: number;
}

/** Raised when the automation helpers fail. Carries a message that the user can act on. */
export class FirefoxControlError extends Error {}

function describeOsascriptError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (
    message.includes("-1743") ||
    message.includes("not allowed assistive access") ||
    message.includes("-25211")
  ) {
    return "Raycast cannot control Firefox. Open System Settings > Privacy & Security > Accessibility and allow Raycast.";
  }
  if (
    message.includes("-600") ||
    message.includes("isn’t running") ||
    message.includes("isn't running")
  ) {
    return "Firefox is not running.";
  }

  const lastLine = message.trim().split("\n").pop() ?? message;
  return (
    lastLine.replace(/^execution error:\s*/i, "").trim() ||
    "The automation script failed."
  );
}

/**
 * Turn a value into a JavaScript string literal that holds its JSON form.
 *
 * osascript takes the script as text, so every input has to be written into the script.
 * JSON.stringify twice produces a literal that is safe for any profile name. The two
 * line separators are legal in JSON but not in a JavaScript literal.
 */
function jsonLiteral(value: unknown): string {
  return JSON.stringify(JSON.stringify(value))
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

async function runJxa(script: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    throw new FirefoxControlError(describeOsascriptError(error));
  }
}

/** Part of the executable path that marks a Firefox process. */
function executableMarker(processName: string): string {
  return `/Contents/MacOS/${processName.trim() || "firefox"}`;
}

/**
 * Read the running Firefox instances and the profile path each one was started with.
 *
 * Only the profile path needs ps. Every other reader uses AppKit, which answers by
 * process ID and does not scan the process list.
 */
export async function listFirefoxProcesses(
  processName = "firefox",
): Promise<FirefoxProcess[]> {
  const binary = executableMarker(processName);

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,command="], {
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch {
    return [];
  }

  const processes: FirefoxProcess[] = [];

  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;

    const command = match[2];
    if (!command.includes(binary)) continue;
    // Child processes carry the same profile argument. Keep the browser process only.
    if (/plugin-container|crashhelper|gpu-helper|-contentproc/.test(command))
      continue;

    // The profile path can contain spaces, so read up to the next argument that starts with a dash.
    const profileMatch =
      /(?:^|\s)--?profile\s+(.+?)(?=\s+-{1,2}[A-Za-z]|$)/.exec(command);

    processes.push({
      pid: Number.parseInt(match[1], 10),
      profilePath: profileMatch ? profileMatch[1].trim() : undefined,
    });
  }

  return processes;
}

/**
 * Read every Firefox process and every window in one step.
 *
 * The windows are read through the Accessibility API, which is addressed by process ID.
 * The AppleScript form, "process whose unix id is", makes System Events read the unix id
 * of every process on the machine, and it costs about 250 ms for each use. With eight
 * profiles that form needs about 2.2 s. This one needs about 0.35 s.
 *
 * Each process also reports its start time. The caller stores that value with the window
 * data, so that a later jump can check a stored process ID without a process list.
 */
export async function readFirefoxState(
  processName = "firefox",
): Promise<{ processes: FirefoxProcess[]; windows: FirefoxWindow[] }> {
  const marker = executableMarker(processName);

  const script = `ObjC.import("AppKit");
ObjC.import("ApplicationServices");
(function () {
  const marker = JSON.parse(${jsonLiteral(marker)});
  const fieldSep = String.fromCharCode(31);
  const recSep = String.fromCharCode(30);

  function axValue(element, name) {
    const out = Ref();
    if ($.AXUIElementCopyAttributeValue(element, $(name), out) !== 0) return null;
    return ObjC.castRefToObject(out[0]);
  }

  const records = [];
  // Window titles need the Accessibility permission. Report it, so that an empty
  // result can be told apart from a missing permission.
  records.push([0, -1, $.AXIsProcessTrusted() ? 1 : 0, ""].join(fieldSep));

  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (let i = 0; i < apps.count; i++) {
    const app = apps.objectAtIndex(i);
    const url = app.executableURL;
    if (url.isNil() || String(ObjC.unwrap(url.path)).indexOf(marker) === -1) continue;

    const pid = app.processIdentifier;
    const launchDate = app.launchDate;
    records.push([pid, 0, launchDate.isNil() ? 0 : Math.round(launchDate.timeIntervalSince1970), ""].join(fieldSep));

    const windows = axValue($.AXUIElementCreateApplication(pid), "AXWindows");
    if (windows === null) continue;
    const count = Number(windows.count);
    let index = 0;
    for (let j = 0; j < count; j++) {
      const window = windows.objectAtIndex(j);
      // A locked screen leaves an application element in the list. Keep real windows only.
      const role = axValue(window, "AXRole");
      if (role === null || String(ObjC.unwrap(role)) !== "AXWindow") continue;

      const title = axValue(window, "AXTitle");
      const minimized = axValue(window, "AXMinimized");
      index += 1;
      records.push([
        pid,
        index,
        ObjC.unwrap(minimized) === true ? 1 : 0,
        title === null ? "" : String(ObjC.unwrap(title))
      ].join(fieldSep));
    }
  }
  // The trailing separator turns the newline that osascript adds into an empty record.
  return records.join(recSep) + recSep;
})()`;

  // ps reads the profile paths. It runs next to the window read, not after it.
  const [stdout, fromPs] = await Promise.all([
    runJxa(script),
    listFirefoxProcesses(processName),
  ]);

  const launchTimeByPid = new Map<number, number>();
  const windows: FirefoxWindow[] = [];
  let trusted = true;

  for (const record of stdout.split(RECORD_SEPARATOR)) {
    if (record.trim().length === 0) continue;

    const [rawPid, rawIndex, rawFlag, ...titleParts] =
      record.split(FIELD_SEPARATOR);
    const pid = Number.parseInt(rawPid, 10);
    const index = Number.parseInt(rawIndex, 10);
    if (!Number.isInteger(pid) || !Number.isInteger(index)) continue;

    // Index -1 marks the permission line, index 0 a process line. Only a positive
    // index is a window.
    if (index === -1) {
      trusted = rawFlag === "1";
      continue;
    }
    if (index === 0) {
      launchTimeByPid.set(pid, Number.parseInt(rawFlag, 10) || 0);
      continue;
    }

    windows.push({
      pid,
      index,
      minimized: rawFlag === "1",
      // A title can never contain the field separator, but rejoin defensively.
      title: titleParts.join(FIELD_SEPARATOR),
    });
  }

  if (!trusted) {
    throw new FirefoxControlError(
      "Raycast cannot read the Firefox windows. Open System Settings > Privacy & Security > Accessibility and allow Raycast.",
    );
  }

  const pathByPid = new Map(
    fromPs.map((process) => [process.pid, process.profilePath]),
  );
  const processes: FirefoxProcess[] = Array.from(launchTimeByPid).map(
    ([pid, launchTime]) => ({
      pid,
      launchTime,
      profilePath: pathByPid.get(pid),
    }),
  );

  return { processes, windows };
}

/** Read every window of every Firefox process. */
export async function listFirefoxWindows(
  processName = "firefox",
): Promise<FirefoxWindow[]> {
  return (await readFirefoxState(processName)).windows;
}

/**
 * Bring the first usable candidate to the front of the screen.
 *
 * A candidate is used only while its process still runs Firefox and still has the start
 * time that was stored with it. That check replaces the ps call that the jump commands
 * made before, and it also catches a process ID that macOS gave to another program.
 *
 * "activate" raises the window the profile used last, which is the window a jump wants,
 * and it also unhides the application. The Accessibility API is used only to raise
 * another window or to take a window out of the Dock, because each of its reads costs
 * about 40 ms.
 */
export async function activateFirefoxCandidates(
  candidates: ActivationCandidate[],
  options: { processName?: string; skipFrontmost?: boolean } = {},
): Promise<ActivationResult> {
  if (candidates.length === 0) {
    return {};
  }

  const request = {
    marker: executableMarker(options.processName ?? "firefox"),
    skipFrontmost: options.skipFrontmost === true,
    candidates: candidates.map((candidate) => ({
      pid: candidate.pid,
      key: candidate.key,
      launchTime: candidate.launchTime ?? 0,
      windowIndex: candidate.windowIndex ?? 1,
      restore: candidate.restore === true,
    })),
  };

  const script = `ObjC.import("AppKit");
(function () {
  const request = JSON.parse(${jsonLiteral(request)});
  const frontPid = request.skipFrontmost
    ? $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier
    : 0;

  for (const candidate of request.candidates) {
    if (request.skipFrontmost && candidate.pid === frontPid) continue;

    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(candidate.pid);
    if (app.isNil()) continue;

    const url = app.executableURL;
    if (url.isNil() || String(ObjC.unwrap(url.path)).indexOf(request.marker) === -1) continue;

    if (candidate.launchTime > 0) {
      const launchDate = app.launchDate;
      if (launchDate.isNil()) continue;
      if (Math.abs(Math.round(launchDate.timeIntervalSince1970) - candidate.launchTime) > 1) continue;
    }

    if (candidate.windowIndex > 1 || candidate.restore) {
      ObjC.import("ApplicationServices");
      const out = Ref();
      if ($.AXUIElementCopyAttributeValue($.AXUIElementCreateApplication(candidate.pid), $("AXWindows"), out) === 0) {
        const windows = ObjC.castRefToObject(out[0]);
        if (candidate.windowIndex <= Number(windows.count)) {
          const window = windows.objectAtIndex(candidate.windowIndex - 1);
          $.AXUIElementSetAttributeValue(window, $("AXMinimized"), ObjC.wrap(false));
          $.AXUIElementPerformAction(window, $("AXRaise"));
        }
      }
    }

    app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
    return JSON.stringify({ key: candidate.key, pid: candidate.pid });
  }

  return "{}";
})()`;

  const stdout = await runJxa(script);
  try {
    return JSON.parse(stdout.trim()) as ActivationResult;
  } catch {
    throw new FirefoxControlError("The automation script failed.");
  }
}

/** Bring one window of one Firefox process to the front of the screen. */
export async function activateFirefoxWindow(
  pid: number,
  windowIndex: number,
  processName = "firefox",
): Promise<void> {
  if (
    !Number.isInteger(pid) ||
    !Number.isInteger(windowIndex) ||
    windowIndex < 1
  ) {
    throw new FirefoxControlError("Invalid window reference.");
  }

  const result = await activateFirefoxCandidates(
    [{ pid, key: String(pid), windowIndex, restore: true }],
    { processName },
  );
  if (!result.key) {
    throw new FirefoxControlError("The Firefox window is gone.");
  }
}

/** Start Firefox with one profile directory. Use it when the profile has no running window. */
export async function launchFirefoxProfile(profilePath: string): Promise<void> {
  const path = profilePath.trim();
  if (!path) {
    throw new FirefoxControlError("This mapping has no profile path.");
  }

  try {
    await execFileAsync(
      "/usr/bin/open",
      ["-n", "-a", "Firefox", "--args", "--profile", path],
      { timeout: 15_000 },
    );
  } catch (error) {
    throw new FirefoxControlError(
      error instanceof Error ? error.message : "Could not start Firefox.",
    );
  }
}
