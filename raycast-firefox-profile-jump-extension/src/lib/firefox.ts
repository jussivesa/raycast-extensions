import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Field and record delimiters used by the AppleScript helpers. Window titles cannot contain them. */
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

/** One running Firefox instance, as reported by ps. */
export interface FirefoxProcess {
  pid: number;
  /** Value of the -profile or --profile argument. Absent if Firefox started with the default profile. */
  profilePath?: string;
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
    return "Raycast cannot control System Events. Open System Settings > Privacy & Security > Accessibility and allow Raycast.";
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

async function runOsascript(
  script: string,
  language?: "JavaScript",
): Promise<string> {
  const args = language ? ["-l", language, "-e", script] : ["-e", script];
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", args, {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    throw new FirefoxControlError(describeOsascriptError(error));
  }
}

/**
 * Build the specifier for one Firefox process.
 *
 * The specifier must be repeated in full at every use. AppleScript degrades a stored
 * process or window reference to one that names the application, and every profile runs
 * an application with the same name, so a stored reference resolves to the wrong profile.
 */
function processRef(pid: number): string {
  return `(first process whose unix id is ${pid})`;
}

/** Read the running Firefox instances and the profile path each one was started with. */
export async function listFirefoxProcesses(
  processName = "firefox",
): Promise<FirefoxProcess[]> {
  const binary = `/Contents/MacOS/${processName.trim() || "firefox"}`;

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
 * Read the windows of the given processes.
 *
 * Titles and minimized states are read one list per process instead of one value per
 * window. Every extra value costs an Apple event, and a per-window loop is about three
 * times slower.
 */
export async function listWindowsOfProcesses(
  pids: number[],
): Promise<FirefoxWindow[]> {
  if (pids.length === 0) {
    return [];
  }

  // A process can stop between the ps call and this script, so each block is guarded.
  const blocks = pids
    .map(
      (pid) => `  try
    set nameList to name of every window of ${processRef(pid)}
    set minList to value of attribute "AXMinimized" of every window of ${processRef(pid)}
    repeat with j from 1 to (count of nameList)
      set winTitle to item j of nameList
      if winTitle is missing value then set winTitle to ""
      set winMinimized to "0"
      try
        if (item j of minList) is true then set winMinimized to "1"
      end try
      set out to out & "${pid}" & fieldSep & j & fieldSep & winMinimized & fieldSep & winTitle & recSep
    end repeat
  end try`,
    )
    .join("\n");

  const stdout = await runOsascript(`
set fieldSep to character id 31
set recSep to character id 30
set out to ""
tell application "System Events"
${blocks}
end tell
return out`);

  return stdout
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [pid, index, minimized, ...titleParts] =
        record.split(FIELD_SEPARATOR);
      return {
        pid: Number.parseInt(pid, 10),
        index: Number.parseInt(index, 10),
        minimized: minimized === "1",
        // A title can never contain the field separator, but rejoin defensively.
        title: titleParts.join(FIELD_SEPARATOR),
      };
    })
    .filter(
      (window) =>
        Number.isInteger(window.pid) && Number.isInteger(window.index),
    );
}

/** Read every Firefox process and every window in one step. */
export async function readFirefoxState(
  processName = "firefox",
): Promise<{ processes: FirefoxProcess[]; windows: FirefoxWindow[] }> {
  const processes = await listFirefoxProcesses(processName);
  const windows = await listWindowsOfProcesses(
    processes.map((process) => process.pid),
  );
  return { processes, windows };
}

/**
 * Process ID of the application that has the keyboard focus.
 *
 * AppKit answers this in about 60 ms. The AppleScript form, "first process whose
 * frontmost is true", asks System Events for the attribute of every process and costs
 * about 300 ms, which is too much for a hotkey.
 *
 * Undefined when the value cannot be read. The caller then treats the front
 * application as one that is not Firefox.
 */
export async function frontmostProcessId(): Promise<number | undefined> {
  try {
    const stdout = await runOsascript(
      'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier',
      "JavaScript",
    );
    const pid = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Read every window of every Firefox process. */
export async function listFirefoxWindows(
  processName = "firefox",
): Promise<FirefoxWindow[]> {
  return (await readFirefoxState(processName)).windows;
}

/**
 * Bring one Firefox window to the front of the screen and give it the keyboard focus.
 *
 * Every profile runs an application with the same name and the same bundle identifier,
 * so the process must be addressed by process ID. The tell block does that: it resolves
 * its target once and keeps the process ID. A stored process or window reference instead
 * degrades to one that names the application, and then acts on the wrong profile.
 *
 * "set frontmost" also unhides the application, so a hidden profile needs no extra step.
 */
export async function activateFirefoxWindow(
  pid: number,
  windowIndex: number,
): Promise<void> {
  if (
    !Number.isInteger(pid) ||
    !Number.isInteger(windowIndex) ||
    windowIndex < 1
  ) {
    throw new FirefoxControlError("Invalid window reference.");
  }

  await runOsascript(`
tell application "System Events"
  if (count of (every process whose unix id is ${pid})) is 0 then error "The Firefox process stopped." number 1000
  tell ${processRef(pid)}
    if (count of windows) < ${windowIndex} then error "The Firefox window was closed." number 1001
    set frontmost to true
    set wasMinimized to false
    try
      set wasMinimized to ((value of attribute "AXMinimized" of window ${windowIndex}) is true)
    end try
    if wasMinimized then
      set value of attribute "AXMinimized" of window ${windowIndex} to false
    else
      try
        perform action "AXRaise" of window ${windowIndex}
      end try
    end if
  end tell
end tell
return "ok"`);
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
