'use client';

import { useState } from 'react';
import { Icon } from '@bh/ui';

/** Uses the browser's location only when asked; coordinates go into the URL, nothing is stored. */
export function NearMe({ label, errorText }: { label: string; errorText: string }) {
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        className="btn btn-secondary"
        disabled={busy}
        onClick={() => {
          if (!navigator.geolocation) { setErr(true); return; }
          setBusy(true);
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const u = new URL(window.location.href);
              u.searchParams.set('near', `${pos.coords.latitude.toFixed(3)},${pos.coords.longitude.toFixed(3)}`);
              u.searchParams.delete('q');
              u.hash = 'finder';
              window.location.assign(u.toString());
            },
            () => { setBusy(false); setErr(true); },
            { timeout: 8000 },
          );
        }}
      >
        <Icon name="target" size={16} />{label}
      </button>
      {err && <span role="alert" className="mt-1 text-xs text-danger">{errorText}</span>}
    </span>
  );
}
