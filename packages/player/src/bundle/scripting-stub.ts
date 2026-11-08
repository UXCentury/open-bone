/** Stands in for @openbone/scripting in web bundles built without the sandbox (never called: see sandbox-none.ts). */
export async function createQuickJsHost(): Promise<never> {
  throw new Error("OpenBone: this player build has no script sandbox");
}
