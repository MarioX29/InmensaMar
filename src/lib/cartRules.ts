export function nextCartQuantity(current:number, delta:number, stock:number):number|null {
  const next=Math.round((current+delta)*10000)/10000;
  if (delta>0 && (stock<=0 || next>stock)) return null;
  return Math.max(0,next);
}
export function cartExceedsStock(quantity:number, stock:number):boolean {
  return quantity>stock;
}
