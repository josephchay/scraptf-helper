// 0.7.1 (UX-7): the boundary sentence the dashboard says wherever scrap.tf data shows, true with the
// opt-in scrap.tf window on too. Up to 0.6 the app never showed scrap.tf at all ("never visits"); since
// F21 the user may browse it in the Flip Desk window, so what stays true is that nothing loads it on the
// app's own (R1): no fetch, no poll, no refresh. Pure and zod-free.

/** The one short boundary sentence. */
export const SCRAPTF_BOUNDARY_SHORT = 'Flip Desk never loads scrap.tf on its own.';

/**
 * Where scrap.tf data comes from (R10): "prices you type, pages you save", plus ", or pages you browse in
 * the Flip Desk window" while the user has that window on.
 */
export function scraptfDataSourcesText(windowOn: boolean): string {
  return windowOn ? 'prices you type, pages you save, or pages you browse in the Flip Desk window' : 'prices you type, pages you save';
}
