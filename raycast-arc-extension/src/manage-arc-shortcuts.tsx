import {
  Action,
  ActionPanel,
  Alert,
  Clipboard,
  Form,
  Icon,
  List,
  Toast,
  confirmAlert,
  showToast,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { WorkspaceTabMapping } from "./lib/arc";
import {
  addShortcut,
  deleteShortcut,
  exportShortcutsJSON,
  loadShortcuts,
  mergeShortcuts,
  parseShortcuts,
  saveShortcuts,
  updateShortcut,
} from "./lib/storage";

export default function Command() {
  const [shortcuts, setShortcuts] = useState<WorkspaceTabMapping[] | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const data = await loadShortcuts();
      setShortcuts(data);
      setIsLoading(false);
    })();
  }, []);

  async function handleAdd(input: Omit<WorkspaceTabMapping, "id">) {
    const created = await addShortcut(input);
    setShortcuts((prev) =>
      Array.isArray(prev) ? [...prev, created] : [created],
    );
    await showToast({ style: Toast.Style.Success, title: "Shortcut added" });
  }

  async function handleEdit(updated: WorkspaceTabMapping) {
    await updateShortcut(updated);
    setShortcuts(
      (prev) =>
        prev?.map((s) => (s.id === updated.id ? updated : s)) ?? [updated],
    );
    await showToast({ style: Toast.Style.Success, title: "Shortcut updated" });
  }

  async function handleDelete(id: string) {
    const ok = await confirmAlert({
      title: "Delete Shortcut?",
      message: "This cannot be undone.",
      primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
    });
    if (!ok) return;
    await deleteShortcut(id);
    setShortcuts((prev) => prev?.filter((s) => s.id !== id) ?? []);
    await showToast({ style: Toast.Style.Success, title: "Shortcut deleted" });
  }

  async function handleExport() {
    const json = exportShortcutsJSON(shortcuts ?? []);
    await Clipboard.copy(json);
    await showToast({
      style: Toast.Style.Success,
      title: "Exported to clipboard",
    });
  }

  async function handleImportFromClipboard() {
    const text = await Clipboard.readText();
    if (!text) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Clipboard is empty",
      });
      return;
    }
    const incoming = parseShortcuts(text);
    if (incoming.length === 0) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Nothing to import",
        message: "Make sure clipboard contains valid JSON",
      });
      return;
    }
    const merged = mergeShortcuts(shortcuts ?? [], incoming);
    await saveShortcuts(merged);
    setShortcuts(merged);
    await showToast({
      style: Toast.Style.Success,
      title: `Imported ${incoming.length} shortcut${incoming.length === 1 ? "" : "s"}`,
    });
  }

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search shortcuts..."
      actions={
        <ActionPanel>
          <Action.Push
            icon={Icon.Plus}
            title="Add Shortcut"
            target={<ShortcutForm onSubmit={handleAdd} />}
          />
        </ActionPanel>
      }
    >
      <List.EmptyView
        title="No shortcuts yet"
        description="Add your first Arc workspace-tab shortcut"
        actions={
          <EmptyActions onAdd={handleAdd} onImport={handleImportFromClipboard} />
        }
      />
      {shortcuts?.map((s) => (
        <List.Item
          key={s.id}
          title={s.alias}
          subtitle={`${s.workspaceName} → Tab #${s.tab.selector.index}`}
          accessories={[
            ...(s.keywords && s.keywords.length > 0
              ? [{ text: s.keywords.join(", ") }]
              : []),
          ]}
          actions={
            <ActionPanel>
              <Action.Push
                icon={Icon.Plus}
                title="Add Shortcut"
                target={<ShortcutForm onSubmit={handleAdd} />}
              />
              <Action.Push
                icon={Icon.Pencil}
                title="Edit Shortcut"
                target={
                  <ShortcutForm
                    shortcut={s}
                    onSubmit={(v) => handleEdit({ ...s, ...v })}
                  />
                }
              />
              <Action
                icon={Icon.Trash}
                title="Delete Shortcut"
                style={Action.Style.Destructive}
                onAction={() => handleDelete(s.id!)}
                shortcut={{ modifiers: ["cmd"], key: "delete" }}
              />
              <ActionPanel.Section>
                <Action
                  icon={Icon.Clipboard}
                  title="Export Shortcuts to Clipboard"
                  onAction={handleExport}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "e" }}
                />
                <Action
                  icon={Icon.Clipboard}
                  title="Import Shortcuts from Clipboard"
                  onAction={handleImportFromClipboard}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "i" }}
                />
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

function EmptyActions({
  onAdd,
  onImport,
}: {
  onAdd: (v: Omit<WorkspaceTabMapping, "id">) => void;
  onImport: () => void;
}) {
  return (
    <ActionPanel>
      <Action.Push
        icon={Icon.Plus}
        title="Add Shortcut"
        target={<ShortcutForm onSubmit={onAdd} />}
      />
      <Action
        icon={Icon.Clipboard}
        title="Import Shortcuts from Clipboard"
        onAction={onImport}
      />
    </ActionPanel>
  );
}

function ShortcutForm({
  shortcut,
  onSubmit,
}: {
  shortcut?: WorkspaceTabMapping;
  onSubmit: (v: Omit<WorkspaceTabMapping, "id">) => void;
}) {
  const [alias, setAlias] = useState(shortcut?.alias ?? "");
  const [workspaceName, setWorkspaceName] = useState(
    shortcut?.workspaceName ?? "",
  );
  const [tabIndex, setTabIndex] = useState(
    String(shortcut?.tab.selector.index ?? ""),
  );
  const [keywords, setKeywords] = useState(
    shortcut?.keywords?.join(", ") ?? "",
  );

  function handleSubmit() {
    if (!alias.trim() || !workspaceName.trim() || !tabIndex.trim()) {
      showToast({
        style: Toast.Style.Failure,
        title: "Required fields missing",
        message: "Alias, workspace name, and tab index are required",
      });
      return;
    }

    const parsedIndex = parseInt(tabIndex, 10);

    if (isNaN(parsedIndex) || parsedIndex < 1) {
      showToast({
        style: Toast.Style.Failure,
        title: "Invalid index",
        message: "Tab index must be a positive number",
      });
      return;
    }

    const keywordsArray = keywords
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    onSubmit({
      alias: alias.trim(),
      workspaceName: workspaceName.trim(),
      tab: {
        selector: {
          index: parsedIndex,
        },
      },
      keywords: keywordsArray,
    });
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={shortcut ? "Save Changes" : "Add Shortcut"}
            onSubmit={handleSubmit}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="alias"
        title="Alias"
        value={alias}
        onChange={setAlias}
        placeholder="e.g., Gmail Work"
        autoFocus
      />
      <Form.TextField
        id="workspaceName"
        title="Workspace Name"
        value={workspaceName}
        onChange={setWorkspaceName}
        placeholder="e.g., Work"
      />
      <Form.TextField
        id="tabIndex"
        title="Tab Index"
        value={tabIndex}
        onChange={setTabIndex}
        placeholder="e.g., 1 (for first tab), 2 (for second tab)"
      />
      <Form.TextField
        id="keywords"
        title="Keywords (optional)"
        value={keywords}
        onChange={setKeywords}
        placeholder="e.g., email, mail, inbox (comma-separated)"
      />
      <Form.Description
        title="Info"
        text={`This shortcut will open pinned tab #${tabIndex} in the "${workspaceName}" workspace using keyboard shortcut.`}
      />
    </Form>
  );
}
