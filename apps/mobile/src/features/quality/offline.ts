/**
 * Offline audits: every change is written to the phone first (a draft per audit), then a sync queue pushes it to the
 * API whenever the device is online — photos first (local ids are swapped for server ids), then the changed answers
 * (merged per question on the server), then a queued completion. Nothing is lost when the connection drops mid-visit.
 *
 * The same queue carries self-check runs (opening, closing and temperature checks: answers, photos and the submit)
 * and corrective-action evidence (photos of the fix and the "fixed" submission), stored next to the audit drafts
 * under their own key prefix.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AuditAnswer } from '@bh/shared';
import { network } from '@/lib/network';
import { ApiError } from '@/lib/errors';
import { supplyApi, type RunDetail } from '../supply/api';
import { qualityApi, type AuditDetail, type FileRef } from './api';
import { draftStore } from './store';

export interface PendingPhoto { localId: string; questionId: string; base64: string; mime: string }
export interface Draft {
  orgId: string;
  auditId: string;
  /** The audit as last loaded, so it opens offline. */
  audit: AuditDetail;
  answers: Record<string, AuditAnswer>;
  dirty: string[];
  photos: PendingPhoto[];
  /** Server ids for photos already uploaded from this phone (local id → server id). */
  uploaded: Record<string, string>;
  complete: { summary: string | null } | null;
  savedAt: string | null;
  lastError: string | null;
}

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';
let syncState: SyncState = 'idle';
let version = 0;
const listeners = new Set<() => void>();
const emit = () => { version++; listeners.forEach((l) => l()); };
const setState = (s: SyncState) => { syncState = s; emit(); };

const key = (auditId: string) => auditId;
const cache = new Map<string, Draft>();

/** Self-check runs and corrective-action evidence share the store under these key prefixes (audits use their id). */
const SC = 'sc_';
const EV = 'ev_';
const isAuditKey = (k: string) => !k.startsWith(SC) && !k.startsWith(EV);

export async function loadDraft(auditId: string): Promise<Draft | null> {
  if (!isAuditKey(auditId)) return null;
  if (cache.has(auditId)) return cache.get(auditId)!;
  const raw = await draftStore.read(key(auditId));
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Draft;
    cache.set(auditId, d);
    return d;
  } catch {
    return null;
  }
}

async function persist(d: Draft) {
  cache.set(d.auditId, d);
  await draftStore.write(key(d.auditId), JSON.stringify(d));
  emit();
}

/** Starts (or refreshes) the local draft from the server copy, keeping unsynced local changes. */
export async function openDraft(orgId: string, audit: AuditDetail): Promise<Draft> {
  const existing = await loadDraft(audit.id);
  const server = Object.fromEntries(Object.entries(audit.answers).map(([k, { photos: _p, ...v }]) => [k, v as AuditAnswer]));
  const d: Draft = existing
    ? { ...existing, audit, answers: { ...server, ...Object.fromEntries(existing.dirty.map((q) => [q, existing.answers[q]!])) } }
    : { orgId, auditId: audit.id, audit, answers: server, dirty: [], photos: [], uploaded: {}, complete: null, savedAt: null, lastError: null };
  await persist(d);
  return d;
}

export async function setAnswer(auditId: string, questionId: string, patch: Partial<AuditAnswer>) {
  const d = await loadDraft(auditId);
  if (!d) return;
  const next: Draft = { ...d, answers: { ...d.answers, [questionId]: { ...d.answers[questionId], ...patch } }, dirty: [...new Set([...d.dirty, questionId])] };
  await persist(next);
  void syncAll();
}

/** Adds a photo taken on the phone; it gets a local id until it uploads. */
export async function addPhoto(auditId: string, questionId: string, base64: string, mime: string) {
  const d = await loadDraft(auditId);
  if (!d) return;
  const localId = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const ids = [...(d.answers[questionId]?.photoIds ?? []), localId];
  await persist({ ...d, photos: [...d.photos, { localId, questionId, base64, mime }], answers: { ...d.answers, [questionId]: { ...d.answers[questionId], photoIds: ids } }, dirty: [...new Set([...d.dirty, questionId])] });
  void syncAll();
}

