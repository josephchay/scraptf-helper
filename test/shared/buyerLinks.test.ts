// F3: the drawer's buyer actions open these profile pages through 'links.open',
// so they must pass the external-link allowlist as built.

import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl } from '../../src/shared/links';

const STEAMID = '76561198012345678';

describe('buyer profile links', () => {
  it('allows the backpack.tf and Steam profile of a SteamID64', () => {
    expect(isAllowedExternalUrl(`https://backpack.tf/profiles/${STEAMID}`)).toBe(true);
    expect(isAllowedExternalUrl(`https://steamcommunity.com/profiles/${STEAMID}`)).toBe(true);
  });

  it('still refuses look-alikes and the Steam redirector', () => {
    expect(isAllowedExternalUrl(`http://backpack.tf/profiles/${STEAMID}`)).toBe(false);
    expect(isAllowedExternalUrl(`https://backpack.tf.evil.example/profiles/${STEAMID}`)).toBe(false);
    expect(isAllowedExternalUrl(`https://steamcommunity.com/linkfilter/?u=https://evil.example`)).toBe(false);
  });
});
