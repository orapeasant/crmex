import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function Field({ id, label, hint, error, children, className }: { id: string; label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Radix Select can't hold an empty value; NONE stands in for "no selection". */
export const NONE = '__none__';

export function SimpleSelect<V extends string>({ id, value, onChange, options, placeholder, className }: { id?: string; value: V; onChange: (v: V) => void; options: { value: V; label: string }[]; placeholder?: string; className?: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as V)}>
      <SelectTrigger id={id} className={cn('w-full', className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function FormError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-800 dark:text-red-300">
      {error}
    </div>
  );
}
