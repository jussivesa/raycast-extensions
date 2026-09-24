// Firefox Link Chooser: a default-browser app that asks which Firefox profile opens a link.
//
// Firefox shows its own profile selector only when a new Firefox process starts and the
// default profile is not running. When the default profile runs, every link goes to it.
// This app receives the link instead, shows the profiles of the Firefox profile group and
// gives the link to the profile you select.

import AppKit
import SQLite3
import UniformTypeIdentifiers

let firefoxBundleID = "org.mozilla.firefox"
let lastProfileKey = "lastProfilePath"

struct FirefoxProfile {
    let name: String
    /// Absolute profile directory.
    let path: String
    let background: NSColor?
    let foreground: NSColor?
}

// MARK: - Profile data

enum FirefoxProfileStore {
    static let root = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Firefox")

    /// Read an INI file into its sections, in file order.
    static func readIni(_ name: String) -> [(section: String, values: [String: String])] {
        guard let text = try? String(contentsOf: root.appendingPathComponent(name), encoding: .utf8) else {
            return []
        }
        var sections: [(section: String, values: [String: String])] = []
        for rawLine in text.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("[") && line.hasSuffix("]") {
                sections.append((String(line.dropFirst().dropLast()), [:]))
            } else if let equals = line.firstIndex(of: "="), !sections.isEmpty {
                let key = String(line[..<equals])
                let value = String(line[line.index(after: equals)...])
                sections[sections.count - 1].values[key] = value
            }
        }
        return sections
    }

    static func absolutePath(_ path: String, relative: Bool = true) -> String {
        relative ? root.appendingPathComponent(path).standardizedFileURL.path : path
    }

    /// Profile directory that Firefox starts when no profile is given.
    static func installDefaultPath() -> String? {
        for entry in readIni("installs.ini") {
            if let path = entry.values["Default"] {
                return absolutePath(path)
            }
        }
        return nil
    }

    /// Profiles of the profile group, from the group database. Falls back to profiles.ini.
    static func load() -> [FirefoxProfile] {
        let entries = readIni("profiles.ini").filter { $0.section.hasPrefix("Profile") }
        let storeID = entries.compactMap { $0.values["StoreID"] }.first

        var profiles: [FirefoxProfile] = []
        if let storeID {
            profiles = readGroupDatabase(root.appendingPathComponent("Profile Groups/\(storeID).sqlite"))
        }
        if profiles.isEmpty {
            profiles = entries.compactMap { entry in
                guard let name = entry.values["Name"], let path = entry.values["Path"] else { return nil }
                let resolved = absolutePath(path, relative: entry.values["IsRelative"] != "0")
                return FirefoxProfile(name: name, path: resolved, background: nil, foreground: nil)
            }
        }
        return profiles.filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    private static func readGroupDatabase(_ url: URL) -> [FirefoxProfile] {
        var db: OpaquePointer?
        // Read only. Firefox holds the database open and writes to it.
        let uri = "file:\(url.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? url.path)?mode=ro"
        guard sqlite3_open_v2(uri, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil) == SQLITE_OK else {
            sqlite3_close(db)
            return []
        }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 1000)

        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT name, path, themeBg, themeFg FROM Profiles ORDER BY id", -1, &statement, nil) == SQLITE_OK else {
            return []
        }
        defer { sqlite3_finalize(statement) }

        func column(_ index: Int32) -> String {
            guard let text = sqlite3_column_text(statement, index) else { return "" }
            return String(cString: text)
        }

        var profiles: [FirefoxProfile] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            profiles.append(FirefoxProfile(
                name: column(0),
                path: absolutePath(column(1)),
                background: parseColor(column(2)),
                foreground: parseColor(column(3))))
        }
        return profiles
    }

    /// Parse "rgb(173,0,89)".
    static func parseColor(_ text: String) -> NSColor? {
        let numbers = text.split(whereSeparator: { !$0.isNumber }).compactMap { Double($0) }
        guard text.hasPrefix("rgb"), numbers.count >= 3 else { return nil }
        return NSColor(srgbRed: numbers[0] / 255, green: numbers[1] / 255, blue: numbers[2] / 255, alpha: 1)
    }
}

