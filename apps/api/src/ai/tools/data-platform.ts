import { z } from 'zod';
import { SALES_SOURCE_KINDS } from '@bh/shared';
import { defineTool, ToolError } from '../types.ts';
import { fmtMoney, itemsOf, table } from '../present.ts';
import { pickOne, plural, resolveLocation } from './_helpers.ts';

/**
 * Data platform: POS and booking sales connectors with the royalty reconciliation, the import wizard, bulk location
 * launches and opt-in network benchmarks. Writes are proposals: a resync, a gross-sales source, an import mapping
 * (validated, never run) and a bulk launch (sites always as drafts).
 */

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const FLAG_LABEL: Record<string, string> = {
  variance: 'self-reported sales differ from the connector beyond the threshold', missing_days: 'days missing from the connector', sync_failed: 'last sync failed',
  authorization_expired: 'connector authorisation expired', branchharbor_payments_ignored: 'BranchHarbor payments are not the royalty source', sandbox: 'sample (sandbox) data', foreign_currency: 'connector reports another currency',
};
const flagText = (f: string) => FLAG_LABEL[f] ?? f.replace(/_/g, ' ');

/** Reconciliation rows trimmed for the model and the tables (one row per location, amounts in its own currency). */
function reconRows(r: any) {
  return (r.rows ?? []).map((x: any) => {
    const conn = x.connectors?.[0] ?? null;
    const self = x.selfReported?.[0] ?? null;
    const flags: string[] = [...(x.flags ?? [])];
    if (conn?.missingDays) flags.push('missing_days');
    if (conn && conn.status !== 'connected') flags.push(conn.status === 'authorization_expired' ? 'authorization_expired' : 'sync_failed');
    return {
      locationId: x.location.id, location: x.location.name, currency: x.location.currency, source: x.source.source, provider: conn?.provider ?? null,
      branchharborMinor: x.branchharbor?.grossMinor ?? 0, connectorMinor: conn?.grossMinor ?? null, selfReportedMinor: self?.grossMinor ?? null,
      variancePct: self?.comparison?.variance?.pct ?? null, flags: [...new Set(flags)].filter((f) => f !== 'sandbox'), sandbox: (x.flags ?? []).includes('sandbox') || !!conn?.sandbox,
    };
  });
}

const getReconciliation = defineTool({
  name: 'get_reconciliation',
  kind: 'read',
  area: 'finance',
  modules: ['network.sales_connectors'],
  description: 'Royalty sales reconciliation for a period (default: the last closed royalty period): per location, BranchHarbor payments vs POS/booking connector sales vs self-reported figures, the gross-sales source used for royalties and any flags. Amounts stay in each location’s currency.',
  input: z.object({ from: ymd.optional(), to: ymd.optional(), location: z.string().max(120).optional() }),
  async run(ctx, i) {
    const loc = await resolveLocation(ctx, i.location);
    const r = await ctx.api.get(ctx.o('/sales-connectors/reconciliation'), { from: i.from, to: i.to });
    return { from: r.from, to: r.to, rows: reconRows(r).filter((x: any) => !loc || x.locationId === loc.id) };
  },
  present: (r) => {
    const flagged = r.rows.filter((x: any) => x.flags.length);
    return {
      summary: `Reconciliation ${r.from} to ${r.to}: ${plural(r.rows.length, 'location')}, ${flagged.length} flagged${flagged.length ? ` (${flagged.slice(0, 4).map((x: any) => `${x.location}: ${x.flags.map(flagText).join(', ')}`).join('; ')})` : ''}.`,
      blocks: r.rows.length ? [table(`Sales reconciliation ${r.from} – ${r.to}`, [{ key: 'location', label: 'Location' }, { key: 'source', label: 'Royalty source', kind: 'status' }, { key: 'branchharborMinor', label: 'BranchHarbor', kind: 'money' }, { key: 'connectorMinor', label: 'Connector', kind: 'money' }, { key: 'selfReportedMinor', label: 'Self-reported', kind: 'money' }, { key: 'variancePct', label: 'Variance %', kind: 'percent' }, { key: 'flagList', label: 'Flags' }],
        r.rows.map((x: any) => ({ ...x, flagList: x.flags.map(flagText).join('; ') || '—' })), { currencyKey: 'currency', note: r.rows.some((x: any) => x.sandbox) ? 'Some connectors run in sandbox mode with sample data.' : undefined })] : [],
      citations: [{ id: 'recon', title: 'Sales reconciliation', url: '/sales-connectors/reconciliation', sourceType: 'screen' }],
    };
  },
});

