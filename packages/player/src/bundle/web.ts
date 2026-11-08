/**
 * Entry of the web player library (`openbone-player.js` / `.mjs`) shipped by the editor's Web export.
 *
 * Including it defines `<openbone-player>` (unless something already did) and exposes the API:
 *   - classic script: `window.OpenBone` = { Player, OpenBonePlayerElement, definePlayerElement, parseDocument, version }
 *   - ES module: the same names as exports.
 *
 * Built in two flavours: with the QuickJS script sandbox inlined (scripts run), or without it (smaller; documents
 * with scripts still play, their scripts are skipped with a console warning). See build.ts.
 */
import { parseDocument } from "@openbone/core";
import { OpenBonePlayerElement, definePlayerElement } from "../element.ts";
import { Player, setScriptHostFactory } from "../player.ts";
import { sandboxFactory } from "openbone:script-sandbox";

declare const __OPENBONE_VERSION__: string;
export const version = __OPENBONE_VERSION__;

setScriptHostFactory(sandboxFactory);
if (typeof customElements !== "undefined" && !customElements.get("openbone-player")) definePlayerElement();

export { OpenBonePlayerElement, Player, definePlayerElement, parseDocument };
