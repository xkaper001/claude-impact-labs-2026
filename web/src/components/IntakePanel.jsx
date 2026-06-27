import React, { useEffect } from 'react';
import Intake from './Intake.jsx';

/** IntakePanel — a right-side slide-over that hosts the existing Intake form
 *  over the dashboard, so the hero map stays visible and can zoom when the
 *  intake submits. Adapts Intake's onBack / onSearched / onCaseSaved to
 *  open/close + the dashboard's inline search flow. */
export default function IntakePanel({ open, tr, lang, mode, config, data, online, onClose, onSearched, onCaseSaved }) {
  // Esc closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={`scrim ${open ? 'show' : ''}`} onClick={onClose} aria-hidden={!open} />
      <aside className={`intake-panel ${open ? 'open' : ''}`} aria-hidden={!open}>
        <Intake
          tr={tr}
          lang={lang}
          mode={mode}
          config={config}
          data={data}
          online={online}
          onBack={onClose}
          onCaseSaved={onCaseSaved}
          onSearched={(q) => { onClose(); onSearched(q); }}
        />
      </aside>
    </>
  );
}
