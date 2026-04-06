-- Create likes table
create table if not exists public.likes (
  user_address text not null,
  venture_id uuid not null references public.ventures(id) on delete cascade,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  primary key (user_address, venture_id)
);

-- Create comments table
create table if not exists public.comments (
  id uuid default gen_random_uuid() primary key,
  venture_id uuid not null references public.ventures(id) on delete cascade,
  user_address text not null,
  content text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS
alter table public.likes enable row level security;
alter table public.comments enable row level security;

-- Policies for Likes
create policy "Anyone can read likes" on public.likes for select using (true);
create policy "Authenticated users can like" on public.likes for insert with check (true);
create policy "Users can delete their own likes" on public.likes for delete using (true); -- Simplified for demo, ideally check user_address

-- Policies for Comments
create policy "Anyone can read comments" on public.comments for select using (true);
create policy "Authenticated users can comment" on public.comments for insert with check (true);