// MARK: - Firefox control

/// Opens links in one Firefox profile. A link never goes on a command line: every local
/// process can read a command line with ps, and a link can contain a token.
enum Firefox {
    /// Remoting name of Firefox (`remotingName` in the application data).
    static let program = "firefox"

    static func appURL() -> URL? {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: firefoxBundleID)
    }

    /// Name of the message port of the running instance of a profile.
    ///
    /// Same as BuildClassName in toolkit/components/remote/RemoteUtils.h. The port exists
    /// while the profile runs. Only processes of the same login session can reach it.
    static func remotePortName(for profilePath: String) -> String {
        let name = "Mozilla_\(program)_\(profilePath)_RemoteWindow"
        // macOS limits a port name to 128 characters. Firefox then uses a hash of the name.
        guard name.utf16.count > 128 else { return name }
        var hash: UInt32 = 0
        for unit in name.utf16 {
            // mozilla::HashString: golden ratio hash over the UTF-16 code units.
            hash = 0x9E37_79B9 &* (((hash << 5) | (hash >> 27)) ^ UInt32(unit))
        }
        return String(format: "Mozilla_%08x_RemoteWindow", hash)
    }

    /// Open the links in the profile, then bring its window to the front.
    ///
    /// - Profile runs: the links go to its message port, the same way a second Firefox
    ///   process gives its command line to the running instance (nsMacRemoteClient).
    ///   Firefox opens them in that instance. A link that Firefox receives in an Apple
    ///   event instead goes to the group default profile, not to the profile it was sent to.
    /// - Profile does not run: Firefox starts with "--profile <dir>" and gets the links in an
    ///   Apple event, which it reads at startup.
    ///
    /// Calls the completion with an error text for the user, or nil.
    static func open(_ urls: [URL], in profile: FirefoxProfile, completion: @escaping (String?) -> Void) {
        if let port = CFMessagePortCreateRemote(nil, remotePortName(for: profile.path) as CFString) {
            defer { CFMessagePortInvalidate(port) }
            // The first argument stands for the program path. Firefox ignores it.
            // Without links, --profiles-activate only raises the window of the profile.
            let arguments = urls.isEmpty
                ? ["", "--profiles-activate"]
                : [""] + urls.flatMap { ["-new-tab", $0.absoluteString] }
            let message: NSDictionary = ["args": arguments, "raise": true]
            guard let data = try? NSKeyedArchiver.archivedData(withRootObject: message, requiringSecureCoding: false) else {
                completion("The link could not be prepared for Firefox.")
                return
            }
            let result = CFMessagePortSendRequest(port, 0, data as CFData, 10, 0, nil, nil)
            completion(result == kCFMessagePortSuccess ? nil : "Firefox did not accept the link (error \(result)).")
            return
        }

        guard let app = appURL() else {
            completion("Firefox is not installed.")
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = ["--profile", profile.path]
        configuration.createsNewApplicationInstance = true
        configuration.activates = true

        let done: (NSRunningApplication?, Error?) -> Void = { _, error in
            DispatchQueue.main.async {
                completion(error.map { "Firefox did not start: \($0.localizedDescription)" })
            }
        }
        if urls.isEmpty {
            NSWorkspace.shared.openApplication(at: app, configuration: configuration, completionHandler: done)
        } else {
            NSWorkspace.shared.open(urls, withApplicationAt: app, configuration: configuration, completionHandler: done)
        }
    }
}

// MARK: - Chooser window

final class ChooserController: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate, NSWindowDelegate {
    private let allProfiles: [FirefoxProfile]
    private var shown: [FirefoxProfile] = []
    private let defaultPath: String?
    private(set) var urls: [URL] = []
    private let onChoice: (FirefoxProfile?) -> Void

    private let panel: NSPanel
    private let urlLabel = NSTextField(labelWithString: "")
    private let search = NSSearchField()
    private let table = NSTableView()
    private var keyMonitor: Any?
    private var finished = false

