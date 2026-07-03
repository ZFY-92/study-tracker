-- 在 Supabase 项目的 SQL Editor 中执行此脚本（只需部署者执行一次）
create table if not exists sync_vault (
  vault_id text primary key,
  payload text not null,
  iv text not null,
  client_updated_at text
);

alter table sync_vault enable row level security;

create policy "sync_vault_public_all"
  on sync_vault
  for all
  using (true)
  with check (true);