export async function queueComplete(auditId: string, summary: string | null) {
  const d = await loadDraft(auditId);
  if (!d) return;
  await persist({ ...d, complete: { summary } });
  await syncAll();
}

export async function discardDraft(auditId: string) {
  cache.delete(auditId);
  await draftStore.remove(key(auditId));
  emit();
}

const isNetwork = (e: unknown) => e instanceof ApiError && (e.code === 'network_error' || e.status === 0);

/** Pushes one draft: photos, then answers, then completion. Returns the completed audit when it finished. */
async function syncDraft(d0: Draft): Promise<AuditDetail | null> {
  let d = d0;
  // 1. Photos (each once; a retry after a dropped response may upload a duplicate, which is harmless).
  for (const p of [...d.photos]) {
    const up = await qualityApi.uploadPhoto(d.orgId, d.auditId, { filename: `${p.questionId}.jpg`, contentType: p.mime, dataBase64: p.base64 });
    const swap = (ids?: string[]) => ids?.map((x) => (x === p.localId ? up.id : x));
    d = {
      ...d, photos: d.photos.filter((x) => x.localId !== p.localId), uploaded: { ...d.uploaded, [p.localId]: up.id },
      answers: Object.fromEntries(Object.entries(d.answers).map(([k, v]) => [k, v.photoIds ? { ...v, photoIds: swap(v.photoIds) } : v])),
      audit: { ...d.audit, answers: { ...d.audit.answers, [p.questionId]: { ...d.audit.answers[p.questionId], photos: [...(d.audit.answers[p.questionId]?.photos ?? []), up] } } },
    };
    await persist(d);
  }
  // 2. Changed answers (merged per question on the server).
  if (d.dirty.length && !d.complete) {
    const batch = Object.fromEntries(d.dirty.map((q) => [q, d.answers[q]!]));
    const r = await qualityApi.saveAnswers(d.orgId, d.auditId, batch);
    const latest = (await loadDraft(d.auditId)) ?? d;
    // Questions changed again while saving stay dirty.
    const still = latest.dirty.filter((q) => JSON.stringify(latest.answers[q]) !== JSON.stringify(batch[q]));
    d = { ...latest, dirty: still, savedAt: r.savedAt, lastError: null };
    await persist(d);
  }
  // 3. Completion (sends any remaining answers with it).
  if (d.complete) {
    const pending = Object.fromEntries(d.dirty.map((q) => [q, d.answers[q]!]));
    const done = await qualityApi.complete(d.orgId, d.auditId, d.complete.summary, pending);
    await discardDraft(d.auditId);
    return done;
  }
  return null;
}

let running: Promise<void> | null = null;
/** Syncs every draft on this phone. Safe to call often: runs one at a time. */
export function syncAll(): Promise<void> {
  running ??= (async () => {
    if (!network.isOnline()) { setState('offline'); return; }
    setState('syncing');
    let failed = false;
    for (const k of await draftStore.keys()) {
      if (k.startsWith(SC) || k.startsWith(EV)) {
        const r = await loadExtra(k);
        if (!r || !hasWork(r)) continue;
        try {
          if (r.kind === 'self_check') await syncSelfCheck(r);
          else await syncEvidence(r);
        } catch (e) {
          if (isNetwork(e)) { setState('offline'); return; }
          failed = true;
          const cur = (await loadExtra(k)) ?? r;
          await persistExtra(cur.kind === 'self_check' ? { ...cur, lastError: e instanceof Error ? e.message : String(e), complete: null } : { ...cur, lastError: e instanceof Error ? e.message : String(e), submit: false });
        }
        continue;
      }
      const d = await loadDraft(k);
      if (!d || (!d.dirty.length && !d.photos.length && !d.complete)) continue;
      try {
        await syncDraft(d);
      } catch (e) {
        if (isNetwork(e)) { setState('offline'); return; }
        failed = true;
        await persist({ ...((await loadDraft(k)) ?? d), lastError: e instanceof Error ? e.message : String(e), complete: null });
      }
    }
    setState(failed ? 'error' : 'idle');
  })().finally(() => { running = null; });
  return running;
}

