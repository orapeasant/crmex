import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveEnv, livePhone, setupLiveFixture, type LiveFixture } from './harness';

/**
 * docs/spec/test-plan.md §18.1-§18.3 — the database half of the firm
 * isolation suite, run against a real Supabase project through supabase-js.
 *
 * "rejected" = the statement errors (an RLS WITH CHECK, a missing grant, a
 * trigger or a constraint). "zero rows" = the statement succeeds but RLS
 * filtered every target row, so nothing came back.
 */
const live = liveEnv();
const describeLive = live ? describe : describe.skip;

describeLive('TEN (live): firm isolation in Postgres', () => {
  let f: LiveFixture;
  let clientA: string;
  let matterA: string;
  let clientB: string;
  let matterB: string;

  beforeAll(async () => {
    f = await setupLiveFixture();

    const seed = async <T extends Record<string, unknown>>(
      user: LiveFixture['A1'],
      table: string,
      row: T,
    ): Promise<string> => {
      const { data, error } = await user.db.from(table).insert(row).select('id').single();
      if (error) throw new Error(`seed ${table}: ${error.message}`);
      return data!.id as string;
    };

    clientA = await seed(f.A1, 'clients', {
      org_id: f.orgA,
      display_name: 'Firm A client',
      phone_e164: livePhone(f.runId, 1),
    });
    matterA = await seed(f.A1, 'matters', {
      org_id: f.orgA,
      matter_number: `A-${f.runId}-1`,
      title: 'Firm A matter',
    });
    clientB = await seed(f.B1, 'clients', {
      org_id: f.orgB,
      display_name: 'Firm B client',
      phone_e164: livePhone(f.runId, 2),
    });
    matterB = await seed(f.B1, 'matters', {
      org_id: f.orgB,
      matter_number: `B-${f.runId}-1`,
      title: 'Firm B matter',
    });
  }, 120_000);

  afterAll(async () => {
    if (f) await f.teardown();
  }, 60_000);

  // --- §18.1 membership helpers -------------------------------------------

  it('TEN-02: the helpers answer only about the caller, and anon cannot execute them', async () => {
    const { data: asA1 } = await f.A1.db.rpc('is_org_member', { org: f.orgA });
    expect(asA1).toBe(true);

    const { data: asB1 } = await f.B1.db.rpc('is_org_member', { org: f.orgA });
    expect(asB1).toBe(false);

    const { data: roleA2 } = await f.A2.db.rpc('has_org_role', { org: f.orgA, roles: ['owner', 'admin'] });
    expect(roleA2).toBe(false);

    const { data: roleA1 } = await f.A1.db.rpc('has_org_role', { org: f.orgA, roles: ['owner', 'admin'] });
    expect(roleA1).toBe(true);

    const { error: anonErr } = await f.anon.rpc('is_org_member', { org: f.orgA });
    expect(anonErr, 'anon must not be able to execute the membership helpers').not.toBeNull();
  });

  // --- §18.2 CRM tables ----------------------------------------------------

  it('TEN-03: A2 inserts into Firm A and created_by defaults to the caller', async () => {
    const { data, error } = await f.A2.db
      .from('tasks')
      .insert({ org_id: f.orgA, title: 'A2 task', matter_id: matterA })
      .select('id, created_by')
      .single();
    expect(error).toBeNull();
    expect(data!.created_by).toBe(f.A2.id);

    const { error: linkErr } = await f.A2.db
      .from('matter_clients')
      .insert({ org_id: f.orgA, matter_id: matterA, client_id: clientA });
    expect(linkErr).toBeNull();
  });

  it('TEN-04: A2 reads and updates a row A1 created; updated_at advances', async () => {
    const { data: before } = await f.A2.db.from('clients').select('id, updated_at').eq('id', clientA).single();
    expect(before).not.toBeNull();

    await new Promise((r) => setTimeout(r, 1100));
    const { data: after, error } = await f.A2.db
      .from('clients')
      .update({ notes: 'edited by A2' })
      .eq('id', clientA)
      .select('id, notes, updated_at')
      .single();
    expect(error).toBeNull();
    expect(after!.notes).toBe('edited by A2');
    expect(new Date(after!.updated_at).getTime()).toBeGreaterThan(new Date(before!.updated_at).getTime());
  });

  it('TEN-04: X, unfiltered, sees both firms — the client must filter by the active org_id', async () => {
    const { data } = await f.X.db.from('clients').select('id, org_id').in('id', [clientA, clientB]);
    expect(new Set((data ?? []).map((r) => r.org_id))).toEqual(new Set([f.orgA, f.orgB]));
  });

  it('TEN-05: B1 sees zero Firm A rows in the CRM and tenancy tables', async () => {
    const { data: clients } = await f.B1.db.from('clients').select('id').eq('id', clientA);
    expect(clients).toEqual([]);
    const { data: matters } = await f.B1.db.from('matters').select('id').eq('id', matterA);
    expect(matters).toEqual([]);
    const { data: tasks } = await f.B1.db.from('tasks').select('id').eq('org_id', f.orgA);
    expect(tasks).toEqual([]);
    const { data: links } = await f.B1.db.from('matter_clients').select('matter_id').eq('org_id', f.orgA);
    expect(links).toEqual([]);
    const { data: orgs } = await f.B1.db.from('organizations').select('id').eq('id', f.orgA);
    expect(orgs).toEqual([]);
    const { data: members } = await f.B1.db.from('org_members').select('user_id').eq('org_id', f.orgA);
    expect(members).toEqual([]);
  });

  it('TEN-06: B1 cannot insert into Firm A, and A1 cannot attribute a row to someone else', async () => {
    const { error: crossErr } = await f.B1.db.from('clients').insert({ org_id: f.orgA, display_name: 'smuggled' });
    expect(crossErr).not.toBeNull();

    const { error: attrErr } = await f.A1.db
      .from('clients')
      .insert({ org_id: f.orgA, display_name: 'misattributed', created_by: f.A2.id });
    expect(attrErr).not.toBeNull();

    const { error: taskErr } = await f.B1.db.from('tasks').insert({ org_id: f.orgA, title: 'smuggled' });
    expect(taskErr).not.toBeNull();
  });

  it('TEN-07: B1 updating or deleting Firm A rows affects zero rows', async () => {
    const { data: updated, error: upErr } = await f.B1.db
      .from('clients')
      .update({ display_name: 'hijacked' })
      .eq('id', clientA)
      .select('id');
    expect(upErr).toBeNull();
    expect(updated).toEqual([]);

    const { data: deleted, error: delErr } = await f.B1.db.from('clients').delete().eq('id', clientA).select('id');
    expect(delErr).toBeNull();
    expect(deleted).toEqual([]);

    const { data: still } = await f.admin.from('clients').select('display_name').eq('id', clientA).single();
    expect(still!.display_name).toBe('Firm A client');
  });

  it('TEN-08: org_id is immutable — for a member of both firms and for the service role', async () => {
    const { error: xErr } = await f.X.db.from('clients').update({ org_id: f.orgB }).eq('id', clientA).select('id');
    expect(xErr).not.toBeNull();

    const { error: svcErr } = await f.admin.from('clients').update({ org_id: f.orgB }).eq('id', clientA).select('id');
    expect(svcErr, 'the service role must not be able to move a row between firms').not.toBeNull();

    const { error: matterErr } = await f.X.db.from('matters').update({ org_id: f.orgB }).eq('id', matterA).select('id');
    expect(matterErr).not.toBeNull();

    // Re-sending an unchanged org_id must still work — supabase-js commonly
    // sends the whole row on update.
    const { data: ok, error: okErr } = await f.A1.db
      .from('clients')
      .update({ org_id: f.orgA, notes: 'unchanged org_id' })
      .eq('id', clientA)
      .select('id');
    expect(okErr).toBeNull();
    expect(ok).toHaveLength(1);
  });

  it('TEN-08: created_by cannot be reassigned', async () => {
    const { error } = await f.A2.db.from('clients').update({ created_by: f.A2.id }).eq('id', clientA).select('id');
    expect(error).not.toBeNull();
  });

  it('TEN-09: a matter_clients link can never cross firms', async () => {
    for (const orgId of [f.orgA, f.orgB]) {
      const { error } = await f.X.db
        .from('matter_clients')
        .insert({ org_id: orgId, matter_id: matterA, client_id: clientB });
      expect(error, `cross-firm link accepted with org_id=${orgId}`).not.toBeNull();
    }

    const { error: svcErr } = await f.admin
      .from('matter_clients')
      .insert({ org_id: f.orgA, matter_id: matterA, client_id: clientB });
    expect(svcErr).not.toBeNull();
  });

  it("TEN-10: neither a task's matter_id nor message_history.client_id can cross firms", async () => {
    const { error: insErr } = await f.X.db
      .from('tasks')
      .insert({ org_id: f.orgA, title: 'cross-firm matter', matter_id: matterB });
    expect(insErr).not.toBeNull();

    const { data: task, error: okErr } = await f.A1.db
      .from('tasks')
      .insert({ org_id: f.orgA, title: 'same-firm matter', matter_id: matterA })
      .select('id')
      .single();
    expect(okErr).toBeNull();

    const { error: updErr } = await f.X.db.from('tasks').update({ matter_id: matterB }).eq('id', task!.id).select('id');
    expect(updErr).not.toBeNull();

    const { error: msgErr } = await f.X.db.from('message_history').insert({
      org_id: f.orgA,
      user_id: f.X.id,
      jid: '15550001@s.whatsapp.net',
      body: 'hi',
      batch_id: randomUUID(),
      status: 'SENT',
      client_id: clientB,
    });
    expect(msgErr).not.toBeNull();
  });

  it('TEN-11: a task can only be assigned to a member of its own firm', async () => {
    const { error: outsideErr } = await f.A1.db
      .from('tasks')
      .insert({ org_id: f.orgA, title: 'assigned outside', assignee_id: f.B1.id });
    expect(outsideErr).not.toBeNull();

    const { data: ok, error: okErr } = await f.A1.db
      .from('tasks')
      .insert({ org_id: f.orgA, title: 'assigned inside', assignee_id: f.A2.id })
      .select('id')
      .single();
    expect(okErr).toBeNull();

    const { error: reassignErr } = await f.A1.db
      .from('tasks')
      .update({ assignee_id: f.B1.id })
      .eq('id', ok!.id)
      .select('id');
    expect(reassignErr).not.toBeNull();

    const { error: svcErr } = await f.admin
      .from('tasks')
      .update({ assignee_id: f.B1.id })
      .eq('id', ok!.id)
      .select('id');
    expect(svcErr, 'the assignee trigger must bind the service role too').not.toBeNull();
  });

  it('TEN-12: uniqueness is per firm; invalid E.164 and blank names are rejected', async () => {
    const phone = livePhone(f.runId, 1);

    const { error: dupPhone } = await f.A2.db
      .from('clients')
      .insert({ org_id: f.orgA, display_name: 'dup phone', phone_e164: phone });
    expect(dupPhone).not.toBeNull();

    // The same number in another firm is a different matter entirely.
    const { data: otherFirm, error: otherErr } = await f.B1.db
      .from('clients')
      .insert({ org_id: f.orgB, display_name: 'same number elsewhere', phone_e164: phone })
      .select('id')
      .single();
    expect(otherErr).toBeNull();
    expect(otherFirm).not.toBeNull();

    const { error: dupMatter } = await f.A2.db
      .from('matters')
      .insert({ org_id: f.orgA, matter_number: `A-${f.runId}-1`, title: 'dup number' });
    expect(dupMatter).not.toBeNull();

    const { error: badPhone } = await f.A1.db
      .from('clients')
      .insert({ org_id: f.orgA, display_name: 'bad phone', phone_e164: '0123 not-e164' });
    expect(badPhone).not.toBeNull();

    const { error: blankName } = await f.A1.db.from('clients').insert({ org_id: f.orgA, display_name: '   ' });
    expect(blankName).not.toBeNull();
  });

  it('TEN-13: only an owner/admin deletes clients; a member gets zero rows', async () => {
    const { data: victim } = await f.A1.db
      .from('clients')
      .insert({ org_id: f.orgA, display_name: 'to delete', phone_e164: livePhone(f.runId, 3) })
      .select('id')
      .single();

    const { data: memberDelete, error: memberErr } = await f.A2.db
      .from('clients')
      .delete()
      .eq('id', victim!.id)
      .select('id');
    expect(memberErr).toBeNull();
    expect(memberDelete, 'a member must not be able to delete a client').toEqual([]);

    const { data: ownerDelete } = await f.A1.db.from('clients').delete().eq('id', victim!.id).select('id');
    expect(ownerDelete).toHaveLength(1);
  });

  it('TEN-13: deleting a matter nulls tasks.matter_id and keeps the task in the firm', async () => {
    const { data: m } = await f.A1.db
      .from('matters')
      .insert({ org_id: f.orgA, matter_number: `A-${f.runId}-del`, title: 'to delete' })
      .select('id')
      .single();
    const { data: t } = await f.A1.db
      .from('tasks')
      .insert({ org_id: f.orgA, title: 'orphan me', matter_id: m!.id })
      .select('id')
      .single();

    const { error } = await f.A1.db.from('matters').delete().eq('id', m!.id);
    expect(error).toBeNull();

    const { data: after } = await f.A1.db.from('tasks').select('id, matter_id, org_id').eq('id', t!.id).single();
    expect(after!.matter_id).toBeNull();
    expect(after!.org_id).toBe(f.orgA);
  });

  it('TEN-13: deleting a client nulls message_history.client_id and keeps the history row', async () => {
    const { data: c } = await f.A1.db
      .from('clients')
      .insert({ org_id: f.orgA, display_name: 'history owner', phone_e164: livePhone(f.runId, 4) })
      .select('id')
      .single();
    const { data: msg, error: msgErr } = await f.A1.db
      .from('message_history')
      .insert({
        org_id: f.orgA,
        user_id: f.A1.id,
        jid: '15550002@s.whatsapp.net',
        body: 'hello',
        batch_id: randomUUID(),
        status: 'SENT',
        client_id: c!.id,
      })
      .select('id')
      .single();
    expect(msgErr).toBeNull();

    await f.A1.db.from('clients').delete().eq('id', c!.id);

    const { data: after } = await f.A1.db.from('message_history').select('id, client_id').eq('id', msg!.id).single();
    expect(after, 'the history row must survive the client being deleted').not.toBeNull();
    expect(after!.client_id).toBeNull();
  });

  // --- §18.3 tenancy tables, anon, shared tables ---------------------------

  it('TEN-14: firms, membership and invitations are service-role only', async () => {
    const { error: newOrg } = await f.A1.db.from('organizations').insert({ name: 'self-serve firm' });
    expect(newOrg).not.toBeNull();

    const { error: selfPromote } = await f.A2.db
      .from('org_members')
      .update({ role: 'owner' })
      .eq('org_id', f.orgA)
      .eq('user_id', f.A2.id)
      .select('role');
    expect(selfPromote, 'a member must not be able to promote themselves').not.toBeNull();

    const { error: joinB } = await f.A1.db
      .from('org_members')
      .insert({ org_id: f.orgB, user_id: f.A1.id, role: 'member' });
    expect(joinB).not.toBeNull();

    const { error: invite } = await f.A1.db.from('org_invitations').insert({
      org_id: f.orgA,
      role: 'member',
      token_hash: `forged-${f.runId}`,
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    expect(invite).not.toBeNull();

    const { error: audit } = await f.A1.db
      .from('org_audit_log')
      .insert({ org_id: f.orgA, actor_id: f.A1.id, action: 'forged' });
    expect(audit).not.toBeNull();

    const { error: usage } = await f.A1.db.from('org_usage_daily').select('day').eq('org_id', f.orgA);
    expect(usage, 'org_usage_daily must not be readable by a client').not.toBeNull();
  });

  it("TEN-14: a member reads no invitations or audit rows; an owner reads their own firm's", async () => {
    await f.admin.from('org_invitations').insert({
      org_id: f.orgA,
      role: 'member',
      token_hash: `live-${f.runId}`,
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    await f.admin.from('org_audit_log').insert({ org_id: f.orgA, actor_id: f.A1.id, action: 'member.add' });

    const { data: memberInv } = await f.A2.db.from('org_invitations').select('id').eq('org_id', f.orgA);
    expect(memberInv).toEqual([]);
    const { data: memberAudit } = await f.A2.db.from('org_audit_log').select('id').eq('org_id', f.orgA);
    expect(memberAudit).toEqual([]);

    const { data: ownerInv } = await f.A1.db.from('org_invitations').select('id').eq('org_id', f.orgA);
    expect(ownerInv!.length).toBeGreaterThan(0);
    const { data: ownerAudit } = await f.A1.db.from('org_audit_log').select('id').eq('org_id', f.orgA);
    expect(ownerAudit!.length).toBeGreaterThan(0);

    const { data: otherFirmInv } = await f.B1.db.from('org_invitations').select('id').eq('org_id', f.orgA);
    expect(otherFirmInv).toEqual([]);
  });

  it('TEN-15: anon reads nothing from any tenancy or firm table', async () => {
    for (const table of [
      'organizations',
      'org_members',
      'org_invitations',
      'org_audit_log',
      'org_usage_daily',
      'clients',
      'matters',
      'matter_clients',
      'tasks',
      'send_jobs',
      'message_history',
      'image_sessions',
      'contact_meta',
    ]) {
      const { data, error } = await f.anon.from(table).select('*').limit(1);
      expect(error !== null || (data ?? []).length === 0, `anon could read ${table}`).toBe(true);
    }
  });

  it('TEN-16: message_history is firm-shared, insert-only and correctly attributed', async () => {
    const batch = randomUUID();
    const { error: crossErr } = await f.B1.db.from('message_history').insert({
      org_id: f.orgA,
      user_id: f.B1.id,
      jid: '15550003@s.whatsapp.net',
      body: 'cross firm',
      batch_id: batch,
      status: 'SENT',
    });
    expect(crossErr).not.toBeNull();

    const { error: misattrErr } = await f.A1.db.from('message_history').insert({
      org_id: f.orgA,
      user_id: f.A2.id,
      jid: '15550004@s.whatsapp.net',
      body: 'not mine',
      batch_id: batch,
      status: 'SENT',
    });
    expect(misattrErr).not.toBeNull();

    const { data: mine, error: mineErr } = await f.A1.db
      .from('message_history')
      .insert({
        org_id: f.orgA,
        user_id: f.A1.id,
        jid: '15550005@s.whatsapp.net',
        body: 'mine',
        batch_id: batch,
        status: 'SENT',
      })
      .select('id')
      .single();
    expect(mineErr).toBeNull();

    const { data: seenByA2 } = await f.A2.db.from('message_history').select('id').eq('id', mine!.id);
    expect(seenByA2, "a firm member must see the firm's sends").toHaveLength(1);
    const { data: seenByB1 } = await f.B1.db.from('message_history').select('id').eq('id', mine!.id);
    expect(seenByB1).toEqual([]);

    // Settled history is written once: there is no client update policy.
    const { data: updated, error: updErr } = await f.A1.db
      .from('message_history')
      .update({ body: 'rewritten' })
      .eq('id', mine!.id)
      .select('id');
    expect(updErr === null ? updated : []).toEqual([]);
  });

  it('TEN-17: contact_meta is shared by the firm and stamps the last writer', async () => {
    const jid = `1555${f.runId.slice(0, 4)}@s.whatsapp.net`;
    const { error: seedErr } = await f.A1.db
      .from('contact_meta')
      .insert({ org_id: f.orgA, user_id: f.A1.id, jid, tags: ['vip'] });
    expect(seedErr).toBeNull();

    // A2 upserts the row A1 wrote, without sending user_id at all.
    const { error: upsertErr } = await f.A2.db
      .from('contact_meta')
      .upsert({ org_id: f.orgA, jid, tags: ['vip', 'suppressed'] }, { onConflict: 'org_id,jid' });
    expect(upsertErr).toBeNull();

    const { data: after } = await f.admin
      .from('contact_meta')
      .select('user_id, tags')
      .eq('org_id', f.orgA)
      .eq('jid', jid)
      .single();
    expect(after!.user_id, 'user_id records who last wrote the row').toBe(f.A2.id);
    expect(after!.tags, 'a suppressed tag must survive the upsert').toContain('suppressed');

    const { data: b1Update, error: b1Err } = await f.B1.db
      .from('contact_meta')
      .update({ tags: [] })
      .eq('org_id', f.orgA)
      .eq('jid', jid)
      .select('id');
    expect(b1Err === null ? b1Update : []).toEqual([]);

    const { error: moveErr } = await f.X.db
      .from('contact_meta')
      .update({ org_id: f.orgB })
      .eq('org_id', f.orgA)
      .eq('jid', jid)
      .select('id');
    expect(moveErr).not.toBeNull();
  });

  it('TEN-20: removing a membership ends access on the very next statement', async () => {
    const { data: before } = await f.A2.db.from('clients').select('id').eq('org_id', f.orgA);
    expect(before!.length).toBeGreaterThan(0);

    await f.admin.from('org_members').delete().eq('org_id', f.orgA).eq('user_id', f.A2.id);

    const { data: after } = await f.A2.db.from('clients').select('id').eq('org_id', f.orgA);
    expect(after, 'access must end immediately, without waiting for the JWT to expire').toEqual([]);

    const { error: insertErr } = await f.A2.db.from('clients').insert({ org_id: f.orgA, display_name: 'after removal' });
    expect(insertErr).not.toBeNull();

    // Restore, so this case does not constrain the order of the others.
    await f.admin.from('org_members').insert({ org_id: f.orgA, user_id: f.A2.id, role: 'member', email: f.A2.email });
  });
});
