-- Yūgen Nexus — Supabase schema
-- Run this entire file in Supabase Dashboard > SQL Editor > New query.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  username_key text generated always as (lower(username)) stored,
  email text not null,
  role text not null default 'basic' check (role in ('basic', 'vip', 'owner', 'developers')),
  email_confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  last_login timestamptz
);

alter table public.profiles add column if not exists email_confirmed boolean not null default false;

create unique index if not exists profiles_username_key_unique
  on public.profiles (username_key);
create index if not exists profiles_role_idx on public.profiles (role);

alter table public.profiles enable row level security;
revoke all on public.profiles from anon;
grant select on public.profiles to authenticated;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
  on public.profiles for select to authenticated
  using (auth.uid() = id);

-- Create a profile automatically when an Auth account is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_username text;
begin
  requested_username := trim(coalesce(new.raw_user_meta_data ->> 'username', ''));
  if requested_username = '' then
    requested_username := split_part(coalesce(new.email, 'user'), '@', 1);
  end if;
  if length(requested_username) < 3 or length(requested_username) > 32
     or requested_username !~ '^[A-Za-z0-9_.-]+$' then
    raise exception 'Username harus 3-32 karakter dan memakai huruf, angka, titik, garis bawah, atau strip.';
  end if;
  if lower(requested_username) = 'zill' then
    raise exception 'Username ini tidak tersedia.';
  end if;
  insert into public.profiles (id, username, email, role, email_confirmed)
  values (new.id, requested_username, coalesce(new.email, ''), 'basic', new.email_confirmed_at is not null);
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

create or replace function public.sync_user_email_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email_confirmed_at is distinct from old.email_confirmed_at or new.email is distinct from old.email then
    update public.profiles
      set email = coalesce(new.email, ''), email_confirmed = (new.email_confirmed_at is not null)
      where id = new.id;
  end if;
  return new;
end;
$$;
revoke all on function public.sync_user_email_confirmation() from public, anon, authenticated;
drop trigger if exists on_auth_user_email_confirmation on auth.users;
create trigger on_auth_user_email_confirmation
after update of email_confirmed_at, email on auth.users
for each row execute procedure public.sync_user_email_confirmation();

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Update last_login without giving users permission to change their role.
create or replace function public.touch_my_profile()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Login diperlukan.'; end if;
  update public.profiles set last_login = now() where id = auth.uid();
end;
$$;
revoke all on function public.touch_my_profile() from public, anon;
grant execute on function public.touch_my_profile() to authenticated;

-- Admin-only RPC: list profiles. Authorization is checked on the server.
create or replace function public.admin_list_profiles()
returns table (
  id uuid,
  username text,
  email text,
  role text,
  created_at timestamptz,
  last_login timestamptz,
  email_confirmed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('owner', 'developers')
  ) then
    raise exception 'Akses ditolak.' using errcode = '42501';
  end if;
  return query
    select p.id, p.username, p.email, p.role, p.created_at, p.last_login, p.email_confirmed
    from public.profiles p order by p.created_at desc;
end;
$$;
revoke all on function public.admin_list_profiles() from public, anon;
grant execute on function public.admin_list_profiles() to authenticated;

create or replace function public.admin_set_profile_role(p_username text, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('owner', 'developers')
  ) then
    raise exception 'Akses ditolak.' using errcode = '42501';
  end if;
  if p_role not in ('basic', 'vip', 'owner', 'developers') then
    raise exception 'Role tidak valid.';
  end if;
  if lower(trim(p_username)) = 'zill' and p_role <> 'developers' then
    raise exception 'Role akun khusus tidak dapat diturunkan.';
  end if;
  update public.profiles set role = p_role
  where username_key = lower(trim(p_username));
  if not found then raise exception 'User tidak ditemukan.'; end if;
end;
$$;
revoke all on function public.admin_set_profile_role(text, text) from public, anon;
grant execute on function public.admin_set_profile_role(text, text) to authenticated;

create or replace function public.admin_delete_user(p_username text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_id uuid;
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('owner', 'developers')
  ) then
    raise exception 'Akses ditolak.' using errcode = '42501';
  end if;
  select p.id into target_id from public.profiles p
  where p.username_key = lower(trim(p_username));
  if target_id is null then raise exception 'User tidak ditemukan.'; end if;
  if target_id = auth.uid() then raise exception 'Tidak dapat menghapus akun sendiri.'; end if;
  if lower(trim(p_username)) = 'zill' then raise exception 'Akun khusus tidak dapat dihapus.'; end if;
  -- Deleting auth.users cascades to public.profiles.
  delete from auth.users where id = target_id;
end;
$$;
revoke all on function public.admin_delete_user(text) from public, anon;
grant execute on function public.admin_delete_user(text) to authenticated;

-- IMPORTANT: after creating your account, promote it manually from SQL Editor:
-- update public.profiles set role = 'developers' where username_key = lower('YOUR_USERNAME');
-- Only run that statement for your own account.
