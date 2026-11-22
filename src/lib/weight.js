export function poundsAndOuncesToQuantity(pounds, ounces) {
  return Math.round((pounds + ounces / 16) * 10000) / 10000;
}

export function quantityToPoundsAndOunces(quantity) {
  const safe = Math.max(0, Math.round(quantity * 10000) / 10000);
  const totalOunces = Math.round(safe * 16 * 10000) / 10000;
  const pounds = Math.floor(totalOunces / 16 + 0.0000001);
  const ounces = Math.round((totalOunces - pounds * 16) * 10000) / 10000;
  return { pounds, ounces };
}
