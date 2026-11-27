import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DocumentStore, createDocument, deserialize, serialize } from "@openbone/core";
import type { OpenBoneDocument } from "@openbone/core";

/** One open project: the store plus where it lives on disk. */
/** Ask the open editor to do something and wait for its answer. */
export interface EditorLink {
  /** True while at least one editor is connected. */
  readonly connected: boolean;
  request(task: string, args: Record<string, unknown>, o?: { onProgress?: (stage: string, p: number) => void; timeoutMs?: number }): Promise<unknown>;
}

export class ProjectSession {
  store = new DocumentStore(createDocument("Untitled"));
  filePath: string | null = null;
  autosave = true;
  /**
   * Work the connected editor does for the server (set by the live bridge): tasks that need a browser, such as tracking
   * a body in a video. Null when the bridge is off.
   */
  editor: EditorLink | null = null;
  /** Nothing has happened yet: no project created or opened, no edit. An editor that connects now keeps its scene. */
  private touched = false;

  constructor() {
    this.store.subscribe(() => {
      this.touched = true;
    });
  }

  get pristine(): boolean {
    return !this.touched && this.filePath === null;
  }

  get doc(): OpenBoneDocument {
    return this.store.doc;
  }

  get baseDir(): string {
    return this.filePath ? path.dirname(this.filePath) : process.cwd();
  }

  newProject(name: string, filePath: string | null, opts: Partial<OpenBoneDocument> = {}) {
    this.store.load(createDocument(name, opts));
    this.filePath = filePath ? path.resolve(filePath) : null;
  }

  async open(filePath: string) {
    const abs = path.resolve(filePath);
    const doc = deserialize(await readFile(abs, "utf8"));
    this.store.load(doc);
    this.filePath = abs;
  }

  async save(filePath?: string) {
    if (filePath) this.filePath = path.resolve(filePath);
    if (!this.filePath) throw new Error("No file path: pass `path` to save_project or create the project with a path");
    await writeFile(this.filePath, serialize(this.doc));
    return this.filePath;
  }

  async maybeAutosave() {
    if (this.autosave && this.filePath) await this.save();
  }

  /** Resolve an image src (data URI, URL, or path relative to the project) to something loadImage accepts. */
  async readImageSrc(src: string): Promise<Buffer | string> {
    if (src.startsWith("data:") || /^https?:/.test(src)) return src;
    return readFile(path.isAbsolute(src) ? src : path.join(this.baseDir, src));
  }
}
