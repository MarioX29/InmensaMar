import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=(path)=>fs.readFileSync(new URL(`../${path}`,import.meta.url),'utf8');

test('official Inmensa-Mar logo is used in the shell, login and public storefront',()=>{
  const main=read('src/main.tsx'),auth=read('src/auth/AuthGate.tsx'),storefront=read('src/storefront/Storefront.tsx');
  assert.match(main,/src="\/logo-inmensa-mar\.jpg"/);
  assert.match(auth,/src="\/logo-inmensa-mar\.jpg"/);
  assert.match(storefront,/src="\/logo-inmensa-mar\.jpg"/);
  assert.ok(fs.existsSync(new URL('../public/logo-inmensa-mar.jpg',import.meta.url)));
  assert.ok(fs.existsSync(new URL('../public/icon-192.png',import.meta.url)));
  assert.ok(fs.existsSync(new URL('../public/icon-512.png',import.meta.url)));
});

test('inventory opens the existing purchase form without leaving the inventory page',()=>{
  const main=read('src/main.tsx'),operations=read('src/admin/AdminOperationsPanel.tsx');
  assert.match(main,/setInventoryPurchaseOpen\(true\)/);
  assert.match(main,/<AdminOperationsPanel purchaseOnly/);
  assert.match(operations,/purchaseOnly\?:boolean/);
});

test('stock minimum helper text explains the active threshold and the disabled zero value',()=>{
  const file=read('src/admin/StockMinimumPanel.tsx');
  assert.match(file,/alerta cuando queden menos de/);
  assert.match(file,/alertas de reposición están desactivadas/);
});

test('owner dashboard avoids rendering empty zero-only sales bars',()=>{
  const file=read('src/admin/OwnerDashboardPanel.tsx');
  assert.match(file,/daily\.every\(d=>Number\(d\.sales_cents\)===0\)/);
  assert.match(file,/No hay ventas registradas en este período/);
});

test('sales history exposes date and status filters and expands line/payment details',()=>{
  const file=read('src/admin/SalesHistoryPanel.tsx');
  for(const value of ['Desde','Hasta','Estado','Buscar venta','sale_lines','sale_payments','unit_price_cents','Pagos registrados']) assert.ok(file.includes(value),`missing ${value}`);
});

test('transfer verification separates pending and verified records and supports source/date filters',()=>{
  const file=read('src/admin/TransferVerificationPanel.tsx');
  for(const value of ['Por verificar','Verificadas','Origen','Desde','Hasta','Transferencia verificada','Verifiqué el abono']) assert.ok(file.includes(value),`missing ${value}`);
});

test('delivery route details group cancelled orders and transfer summary opens Finance',()=>{
  const file=read('src/delivery/DeliveryPanel.tsx');
  assert.match(file,/Ver \{cancelledAssigned\.length\} pedidos cancelados/);
  assert.match(file,/onOpenTransfers\?\.\(\)/);
  assert.match(file,/Detalles de la salida/);
});

test('finance expense history can be expanded for its recorded details',()=>{
  const file=read('src/admin/FinanceExpensesPanel.tsx');
  assert.match(file,/<details className="finance-entry finance-entry-details"/);
  assert.match(file,/Fecha del gasto/);
});

test('cash balance and pending disclosures use a reversible chevron instead of a close icon',()=>{
  const panel=read('src/cash/CashPanel.tsx'),css=read('src/cash/cash.css');
  assert.equal((panel.match(/className="cash-disclosure-chevron"/g)||[]).length,3);
  assert.match(css,/cash-disclosure\[open\]>summary>\.cash-disclosure-chevron\{transform:rotate\(180deg\)\}/);
  assert.doesNotMatch(panel,/<span aria-hidden="true">\+<\/span>/);
});

test('stock minimum helper does not treat an empty input as zero',()=>{
  const file=read('src/admin/StockMinimumPanel.tsx');
  assert.match(file,/!value\.trim\(\)\?'Ingresá un mínimo para configurar la alerta\.'/);
});
