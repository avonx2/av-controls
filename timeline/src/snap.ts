export function snapTimeToMarkers(
  time: number,
  markers: number[],
  widthPx: number,
  secondsPerWidth: number,
  thresholdPx = 10,
): number {
  if (!markers.length || !Number.isFinite(time)) return time

  const thresholdSeconds = (secondsPerWidth / Math.max(1, widthPx)) * thresholdPx
  let best = time
  let bestDistance = Infinity

  for (const marker of markers) {
    const distance = Math.abs(marker - time)
    if (distance < bestDistance) {
      bestDistance = distance
      best = marker
    }
  }

  return bestDistance <= thresholdSeconds ? best : time
}
