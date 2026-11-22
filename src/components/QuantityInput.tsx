import { useEffect, useMemo, useRef, useState } from 'react';
import type { InventoryUnit } from '../lib/units';
import { unitLabels } from '../lib/units';
import { poundsAndOuncesToQuantity, quantityToPoundsAndOunces } from '../lib/weight.js';
import './quantity-input.css';

type QuantityInputProps = {
  unit: InventoryUnit;
  value: number;
  onCommit: (quantity: number) => void;
  disabled?: boolean;
  label?: string;
  max?: number;
};

function parseNonNegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function QuantityInput({ unit, value, onCommit, disabled = false, label = 'Cantidad', max = 100000 }: QuantityInputProps) {
  const [pounds, setPounds] = useState('0');
  const [ounces, setOunces] = useState('0');
  const [quantityDraft, setQuantityDraft] = useState(String(value));
  const [quantityDirty, setQuantityDirty] = useState(false);
  const [error, setError] = useState('');
  const localWeightCommit = useRef<number | null>(null);

  useEffect(() => {
    if (unit === 'lb') {
      // Keep the user's in-progress text when the parent echoes our own live update.
      if (localWeightCommit.current !== null && Math.abs(value - localWeightCommit.current) < 0.0000001) {
        localWeightCommit.current = null;
        return;
      }
      const next = quantityToPoundsAndOunces(value);
      setPounds(String(next.pounds));
      setOunces(String(next.ounces));
    } else {
      setQuantityDraft(String(value));
      setQuantityDirty(false);
    }
    setError('');
  }, [unit, value]);

  const poundsPreview = useMemo(() => {
    const lb = Number(pounds);
    const oz = Number(ounces.replace(',', '.'));
    if (!pounds.trim() || !ounces.trim() || !Number.isSafeInteger(lb) || lb < 0 || !Number.isFinite(oz) || oz < 0) return null;
    const result = poundsAndOuncesToQuantity(lb, oz);
    return Number.isFinite(result) && result > 0 && result <= max ? result : null;
  }, [pounds, ounces, max]);

  function commitPounds(nextPounds = pounds, nextOunces = ounces) {
    const lb = parseNonNegativeInteger(nextPounds);
    const oz = Number(nextOunces.replace(',', '.'));
    if (lb === null || !nextOunces.trim() || !Number.isFinite(oz) || oz < 0 || Math.round(oz * 10000) !== oz * 10000) {
      return false;
    }
    const result = poundsAndOuncesToQuantity(lb, oz);
    if (result <= 0 || result > max) return false;
    if (Math.abs(result - value) >= 0.0000001) {
      localWeightCommit.current = result;
      onCommit(result);
    }
    return true;
  }

  function normalizePoundsDraft() {
    if (!commitPounds()) {
      const stored = quantityToPoundsAndOunces(value);
      setPounds(String(stored.pounds));
      setOunces(String(stored.ounces));
      setError('Revisá la cantidad de libras y onzas.');
      return;
    }
    const total = poundsAndOuncesToQuantity(Number(pounds), Number(ounces.replace(',', '.')));
    const normalized = quantityToPoundsAndOunces(total);
    setPounds(String(normalized.pounds));
    setOunces(String(normalized.ounces));
    setError('');
  }

  function commitOtherUnit() {
    if (!quantityDirty) return;
    const parsed = Number(quantityDraft.replace(',', '.'));
    const normalized = Math.round(parsed * 10000) / 10000;
    if (!quantityDraft.trim() || !Number.isFinite(parsed) || normalized <= 0 || normalized > max || !Number.isInteger(normalized)) {
      setError(`Ingresá una cantidad entera válida de ${unitLabels[unit]}.`);
      return;
    }
    setError('');
    setQuantityDirty(false);
    onCommit(normalized);
  }

  if (unit === 'lb') {
    const totalOunces = poundsPreview === null ? null : Math.round(poundsPreview * 16 * 10000) / 10000;
    const normalizedPounds = totalOunces === null ? 0 : Math.floor(totalOunces / 16);
    const normalizedOunces = totalOunces === null ? 0 : Math.round((totalOunces - normalizedPounds * 16) * 10000) / 10000;
    const decimalPounds = poundsPreview === null ? '' : poundsPreview.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return <div className="im-quantity-input" data-unit="lb">
      <div className="im-quantity-parts">
        <label><span>Libras</span><input type="number" inputMode="numeric" min="0" step="1" value={pounds} disabled={disabled} onChange={event => { const next = event.target.value; setPounds(next); setError(''); commitPounds(next, ounces); }} onBlur={normalizePoundsDraft} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); normalizePoundsDraft(); } }}/></label>
        <label><span>Onzas</span><input type="number" inputMode="decimal" min="0" step="0.01" value={ounces} disabled={disabled} onChange={event => { const next = event.target.value; setOunces(next); setError(''); commitPounds(pounds, next); }} onBlur={normalizePoundsDraft} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); normalizePoundsDraft(); } }}/></label>
      </div>
      <div className="im-quantity-footer" aria-live="polite">
        <small>{totalOunces === null ? 'Completá libras y onzas' : normalizedOunces ? `${normalizedPounds} lb + ${normalizedOunces} oz · ${decimalPounds} lb` : normalizedPounds ? `${normalizedPounds} lb` : `${normalizedOunces} oz · ${decimalPounds} lb`}</small>
      </div>
      {error && <small className="im-quantity-error" role="alert">{error}</small>}
    </div>;
  }

  return <div className="im-quantity-input" data-unit={unit}>
    <label className="im-quantity-single"><span>{label} ({unitLabels[unit]})</span><input type="number" inputMode="numeric" min="1" step="1" value={quantityDraft} disabled={disabled} onChange={event => { setQuantityDraft(event.target.value); setQuantityDirty(true); setError(''); }} onBlur={commitOtherUnit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitOtherUnit(); } }}/></label>
    {error && <small className="im-quantity-error" role="alert">{error}</small>}
  </div>;
}
