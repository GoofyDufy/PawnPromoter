/**
 * A modal dialog (the desktop's small Toplevel windows): a native <dialog>,
 * closed with Escape, its buttons laid out by the caller.
 */
import { type ReactNode, useEffect, useRef } from 'react';

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    return () => { if (d.open) d.close(); };
  }, []);
  return (
    <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} aria-label={title}
      onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}
