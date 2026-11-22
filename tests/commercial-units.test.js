import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('commercial unit set is exactly the five agreed units', async () => {
  const source = await read('../src/lib/units.ts');
  assert.match(source, /\['lb', 'unit', 'dozen', 'package', 'box'\]/);
  for (const label of ["lb: 'lb'", "unit: 'unidad'", "dozen: 'docena'", "package: 'paquete'", "box: 'caja'"]) {
    assert.ok(source.includes(label), `missing unit label: ${label}`);
  }
});

test('only pounds allow fractional quantities in the shared model', async () => {
  const source = await read('../src/lib/units.ts');
  assert.match(source, /return unit === 'lb'/);
  assert.match(source, /return unit === 'lb' \? 0\.5 : 1/);
});

test('the catalog keeps five inventory units while the POS captures pounds and ounces separately', async () => {
  const catalog = await read('../src/admin/CatalogPanel.tsx');
  const pos = await read('../src/main.tsx');
  const input = await read('../src/components/QuantityInput.tsx');
  assert.match(catalog, /inventoryUnits\.map/);
  assert.doesNotMatch(pos, /<option value=\"oz\">/);
  assert.match(pos, /commitQuantity\(p:Product, entered:number\)/);
  assert.match(pos, /<QuantityInput unit=\{product\.unit\}/);
  assert.match(input, /<span>Libras<\/span>/);
  assert.match(input, /<span>Onzas<\/span>/);
  assert.match(input, /poundsAndOuncesToQuantity/);
});

test('database migration extends the constraint and enforces whole non-pound quantities', async () => {
  const migration = await read('../supabase/migrations/20261121_01_commercial_units.sql');
  assert.match(migration, /CHECK \(base_unit IN \('lb','unit','dozen','package','box'\)\)/);
  assert.match(migration, /p_base_unit NOT IN \('lb','unit','dozen','package','box'\)/);
  assert.match(migration, /IF v_unit <> 'lb' AND p_quantity<>trunc\(p_quantity\)/);
  assert.match(migration, /v_variant\.base_unit <> 'lb' and v_item\.quantity <> trunc\(v_item\.quantity\)/);
  assert.match(migration, /v_variant\.base_unit <> 'lb' and v_item\.quantity <> trunc\(v_item\.quantity\)/);
});


test('weight entry is used in counter sales and both internal and public order forms', async () => {
  const pos = await read('../src/main.tsx');
  const orders = await read('../src/orders/OrdersPanel.tsx');
  const storefront = await read('../src/storefront/Storefront.tsx');
  assert.match(pos, /<QuantityInput unit=\{product\.unit\}/);
  assert.match(orders, /<QuantityInput unit=\{p\.unit\}/);
  assert.match(storefront, /<QuantityInput unit=\{p\.unit\}/);
});
