-- CRMEX Storage: private `user-images` bucket with folder-prefix RLS policies.
-- Source: docs/spec/crmex.md §3.3 (verbatim) + §4.
--
-- Object path convention: <user_id>/<sha256>.png — always constructed
-- server-side (core-server) from the JWT-derived user_id, never from
-- client-supplied input. These policies are the second line of defence:
-- core-server's service role key bypasses them, so path construction in
-- application code (core-server/src/lib/paths.ts) is the primary control.

insert into storage.buckets (id, name, public)
values ('user-images', 'user-images', false)
on conflict (id) do update set public = excluded.public;

create policy own_images_read on storage.objects
  for select using (
    bucket_id = 'user-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy own_images_write on storage.objects
  for insert with check (
    bucket_id = 'user-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy own_images_delete on storage.objects
  for delete using (
    bucket_id = 'user-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
