'use client';

import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon, cx } from '@bh/ui';
import { minorUnitExponent, type AiChartBlock, type AiCitation, type AiTableBlock, type Currency } from '@bh/shared';

/** Minimal formatting for answers: paragraphs, bullet lists and **bold**. Text only (never HTML). */
export function RichText({ text, className }: { text: string; className?: string }) {
  const inline = (s: string): ReactNode[] => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>));
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className={cx('flex flex-col gap-2', className)}>
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        if (lines.every((l) => /^\s*([-•*]|\d+\.)\s+/.test(l))) {
          return (
            <ul key={i} className="flex list-disc flex-col gap-1 pl-5">
              {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-•*]|\d+\.)\s+/, ''))}</li>)}
            </ul>
          );
        }
        return <p key={i} className="whitespace-pre-line">{inline(b.replace(/^#+\s*/, ''))}</p>;
      })}
    </div>
  );
}

export function useFormatters() {
  const locale = useLocale();
  const money = (minor: number | null | undefined, currency: string | null | undefined) => {
    if (minor === null || minor === undefined || !currency) return '—';
    const exp = minorUnitExponent(currency as Currency);
    try {
      return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: exp, maximumFractionDigits: exp }).format(minor / 10 ** exp);
    } catch {
      return `${(minor / 10 ** exp).toFixed(exp)} ${currency}`;
    }
  };
  const num = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? '—' : new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n));
  const date = (s: string | null | undefined) => {
    if (!s) return '—';
    const d = new Date(s.length === 10 ? `${s}T12:00:00Z` : s);
    if (Number.isNaN(d.getTime())) return s;
    return new Intl.DateTimeFormat(locale, s.length === 10 ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' }).format(d);
  };
  return { money, num, date, locale };
}

const STATUS_TONE: Record<string, string> = {
  overdue: 'bg-[#FCE3E1] text-[#8A1F17]', expired: 'bg-[#FCE3E1] text-[#8A1F17]', failed: 'bg-[#FCE3E1] text-[#8A1F17]', critical: 'bg-[#FCE3E1] text-[#8A1F17]',
  expiring: 'bg-[#FFF1C9] text-[#6B4A00]', warning: 'bg-[#FFF1C9] text-[#6B4A00]', open: 'bg-[#FFF1C9] text-[#6B4A00]', pending: 'bg-[#FFF1C9] text-[#6B4A00]', new: 'bg-[#E4EEFF] text-[#1D3F7A]',
  on_time: 'bg-[#DFF3E4] text-[#14532D]', passed: 'bg-[#DFF3E4] text-[#14532D]', valid: 'bg-[#DFF3E4] text-[#14532D]', operating: 'bg-[#DFF3E4] text-[#14532D]', paid: 'bg-[#DFF3E4] text-[#14532D]', published: 'bg-[#DFF3E4] text-[#14532D]', approved: 'bg-[#DFF3E4] text-[#14532D]',
};

export function StatusPill({ value }: { value: string }) {
  if (!value) return null;
  return <span className={cx('inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold', STATUS_TONE[value] ?? 'bg-canvas text-graphite')}>{value.replace(/_/g, ' ')}</span>;
}

