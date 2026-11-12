import { type TextAttachment, splitFontFamilies } from "@openbone/core";
import { For, Show } from "solid-js";
import { askConfirm } from "../dialogs.tsx";
import { importFonts } from "../fonts.ts";
import { apply, doc, selection, setSelection } from "../state.ts";
import { Section, SelectField, TextField } from "./fields.tsx";

const fonts = () => doc().fonts ?? [];

let fileInput: HTMLInputElement | undefined;
/** Open the file picker for font files; resolves with the new font's id (the last one when several are picked). */
export function pickFonts(): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (!fileInput) return resolve(undefined);
    fileInput.onchange = () => {
      const files = fileInput!.files;
      if (!files?.length) return resolve(undefined);
      void importFonts(files).then((id) => {
        fileInput!.value = "";
        resolve(id);
      });
    };
    fileInput.click();
  });
}

const WEIGHT_NAMES: Record<number, string> = { 100: "Thin", 200: "Extra light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Extra bold", 900: "Black" };
const weightLabel = (w: number | undefined) => WEIGHT_NAMES[w ?? 400] ?? String(w ?? 400);

/** Text attachments (slot / name) whose font list names a family. */
function textsUsing(family: string): string[] {
  const f = family.toLowerCase();
  const d = doc();
  const out: string[] = [];
  for (const skin of d.skeleton.skins)
    for (const [slotId, atts] of Object.entries(skin.attachments))
      for (const a of Object.values(atts))
        if (a.type === "text" && splitFontFamilies((a as TextAttachment).font).some((x) => x.toLowerCase() === f))
          out.push(`${d.skeleton.slots.find((s) => s.id === slotId)?.name ?? slotId}/${a.name}`);
  return out;
}

/** Hierarchy section: the document's font files, shown in their own face. */
export function FontsSection() {
  const sel = () => selection();
  return (
    <Section
      title="Fonts"
      actions={
        <>
          <button title="Add TTF / OTF font files (WOFF2 for the web only)" onClick={() => void pickFonts()}>
            +
          </button>
          <input ref={fileInput} type="file" accept=".ttf,.otf,.woff,.woff2,font/*" multiple hidden />
        </>
      }
    >
      <For each={fonts()} fallback={<div class="muted pad">Drop TTF/OTF files on the viewport or use + to make text look the same everywhere</div>}>
        {(f) => {
          const live = () => (doc(), fonts().find((x) => x.id === f.id) ?? f);
          return (
            <div class="tree-row" classList={{ selected: sel()?.kind === "font" && sel()!.id === f.id }} onClick={() => setSelection({ kind: "font", id: f.id })} title="Font file">
              <span class="icon">𝐀</span>
              <span style={{ "font-family": `"${live().family}"`, "font-weight": String(live().weight ?? 400), "font-style": live().style ?? "normal" }}>{live().family}</span>
              <span class="muted"> {weightLabel(live().weight)}{live().style === "italic" ? " italic" : ""}</span>
            </div>
          );
        }}
      </For>
    </Section>
  );
}

export function FontInspector(p: { id: string }) {
  const f = () => (doc(), fonts().find((x) => x.id === p.id));
  return (
    <Show when={f()}>
      <Section title="Font file">
        <div class="font-sample" style={{ "font-family": `"${f()!.family}"`, "font-weight": String(f()!.weight ?? 400), "font-style": f()!.style ?? "normal" }}>
          Aa Bb 123 · 風の丘
        </div>
        <TextField label="Family" value={f()!.family} onCommit={(v) => v && apply("updateFont", { font: p.id, family: v })} />
        <SelectField
          label="Weight"
          value={String(f()!.weight ?? 400)}
          options={Object.keys(WEIGHT_NAMES).map((w) => ({ value: w, label: `${w} ${WEIGHT_NAMES[Number(w)]}` }))}
          onCommit={(v) => apply("updateFont", { font: p.id, weight: Number(v) })}
        />
        <SelectField
          label="Style"
          value={f()!.style ?? "normal"}
          options={[
            { value: "normal", label: "Normal" },
            { value: "italic", label: "Italic" },
          ]}
          onCommit={(v) => apply("updateFont", { font: p.id, style: v as "normal" | "italic" })}
        />
        <TextField label="Name" value={f()!.name} onCommit={(v) => v && apply("updateFont", { font: p.id, name: v })} />
        <div class="hint">{f()!.src.startsWith("data:") ? "embedded in the project" : f()!.src}</div>
        <div class="hint">
          Texts whose Font lists “{f()!.family}” use this file. Used by: {textsUsing(f()!.family).join(", ") || "no text yet"}
        </div>
        <div class="btn-row">
          <button
            class="danger"
            onClick={() =>
              void askConfirm({
                title: `Delete “${f()!.name}”?`,
                message: "Texts that use this family fall back to fonts installed on each device. You can undo this.",
                confirmLabel: "Delete",
                danger: true,
              }).then((ok) => ok && apply("deleteFont", { font: p.id }) !== undefined && setSelection(null))
            }
          >
            Delete
          </button>
        </div>
      </Section>
    </Show>
  );
}
