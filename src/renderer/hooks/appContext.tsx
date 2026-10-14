import type { PushContract } from '../../shared/rpc';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppStatus, DeepPartial, Scrap, SecretsStatus, Settings } from '../../shared/types';
import { isMock, rpc } from '../api';
import { errorMessage } from '../format';
import { useHashRoute } from './useHashRoute';
import { usePush } from './useRpc';
import { writePref } from './usePersistentState';

export type ToastTone = 'info' | 'good' | 'warn' | 'bad';

export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
}

export interface AppContextValue {
  isMock: boolean;
  status: AppStatus | null;
  settings: Settings | null;
  secrets: SecretsStatus | null;
  /** Current key price in scrap, or null until the first status arrives. */
  keyScrap: Scrap | null;
  /** Last connection problem talking to the app itself (not to a platform). */
  bridgeError: string | null;
  /** Background service process state pushed by main; null until the first push (assumed ready). */
  serviceState: PushContract['service.state'] | null;
  updateSettings: (patch: DeepPartial<Settings>) => Promise<Settings | null>;
  refreshStatus: () => void;
  setSecrets: (s: SecretsStatus) => void;
  segments: string[];
  navigate: (path: string) => void;
  itemSku: string | null;
  openItem: (sku: string) => void;
  closeItem: () => void;
  toasts: ToastItem[];
  toast: (text: string, tone?: ToastTone) => void;
  dismissToast: (id: number) => void;
  /** Bumped after local mutations so counts elsewhere refresh. */
  dataVersion: number;
  bumpData: () => void;
}

const Ctx = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

/** Applies theme and density to <html>; "system" follows prefers-color-scheme in CSS. */
export function applyAppearance(ui: Settings['ui'] | null | undefined): void {
  const root = document.documentElement;
  const theme = ui?.theme ?? 'system';
  root.dataset['theme'] = theme;
  root.dataset['density'] = ui?.density ?? 'comfortable';
  writePref('appearance', { theme, density: ui?.density ?? 'comfortable' });
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [serviceState, setServiceState] = useState<PushContract['service.state'] | null>(null);
  const [itemSku, setItemSku] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [dataVersion, setDataVersion] = useState(0);
  const toastSeq = useRef(1);
  const { segments, navigate } = useHashRoute();

  const toast = useCallback((text: string, tone: ToastTone = 'info') => {
    const id = toastSeq.current++;
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 8000 : 4500);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const refreshStatus = useCallback(() => {
    rpc('status.get')
      .then((s) => {
        setStatus(s);
        setBridgeError(null);
      })
      .catch((e: unknown) => setBridgeError(errorMessage(e)));
  }, []);

  useEffect(() => {
    refreshStatus();
    rpc('settings.get')
      .then(setSettings)
      .catch((e: unknown) => setBridgeError(errorMessage(e)));
    rpc('secrets.status')
      .then(setSecrets)
      .catch(() => setSecrets(null));
  }, [refreshStatus]);

  usePush('status.changed', setStatus);
  usePush('settings.changed', setSettings);
  // Notification clicks and the quick-entry window ask the dashboard to open an item.
  usePush('ui.openItem', (p) => {
    if (p && typeof p.sku === 'string' && p.sku.trim()) setItemSku(p.sku.trim());
  });
  const lastServiceState = useRef<string | null>(null);
  usePush('service.state', (p) => {
    if (!p || typeof p.state !== 'string') return;
    const prev = lastServiceState.current;
    lastServiceState.current = p.state;
    setServiceState(p);
    // A (re)started service has fresh status; fetch it once it is ready again.
    if (p.state === 'ready' && prev !== null && prev !== 'ready') refreshStatus();
  });

  useEffect(() => {
    if (settings) applyAppearance(settings.ui);
  }, [settings]);

  const updateSettings = useCallback(
    async (patch: DeepPartial<Settings>) => {
      try {
        const next = await rpc('settings.set', patch);
        setSettings(next);
        refreshStatus();
        return next;
      } catch (e) {
        toast(`Could not save settings: ${errorMessage(e)}`, 'bad');
        return null;
      }
    },
    [refreshStatus, toast],
  );

  const openItem = useCallback((sku: string) => setItemSku(sku), []);
  const closeItem = useCallback(() => setItemSku(null), []);
  const bumpData = useCallback(() => setDataVersion((v) => v + 1), []);

  const value = useMemo<AppContextValue>(
    () => ({
      isMock,
      status,
      settings,
      secrets,
      keyScrap: status?.keyPrice?.valueScrap ?? null,
      bridgeError,
      serviceState,
      updateSettings,
      refreshStatus,
      setSecrets,
      segments,
      navigate,
      itemSku,
      openItem,
      closeItem,
      toasts,
      toast,
      dismissToast,
      dataVersion,
      bumpData,
    }),
    [status, settings, secrets, bridgeError, serviceState, updateSettings, refreshStatus, segments, navigate, itemSku, openItem, closeItem, toasts, toast, dismissToast, dataVersion, bumpData],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