/** A table built from tool results. Money is shown in each row's own currency. */
export function MarinaTable({ block }: { block: AiTableBlock }) {
  const f = useFormatters();
  const cols = block.columns.filter((c) => c.key !== 'id' || block.columns.length < 3);
  const cell = (row: Record<string, string | number | null>, c: AiTableBlock['columns'][number]) => {
    const v = row[c.key];
    switch (c.kind) {
      case 'money': return f.money(typeof v === 'number' ? v : null, block.currencyKey ? String(row[block.currencyKey] ?? '') : null);
      case 'percent': return v === null || v === undefined || v === '' ? '—' : `${f.num(Number(v))}%`;
      case 'number': return f.num(typeof v === 'number' ? v : v === null ? null : Number(v));
      case 'date': return f.date(v === null ? null : String(v));
      case 'status': return v ? <StatusPill value={String(v)} /> : '—';
      default: return v === null || v === undefined || v === '' ? '—' : String(v);
    }
  };
  return (
    <figure className="flex flex-col gap-1.5" data-testid="marina-table">
      <figcaption className="text-[12px] font-bold">{block.title}</figcaption>
      <div className="max-w-full overflow-x-auto rounded-md border border-line-soft">
        <table className="w-full min-w-max border-collapse text-left text-[12px]">
          <thead className="bg-canvas">
            <tr>{cols.map((c) => <th key={c.key} scope="col" className={cx('whitespace-nowrap px-2.5 py-1.5 font-bold text-stone', ['money', 'number', 'percent'].includes(c.kind ?? '') && 'text-right')}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {block.rows.map((r, i) => (
              <tr key={i} className="border-t border-line-soft">
                {cols.map((c) => <td key={c.key} className={cx('max-w-[260px] px-2.5 py-1.5 align-top', ['money', 'number', 'percent'].includes(c.kind ?? '') && 'whitespace-nowrap text-right tabular-nums')}>{cell(r, c)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {block.note && <p className="text-[11px] text-stone">{block.note}</p>}
    </figure>
  );
}

const SERIES = ['#5B3FC4', '#C9A227', '#1E7F6E', '#C2410C'];

/** Bar or line chart (SVG). One chart per currency for money. */
export function MarinaChart({ block }: { block: AiChartBlock }) {
  const f = useFormatters();
  const labels = block.series[0]?.points.map((p) => p.label) ?? [];
  const values = block.series.flatMap((s) => s.points.map((p) => p.value ?? 0));
  const max = Math.max(1, ...values);
  const fmt = (v: number | null) => (block.unit === 'money' ? f.money(v, block.currency ?? null) : block.unit === 'percent' ? `${f.num(v)}%` : f.num(v));
  const W = 320;
  const rowH = block.kind === 'bar' ? 22 * block.series.length + 10 : 0;
  if (block.kind === 'line') {
    const H = 120;
    const x = (i: number) => (labels.length <= 1 ? W / 2 : 8 + (i * (W - 16)) / (labels.length - 1));
    const y = (v: number) => H - 16 - (v / max) * (H - 32);
    return (
      <figure className="flex flex-col gap-1.5" data-testid="marina-chart">
        <figcaption className="text-[12px] font-bold">{block.title}</figcaption>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={block.title}>
          {block.series.map((s, si) => (
            <polyline key={s.name} fill="none" stroke={SERIES[si % SERIES.length]} strokeWidth={2} points={s.points.map((p, i) => (p.value === null ? null : `${x(i)},${y(p.value)}`)).filter(Boolean).join(' ')} />
          ))}
          {labels.map((l, i) => <text key={l} x={x(i)} y={H - 2} fontSize={9} textAnchor="middle" fill="currentColor" opacity={0.6}>{l}</text>)}
        </svg>
        <Legend series={block.series.map((s) => s.name)} />
      </figure>
    );
  }
  return (
    <figure className="flex flex-col gap-1.5" data-testid="marina-chart">
      <figcaption className="text-[12px] font-bold">{block.title}</figcaption>
      <div className="flex flex-col gap-2" role="img" aria-label={block.title}>
        {labels.map((l, i) => (
          <div key={l} className="grid grid-cols-[minmax(80px,30%)_1fr] items-center gap-2 text-[11px]" style={{ minHeight: rowH }}>
            <span className="truncate font-semibold">{l}</span>
            <div className="flex flex-col gap-1">
              {block.series.map((s, si) => {
                const v = s.points[i]?.value ?? null;
                return (
                  <div key={s.name} className="flex items-center gap-1.5">
                    <span className="h-3 rounded-sm" style={{ width: `${Math.max(2, ((v ?? 0) / max) * 100)}%`, background: SERIES[si % SERIES.length], opacity: si ? 0.55 : 1 }} />
                    <span className="whitespace-nowrap tabular-nums text-stone">{fmt(v)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {block.series.length > 1 && <Legend series={block.series.map((s) => s.name)} />}
    </figure>
  );
}

function Legend({ series }: { series: string[] }) {
  return (
    <div className="flex flex-wrap gap-3 text-[11px] text-stone">
      {series.map((s, i) => (
        <span key={s} className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: SERIES[i % SERIES.length], opacity: i ? 0.55 : 1 }} />{s}</span>
      ))}
    </div>
  );
}

export function Citations({ citations }: { citations: AiCitation[] }) {
  const t = useTranslations('marina');
  if (!citations.length) return null;
  const seen = new Set<string>();
  const list = citations.filter((c) => !seen.has(c.id) && seen.add(c.id));
  return (
    <div className="flex flex-col gap-1" data-testid="marina-citations">
      <div className="text-[11px] font-bold uppercase tracking-[0.05em] text-stone">{t('sources')}</div>
      <ul className="flex flex-wrap gap-1.5">
        {list.map((c) => (
          <li key={c.id}>
            {c.url?.startsWith('/') ? (
              <Link href={c.url} className="inline-flex items-center gap-1 rounded-full bg-canvas px-2.5 py-1 text-[11px] font-semibold hover:bg-line-soft" title={c.snippet}>
                <Icon name="file" size={11} />{c.title}
              </Link>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-canvas px-2.5 py-1 text-[11px] font-semibold" title={c.snippet}><Icon name="file" size={11} />{c.title}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Notices({ notices }: { notices: Array<{ code: string; message: string }> }) {
  const t = useTranslations('marina');
  const shown = notices.filter((n) => n.code !== 'sandbox');
  if (!shown.length) return null;
  return (
    <div className="flex flex-col gap-1">
      {shown.map((n) => (
        <p key={n.code} className={cx('flex items-start gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-semibold', n.code === 'untrusted_content' ? 'bg-[#FFF1C9] text-[#6B4A00]' : 'bg-canvas text-graphite')}>
          <Icon name={n.code === 'not_legal_advice' ? 'scale' : n.code === 'untrusted_content' ? 'alert' : 'info'} size={12} />
          {t.has(`notice.${n.code}`) ? t(`notice.${n.code}`) : n.message}
        </p>
      ))}
    </div>
  );
}