const listVarianceFlags = defineTool({
  name: 'list_variance_flags',
  kind: 'read',
  area: 'finance',
  modules: ['network.sales_connectors'],
  description: 'Only the locations whose sales need attention before royalties: self-reported sales that differ from connector data beyond the threshold, missing connector days, failed syncs and expired authorisations. Answers "sales variance" questions.',
  input: z.object({ from: ymd.optional(), to: ymd.optional() }),
  async run(ctx, i) {
    const r = await ctx.api.get(ctx.o('/sales-connectors/reconciliation'), { from: i.from, to: i.to });
    return { from: r.from, to: r.to, rows: reconRows(r).filter((x: any) => x.flags.some((f: string) => f !== 'branchharbor_payments_ignored')) };
  },
  present: (r, _i, ctx) => ({
    summary: r.rows.length
      ? `${plural(r.rows.length, 'location')} with sales flags for ${r.from} to ${r.to}: ${r.rows.map((x: any) => `${x.location} (${x.flags.filter((f: string) => f !== 'branchharbor_payments_ignored').map(flagText).join(', ')}${x.variancePct !== null ? `, ${x.variancePct}%: reported ${fmtMoney(x.selfReportedMinor, x.currency, ctx.locale)} vs connector ${fmtMoney(x.connectorMinor, x.currency, ctx.locale)}` : ''})`).join('; ')}.`
      : `No sales variance or sync flags for ${r.from} to ${r.to}.`,
    blocks: r.rows.length ? [table('Sales flags', [{ key: 'location', label: 'Location' }, { key: 'selfReportedMinor', label: 'Self-reported', kind: 'money' }, { key: 'connectorMinor', label: 'Connector', kind: 'money' }, { key: 'flagList', label: 'Flags' }],
      r.rows.map((x: any) => ({ ...x, flagList: x.flags.filter((f: string) => f !== 'branchharbor_payments_ignored').map((f: string) => (f === 'variance' && x.variancePct !== null ? `${flagText(f)} (${x.variancePct}%)` : flagText(f))).join('; ') })), { currencyKey: 'currency' })] : [],
    citations: [{ id: 'recon', title: 'Sales reconciliation', url: '/sales-connectors/reconciliation', sourceType: 'screen' }],
  }),
});

const connectorHealth = defineTool({
  name: 'get_sales_connector_health',
  kind: 'read',
  area: 'network',
  modules: ['network.sales_connectors'],
  description: 'POS and booking connectors per location (Square, Shopify, Lightspeed, Clover, Mindbody…): status, last sync, last error, and each location’s gross-sales source for royalties.',
  input: z.object({ location: z.string().max(120).optional() }),
  async run(ctx, i) {
    const loc = await resolveLocation(ctx, i.location);
    const r = await ctx.api.get(ctx.o('/sales-connectors'));
    const rows: any[] = [];
    for (const l of r.locations ?? []) {
      if (loc && l.id !== loc.id) continue;
      for (const c of l.connections ?? []) rows.push({ connectionId: c.id, location: l.name, provider: c.name ?? c.provider, status: c.status, mode: c.mode, lastSyncAt: c.lastSyncAt, lastSyncStatus: c.lastSyncStatus, lastError: c.lastError, source: l.source?.source ?? null });
    }
    return { connections: rows, locationsWithout: (r.locations ?? []).filter((l: any) => !l.connections?.length && (!loc || l.id === loc.id)).length };
  },
  present: (r) => {
    const bad = r.connections.filter((c: any) => c.status !== 'connected' || c.lastSyncStatus === 'failed');
    return {
      summary: `${plural(r.connections.length, 'connector')}; ${bad.length} need attention${bad.length ? ` (${bad.map((c: any) => `${c.location} ${c.provider}: ${c.status === 'connected' ? 'last sync failed' : c.status.replace(/_/g, ' ')}`).join('; ')})` : ''}; ${r.locationsWithout} location(s) without a connector.`,
      blocks: r.connections.length ? [table('Sales connectors', [{ key: 'location', label: 'Location' }, { key: 'provider', label: 'Connector' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'lastSyncStatus', label: 'Last sync', kind: 'status' }, { key: 'lastSyncAt', label: 'At', kind: 'date' }, { key: 'lastError', label: 'Error' }], r.connections)] : [],
      citations: [{ id: 'connectors', title: 'Sales connectors', url: '/sales-connectors', sourceType: 'screen' }],
    };
  },
});