    init(profiles: [FirefoxProfile], defaultPath: String?, onChoice: @escaping (FirefoxProfile?) -> Void) {
        // The default profile comes first. The other profiles keep the Firefox order.
        allProfiles = profiles.filter { $0.path == defaultPath } + profiles.filter { $0.path != defaultPath }
        self.defaultPath = defaultPath
        self.onChoice = onChoice
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 460, height: 420),
                        styleMask: [.titled, .closable, .fullSizeContentView],
                        backing: .buffered, defer: false)
        super.init()
        buildWindow()
        applyFilter()
    }

    private func buildWindow() {
        panel.title = "Open in Firefox profile"
        panel.level = .floating
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.delegate = self

        urlLabel.lineBreakMode = .byTruncatingMiddle
        urlLabel.textColor = .secondaryLabelColor
        urlLabel.font = .systemFont(ofSize: 12)

        search.placeholderString = "Filter profiles"
        search.delegate = self
        search.sendsSearchStringImmediately = true

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("profile"))
        table.addTableColumn(column)
        table.headerView = nil
        table.rowHeight = 30
        table.style = .inset
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.doubleAction = #selector(chooseClicked)
        table.refusesFirstResponder = true

        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false

        let hint = NSTextField(labelWithString: "↑↓ select   ↩ open   ⌘1–⌘9 open directly   esc cancel")
        hint.textColor = .tertiaryLabelColor
        hint.font = .systemFont(ofSize: 11)

        let stack = NSStackView(views: [urlLabel, search, scroll, hint])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 36, left: 14, bottom: 12, right: 14)
        stack.translatesAutoresizingMaskIntoConstraints = false
        for view in [urlLabel, search, scroll] {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -28).isActive = true
        }
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 200).isActive = true

        let content = NSVisualEffectView()
        content.material = .popover
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        panel.contentView = content
    }

    func add(_ newURLs: [URL]) {
        urls.append(contentsOf: newURLs)
        switch urls.count {
        case 0: urlLabel.stringValue = "No link. Opens the profile."
        case 1: urlLabel.stringValue = urls[0].isFileURL ? urls[0].path : urls[0].absoluteString
        default: urlLabel.stringValue = "\(urls.count) links: \(urls.map(\.absoluteString).joined(separator: ", "))"
        }
    }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(search)

        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, event.modifierFlags.contains(.command),
                  let chars = event.charactersIgnoringModifiers, let digit = Int(chars), (1...9).contains(digit) else {
                return event
            }
            if digit <= self.shown.count {
                self.finish(with: self.shown[digit - 1])
            }
            return nil
        }
    }

    private func applyFilter() {
        let query = search.stringValue.trimmingCharacters(in: .whitespaces).lowercased()
        shown = query.isEmpty ? allProfiles : allProfiles.filter { $0.name.lowercased().contains(query) }
        table.reloadData()

        var row = 0
        if query.isEmpty, let last = UserDefaults.standard.string(forKey: lastProfileKey),
           let index = shown.firstIndex(where: { $0.path == last }) {
            row = index
        }
        if !shown.isEmpty {
            table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
            table.scrollRowToVisible(row)
        }
    }

    private func moveSelection(by delta: Int) {
        guard !shown.isEmpty else { return }
        let row = min(max(table.selectedRow + delta, 0), shown.count - 1)
        table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        table.scrollRowToVisible(row)
    }

    @objc private func chooseClicked() {
        let row = table.clickedRow >= 0 ? table.clickedRow : table.selectedRow
        if shown.indices.contains(row) {
            finish(with: shown[row])
        }
    }

    private func finish(with profile: FirefoxProfile?) {
        guard !finished else { return }
        finished = true
        if let keyMonitor {
            NSEvent.removeMonitor(keyMonitor)
        }
        panel.orderOut(nil)
        onChoice(profile)
    }

    // NSSearchFieldDelegate

    func controlTextDidChange(_ notification: Notification) {
        applyFilter()
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        switch selector {
        case #selector(NSResponder.moveUp(_:)): moveSelection(by: -1)
        case #selector(NSResponder.moveDown(_:)): moveSelection(by: 1)
        case #selector(NSResponder.insertNewline(_:)): chooseClicked()
        case #selector(NSResponder.cancelOperation(_:)): finish(with: nil)
        default: return false
        }
        return true
    }

    // NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        finish(with: nil)
    }

    // NSTableViewDataSource, NSTableViewDelegate

    func numberOfRows(in tableView: NSTableView) -> Int {
        shown.count
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let profile = shown[row]

        let dot = NSView()
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 7
        dot.layer?.backgroundColor = (profile.foreground ?? .systemGray).cgColor
        dot.layer?.borderColor = (profile.background ?? .clear).cgColor
        dot.layer?.borderWidth = 2
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.widthAnchor.constraint(equalToConstant: 14).isActive = true
        dot.heightAnchor.constraint(equalToConstant: 14).isActive = true

        let name = NSTextField(labelWithString: profile.name)
        name.font = .systemFont(ofSize: 13)
        name.lineBreakMode = .byTruncatingTail

        let detail = NSTextField(labelWithString: [
            profile.path == defaultPath ? "default" : nil,
            row < 9 ? "⌘\(row + 1)" : nil,
        ].compactMap { $0 }.joined(separator: "   "))
        detail.font = .systemFont(ofSize: 11)
        detail.textColor = .secondaryLabelColor
        detail.setContentHuggingPriority(.required, for: .horizontal)

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let stack = NSStackView(views: [dot, name, spacer, detail])
        stack.orientation = .horizontal
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 4, bottom: 0, right: 6)
        return stack
    }
}

