export type VirtualLayout<T> = {
  items: readonly T[];
  starts: number[];
  ends: number[];
  totalSize: number;
  gap: number;
};

export type VirtualRange = {
  firstIndex: number;
  lastIndex: number;
};

export type VirtualWindow<T> = {
  entries: T[];
  topSpacerHeight: number;
  bottomSpacerHeight: number;
};

function lowerBound(values: readonly number[], target: number) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid]! < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function upperBound(values: readonly number[], target: number) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid]! <= target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

export function createVirtualLayout<T>(
  items: readonly T[],
  getSize: (item: T, index: number) => number,
  gap = 0,
): VirtualLayout<T> {
  const starts: number[] = [];
  const ends: number[] = [];
  let y = 0;
  items.forEach((item, index) => {
    const size = Math.max(0, getSize(item, index));
    starts.push(y);
    y += size;
    ends.push(y);
    y += gap;
  });
  return {
    items,
    starts,
    ends,
    totalSize: y,
    gap,
  };
}

export function getVirtualRange(
  layout: VirtualLayout<unknown>,
  viewportTop: number,
  viewportBottom: number,
): VirtualRange | null {
  if (!layout.items.length) return null;
  const firstIndex = Math.min(layout.items.length - 1, lowerBound(layout.ends, viewportTop));
  const lastIndex = Math.min(layout.items.length - 1, upperBound(layout.starts, viewportBottom) - 1);
  if (lastIndex < firstIndex) return null;
  return { firstIndex, lastIndex };
}

export function getVirtualWindow<T>(
  layout: VirtualLayout<T>,
  viewportTop: number,
  viewportBottom: number,
): VirtualWindow<T> {
  const range = getVirtualRange(layout, viewportTop, viewportBottom);
  if (!range) {
    const first = layout.items[0];
    return {
      entries: first === undefined ? [] : [first],
      topSpacerHeight: 0,
      bottomSpacerHeight: first === undefined
        ? 0
        : Math.max(0, layout.totalSize - layout.ends[0]! - layout.gap),
    };
  }
  const afterVisible = layout.ends[range.lastIndex]! + layout.gap;
  return {
    entries: layout.items.slice(range.firstIndex, range.lastIndex + 1),
    topSpacerHeight: Math.max(0, layout.starts[range.firstIndex] ?? 0),
    bottomSpacerHeight: Math.max(0, layout.totalSize - afterVisible),
  };
}

export function findVirtualItemStart<T>(
  layout: VirtualLayout<T>,
  predicate: (item: T, index: number) => boolean,
) {
  const index = layout.items.findIndex(predicate);
  return index === -1 ? null : layout.starts[index] ?? null;
}