async function findConnection(ctx: Parameters<typeof resolveLocation>[0], location: string, provider?: string) {
  const loc = await resolveLocation(ctx, location);
  const r = await ctx.api.get(ctx.o('/sales-connectors'));
  const l = (r.locations ?? []).find((x: any) => x.id === loc!.id);
  const conns = (l?.connections ?? []).filter((c: any) => !provider || c.provider === provider.toLowerCase() || String(c.name).toLowerCase() === provider.toLowerCase());
  if (!conns.length) throw new ToolError('not_found', `${loc!.name} has no${provider ? ` ${provider}` : ''} sales connector.`, 404);
  if (conns.length > 1) throw new ToolError('ambiguous', `${loc!.name} has several connectors (${conns.map((c: any) => c.provider).join(', ')}). Which one?`);
  return { loc: loc!, conn: conns[0], location: l };
}

const proposeResync = defineTool({
  name: 'propose_resync',
  kind: 'write',
  area: 'network',
  modules: ['network.sales_connectors'],
  risk: 'change',
  description: 'Resync a location’s POS / booking connector in the background: without dates the last three days, with from/to up to 92 days. Use after a failed sync or a variance flag.',
  input: z.object({ location: z.string().min(1).max(120), provider: z.string().max(40).optional(), from: ymd.optional(), to: ymd.optional() }).refine((i) => !!i.from === !!i.to, { message: 'Give both dates or neither' }),
  async preview(ctx, i) {
    const { loc, conn } = await findConnection(ctx, i.location, i.provider);
    if (conn.status === 'authorization_expired') throw new ToolError('reauthorise', `${loc.name}’s ${conn.name ?? conn.provider} connection has expired: someone with access must reconnect it on the Sales connectors screen first.`);
    return { title: `Resync ${conn.name ?? conn.provider} for ${loc.name}`, summary: i.from ? `Sales from ${i.from} to ${i.to}.` : 'The last three days.', details: [{ label: 'Last sync', value: `${conn.lastSyncStatus ?? '—'} ${conn.lastSyncAt ? `(${String(conn.lastSyncAt).slice(0, 16).replace('T', ' ')})` : ''}`.trim() }], link: '/sales-connectors' };
  },
  async execute(ctx, i) {
    const { conn } = await findConnection(ctx, i.location, i.provider);
    const run = await ctx.api.post(ctx.o(`/sales-connectors/${conn.id}/sync`), i.from ? { from: i.from, to: i.to } : {});
    return { result: { runId: run.id, status: run.status }, link: '/sales-connectors' };
  },
});

