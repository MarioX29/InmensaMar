export const inventoryUnits = ['lb', 'unit', 'dozen', 'package', 'box'] as const;

export type InventoryUnit = typeof inventoryUnits[number];

export const unitLabels: Record<InventoryUnit, string> = {
  lb: 'lb',
  unit: 'unidad',
  dozen: 'docena',
  package: 'paquete',
  box: 'caja',
};

export function isInventoryUnit(value: unknown): value is InventoryUnit {
  return typeof value === 'string' && (inventoryUnits as readonly string[]).includes(value);
}

export function allowsFractionalQuantity(unit: InventoryUnit): boolean {
  return unit === 'lb';
}

export function quantityStep(unit: InventoryUnit): number {
  return unit === 'lb' ? 0.5 : 1;
}
