'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Icon, cx } from '@bh/ui';
import { ASSISTANT_NAME, WORKSPACES } from '@bh/shared';
import { flatNav, workspaceNav } from '@/lib/access';
import { useApp } from '../shell/AppContext';
import { useNavLabel } from '../shell/Sidebar';
import { useMarina } from './MarinaProvider';

/** Cmd/Ctrl+K: "Ask Marina or jump to…". The first option asks the assistant; the rest are screens the person can open. */
export function CommandBar() {
  const t = useTranslations('marina');
  const app = useApp();
  const m = useMarina();
  const router = useRouter();
  const label = useNavLabel();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('marina:command', onOpen);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('marina:command', onOpen);
    };
  }, []);
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const links = useMemo(() => {
    const all = app.org.model === 'independent' ? flatNav(app.capabilities, app.industry) : [...WORKSPACES, 'settings' as const].flatMap((w) => workspaceNav(w, app.capabilities, app.industry));
    const seen = new Set<string>();
    return all.filter((l) => !seen.has(l.href) && seen.add(l.href)).map((l) => ({ href: l.href, icon: l.icon, label: label(l) }));
  }, [app.capabilities, app.industry, app.org.model, label]);

  const needle = q.trim().toLowerCase();
  const matches = (needle ? links.filter((l) => l.label.toLowerCase().includes(needle) || l.href.includes(needle)) : links).slice(0, 8);
  const options = [...(m.available && needle ? [{ kind: 'ask' as const }] : []), ...matches.map((l) => ({ kind: 'go' as const, ...l }))];

  const choose = (i: number) => {
    const o = options[i];
    if (!o) return;
    setOpen(false);
    if (o.kind === 'ask') m.ask(q);
    else router.push(o.href);
  };
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onClick={() => setOpen(false)}>
      <div role="dialog" aria-modal="true" aria-label={t('command.title', { name: ASSISTANT_NAME })} className="w-full max-w-xl overflow-hidden rounded-xl bg-surface shadow-pop" onClick={(e) => e.stopPropagation()} data-testid="marina-command">
        <label className="flex items-center gap-3 border-b border-line-soft px-4">
          <Icon name="sparkles" size={18} />
          <span className="sr-only">{t('command.title', { name: ASSISTANT_NAME })}</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
            }}
            placeholder={m.available ? t('command.placeholder', { name: ASSISTANT_NAME }) : t('command.placeholderNav')}
            className="h-14 flex-1 bg-transparent text-[15px] outline-none"
            role="combobox"
            aria-expanded="true"
            aria-controls="marina-command-list"
          />
          <kbd className="rounded border border-line-soft px-1.5 py-0.5 text-[10px] text-stone">Esc</kbd>
        </label>
        <ul id="marina-command-list" role="listbox" className="max-h-[50vh] overflow-y-auto p-2">
          {options.map((o, i) => (
            <li key={o.kind === 'ask' ? 'ask' : o.href} role="option" aria-selected={i === active}>
              <button type="button" onMouseEnter={() => setActive(i)} onClick={() => choose(i)} className={cx('flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm', i === active && 'bg-canvas')}>
                {o.kind === 'ask' ? (
                  <>
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[linear-gradient(135deg,#2E6FD8,#5B3FC4)] text-white"><Icon name="sparkles" size={13} /></span>
                    <span className="min-w-0 flex-1 truncate"><strong>{t('command.ask', { name: ASSISTANT_NAME })}</strong> <span className="text-stone">“{q}”</span></span>
                  </>
                ) : (
                  <>
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-canvas"><Icon name={o.icon} size={14} /></span>
                    <span className="flex-1">{o.label}</span>
                    <span className="text-[11px] text-stone">{t('command.jump')}</span>
                  </>
                )}
              </button>
            </li>
          ))}
          {options.length === 0 && <li className="px-3 py-4 text-sm text-stone">{t('command.empty')}</li>}
        </ul>
        <p className="border-t border-line-soft px-4 py-2 text-[11px] text-stone">{t('command.hint')}</p>
      </div>
    </div>
  );
}