const proposeSalesSource = defineTool({
  name: 'propose_sales_source',
  kind: 'write',
  hqOnly: true,
  area: 'finance',
  modules: ['network.sales_connectors'],
  action: 'publish',
  risk: 'money',
  description: 'Set which gross-sales figure a location’s royalties use: BranchHarbor payments, one connector, or self-reported (with evidence), and the variance threshold that flags self-reported figures. Affects royalty statements still open. HQ only.',
  input: z.object({ location: z.string().min(1).max(120), source: z.enum(SALES_SOURCE_KINDS), provider: z.string().max(40).optional(), varianceThresholdPct: z.number().min(0).max(50).optional(), note: z.string().trim().max(500).optional() }),
  async preview(ctx, i) {
    const loc = await resolveLocation(ctx, i.location);
    const conn = i.source === 'connector' ? (await findConnection(ctx, i.location, i.provider)).conn : null;
    return {
      title: `Royalty sales source for ${loc!.name}: ${i.source === 'connector' ? conn.name ?? conn.provider : i.source.replace('_', ' ')}`,
      summary: 'Royalty statements still open for this location use the new source; issued statements do not change.',
      details: [...(i.varianceThresholdPct !== undefined ? [{ label: 'Variance threshold', value: `${i.varianceThresholdPct}%` }] : []), ...(i.note ? [{ label: 'Note', value: i.note }] : [])],
      link: '/sales-connectors',
      editable: [{ key: 'note', label: 'Note', kind: 'textarea' }],
    };
  },
  async execute(ctx, i) {
    const loc = await resolveLocation(ctx, i.location);
    const conn = i.source === 'connector' ? (await findConnection(ctx, i.location, i.provider)).conn : null;
    const r = await ctx.api.put(ctx.o(`/sales-connectors/sources/${loc!.id}`), { source: i.source, connectionId: conn?.id ?? null, ...(i.varianceThresholdPct !== undefined ? { varianceThresholdBps: Math.round(i.varianceThresholdPct * 100) } : {}), note: i.note ?? null });
    return { result: { source: r.source, openStatements: r.openStatements }, link: '/sales-connectors' };
  },
});

/* ------------------------------ Imports and launches ------------------------------ */

const importStatus = defineTool({
  name: 'get_import_status',
  kind: 'read',
  area: 'network',
  modules: ['settings.import'],
  description: 'Data imports (customers, staff, locations, products…): file, status, rows valid / with errors, created and updated counts, the first row errors and whether it can still be undone. Without an import, lists recent imports.',
  input: z.object({ import: z.string().max(200).optional().describe('Import id or file name') }),
  async run(ctx, i) {
    const list = itemsOf(await ctx.api.get(ctx.o('/imports')));
    if (!i.import) return { items: list.map((b) => ({ id: b.id, entity: b.entity, filename: b.filename, status: b.status, totalRows: b.totalRows, validRows: b.validRows, errorRows: b.errorRows, createdCount: b.createdCount, updatedCount: b.updatedCount, createdAt: b.createdAt })) };
    const b = pickOne(list, i.import, (x) => x.filename, (x) => x.id, 'import');
    const d = await ctx.api.get(ctx.o(`/imports/${b.id}`));
    return { batch: { id: d.id, entity: d.entity, filename: d.filename, status: d.status, headers: d.headers, mapping: d.mapping, totalRows: d.totalRows, validRows: d.validRows, errorRows: d.errorRows, createdCount: d.createdCount, updatedCount: d.updatedCount, skippedCount: d.skippedCount, errors: (d.errors ?? []).slice(0, 10), canUndo: d.canUndo, undoUntil: d.undoUntil } };
  },
  present: (r) => r.batch
    ? { summary: `${r.batch.filename} (${r.batch.entity}): ${r.batch.status}; ${r.batch.validRows}/${r.batch.totalRows} rows valid, ${r.batch.errorRows} with errors; ${r.batch.createdCount} created, ${r.batch.updatedCount} updated.${r.batch.errors.length ? ` First errors: ${r.batch.errors.slice(0, 3).map((e: any) => `row ${e.row} ${e.field ?? ''}: ${e.message}`).join('; ')}.` : ''}`, citations: [{ id: r.batch.id, title: r.batch.filename, url: `/import?batch=${r.batch.id}`, sourceType: 'import' }] }
    : { summary: `${plural(r.items.length, 'import')}: ${r.items.slice(0, 5).map((b: any) => `${b.filename} (${b.status})`).join('; ')}.`, blocks: r.items.length ? [table('Imports', [{ key: 'createdAt', label: 'Uploaded', kind: 'date' }, { key: 'filename', label: 'File' }, { key: 'entity', label: 'Type' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'validRows', label: 'Valid', kind: 'number' }, { key: 'errorRows', label: 'Errors', kind: 'number' }], r.items)] : [], citations: [{ id: 'import', title: 'Import', url: '/import', sourceType: 'screen' }] },
});

