export type DisplayAdjustment = {
  verticalOffsetPercent: number;
  zoom: number;
  horizontalScale: number;
};

export const DEFAULT_DISPLAY_ADJUSTMENT: DisplayAdjustment = {
  verticalOffsetPercent: 0,
  zoom: 0.9,
  horizontalScale: 1,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundAdjustment(value: number) {
  return Math.round(value * 1000) / 1000;
}

export function normalizeDisplayAdjustment(
  value: Partial<DisplayAdjustment> | null | undefined,
): DisplayAdjustment {
  const zoom = roundAdjustment(
    clamp(Number(value?.zoom) || DEFAULT_DISPLAY_ADJUSTMENT.zoom, 0.4, 1),
  );
  const maximumVerticalOffset = roundAdjustment((1 - zoom) * 50);
  return {
    verticalOffsetPercent: roundAdjustment(
      clamp(
        Number(value?.verticalOffsetPercent) || 0,
        -maximumVerticalOffset,
        maximumVerticalOffset,
      ),
    ),
    zoom,
    horizontalScale: roundAdjustment(
      clamp(Number(value?.horizontalScale) || 1, 0.5, 3),
    ),
  };
}

export function adjustDisplayForKey(
  current: DisplayAdjustment,
  key: string,
): DisplayAdjustment | null {
  if (key === "0") return DEFAULT_DISPLAY_ADJUSTMENT;
  if (key === "ArrowUp") {
    return normalizeDisplayAdjustment({
      ...current,
      verticalOffsetPercent: current.verticalOffsetPercent - 1,
    });
  }
  if (key === "ArrowDown") {
    return normalizeDisplayAdjustment({
      ...current,
      verticalOffsetPercent: current.verticalOffsetPercent + 1,
    });
  }
  if (key === "ArrowRight") {
    return normalizeDisplayAdjustment({
      ...current,
      horizontalScale: current.horizontalScale + 0.025,
    });
  }
  if (key === "ArrowLeft") {
    return normalizeDisplayAdjustment({
      ...current,
      horizontalScale: current.horizontalScale - 0.025,
    });
  }
  if (key === "+" || key === "=" || key === "Add") {
    return normalizeDisplayAdjustment({
      ...current,
      zoom: current.zoom + 0.025,
    });
  }
  if (key === "-" || key === "_" || key === "Subtract") {
    return normalizeDisplayAdjustment({
      ...current,
      zoom: current.zoom - 0.025,
    });
  }
  return null;
}

export function getNextPlaylistIndex(
  currentIndex: number,
  itemCount: number,
  loopEnabled: boolean,
) {
  if (itemCount <= 0) return null;
  if (currentIndex + 1 < itemCount) return currentIndex + 1;
  return loopEnabled ? 0 : null;
}

export type PlaybackEndAction =
  | "pause"
  | "single-loop"
  | "playlist-loop"
  | "playlist-random";

export function getPlaylistIndexForEndAction(
  currentIndex: number,
  itemCount: number,
  action: PlaybackEndAction,
  randomValue = Math.random(),
) {
  if (action === "pause") return null;
  if (action === "single-loop") {
    if (currentIndex < 0) return currentIndex;
    return itemCount > 0
      ? Math.min(Math.max(currentIndex, 0), itemCount - 1)
      : Math.max(0, currentIndex);
  }
  if (itemCount <= 0) return null;
  if (action === "playlist-loop") {
    return currentIndex + 1 < itemCount ? currentIndex + 1 : 0;
  }
  if (itemCount === 1) return 0;
  if (currentIndex < 0) {
    return Math.min(
      itemCount - 1,
      Math.floor(Math.max(0, Math.min(0.999999, randomValue)) * itemCount),
    );
  }
  const safeCurrent = Math.min(Math.max(currentIndex, 0), itemCount - 1);
  const randomSlot = Math.min(
    itemCount - 2,
    Math.floor(Math.max(0, Math.min(0.999999, randomValue)) * (itemCount - 1)),
  );
  return randomSlot >= safeCurrent ? randomSlot + 1 : randomSlot;
}

export function planPlaylistUpload<T>(
  currentItems: T[],
  incomingItems: T[],
  currentIndex: number,
  hasActiveMedia: boolean,
) {
  const preserveActiveMedia =
    hasActiveMedia || currentItems.length > 0;
  return {
    items: preserveActiveMedia
      ? [...currentItems, ...incomingItems]
      : incomingItems,
    activeIndex: preserveActiveMedia
      ? currentItems.length > 0
        ? currentIndex
        : -1
      : 0,
    replaceActiveMedia: !preserveActiveMedia,
  };
}

export function planPlaylistItemRemoval<T>(
  items: T[],
  removeIndex: number,
  activeIndex: number,
) {
  if (removeIndex < 0 || removeIndex >= items.length) {
    return { items, activeIndex, removedActiveItem: false };
  }
  return {
    items: items.filter((_, index) => index !== removeIndex),
    activeIndex:
      removeIndex === activeIndex
        ? -1
        : removeIndex < activeIndex
          ? activeIndex - 1
          : activeIndex,
    removedActiveItem: removeIndex === activeIndex,
  };
}
