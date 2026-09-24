// Chrome build: the engine is hosted in the offscreen document, not here.
export const isInProcess = false;
export async function hostPerception() {
  throw new Error("in-process perception is Firefox-only");
}
