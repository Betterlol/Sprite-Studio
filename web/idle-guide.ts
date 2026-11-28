import type { Asset, IdleGuide } from "../studio/model.ts";

export type IdleGuideTarget = {
  imageId: string;
  opacity: number;
  label: string;
};

/**
 * Resolve the saved IDLE guide against the assets that exist right now.
 *
 * A guide whose source was deleted, emptied or replaced by an animated image
 * resolves to null, so the canvas reports "not configured" and offers the
 * configuration page again instead of drawing something else.
 */
export function resolveIdleGuide(
  guide: IdleGuide | undefined,
  assets: Asset[],
): IdleGuideTarget | null {
  if (!guide) return null;
  const image = (id: string) => {
    const asset = assets.find((item) => item.id === id);
    return asset?.type === "image" && asset.frameCount === 1 ? asset : undefined;
  };
  if (guide.kind === "image") {
    const target = image(guide.assetId);
    return target
      ? { imageId: target.id, opacity: guide.opacity, label: target.name }
      : null;
  }
  const clip = assets.find((item) => item.id === guide.assetId);
  if (clip?.type !== "clip") return null;
  const first = clip.frames[0];
  const target = first ? image(first.imageId) : undefined;
  return target
    ? { imageId: target.id, opacity: guide.opacity, label: `${clip.name} 首帧` }
    : null;
}
