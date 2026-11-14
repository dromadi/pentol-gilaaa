-- Tiruan minimal Supabase untuk Postgres lokal: peran anon/authenticated dan auth.uid().
create role anon; create role authenticated;
create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.uid',true),'')::uuid $$;
grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon,authenticated;
grant usage on schema public to anon, authenticated;
