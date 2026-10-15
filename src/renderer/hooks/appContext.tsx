import type { PushContract } from '../../shared/rpc';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppStatus, DeepPartial, Scrap, SecretsStatus, Settings } from '../../shared/types';
import { isMock, rpc } from '../api';
import { errorMessage } from '../format';
import { createServiceStateTracker, type ServiceStateTracker } from '../serviceStateModel';
import { createToastTimers, pushToast, toastTimeoutMs, type ToastHold, type ToastItem, type ToastOptions, type ToastTimers, type ToastTone } from '../toastModel';
import { useHashRoute } from './useHashRoute';
import { usePush } from './useRpc';
import { writePref } from './usePersistentState';

export type { ToastAction, ToastHold, ToastItem, ToastOptions, ToastTone } from '../toastModel';

export interface AppContextValue {
  isMock: boolean;
  status: AppStatus | null;
  settings: Settings | null;
  secrets: SecretsStatus | null;
  /** Current key price in scrap, or null until the first status arrives. */
  keyScrap: Scrap | null;
  /** Last connection problem talking to the app itself (not to a platform). */
  bridgeError: string | null;
  /** Background service process state from main (its push, or 'app.serviceState' on load); null until known (assumed ready). */
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
  /**
   * Shows a toast; returns its id. With `opts.action` (e.g. Undo) it stays 12 s by default, pauses
   * while hovered or focused, and the action button runs onClick and dismisses it (H3).
   */
  toast: (text: string, tone?: ToastTone, opts?: ToastOptions) => number;
  dismissToast: (id: number) => void;
  /** Hover or focus on an action toast holds its countdown (ToastStack calls this). */
  holdToast: (id: number, why: ToastHold, on: boolean) => void;
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

  // A toast pushed out of a full stack keeps its countdown; it expires as a no-op filter.
  const toastTimers = useRef<ToastTimers | null>(null);
  toastTimers.current ??= createToastTimers((id) => setToasts((t) => t.filter((x) => x.id !== id)));
  useEffect(() => () => toastTimers.current?.clearAll(), []);
  const toast = useCallback((text: string, tone: ToastTone = 'info', opts?: ToastOptions): number => {
    const id = toastSeq.current++;
    const item: ToastItem = { id, text, tone, timeoutMs: toastTimeoutMs(tone, opts), ...(opts?.action ? { action: opts.action } : {}) };
    setToasts((t) => pushToast(t, item));
    toastTimers.current?.start(id, item.timeoutMs, { pausable: item.action !== undefined });
    return id;
  }, []);
  const dismissToast = useCallback((id: number) => {
    toastTimers.current?.clear(id);
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);
  const holdToast = useCallback((id: number, why: ToastHold, on: boolean) => toastTimers.current?.hold(id, why, on), []);

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
  const serviceTracker = useRef<ServiceStateTracker | null>(null);
  serviceTracker.current ??= createServiceStateTracker(setServiceState, refreshStatus);
  usePush('service.state', (p) => serviceTracker.current?.onPush(p));
  // The push is sent once per change; a page loaded after it (crash reload, late first open) asks main.
  useEffect(() => {
    rpc('app.serviceState')
      .then((p) => serviceTracker.current?.onCurrent(p))
      .catch(() => undefined);
  }, []);

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
      holdToast,
      dataVersion,
      bumpData,
    }),
    [status, settings, secrets, bridgeError, serviceState, updateSettings, refreshStatus, segments, navigate, itemSku, openItem, closeItem, toasts, toast, dismissToast, holdToast, dataVersion, bumpData],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
