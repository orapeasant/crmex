import type { ReactNode } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { initialsFor } from 'shared-ui';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';

const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-100 dark:bg-slate-900/60 text-slate-700 dark:text-slate-300 ring-slate-200 dark:ring-slate-800',
  success: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-800',
  warning: 'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 ring-amber-200 dark:ring-amber-800',
  danger: 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 ring-red-200 dark:ring-red-800',
  info: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 ring-sky-200 dark:ring-sky-800',
  brand: 'bg-teal-50 dark:bg-teal-950/40 text-teal-800 dark:text-teal-300 ring-teal-200 dark:ring-teal-800',
};

export function StatusBadge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset', TONES[tone], className)}>{children}</span>;
}

export function Initials({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-teal-100 dark:bg-teal-900/60 text-xs font-semibold text-teal-800 dark:text-teal-300', className)}>
      {initialsFor(name)}
    </span>
  );
}

export function PageHeader({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 border-b bg-card px-6 py-5 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-4 px-6 py-6 lg:px-8', className)}>{children}</div>;
}

export function EmptyState({ icon, title, text, action, className }: { icon?: ReactNode; title: string; text?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-card px-6 py-14 text-center', className)}>
      {icon && <div className="mb-1 flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">{icon}</div>}
      <div className="font-medium">{title}</div>
      {text && <p className="max-w-md text-sm text-muted-foreground">{text}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = "Couldn't load this" }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-800 dark:text-red-300">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <div className="flex-1">
        <div className="font-medium">{title}</div>
        <div className="text-red-700 dark:text-red-300">{errorText(error)}</div>
      </div>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function errorText(error: unknown): string {
  if (!error) return 'Something went wrong.';
  if (typeof error === 'string') return error;
  const e = error as { message?: unknown };
  return typeof e.message === 'string' ? e.message : 'Something went wrong.';
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="rounded-lg border bg-card p-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="mb-3 h-8 w-full last:mb-0" />
      ))}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin', className)} aria-hidden="true" />;
}

export function Section({ title, actions, children, className }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0 rounded-lg border bg-card', className)}>
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-sm">{children}</dd>
    </div>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            className={destructive ? 'bg-destructive text-white hover:bg-destructive/90' : undefined}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {busy && <Spinner />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
