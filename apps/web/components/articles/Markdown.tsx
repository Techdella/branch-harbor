import type { ReactNode } from 'react';
import { Icon } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { headingId } from '@/lib/articles';

/**
 * Renders the Markdown subset used by content/blog and content/guides (see lib/articles.ts). Content is authored in
 * this repository, so no HTML is accepted: everything is rendered as React elements.
 */

type Block =
  | { t: 'h'; level: 2 | 3; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'quote'; text: string }
  | { t: 'table'; head: string[]; rows: string[][] };

function parse(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  const isBlockStart = (l: string) => /^(#{2,3}\s|[-*]\s|\d+\.\s|>|\|)/.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{2,3})\s+(.+)$/.exec(line);
    if (h) {
      out.push({ t: 'h', level: h[1]!.length as 2 | 3, text: h[2]!.trim() });
      i++;
      continue;
    }
    if (/^[-*]\s/.test(line) || /^\d+\.\s/.test(line)) {
      const ordered = /^\d+\.\s/.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\d+\.\s/ : /^[-*]\s/).test(lines[i]!)) {
        let item = lines[i]!.replace(ordered ? /^\d+\.\s+/ : /^[-*]\s+/, '');
        i++;
        // Indented continuation lines belong to the item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!)) item += ' ' + lines[i++]!.trim();
        items.push(item);
      }
      out.push({ t: ordered ? 'ol' : 'ul', items });
      continue;
    }
    if (line.startsWith('>')) {
      const parts: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) parts.push(lines[i++]!.replace(/^>\s?/, ''));
      out.push({ t: 'quote', text: parts.join(' ').trim() });
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith('|')) {
        const cells = lines[i++]!.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
        rows.push(cells);
      }
      out.push({ t: 'table', head: rows[0] ?? [], rows: rows.slice(1) });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!)) para.push(lines[i++]!.trim());
    out.push({ t: 'p', text: para.join(' ') });
  }
  return out;
}

/** Inline: **bold**, *italic*, `code`, [text](href). */
function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const key = `${keyBase}-${n++}`;
    if (m[2]) nodes.push(<strong key={key} className="font-bold text-ink">{inline(m[2], key)}</strong>);
    else if (m[3]) nodes.push(<em key={key}>{m[3]}</em>);
    else if (m[4]) nodes.push(<code key={key} className="rounded-md bg-canvas px-1.5 py-0.5 text-[0.9em] font-semibold">{m[4]}</code>);
    else if (m[5] && m[6]) {
      const href = m[6];
      const cls = 'font-semibold text-ink underline decoration-line underline-offset-4 transition hover:decoration-ink';
      nodes.push(
        href.startsWith('/') ? (
          <Link key={key} href={href} className={cls}>
            {m[5]}
          </Link>
        ) : (
          <a key={key} href={href} className={cls} rel="noopener noreferrer">
            {m[5]}
          </a>
        ),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ source }: { source: string }) {
  const blocks = parse(source);
  return (
    <div className="flex flex-col gap-5 text-[17px] leading-[1.75] text-graphite">
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.t) {
          case 'h':
            return b.level === 2 ? (
              <h2 key={k} id={headingId(b.text)} className="mt-6 scroll-mt-28 text-[26px] leading-tight font-extrabold tracking-[-0.03em] text-ink md:text-[30px]">
                {inline(b.text, k)}
              </h2>
            ) : (
              <h3 key={k} id={headingId(b.text)} className="mt-2 scroll-mt-28 text-xl leading-snug font-extrabold tracking-[-0.02em] text-ink">
                {inline(b.text, k)}
              </h3>
            );
          case 'p':
            return <p key={k}>{inline(b.text, k)}</p>;
          case 'ul':
            return (
              <ul key={k} className="flex flex-col gap-2.5 ps-1">
                {b.items.map((it, j) => (
                  <li key={j} className="flex gap-3">
                    <span className="mt-[0.7em] h-1.5 w-1.5 shrink-0 rounded-full bg-ink" aria-hidden="true" />
                    <span>{inline(it, `${k}-${j}`)}</span>
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={k} className="flex flex-col gap-3">
                {b.items.map((it, j) => (
                  <li key={j} className="flex gap-3">
                    <span className="tabular mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-canvas text-sm font-extrabold text-ink" aria-hidden="true">
                      {j + 1}
                    </span>
                    <span>{inline(it, `${k}-${j}`)}</span>
                  </li>
                ))}
              </ol>
            );
          case 'quote': {
            const note = /^\*\*(Note|Not legal advice|Tip|Important)[^*]*\*\*/.test(b.text);
            return note ? (
              <aside key={k} className="flex gap-3 rounded-[20px] bg-butter p-5 text-[15px] leading-relaxed text-ink">
                <Icon name="info" size={20} className="mt-0.5 shrink-0" />
                <p>{inline(b.text, k)}</p>
              </aside>
            ) : (
              <blockquote key={k} className="border-s-4 border-ink ps-5 text-lg font-semibold text-ink">
                {inline(b.text, k)}
              </blockquote>
            );
          }
          case 'table':
            return (
              <div key={k} className="-mx-1 overflow-x-auto rounded-[20px] border border-line-soft" tabIndex={0} role="region" aria-label={b.head.join(', ')}>
                <table className="w-full min-w-[560px] border-collapse text-start text-[15px] leading-snug">
                  <thead className="bg-canvas">
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j} scope="col" className="px-4 py-3 text-start font-bold text-ink">
                          {inline(c, `${k}-h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri} className="border-t border-line-soft align-top">
                        {r.map((c, j) =>
                          j === 0 ? (
                            <th key={j} scope="row" className="px-4 py-3 text-start font-bold text-ink">
                              {inline(c, `${k}-${ri}-${j}`)}
                            </th>
                          ) : (
                            <td key={j} className="px-4 py-3">
                              {inline(c, `${k}-${ri}-${j}`)}
                            </td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}
