// Step 5 of the compose flow (crmex.md §18.4): when a browser-queued message
// goes out and how fast. Not shown for a direct send — that device sends
// synchronously right here, so there is no "later" for it to run at.
import { useMemo, useState } from 'react';
import { CAMPAIGN_INTERVAL_PRESETS_MS } from '../../../pacing/pacing.js';
import { ClockIcon } from '../../ui/icons.js';
import { Segmented } from '../../ui/components.js';
import { formatScheduleSummary, isValidIntervalMs, LATE_WINDOW_PRESETS_MS, type CampaignPlan } from './schedule.js';

function localDatetimeValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function hoursLabel(ms: number): string {
  const h = ms / 3_600_000;
  return `${h} h`;
}

export interface ScheduleStepProps {
  plan: CampaignPlan;
  onChange: (plan: CampaignPlan) => void;
  recipientCount: number;
}

export function ScheduleStep({ plan, onChange, recipientCount }: ScheduleStepProps) {
  const isCustomPreset = !(CAMPAIGN_INTERVAL_PRESETS_MS as readonly number[]).includes(plan.intervalMs);
  const [intervalMode, setIntervalMode] = useState<'preset' | 'custom'>(isCustomPreset ? 'custom' : 'preset');
  const [customSeconds, setCustomSeconds] = useState(String(Math.round(plan.intervalMs / 1000)));
  const [dateError, setDateError] = useState<string | null>(null);

  const now = useMemo(() => new Date(), []);
  const minDatetime = useMemo(() => localDatetimeValue(now), [now]);

  const summary = formatScheduleSummary(plan, recipientCount, now);

  function setTiming(mode: 'now' | 'scheduled') {
    if (mode === 'now') {
      onChange({ ...plan, timing: { mode: 'now' } });
    } else {
      // Default the picker to five minutes out, in the local (firm) timezone.
      const soon = new Date(now.getTime() + 5 * 60_000);
      onChange({ ...plan, timing: { mode: 'scheduled', at: soon.toISOString() } });
    }
  }

  function setScheduledAt(value: string) {
    setDateError(null);
    if (!value) return;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      setDateError('Not a valid date and time.');
      return;
    }
    onChange({ ...plan, timing: { mode: 'scheduled', at: d.toISOString() } });
  }

  function applyCustomInterval(raw: string) {
    setCustomSeconds(raw);
    const seconds = Number(raw);
    const ms = seconds * 1000;
    if (isValidIntervalMs(ms)) onChange({ ...plan, intervalMs: ms });
  }

  const scheduledValue = plan.timing.mode === 'scheduled' ? localDatetimeValue(new Date(plan.timing.at)) : '';

  return (
    <div className="stack">
      <div>
        <h1 className="section-title">Schedule and pace</h1>
        <p className="section-subtitle">Choose when this campaign starts and how fast it sends.</p>
      </div>

      <section className="card stack">
        <div className="field__label">When</div>
        <Segmented label="When" value={plan.timing.mode} options={[{ value: 'now', label: 'Send now' }, { value: 'scheduled', label: 'Schedule' }]} onChange={setTiming} />
        {plan.timing.mode === 'scheduled' && (
          <label className="field">
            <span className="field__label">Date and time</span>
            <input className="input" type="datetime-local" value={scheduledValue} min={minDatetime} onChange={(e) => setScheduledAt(e.target.value)} />
          </label>
        )}
        {dateError && <div className="alert alert--error">{dateError}</div>}
      </section>

      <section className="card stack">
        <div className="field__label">Pace</div>
        <Segmented
          label="Pace"
          value={intervalMode}
          options={[{ value: 'preset', label: 'Preset' }, { value: 'custom', label: 'Custom' }]}
          onChange={(mode) => {
            setIntervalMode(mode);
            if (mode === 'preset' && isCustomPreset) onChange({ ...plan, intervalMs: 30_000 });
          }}
        />
        {intervalMode === 'preset' ? (
          <div className="row row--wrap">
            {CAMPAIGN_INTERVAL_PRESETS_MS.map((ms) => (
              <button
                key={ms}
                className={plan.intervalMs === ms ? 'filter-chip filter-chip--active' : 'filter-chip'}
                aria-pressed={plan.intervalMs === ms}
                onClick={() => onChange({ ...plan, intervalMs: ms })}
              >
                every {ms / 1000} s
              </button>
            ))}
          </div>
        ) : (
          <label className="field">
            <span className="field__label">Seconds between sends</span>
            <input className="input" type="number" min={1} max={3600} value={customSeconds} onChange={(e) => applyCustomInterval(e.target.value)} />
          </label>
        )}
        <span className="faint">Each actual gap is randomized ±{plan.jitterPct}% around this, so the run doesn't look mechanical.</span>
      </section>

      <section className="card stack">
        <div className="field__label">Late window</div>
        <p className="card__subtitle">If your phone hasn't picked this up by then, it's cancelled rather than sent late.</p>
        <div className="row row--wrap">
          {LATE_WINDOW_PRESETS_MS.map((ms) => (
            <button
              key={ms}
              className={plan.expiresInMs === ms ? 'filter-chip filter-chip--active' : 'filter-chip'}
              aria-pressed={plan.expiresInMs === ms}
              onClick={() => onChange({ ...plan, expiresInMs: ms })}
            >
              {hoursLabel(ms)}
            </button>
          ))}
        </div>
      </section>

      <section className="card stack">
        <div className="row">
          <ClockIcon size={18} />
          <div className="card__title">{summary}</div>
        </div>
        <div className="alert alert--warning">Your phone must be online and running CRMEX for the whole run.</div>
      </section>
    </div>
  );
}
