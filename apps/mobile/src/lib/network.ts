import { useEffect, useSyncExternalStore } from 'react';
import NetInfo from '@react-native-community/netinfo';

/** Connectivity = device connectivity AND not simulating an outage (demo control in mock mode). */
let deviceOnline = true;
let simulatedOffline = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

let started = false;
function start() {
  if (started) return;
  started = true;
  NetInfo.addEventListener((s) => {
    const next = s.isConnected !== false;
    if (next !== deviceOnline) {
      deviceOnline = next;
      emit();
    }
  });
}

export const network = {
  isOnline: () => deviceOnline && !simulatedOffline,
  isSimulatedOffline: () => simulatedOffline,
  setSimulatedOffline(v: boolean) {
    simulatedOffline = v;
    emit();
  },
  subscribe(l: () => void) {
    start();
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useOnline(): boolean {
  useEffect(start, []);
  return useSyncExternalStore(network.subscribe, network.isOnline, network.isOnline);
}

export function useSimulatedOffline(): boolean {
  return useSyncExternalStore(network.subscribe, network.isSimulatedOffline, network.isSimulatedOffline);
}
