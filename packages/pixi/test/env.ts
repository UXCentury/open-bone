// Pixi reads the browser environment at import time and when compiling shader programs; give Node the little
// it looks at (no WebGL: shaders are built but never compiled in these tests).
const g = globalThis as Record<string, unknown>;
g.navigator ??= { userAgent: "node", gpu: undefined };
g.document ??= { createElement: () => ({ getContext: () => null }) };
