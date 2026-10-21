/** "Save to repertoire" (drill_tab._ask_repertoire_name_and_color): pick one of your repertoires from
 *  the list (your colour in it is filled in), or "New repertoire…" and type a name — and your colour. */
import { useState } from 'react';
import type { PlayerColor } from '../core/models';
import { Modal } from './Modal';

const NEW = '__new__';

/** "Save to repertoire": an existing repertoire from the dropdown, or a new name; and your colour.
 *  defaultColor: the side these lines are for, when known. */
export function SaveDialog({ repertoires, defaultColor = 'white', onSave, onClose }: {
  repertoires: { name: string; colors: PlayerColor[] }[];
  defaultColor?: PlayerColor;
  onSave: (name: string, color: PlayerColor) => Promise<string | null>;
  onClose: () => void;
}) {
  // start on an existing repertoire for this colour when there is one, else on a new name
  const first = repertoires.find((r) => r.colors.includes(defaultColor));
  const [choice, setChoice] = useState(first ? first.name : NEW);
  const [typed, setTyped] = useState('');
  const [color, setColor] = useState<PlayerColor>(defaultColor);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = (choice === NEW ? typed : choice).trim();
  const pick = (value: string) => {
    setChoice(value);
    const rep = repertoires.find((r) => r.name === value);
    if (rep?.colors.length === 1) setColor(rep.colors[0]);      // a one-colour repertoire: that colour
  };
  const save = async () => {
    if (!name) return;
    setBusy(true);
    const problem = await onSave(name, color);
    setBusy(false);
    if (problem) setError(problem);
  };
  const label = (r: { name: string; colors: PlayerColor[] }) =>
    `${r.name}  (${r.colors.map((c) => (c === 'white' ? 'White' : 'Black')).join(' & ')})`;
  return (
    <Modal title="Save to repertoire" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="field"><span>Repertoire</span>
          <select aria-label="Repertoire" value={choice} onChange={(e) => pick(e.target.value)} autoFocus>
            {repertoires.map((r) => <option key={r.name} value={r.name}>{label(r)}</option>)}
            <option value={NEW}>+ New repertoire…</option>
          </select>
        </label>
        {choice === NEW && (
          <label className="field"><span>New repertoire name</span>
            <input aria-label="New repertoire name" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </label>
        )}
        <div className="row" role="radiogroup" aria-label="I play">
          <span>I play</span>
          {(['white', 'black'] as PlayerColor[]).map((c) => (
            <label key={c} className="check"><input type="radio" name="color" checked={color === c} onChange={() => setColor(c)} />
              {c === 'white' ? 'White' : 'Black'}</label>
          ))}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row modal-buttons">
          <button type="submit" className="btn" disabled={busy || !name}>Save</button>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
