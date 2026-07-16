export interface ModulationScale {
  scale: number
}

export const defaultModulationScale: ModulationScale = { scale: 1 }

export function getClampedModulationScale(modulationScale: ModulationScale): number {
  return Math.max(0, Math.min(1, modulationScale.scale))
}
