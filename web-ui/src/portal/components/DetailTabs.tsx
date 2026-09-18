import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/** Tabs whose selection lives in ?tab= so deep links and refresh keep the tab. */
export function DetailTabs({ tabs }: { tabs: { value: string; label: ReactNode; content: ReactNode }[] }) {
  const [params, setParams] = useSearchParams();
  const current = tabs.some((t) => t.value === params.get('tab')) ? params.get('tab')! : tabs[0].value;
  return (
    <Tabs
      value={current}
      onValueChange={(v) => {
        const next = new URLSearchParams(params);
        if (v === tabs[0].value) next.delete('tab');
        else next.set('tab', v);
        setParams(next, { replace: true });
      }}
      className="gap-0"
    >
      <div className="border-b bg-card px-6 lg:px-8">
        <TabsList className="h-11 gap-4 rounded-none bg-transparent p-0">
          {tabs.map((t) => (
            <TabsTrigger
              key={t.value}
              value={t.value}
              className="h-11 flex-none rounded-none border-0 border-b-2 border-transparent bg-transparent px-1 text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {tabs.map((t) => (
        <TabsContent key={t.value} value={t.value} className="px-6 py-6 lg:px-8">
          {t.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}

export function TabCount({ n }: { n: number | undefined }) {
  if (n === undefined) return null;
  return <span className="ml-1.5 rounded-full bg-muted px-1.5 py-px text-[11px] font-medium tabular-nums text-muted-foreground">{n}</span>;
}
