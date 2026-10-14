import type { ReactNode } from 'react';
import { Icon } from '@bh/ui';
import type { IconName } from '@bh/icons';

/** Centered full-page message for errors, not-found and unavailable states. */
export function MessagePage({ icon = 'info', title, body, children }: { icon?: IconName; title: string; body: string; children?: ReactNode }) {
  return (
    <main id="main" className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-4 py-16 text-center">
      <span className="grid size-14 place-items-center rounded-full bg-canvas text-ink" aria-hidden>
        <Icon name={icon} size={26} />
      </span>
      <h1 className="mt-5 text-2xl font-extrabold tracking-tight sm:text-3xl">{title}</h1>
      <p className="mt-3 text-graphite">{body}</p>
      {children && <div className="mt-6 flex flex-wrap justify-center gap-2">{children}</div>}
    </main>
  );
}
