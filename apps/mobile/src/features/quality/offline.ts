/**
 * Offline audits: every change is written to the phone first (a draft per audit), then a sync queue pushes it to the
 * API whenever the device is online — photos first (local ids are swapped for server ids), then the changed answers
 * (merged per question on the server), then a queued completion. Nothing is lost when the connection drops mid-visit.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AuditAnswer } from '@bh/shared';
import { network } from '@/lib/network';
import { ApiError } from '@/lib/errors';
import { qualityApi, type AuditDetail } from './api';
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

export async function loadDraft(auditId: string): Promise<Draft | null> {
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
  for (const k of await draftStore.keys()) { const d = await loadDraft(k); if (d) out.push(d); }
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

/** Number of unsynced changes across this phone (questions, photos, completions). */
export async function pendingCount(): Promise<number> {
  let n = 0;
  for (const k of await draftStore.keys()) {
    const d = await loadDraft(k);
    if (d) n += d.dirty.length + d.photos.length + (d.complete ? 1 : 0);
  }
  return n;
}
