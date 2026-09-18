import { useEffect, type ReactNode } from 'react';
import { BackIcon, PlusIcon } from './icons.js';
import { BACK_PRIORITY, useBackButton } from './util.js';

export function ScreenHeader({ title, onBack, actions }: { title: string; onBack: () => void; actions?: ReactNode }) {
  return (
    <header className="topbar">
      <button className="icon-btn" aria-label="Back" onClick={onBack}>
        <BackIcon />
      </button>
      <span className="topbar__title topbar__title--truncate">{title}</span>
      <span className="topbar__spacer" />
      {actions}
    </header>
  );
}

export function LoadingCard({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="card row" style={{ justifyContent: 'center', color: 'var(--text-muted)', padding: 24 }}>
      <span className="spinner" /> {label}
    </div>
  );
}

export function ErrorCard({ error, onRetry, prefix = "Couldn't load this" }: { error: string | null; onRetry?: () => void; prefix?: string }) {
  return (
    <div className="alert alert--error stack" role="alert">
      <span>
        {prefix}: {error}
      </span>
      {onRetry && (
        <button className="btn btn--secondary btn--sm" style={{ alignSelf: 'flex-start' }} onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <span className="empty__icon">{icon}</span>}
      <div className="card__title">{title}</div>
      {text && <p className="muted">{text}</p>}
      {action}
    </div>
  );
}

export function Fab({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="fab" onClick={onClick} aria-label={label}>
      <PlusIcon size={22} /> <span>{label}</span>
    </button>
  );
}

/** Bottom sheet; closes on backdrop tap, Escape and the hardware back button. */
export function Sheet({ open, onClose, title, children, labelledBy }: { open: boolean; onClose: () => void; title?: string; children: ReactNode; labelledBy?: string }) {
  useBackButton(() => {
    if (!open) return false;
    onClose();
    return true;
  }, BACK_PRIORITY.overlay);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet stack" role="dialog" aria-modal="true" aria-label={labelledBy ? undefined : title} aria-labelledby={labelledBy} onClick={(e) => e.stopPropagation()}>
        {title && <h2 className="section-title">{title}</h2>}
        {children}
      </div>
    </div>
  );
}

export interface ConfirmSheetProps {
  open: boolean;
  title: string;
  message?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmSheet({ open, title, message, confirmLabel, danger, busy, error, onConfirm, onCancel }: ConfirmSheetProps) {
  return (
    <Sheet open={open} onClose={busy ? () => {} : onCancel} title={title}>
      {message && <div className="muted">{message}</div>}
      {error && <div className="alert alert--error">{error}</div>}
      <div className="row">
        <button className="btn btn--secondary" style={{ flex: 1 }} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className={danger ? 'btn btn--danger' : 'btn btn--primary'} style={{ flex: 1 }} onClick={onConfirm} disabled={busy}>
          {busy ? <span className="spinner" /> : confirmLabel}
        </button>
      </div>
    </Sheet>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} className={value === o.value ? 'segmented__item segmented__item--active' : 'segmented__item'} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function FilterChips<T extends string>({ value, options, onChange, label }: { value: T | null; options: { value: T; label: string }[]; onChange: (v: T | null) => void; label: string }) {
  return (
    <div className="filter-chips" aria-label={label}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button key={o.value} className={active ? 'filter-chip filter-chip--active' : 'filter-chip'} aria-pressed={active} onClick={() => onChange(active ? null : o.value)}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="list-item">
      <span className="muted">{label}</span>
      <span className="list-item__value">{children}</span>
    </div>
  );
}

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="row row--between section-label">
      <div className="field__label">{children}</div>
      {action}
    </div>
  );
}
