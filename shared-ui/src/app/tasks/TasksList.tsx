import { useMemo, useState } from 'react';
import { groupTasks } from '../../crm/tasks.js';
import type { TaskRow } from '../../crm/types.js';
import { listMatters, listOrgMemberRows, listTasks } from '../../supabase/crmRepo.js';
import { useActiveFirm, useApp } from '../context.js';
import { useNav } from '../shell/nav.js';
import { EmptyState, ErrorCard, Fab, LoadingCard } from '../ui/components.js';
import { ChevronDownIcon, ChevronRightIcon, TasksIcon } from '../ui/icons.js';
import { useAsync } from '../ui/useAsync.js';
import { TaskItem } from './TaskItem.js';

export function TasksList() {
  const { supabase, user } = useApp();
  const { orgId, dataVersion } = useActiveFirm();
  const nav = useNav();
  const data = useAsync(async () => {
    const [tasks, matters, members] = await Promise.all([listTasks(supabase, orgId), listMatters(supabase, orgId), listOrgMemberRows(supabase, orgId).catch(() => [])]);
    return { tasks, matterTitles: new Map(matters.map((m) => [m.id, m.title])), members };
  }, [supabase, orgId, dataVersion]);
  const [mine, setMine] = useState(false);
  const [showDone, setShowDone] = useState(false);

  const sections = useMemo(() => {
    const tasks = (data.data?.tasks ?? []).filter((t) => !mine || t.assignee_id === user.id);
    return groupTasks(tasks);
  }, [data.data, mine, user.id]);

  const openCount = sections.overdue.length + sections.today.length + sections.upcoming.length + sections.noDate.length;

  function renderSection(title: string, tasks: TaskRow[], tone?: 'danger') {
    if (tasks.length === 0) return null;
    return (
      <section className="stack" style={{ gap: 8 }} key={title}>
        <div className={tone === 'danger' ? 'field__label task-section--danger' : 'field__label'}>
          {title} · {tasks.length}
        </div>
        <ul className="contact-list">
          {tasks.map((t) => (
            <TaskItem key={`${t.id}:${t.status}`} task={t} members={data.data!.members} matterTitle={t.matter_id ? data.data!.matterTitles.get(t.matter_id) : undefined} onOpen={() => nav.push({ name: 'task-form', id: t.id })} />
          ))}
        </ul>
      </section>
    );
  }

  return (
    <main className="content content--with-fab stack">
      <div className="row row--between">
        <h1 className="section-title">Tasks</h1>
        <button className={mine ? 'filter-chip filter-chip--active' : 'filter-chip'} aria-pressed={mine} onClick={() => setMine((v) => !v)}>
          Assigned to me
        </button>
      </div>

      {data.status === 'loading' && <LoadingCard label="Loading tasks…" />}
      {data.status === 'error' && <ErrorCard error={data.error} onRetry={data.reload} prefix="Couldn't load tasks" />}

      {data.data && openCount === 0 && sections.done.length === 0 && (
        <EmptyState
          icon={<TasksIcon size={28} />}
          title={mine ? 'Nothing assigned to you' : 'No tasks yet'}
          text="Track to-dos, filing deadlines and hearings, optionally linked to a matter."
          action={
            <button className="btn btn--primary" onClick={() => nav.push({ name: 'task-form' })}>
              New task
            </button>
          }
        />
      )}
      {data.data && openCount === 0 && sections.done.length > 0 && <div className="card muted" style={{ textAlign: 'center' }}>All caught up.</div>}

      {data.data && (
        <>
          {renderSection('Overdue', sections.overdue, 'danger')}
          {renderSection('Today', sections.today)}
          {renderSection('Upcoming', sections.upcoming)}
          {renderSection('No date', sections.noDate)}
          {sections.done.length > 0 && (
            <section className="stack" style={{ gap: 8 }}>
              <button className="section-toggle" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                {showDone ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />} Done · {sections.done.length}
              </button>
              {showDone && (
                <ul className="contact-list">
                  {sections.done.slice(0, 100).map((t) => (
                    <TaskItem key={`${t.id}:${t.status}`} task={t} members={data.data!.members} matterTitle={t.matter_id ? data.data!.matterTitles.get(t.matter_id) : undefined} onOpen={() => nav.push({ name: 'task-form', id: t.id })} />
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}

      <Fab label="New task" onClick={() => nav.push({ name: 'task-form' })} />
    </main>
  );
}
