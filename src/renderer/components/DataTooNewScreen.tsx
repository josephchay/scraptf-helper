import { Fragment } from 'react';
import { dataTooNewText, type DataTooNew } from '../dataTooNewModel';
import { useRpcQuery } from '../hooks/useRpc';
import { Icon } from './Icon';

/**
 * 0.7.2: the dashboard's only content when the service refused data a newer copy already updated
 * (dataTooNewModel.ts holds the text). Main answers 'app.info' itself, so the running copy shows even
 * while the service refuses its data.
 */
export function DataTooNewScreen({ refusal, onRetry }: { refusal: DataTooNew; onRetry: () => void }) {
  const info = useRpcQuery('app.info', undefined);
  const t = dataTooNewText(refusal, info.data ?? null);
  return (
    <section className="card" role="alert" aria-labelledby="data-too-new-t">
      <h2 id="data-too-new-t">
        <Icon name="warning" /> {t.title}
      </h2>
      <p>{t.lead}</p>
      <p>{t.why}</p>
      <p>{t.safe}</p>
      <div className="section-head">
        <h3>{t.stepsTitle}</h3>
      </div>
      <ol className="steps">
        {t.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <div className="section-head">
        <h3>{t.copyTitle}</h3>
      </div>
      {info.loading ? (
        <p className="muted small">Loading…</p>
      ) : t.copyUnknown ? (
        <p className="muted small">{t.copyUnknown}</p>
      ) : (
        <dl className="kv">
          {t.copy.map((r) => (
            <Fragment key={r.label}>
              <dt>{r.label}</dt>
              <dd className={r.path ? 'mono small' : undefined}>{r.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      <div className="form-actions">
        <button type="button" className="btn small" onClick={onRetry}>
          Retry
        </button>
      </div>
    </section>
  );
}
