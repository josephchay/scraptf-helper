import { SCRAPTF_BOUNDARY_SHORT } from '../../shared/boundaryText';
import type { SetupCode } from '../../shared/types';
import { rpc } from '../api';
import { useApp } from '../hooks/appContext';
import { usePersistentState } from '../hooks/usePersistentState';
import { firstPriceText } from '../scraptfListModel';
import { scraptfWindowOn } from '../scraptfWindowModel';
import { Icon } from './Icon';

interface Step {
  code: SetupCode;
  title: string;
  body: string;
  actions: { label: string; run: () => void }[];
}

/**
 * First-run checklist, shown while status.setupNeeded is non-empty. UX-4: the first price leads with one
 * save of scrap.tf/items (the Import page's price-list card), typing stays as the other way.
 */
export function SetupChecklist() {
  const { status, settings, navigate, toast } = useApp();
  const [dismissedKey, setDismissedKey] = usePersistentState<string>('setup.dismissed', '', (v) => (typeof v === 'string' ? v : ''));
  const needed = status?.setupNeeded ?? [];
  const key = [...needed].sort().join(',');
  if (!needed.length || dismissedKey === key) return null;

  const openQuick = () => {
    rpc('app.showQuickEntry').catch(() => toast('Could not open quick entry.', 'bad'));
  };
  const openSettings = { label: 'Open Settings', run: () => navigate('settings') };
  const steps: Step[] = [
    {
      code: 'bptf-token',
      title: 'Add your backpack.tf access token',
      body: "The live buy-order feed works without it. The token enables snapshots: refreshing an item's buy orders on demand and keeping watched items current.",
      actions: [openSettings],
    },
    {
      code: 'bptf-key',
      title: 'Add your backpack.tf API key',
      body: "Optional. It adds backpack.tf community prices and backpack.tf's key price; PriceDB covers both without it.",
      actions: [openSettings],
    },
    {
      code: 'contact-url',
      title: 'Set a contact URL',
      body: 'It is added to the User-Agent of every request so API operators can reach you instead of blocking you.',
      actions: [openSettings],
    },
    {
      code: 'first-price',
      title: 'Add your first scrap.tf prices',
      body: `${firstPriceText(scraptfWindowOn(settings))} Or type a price you see, or add a price-sheet rule for a whole category.`,
      actions: [
        { label: 'Save scrap.tf/items', run: () => navigate('import') },
        { label: 'Quick entry', run: openQuick },
        { label: 'Price sheet', run: () => navigate('prices') },
      ],
    },
  ];
  const pending = new Set<SetupCode>(needed);
  const doneCount = steps.filter((s) => !pending.has(s.code)).length;

  return (
    <section className="checklist card" aria-labelledby="setup-title">
      <div className="checklist-head">
        <div>
          <h2 id="setup-title">Get set up</h2>
          <p className="muted">
            {doneCount} of {steps.length} done. The app only reads public APIs. {SCRAPTF_BOUNDARY_SHORT}
          </p>
        </div>
        <button type="button" className="btn ghost small" onClick={() => setDismissedKey(key)}>
          Hide for now
        </button>
      </div>
      <ol className="checklist-steps">
        {steps.map((s) => {
          const done = !pending.has(s.code);
          return (
            <li key={s.code} className={done ? 'done' : undefined}>
              <span className="check-mark" aria-hidden="true">
                {done ? <Icon name="check" size={14} /> : null}
              </span>
              <div className="step-text">
                <div className="step-title">
                  {s.title}
                  {done ? <span className="sr-only"> (done)</span> : null}
                </div>
                {!done ? <div className="muted small">{s.body}</div> : null}
              </div>
              {!done ? (
                <div className="step-actions">
                  {s.actions.map((a) => (
                    <button key={a.label} type="button" className="btn small" onClick={a.run}>
                      {a.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