const launchBoard = defineTool({
  name: 'get_launch_board',
  kind: 'read',
  area: 'network',
  modules: ['network.bulk_launch'],
  description: 'Bulk location launches: name, status, progress (done / failed of total), whether sites were published or left as drafts, and the brand templates available.',
  input: z.object({}),
  run: (ctx) => ctx.api.get(ctx.o('/launches')),
  present: (r) => {
    const items = itemsOf(r);
    return {
      summary: `${plural(items.length, 'launch')}: ${items.slice(0, 5).map((l) => `${l.name} (${l.status}, ${l.done}/${l.total}${l.failed ? `, ${l.failed} failed` : ''})`).join('; ')}.`,
      blocks: items.length ? [table('Launches', [{ key: 'name', label: 'Launch' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'total', label: 'Locations', kind: 'number' }, { key: 'done', label: 'Done', kind: 'number' }, { key: 'failed', label: 'Failed', kind: 'number' }, { key: 'siteMode', label: 'Sites' }, { key: 'createdAt', label: 'Started', kind: 'date' }], items)] : [],
      citations: [{ id: 'launch', title: 'Bulk launch', url: '/launch', sourceType: 'screen' }],
    };
  },
});

const draftImportMapping = defineTool({
  name: 'draft_import_mapping',
  kind: 'write',
  area: 'network',
  modules: ['settings.import'],
  risk: 'change',
  description: 'Map an uploaded import file’s columns to BranchHarbor fields (field key → column header) and validate it. Nothing is imported: the person reviews the row errors and runs the import from the Import screen.',
  input: z.object({ import: z.string().min(1).max(200).describe('Import id or file name'), mapping: z.record(z.string().max(60), z.string().max(200).nullable()) }),
  async preview(ctx, i) {
    const list = itemsOf(await ctx.api.get(ctx.o('/imports')));
    const b = pickOne(list, i.import, (x) => x.filename, (x) => x.id, 'import');
    if (!['uploaded', 'validated'].includes(b.status)) throw new ToolError('not_editable', `${b.filename} is ${b.status}; only uploaded or validated imports can be remapped.`, 409);
    const missing = Object.values(i.mapping).filter((h) => h && !b.headers.includes(h));
    if (missing.length) throw new ToolError('unknown_column', `These columns are not in ${b.filename}: ${missing.join(', ')}. Columns: ${b.headers.join(', ')}.`);
    return { title: `Map the columns of ${b.filename} (${b.entity})`, summary: 'Validates the file with this mapping. Nothing is imported until you run it on the Import screen.', details: Object.entries(i.mapping).map(([k, h]) => ({ label: k, value: h ?? '(not imported)' })), link: `/import?batch=${b.id}` };
  },
  async execute(ctx, i) {
    const list = itemsOf(await ctx.api.get(ctx.o('/imports')));
    const b = pickOne(list, i.import, (x) => x.filename, (x) => x.id, 'import');
    const mapping = Object.fromEntries(Object.entries(i.mapping).map(([k, h]) => [k, h ? b.headers.indexOf(h) : null]));
    const r = await ctx.api.put(ctx.o(`/imports/${b.id}/mapping`), { mapping, options: {} });
    return { result: { validRows: r.counts?.valid ?? null, errorRows: r.counts?.invalid ?? null }, link: `/import?batch=${b.id}` };
  },
});

