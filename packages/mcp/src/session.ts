import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DocumentStore, createDocument, deserialize, serialize } from "@openbone/core";
import type { OpenBoneDocument } from "@openbone/core";

/** One open project: the store plus where it lives on disk. */
export class ProjectSession {
  store = new DocumentStore(createDocument("Untitled"));
  filePath: string | null = null;
  autosave = true;

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