let started = false;
/** Starts background syncing: when the device comes back online, and every 30 seconds while drafts wait. */
export function startOfflineSync() {
  if (started) return;
  started = true;
  network.subscribe(() => { if (network.isOnline()) void syncAll(); });
  setInterval(() => void syncAll(), 30_000);
  void syncAll();
}

export function useSyncState() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => syncState, () => syncState);
}

/** The local draft of an audit, kept up to date as changes are saved and synced. */
export function useDraft(auditId: string | null) {
  const v = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => version, () => version);
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (!auditId) return;
    let live = true;
    void loadDraft(auditId).then((d) => live && setDraft(d));
    return () => { live = false; };
  }, [auditId, v]);
  return draft;
}

/** Every audit kept on this phone (opened or prepared for offline use). */
export async function listDrafts(): Promise<Draft[]> {
  const out: Draft[] = [];
  for (const k of await draftStore.keys()) { if (!isAuditKey(k)) continue; const d = await loadDraft(k); if (d) out.push(d); }
  return out;
}

/** Keeps the audits assigned to me on the phone so they open without a connection at the location. */
export async function prepareOffline(orgId: string, auditIds: string[]) {
  for (const id of auditIds) {
    try {
      const a = await qualityApi.audit(orgId, id);
      if (a.permissions.conduct) await openDraft(orgId, a);
    } catch {
      /* try again next time */
    }
  }
}

