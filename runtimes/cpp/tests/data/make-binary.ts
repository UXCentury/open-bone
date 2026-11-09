// Regenerates the binary test pairs: <name>.obonb (core serializeBinary) and <name>.decoded.obone (what the
// TypeScript decoder makes of it). The C++ decoder must produce exactly the same document.
//   pnpm tsx runtimes/cpp/tests/data/make-binary.ts runtimes/cpp/tests/data conformance/fixtures/interactive.obone …
import fs from "node:fs";
import path from "node:path";
import { deserialize, deserializeBinary, serialize, serializeBinary } from "@openbone/core";

const [out, ...files] = process.argv.slice(2);
for (const f of files) {
  const bytes = serializeBinary(deserialize(fs.readFileSync(f, "utf8")));
  const base = path.join(out, path.basename(f, ".obone"));
  fs.writeFileSync(`${base}.obonb`, bytes);
  fs.writeFileSync(`${base}.decoded.obone`, serialize(deserializeBinary(bytes)));
}
