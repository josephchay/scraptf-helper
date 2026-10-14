import { describe, expect, it } from 'vitest';
import { NOTIFY_BODY_MAX, NOTIFY_TITLE_MAX, clip, notificationContent, notificationOptions } from '../../src/main/notify';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';

describe('notificationContent', () => {
  it('keeps a valid push and its SKU', () => {
    expect(notificationContent({ title: 'Profit: Team Captain', body: '+1 ref', sku: '378;6' })).toEqual({ title: 'Profit: Team Captain', body: '+1 ref', sku: '378;6' });
  });

  it('drops malformed pushes and tolerates a bad SKU', () => {
    expect(notificationContent(null)).toBeNull();
    expect(notificationContent({ title: '', body: 'x', sku: null })).toBeNull();
    expect(notificationContent({ title: 'x', body: 3 })).toBeNull();
    expect(notificationContent({ title: 'x', body: 'y', sku: 42 })).toEqual({ title: 'x', body: 'y', sku: null });
  });

  it('clips the title and body to what a toast shows', () => {
    const out = notificationContent({ title: 'T'.repeat(500), body: 'B'.repeat(2000), sku: null });
    expect(out?.title).toHaveLength(NOTIFY_TITLE_MAX);
    expect(out?.body).toHaveLength(NOTIFY_BODY_MAX);
    expect(out?.title.endsWith('...')).toBe(true);
    expect(clip('short', 10)).toBe('short');
  });
});

describe('notificationOptions (F6 silent)', () => {
  const data = { title: 'Candidate: Team Captain', body: 'Check scrap.tf, pay up to 1.22 ref' };

  it('passes notifications.silent to the Electron Notification', () => {
    expect(notificationOptions(data, { silent: true }, 'C:\\icon.png')).toEqual({ ...data, icon: 'C:\\icon.png', silent: true });
    expect(notificationOptions(data, { silent: false }, 'icon.png').silent).toBe(false);
  });

  it('plays the sound by default', () => {
    expect(DEFAULT_SETTINGS.notifications.silent).toBe(false);
    expect(notificationOptions(data, DEFAULT_SETTINGS.notifications, 'icon.png').silent).toBe(false);
    // A settings file from before v0.2 has no silent key at all.
    expect(notificationOptions(data, {} as { silent: boolean }, 'icon.png').silent).toBe(false);
  });
});
