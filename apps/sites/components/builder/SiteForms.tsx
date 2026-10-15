'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { call } from '@/lib/client';

export interface PublicFormDef {
  id: string;
  name: string;
  fields: Array<{ id: string; type: string; label: string; help: string; required: boolean; options: string[] }>;
  settings: { submitLabel: string; successMessage: string; consents: Array<{ purpose: string; label: string }> };
  locations: Array<{ id: string; name: string }>;
}

/** Website form section / landing page form. Submits through the same-origin proxy; spam traps are invisible. */
export function SiteForm({ def, pageUrl }: { def: PublicFormDef; pageUrl?: string }) {
  const t = useTranslations('builder.form');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const started = useRef<number>(0);
  useEffect(() => { started.current = Date.now(); }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const data: Record<string, unknown> = {};
    for (const f of def.fields) data[f.id] = f.type === 'checkbox' ? fd.get(f.id) === 'on' : String(fd.get(f.id) ?? '');
    const consents = Object.fromEntries(def.settings.consents.map((c) => [c.purpose, fd.get(`consent_${c.purpose}`) === 'on']));
    setState('sending');
    setErrors({});
    const r = await call<{ ok: true; message: string | null }>('POST', `/public/forms/${def.id}/submit`, { data, consents, website: String(fd.get('website') ?? ''), startedAt: started.current, pageUrl });
    if (r.ok) { setState('done'); setMessage(r.data.message); return; }
    setState('error');
    setErrors(r.error.fields ?? {});
    setMessage(r.error.code === 'too_fast' ? t('tooFast') : r.error.fields ? t('fixErrors') : r.error.message);
  }

  if (state === 'done') return <p className="bhs-success" role="status">{message || t('success')}</p>;
  const err = (id: string) => (errors[id] ? (errors[id] === 'Required' ? t('required') : t('invalid')) : null);
  return (
    <form className="bhs-form" onSubmit={submit} noValidate>
      {def.fields.map((f) => {
        const e = err(f.id);
        const desc = [f.help ? `${def.id}-${f.id}-help` : '', e ? `${def.id}-${f.id}-err` : ''].filter(Boolean).join(' ') || undefined;
        const common = { id: `${def.id}-${f.id}`, name: f.id, required: f.required, 'aria-invalid': e ? true : undefined, 'aria-describedby': desc };
        if (f.type === 'checkbox') {
          return (
            <div key={f.id}>
              <label className="bhs-check"><input type="checkbox" {...common} /><span>{f.label}</span></label>
              {e && <span id={`${def.id}-${f.id}-err`} className="bhs-err">{e}</span>}
            </div>
          );
        }
        return (
          <label key={f.id} htmlFor={common.id}>
            <span>{f.label}{!f.required && <span className="bhs-subtle"> ({t('optional')})</span>}</span>
            {f.type === 'textarea' ? <textarea {...common} />
              : f.type === 'select' ? <select {...common} defaultValue=""><option value="" disabled>{t('choose')}</option>{f.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>
              : f.type === 'location' ? <select {...common} defaultValue=""><option value="" disabled>{t('chooseLocation')}</option>{def.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
              : <input type={f.type === 'phone' ? 'tel' : f.type} autoComplete={f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : undefined} {...common} />}
            {f.help && <span id={`${def.id}-${f.id}-help`} className="bhs-subtle">{f.help}</span>}
            {e && <span id={`${def.id}-${f.id}-err`} className="bhs-err">{e}</span>}
          </label>
        );
      })}
      {def.settings.consents.map((c) => (
        <label key={c.purpose} className="bhs-check"><input type="checkbox" name={`consent_${c.purpose}`} /><span>{c.label}</span></label>
      ))}
      <div className="bhs-hp" aria-hidden><label>{t('honeypot')}<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
      {state === 'error' && message && <p role="alert" className="bhs-err">{message}</p>}
      <button type="submit" className="bhs-btn bhs-btn-primary" disabled={state === 'sending'} aria-busy={state === 'sending'}>{state === 'sending' ? t('sending') : def.settings.submitLabel || t('submit')}</button>
    </form>
  );
}

/** Newsletter section: email + explicit consent checkbox (never pre-ticked). */
export function NewsletterForm({ brandSlug, locationSlug, buttonLabel }: { brandSlug: string; locationSlug?: string; buttonLabel: string }) {
  const t = useTranslations('builder.newsletter');
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const started = useRef<number>(0);
  useEffect(() => { started.current = Date.now(); }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (fd.get('consent') !== 'on') { setState('error'); setError(t('consentRequired')); return; }
    setState('sending');
    const r = await call('POST', '/public/marketing/newsletter', { brandSlug, locationSlug, email: String(fd.get('email') ?? ''), consent: true, website: String(fd.get('website') ?? ''), startedAt: started.current });
    if (r.ok) setState('done');
    else { setState('error'); setError(r.error.fields?.email ? t('invalidEmail') : r.error.message); }
  }
  if (state === 'done') return <p className="bhs-success" role="status">{t('success')}</p>;
  return (
    <form className="bhs-form" onSubmit={submit} noValidate>
      <label><span>{t('email')}</span><input type="email" name="email" required autoComplete="email" /></label>
      <label className="bhs-check"><input type="checkbox" name="consent" /><span>{t('consent')}</span></label>
      <div className="bhs-hp" aria-hidden><label>{t('honeypot')}<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
      {state === 'error' && error && <p role="alert" className="bhs-err">{error}</p>}
      <button type="submit" className="bhs-btn bhs-btn-primary" disabled={state === 'sending'}>{state === 'sending' ? t('sending') : buttonLabel || t('submit')}</button>
    </form>
  );
}