const proposeBulkLaunch = defineTool({
  name: 'propose_bulk_launch',
  kind: 'write',
  area: 'network',
  modules: ['network.bulk_launch'],
  risk: 'bulk',
  description: 'Launch the locations of a completed or validated locations import in one go: creates the locations, their sites from a brand template (always as drafts, never published) and listings data, optionally inviting staff. HQ reviews and publishes the sites afterwards.',
  input: z.object({ name: z.string().trim().min(1).max(120), import: z.string().min(1).max(200).describe('Locations import id or file name'), template: z.string().max(120).optional(), locationStatus: z.enum(['onboarding', 'opening_soon']).default('opening_soon'), inviteStaff: z.boolean().default(false) }),
  async preview(ctx, i) {
    const list = itemsOf(await ctx.api.get(ctx.o('/imports'))).filter((b) => b.entity === 'locations');
    const b = pickOne(list, i.import, (x) => x.filename, (x) => x.id, 'locations import');
    const parsed = await ctx.api.post(ctx.o('/launches/parse'), { importBatchId: b.id });
    const boards = await ctx.api.get(ctx.o('/launches'));
    const tpl = i.template ? pickOne(boards.templates ?? [], i.template, (t: any) => t.name, (t: any) => t.id, 'site template') : null;
    return {
      title: `Launch “${i.name}”: ${plural(parsed.rows.length, 'location')} from ${b.filename}`,
      summary: `Sites are created as drafts${tpl ? ` from “${tpl.name}”` : ''}; locations start as ${i.locationStatus.replace('_', ' ')}.${parsed.errors?.length ? ` ${parsed.errors.length} row(s) have errors and will fail.` : ''}`,
      details: [{ label: 'Locations', value: parsed.rows.map((x: any) => x.name).join(', ').slice(0, 600) }, { label: 'Staff invitations', value: i.inviteStaff ? 'Sent' : 'Not sent' }],
      link: '/launch',
      editable: [{ key: 'name', label: 'Launch name', kind: 'text' }],
    };
  },
  async execute(ctx, i) {
    const list = itemsOf(await ctx.api.get(ctx.o('/imports'))).filter((b) => b.entity === 'locations');
    const b = pickOne(list, i.import, (x) => x.filename, (x) => x.id, 'locations import');
    const parsed = await ctx.api.post(ctx.o('/launches/parse'), { importBatchId: b.id });
    const boards = await ctx.api.get(ctx.o('/launches'));
    const tpl = i.template ? pickOne(boards.templates ?? [], i.template, (t: any) => t.name, (t: any) => t.id, 'site template') : null;
    const l = await ctx.api.post(ctx.o('/launches'), { name: i.name, templateId: tpl?.id ?? null, siteMode: 'draft', locationStatus: i.locationStatus, inviteStaff: i.inviteStaff, rows: parsed.rows, importBatchId: b.id });
    return { result: { launchId: l.id, status: l.status, total: l.total }, link: '/launch' };
  },
});

/* ------------------------------ Benchmarks ------------------------------ */

const getBenchmarks = defineTool({
  name: 'get_benchmarks',
  kind: 'read',
  area: 'network',
  modules: ['network.benchmarks'],
  networkOnly: true,
  description: 'Your network against similar networks (same industry and region) as percentiles only: for each metric, your percentile in an anonymised, noised cohort and the cohort size. Needs the business to have opted in. Never use it to estimate another business’s figures.',
  input: z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('YYYY-MM, default last full month') }),
  async run(ctx, i) {
    const r = await ctx.api.get(ctx.o('/benchmarks'), { period: i.period });
    // Percentiles only: the cohort distribution values are left out on purpose.
    return { period: r.period, optedIn: r.optedIn, region: r.region, metrics: (r.metrics ?? []).map((m: any) => ({ metric: m.metric, currency: m.currency ?? null, percentile: m.percentile ?? null, cohortSize: m.cohort?.size ?? null, cohortScope: m.cohort?.scope ?? null, status: m.status })) };
  },
  present: (r) => ({
    summary: r.optedIn
      ? `Benchmarks ${r.period}: ${r.metrics.filter((m: any) => m.percentile !== null).map((m: any) => `${m.metric.replace(/_/g, ' ')}${m.currency ? ` (${m.currency})` : ''}: ${m.percentile}th percentile`).join('; ') || 'no cohort large enough yet'}.`
      : 'This business has not opted in to network benchmarks; HQ can opt in on the Benchmarks screen.',
    blocks: r.metrics.length ? [table(`Benchmarks ${r.period}`, [{ key: 'metric', label: 'Metric' }, { key: 'currency', label: 'Currency' }, { key: 'percentile', label: 'Your percentile', kind: 'number' }, { key: 'cohortSize', label: 'Cohort size', kind: 'number' }, { key: 'status', label: 'Status', kind: 'status' }], r.metrics.map((m: any) => ({ ...m, metric: m.metric.replace(/_/g, ' ') })))] : [],
    citations: [{ id: 'benchmarks', title: 'Benchmarks', url: '/benchmarks', sourceType: 'screen' }],
  }),
});

export default [getReconciliation, listVarianceFlags, connectorHealth, proposeResync, proposeSalesSource, importStatus, launchBoard, draftImportMapping, proposeBulkLaunch, getBenchmarks];