/** Number of unsynced changes across this phone (questions, photos, completions, self-checks and evidence). */
export async function pendingCount(): Promise<number> {
  let n = 0;
  for (const k of await draftStore.keys()) {
    if (!isAuditKey(k)) { const r = await loadExtra(k); if (r) n += pendingOf(r); continue; }
    const d = await loadDraft(k);
    if (d) n += d.dirty.length + d.photos.length + (d.complete ? 1 : 0);
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Self-check runs and corrective-action evidence (same queue)         */
/* ------------------------------------------------------------------ */

/** A self-check run kept on the phone: the run as last loaded, local answers and photos, and a queued submit. */
export interface SelfCheckDraft {
  kind: 'self_check';
  orgId: string;
  runId: string;
  run: RunDetail;
  answers: Record<string, AuditAnswer>;
  dirty: string[];
  photos: PendingPhoto[];
  uploaded: Record<string, string>;
  /** Server copies of photos uploaded from this phone (for showing them again offline). */
  photoUrls: Record<string, string>;
  complete: { note: string | null } | null;
  /** The run as the server returned it once submitted (kept until the screen reloads it). */
  done: RunDetail | null;
  savedAt: string | null;
  lastError: string | null;
}

/** Evidence for a corrective action: photos of the fix taken on the phone, and a queued "fixed" submission. */
export interface EvidenceJob {
  kind: 'evidence';
  orgId: string;
  auditId: string;
  actionId: string;
  photos: PendingPhoto[];
  uploaded: FileRef[];
  note: string;
  submit: boolean;
  submitted: boolean;
  lastError: string | null;
}

type Extra = SelfCheckDraft | EvidenceJob;
const extras = new Map<string, Extra>();
const keyOf = (r: Extra) => (r.kind === 'self_check' ? `${SC}${r.runId}` : `${EV}${r.actionId}`);
const hasWork = (r: Extra) => (r.kind === 'self_check' ? r.dirty.length > 0 || r.photos.length > 0 || !!r.complete : r.photos.length > 0 || r.submit);
const pendingOf = (r: Extra) => (r.kind === 'self_check' ? r.dirty.length + r.photos.length + (r.complete ? 1 : 0) : r.photos.length + (r.submit ? 1 : 0));
const localId = () => `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function loadExtra(key: string): Promise<Extra | null> {
  if (extras.has(key)) return extras.get(key)!;
  const raw = await draftStore.read(key);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Extra;
    extras.set(key, r);
    return r;
  } catch {
    return null;
  }
}

async function persistExtra(r: Extra) {
  extras.set(keyOf(r), r);
  await draftStore.write(keyOf(r), JSON.stringify(r));
  emit();
}

async function removeExtra(key: string) {
  extras.delete(key);
  await draftStore.remove(key);
  emit();
}

export const loadSelfCheck = async (runId: string) => (await loadExtra(`${SC}${runId}`)) as SelfCheckDraft | null;

/** Keeps a self-check run on the phone (or refreshes it from the server, keeping unsynced local answers). */
export async function openSelfCheck(orgId: string, run: RunDetail): Promise<SelfCheckDraft> {
  const existing = await loadSelfCheck(run.id);
  const d: SelfCheckDraft = existing
    ? { ...existing, run, answers: { ...run.answers, ...Object.fromEntries(existing.dirty.map((q) => [q, existing.answers[q]!])) }, done: run.status === 'completed' ? run : existing.done }
    : { kind: 'self_check', orgId, runId: run.id, run, answers: { ...run.answers }, dirty: [], photos: [], uploaded: {}, photoUrls: {}, complete: null, done: null, savedAt: null, lastError: null };
  await persistExtra(d);
  return d;
}

export async function setSelfCheckAnswer(runId: string, questionId: string, answer: AuditAnswer) {
  const d = await loadSelfCheck(runId);
  if (!d) return;
  await persistExtra({ ...d, answers: { ...d.answers, [questionId]: answer }, dirty: [...new Set([...d.dirty, questionId])] });
  void syncAll();
}

/** A photo for a self-check item, taken on the phone; it gets a local id until it uploads. */
export async function addSelfCheckPhoto(runId: string, questionId: string, base64: string, mime: string) {
  const d = await loadSelfCheck(runId);
  if (!d) return;
  const id = localId();
  const a = d.answers[questionId] ?? {};
  await persistExtra({ ...d, photos: [...d.photos, { localId: id, questionId, base64, mime }], answers: { ...d.answers, [questionId]: { ...a, photoIds: [...(a.photoIds ?? []), id] } }, dirty: [...new Set([...d.dirty, questionId])] });
  void syncAll();
}

export async function queueSelfCheckComplete(runId: string, note: string | null) {
  const d = await loadSelfCheck(runId);
  if (!d) return;
  await persistExtra({ ...d, complete: { note }, lastError: null });
  await syncAll();
}

/** Forgets a finished self-check (after the screen showed the result). */
export const discardSelfCheck = (runId: string) => removeExtra(`${SC}${runId}`);

async function syncSelfCheck(d0: SelfCheckDraft) {
  let d = d0;
  for (const p of [...d.photos]) {
    const up = await supplyApi.uploadRunPhoto(d.orgId, d.runId, { filename: `${p.questionId}.jpg`, contentType: p.mime, dataBase64: p.base64 });
    const swap = (ids?: string[]) => ids?.map((x) => (x === p.localId ? up.id : x));
    d = {
      ...d, photos: d.photos.filter((x) => x.localId !== p.localId), uploaded: { ...d.uploaded, [p.localId]: up.id }, photoUrls: { ...d.photoUrls, [up.id]: up.url },
      answers: Object.fromEntries(Object.entries(d.answers).map(([k, v]) => [k, v.photoIds ? { ...v, photoIds: swap(v.photoIds) } : v])),
    };
    await persistExtra(d);
  }
  if (d.dirty.length && !d.complete) {
    const batch = Object.fromEntries(d.dirty.map((q) => [q, d.answers[q]!]));
    const r = await supplyApi.saveRun(d.orgId, d.runId, batch);
    const latest = (await loadSelfCheck(d.runId)) ?? d;
    const still = latest.dirty.filter((q) => JSON.stringify(latest.answers[q]) !== JSON.stringify(batch[q]));
    d = { ...latest, dirty: still, savedAt: r.savedAt, lastError: null };
    await persistExtra(d);
  }
  if (d.complete) {
    const done = await supplyApi.completeRun(d.orgId, d.runId, d.answers, d.complete.note ?? undefined);
    await persistExtra({ ...d, dirty: [], complete: null, done, run: done, lastError: null });
  }
}

/** Self-check runs kept on this phone (for opening them without a connection). */
export async function listSelfChecks(): Promise<SelfCheckDraft[]> {
  const out: SelfCheckDraft[] = [];
  for (const k of await draftStore.keys()) if (k.startsWith(SC)) { const r = await loadExtra(k); if (r?.kind === 'self_check') out.push(r); }
  return out;
}

/** Keeps today's runs that this person fills in on the phone, so they open at the location without a connection. */
export async function prepareSelfChecksOffline(orgId: string, runIds: string[]) {
  for (const id of runIds) {
    try {
      const run = await supplyApi.run(orgId, id);
      if (run.canFill && run.status !== 'completed' && run.status !== 'missed') await openSelfCheck(orgId, run);
    } catch {
      /* try again next time */
    }
  }
}

export const loadEvidence = async (actionId: string) => (await loadExtra(`${EV}${actionId}`)) as EvidenceJob | null;

/** A photo of the fix for a corrective action, kept on the phone until it uploads. */
export async function addEvidencePhoto(orgId: string, auditId: string, actionId: string, base64: string, mime: string) {
  const j = (await loadEvidence(actionId)) ?? { kind: 'evidence' as const, orgId, auditId, actionId, photos: [], uploaded: [], note: '', submit: false, submitted: false, lastError: null };
  await persistExtra({ ...j, photos: [...j.photos, { localId: localId(), questionId: '', base64, mime }], lastError: null });
  void syncAll();
}

/** Marks the action fixed with the note: sent with the photos as soon as they are uploaded (now, or when back online). */
export async function queueEvidenceSubmit(orgId: string, auditId: string, actionId: string, note: string) {
  const j = (await loadEvidence(actionId)) ?? { kind: 'evidence' as const, orgId, auditId, actionId, photos: [], uploaded: [], note: '', submit: false, submitted: false, lastError: null };
  await persistExtra({ ...j, note, submit: true, lastError: null });
  await syncAll();
}

export const discardEvidence = (actionId: string) => removeExtra(`${EV}${actionId}`);

async function syncEvidence(j0: EvidenceJob) {
  let j = j0;
  for (const p of [...j.photos]) {
    const up = await qualityApi.uploadEvidence(j.orgId, j.actionId, { filename: `evidence-${p.localId}.jpg`, contentType: p.mime, dataBase64: p.base64 });
    j = { ...j, photos: j.photos.filter((x) => x.localId !== p.localId), uploaded: [...j.uploaded, up] };
    await persistExtra(j);
  }
  if (j.submit && j.uploaded.length) {
    await qualityApi.submitAction(j.orgId, j.actionId, j.note, j.uploaded.map((u) => u.id));
    await persistExtra({ ...j, submit: false, submitted: true, lastError: null });
  }
}

/** A self-check run or evidence job kept on this phone, kept up to date as it changes and syncs. */
function useExtra<T extends Extra>(key: string | null) {
  const v = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => version, () => version);
  const [r, setR] = useState<T | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    void loadExtra(key).then((x) => live && setR(x as T | null));
    return () => { live = false; };
  }, [key, v]);
  return r;
}

export const useSelfCheckDraft = (runId: string | null) => useExtra<SelfCheckDraft>(runId ? `${SC}${runId}` : null);
export const useEvidenceJob = (actionId: string | null) => useExtra<EvidenceJob>(actionId ? `${EV}${actionId}` : null);
