import { CheckIcon } from '../../ui/icons.js';

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="stepper" aria-label="Progress" style={{ listStyle: 'none', padding: 0 }}>
      {steps.map((label, idx) => {
        const state = idx < current ? 'done' : idx === current ? 'active' : 'todo';
        return (
          <li key={label} className={`stepper__step stepper__step--${state}`} aria-current={state === 'active' ? 'step' : undefined}>
            <span className="stepper__circle">{state === 'done' ? <CheckIcon size={14} /> : idx + 1}</span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}
