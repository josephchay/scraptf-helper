import type { Scrap } from '../../shared/types';
import { fmtMoney, fmtRefOnly, fmtSignedMoney, itemTags, qualityClass, qualityName, qualityOf } from '../format';
import { ItemTagChip } from './Pills';

/** Item name coloured by quality, with small attribute tags. */
export function ItemName({ sku, name, tags = true, maxTags = 4 }: { sku: string; name: string; tags?: boolean; maxTags?: number }) {
  const q = qualityOf(sku);
  const list = tags ? itemTags(sku, name) : [];
  const shown = list.slice(0, maxTags);
  return (
    <span className="item-name-wrap">
      <span className={`item-name ${qualityClass(q)}`} title={`${name} (${qualityName(q)})`}>
        {name}
      </span>
      {shown.length ? (
        <span className="item-tags">
          {shown.map((t) => (
            <ItemTagChip key={t.kind} tag={t} />
          ))}
          {list.length > shown.length ? (
            <span className="item-tag" title={list.slice(maxTags).map((t) => t.title).join(', ')}>
              +{list.length - shown.length}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

/** Money with tabular figures. tone="profit" colours gains green and losses red. */
export function Money({
  scrap,
  keyScrap,
  tone,
  signed = false,
  refOnly = false,
  title,
}: {
  scrap: Scrap | null | undefined;
  keyScrap: Scrap | null;
  tone?: 'profit';
  signed?: boolean;
  refOnly?: boolean;
  title?: string;
}) {
  const text = refOnly ? fmtRefOnly(scrap) : signed ? fmtSignedMoney(scrap, keyScrap) : fmtMoney(scrap, keyScrap);
  const cls =
    tone === 'profit' && scrap !== null && scrap !== undefined ? (scrap > 0 ? 'money pos' : scrap < 0 ? 'money neg' : 'money') : 'money';
  const autoTitle = title ?? (scrap !== null && scrap !== undefined && !refOnly && keyScrap && Math.abs(scrap) >= keyScrap ? fmtRefOnly(scrap) : undefined);
  return (
    <span className={cls} title={autoTitle}>
      {text}
    </span>
  );
}
