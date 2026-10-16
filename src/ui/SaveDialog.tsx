/** "Save to repertoire" (drill_tab._ask_repertoire_name_and_color): a name — pick an
 *  existing repertoire to add to it, or type a new one — and your colour. */
import { useState } from 'react';
import type { PlayerColor } from '../core/models';
import { Modal } from './Modal';

/** "Save to repertoire": a name (pick an existing one, or type a new one) and your colour. */
export function SaveDialog({ names, onSave, onClose }: { names: string[]; onSave: (name: string, color: PlayerColor) => Promise<string | null>; onClose: () => void }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<PlayerColor>('white');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const problem = await onSave(name.trim(), color);
    setBusy(false);
    if (problem) setError(problem);
  };
  return (
    <Modal title="Save to repertoire" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="field"><span>Repertoire name</span>
          <span className="note">Pick an existing one to add to it, or type a new name.</span>
          <input list="repertoire-names" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <datalist id="repertoire-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
        </label>
        <div className="row" role="radiogroup" aria-label="I play">
          <span>I play</span>
          {(['white', 'black'] as PlayerColor[]).map((c) => (
            <label key={c} className="check"><input type="radio" name="color" checked={color === c} onChange={() => setColor(c)} />
              {c === 'white' ? 'White' : 'Black'}</label>
          ))}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row modal-buttons">
          <button type="submit" className="btn" disabled={busy || !name.trim()}>Save</button>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

