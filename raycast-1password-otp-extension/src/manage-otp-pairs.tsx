import { Action, ActionPanel, Alert, Clipboard, Form, Icon, List, Toast, confirmAlert, showToast } from "@raycast/api";
import { useEffect, useState } from "react";
import type { OtpPair } from "./lib/storage";
import { addPair, deletePair, exportPairsJSON, loadPairs, mergePairs, parseSeed, savePairs, updatePair } from "./lib/storage";

export default function Command() {
  const [pairs, setPairs] = useState<OtpPair[] | null>(null);

  useEffect(() => {
    (async () => {
      const data = await loadPairs();
      setPairs(data);
    })();
  }, []);

  async function handleAdd(input: { label: string; ref: string }) {

    if (input.ref.endsWith("?attribute=otp") === false) {
      input.ref = input.ref + "?attribute=otp";
    }

    input.ref = input.ref.replace(/"/g, '');

    const created = await addPair(input.label, input.ref);
    setPairs((prev) => (Array.isArray(prev) ? [...prev, created] : [created]));
    await showToast({ style: Toast.Style.Success, title: "Pair added" });
  }

  async function handleEdit(updated: OtpPair) {
    await updatePair(updated);
    setPairs((prev) => prev?.map((p) => (p.id === updated.id ? updated : p)) ?? [updated]);
    await showToast({ style: Toast.Style.Success, title: "Pair updated" });
  }

  async function handleDelete(id: string) {
    const ok = await confirmAlert({ title: "Delete Pair?", message: "This cannot be undone.", primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive } });
    if (!ok) return;
    await deletePair(id);
    setPairs((prev) => prev?.filter((p) => p.id !== id) ?? []);
    await showToast({ style: Toast.Style.Success, title: "Pair deleted" });
  }

  async function handleExport() {
    const json = exportPairsJSON(pairs ?? []);
    await Clipboard.copy(json);
    await showToast({ style: Toast.Style.Success, title: "Exported to clipboard" });
  }

  async function handleImportFromClipboard() {
    const text = await Clipboard.readText();
    if (!text) {
      await showToast({ style: Toast.Style.Failure, title: "Clipboard is empty" });
      return;
    }
    const incoming = parseSeed(text);
    if (incoming.length === 0) {
      await showToast({ style: Toast.Style.Failure, title: "Nothing to import" });
      return;
    }
    const merged = mergePairs(pairs ?? [], incoming);
    await savePairs(merged);
    setPairs(merged);
    await showToast({ style: Toast.Style.Success, title: `Imported ${incoming.length} entr${incoming.length === 1 ? "y" : "ies"}` });
  }

  return (
    <List isLoading={pairs === null} searchBarPlaceholder="Search labels...">
      <List.EmptyView
        title="No pairs yet"
        description="Add your first label/reference pair. You can also paste JSON or 'Label = op://...' lines."
        actions={<EmptyActions onAdd={handleAdd} onImport={handleImportFromClipboard} />}
      />
      {pairs?.map((p) => (
        <List.Item
          key={p.id}
          title={p.label}
          subtitle={p.ref}
          actions={
            <ActionPanel>
              <Action.Push icon={Icon.Plus} title="Add Pair" target={<PairForm onSubmit={handleAdd} />} />
              <Action.Push icon={Icon.Pencil} title="Edit Pair" target={<PairForm pair={p} onSubmit={(v) => handleEdit({ ...p, ...v })} />} />
              <Action icon={Icon.Trash} title="Delete Pair" style={Action.Style.Destructive} onAction={() => handleDelete(p.id)} />
              <Action icon={Icon.Clipboard} title="Export Pairs to Clipboard" onAction={handleExport} />
              <Action icon={Icon.Clipboard} title="Import Pairs from Clipboard" onAction={handleImportFromClipboard} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

function EmptyActions({ onAdd, onImport }: { onAdd: (v: { label: string; ref: string }) => void; onImport: () => void }) {
  return (
    <ActionPanel>
      <Action.Push icon={Icon.Plus} title="Add Pair" target={<PairForm onSubmit={onAdd} />} />
      <Action icon={Icon.Clipboard} title="Import Pairs from Clipboard" onAction={onImport} />
    </ActionPanel>
  );
}

function PairForm({ pair, onSubmit }: { pair?: OtpPair; onSubmit: (v: { label: string; ref: string }) => void }) {
  const [label, setLabel] = useState(pair?.label ?? "");
  const [ref, setRef] = useState(pair?.ref ?? "");

  function handleSubmit() {
    if (!label.trim() || !ref.trim()) {
      showToast({ style: Toast.Style.Failure, title: "Label and reference are required" });
      return;
    }
    onSubmit({ label: label.trim(), ref: ref.trim() });
  }

  return (
    <Form actions={<ActionPanel><Action.SubmitForm title={pair ? "Save Changes" : "Add Pair"} onSubmit={handleSubmit} /></ActionPanel>}>
      <Form.TextField id="label" title="Label" value={label} onChange={setLabel} placeholder="e.g., Google Abc Ltd" autoFocus />
      <Form.TextField id="ref" title="OTP Reference" value={ref} onChange={setRef} placeholder="op://Vault/Item/Section/Field?attribute=otp" />
    </Form>
  );
}
