// Name-tag fade: fully opaque up close, gone by TAG_FAR metres.
export const TAG_NEAR = 28;
export const TAG_FAR = 70;

export function tagAlpha(dist) {
  const k = Math.min(1, Math.max(0, (dist - TAG_NEAR) / (TAG_FAR - TAG_NEAR)));
  return 1 - k * k * (3 - 2 * k);
}
