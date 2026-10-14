// Tray icon: context menu (show, quick entry, pause toggles, quit) and a
// tooltip summarising the latest status push.

import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import type { Logger } from '../service/contracts';
import type { AppStatus, ConnState } from '../shared/types';
import type { ServiceHostStatus } from './serviceHost';
import type { HotkeyStatus } from './settingsStore';

export interface TrayState {
  liveFeedEnabled: boolean;
  networkPaused: boolean;
  status: AppStatus | null;
  service: Pick<ServiceHostStatus, 'state' | 'nextRestartAt'>;
  hotkey: HotkeyStatus;
  now: number;
}

export interface TrayActions {
  showDashboard(): void;
  quickEntry(): void;
  setLiveFeedPaused(paused: boolean): void;
  setNetworkPaused(paused: boolean): void;
  quit(): void;
}

export interface TrayController {
  /** forceMenu rebuilds the menu even if unchanged (resets a checkbox after a refused toggle). */
  update(state: TrayState, forceMenu?: boolean): void;
  destroy(): void;
}

// Windows truncates tray tooltips at 127 characters.
const MAX_TOOLTIP = 127;

const FEED_LABELS: Record<ConnState, string> = {
  off: 'off',
  connecting: 'connecting',
  live: 'live',
  idle: 'idle',
  backoff: 'reconnecting',
  error: 'error',
  paused: 'paused',
  blocked: 'blocked',
};

export function trayTooltip(state: TrayState): string {
  const lines = ['TF2 Flip Desk'];
  const svc = state.service;
  if (svc.state === 'starting' || svc.state === 'idle') {
    lines.push('Starting...');
  } else if (svc.state === 'restarting') {
    // A clock time stays true while the tooltip sits unchanged; a countdown would not.
    lines.push(
      svc.nextRestartAt !== null && svc.nextRestartAt > state.now
        ? `Service restarting at ${new Date(svc.nextRestartAt).toLocaleTimeString()}`
        : 'Service restarting',
    );
  } else if (svc.state === 'stopping' || svc.state === 'stopped') {
    lines.push('Stopping...');
  } else if (state.networkPaused) {
    lines.push('Network paused');
  } else if (!state.status) {
    lines.push('Waiting for data...');
  } else {
    const c = state.status.counts;
    lines.push(`${c.profitable} profitable, ${c.highConfidence} high confidence`);
  }

  if (svc.state === 'ready' && !state.networkPaused) {
    if (!state.liveFeedEnabled) lines.push('Live feed paused');
    else if (state.status) lines.push(`Live feed ${FEED_LABELS[state.status.feed] ?? state.status.feed}`);
    if (state.status && state.status.setupNeeded.length > 0) lines.push('Setup needed: open Settings');
  }
  if (state.hotkey.error) lines.push('Quick-entry hotkey unavailable');

  let text = lines.join('\n');
  if (text.length > MAX_TOOLTIP) text = `${text.slice(0, MAX_TOOLTIP - 3)}...`;
  return text;
}

export function trayMenuTemplate(state: TrayState, actions: TrayActions): MenuItemConstructorOptions[] {
  const quick: MenuItemConstructorOptions = { label: 'Quick entry', click: () => actions.quickEntry() };
  if (state.hotkey.registered && state.hotkey.accelerator) {
    quick.accelerator = state.hotkey.accelerator;
    quick.registerAccelerator = false;
  }
  return [
    { label: 'Show dashboard', click: () => actions.showDashboard() },
    quick,
    { type: 'separator' },
    {
      label: 'Pause live feed',
      type: 'checkbox',
      checked: !state.liveFeedEnabled,
      click: (item) => actions.setLiveFeedPaused(item.checked),
    },
    {
      label: 'Pause all network',
      type: 'checkbox',
      checked: state.networkPaused,
      click: (item) => actions.setNetworkPaused(item.checked),
    },
    { type: 'separator' },
    { label: 'Quit TF2 Flip Desk', click: () => actions.quit() },
  ];
}

function menuKey(state: TrayState): string {
  return JSON.stringify([state.liveFeedEnabled, state.networkPaused, state.hotkey.registered, state.hotkey.accelerator]);
}

export function createTray(iconPath: string, actions: TrayActions, initial: TrayState, log: Logger): TrayController {
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) log.warn('tray icon image is missing or empty');
  const tray = new Tray(image);
  let lastMenuKey = '';
  let lastTooltip = '';

  tray.on('click', () => actions.showDashboard());

  function update(state: TrayState, forceMenu = false): void {
    if (tray.isDestroyed()) return;
    const key = menuKey(state);
    if (forceMenu || key !== lastMenuKey) {
      tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(state, actions)));
      lastMenuKey = key;
    }
    const tip = trayTooltip(state);
    if (tip !== lastTooltip) {
      tray.setToolTip(tip);
      lastTooltip = tip;
    }
  }

  update(initial);

  return {
    update,
    destroy() {
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