// MARK: - Application

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var chooser: ChooserController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if CommandLine.arguments.contains("--set-default") {
            setAsDefaultBrowser()
            return
        }
        // Started without a link, for example from Finder: show the chooser to open a profile.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            if self?.chooser == nil {
                self?.present([])
            }
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        present(urls)
    }

    private func present(_ urls: [URL]) {
        if let chooser {
            chooser.add(urls)
            return
        }

        let profiles = FirefoxProfileStore.load()
        let defaultPath = FirefoxProfileStore.installDefaultPath()
        guard !profiles.isEmpty else {
            // No profile data. Give the links to Firefox as they are.
            if let app = Firefox.appURL(), !urls.isEmpty {
                NSWorkspace.shared.open(urls, withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration()) { _, _ in
                    DispatchQueue.main.async { NSApp.terminate(nil) }
                }
            } else {
                NSApp.terminate(nil)
            }
            return
        }

        let chooser = ChooserController(profiles: profiles, defaultPath: defaultPath) { [weak self] profile in
            guard let self, let profile else {
                NSApp.terminate(nil)
                return
            }
            UserDefaults.standard.set(profile.path, forKey: lastProfileKey)
            Firefox.open(self.chooser?.urls ?? [], in: profile) { error in
                if let error {
                    // The alert does not show the link.
                    let alert = NSAlert()
                    alert.messageText = "The link did not open"
                    alert.informativeText = error
                    NSApp.activate(ignoringOtherApps: true)
                    alert.runModal()
                }
                NSApp.terminate(nil)
            }
        }
        chooser.add(urls)
        self.chooser = chooser
        chooser.show()
    }

    /// Ask macOS to make this app the default browser. macOS shows a confirmation dialog for each change.
    private func setAsDefaultBrowser() {
        let app = Bundle.main.bundleURL
        let workspace = NSWorkspace.shared
        let group = DispatchGroup()
        for scheme in ["http", "https"] {
            group.enter()
            workspace.setDefaultApplication(at: app, toOpenURLsWithScheme: scheme) { error in
                if let error {
                    FileHandle.standardError.write(Data("\(scheme): \(error.localizedDescription)\n".utf8))
                }
                group.leave()
            }
        }
        group.enter()
        workspace.setDefaultApplication(at: app, toOpen: .html) { error in
            if let error {
                FileHandle.standardError.write(Data("html: \(error.localizedDescription)\n".utf8))
            }
            group.leave()
        }
        group.notify(queue: .main) {
            NSApp.terminate(nil)
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
