-- Create Likes Table
create table if not exists public.likes (
  user_address text not null,
  venture_id uuid not null references public.ventures(id) on delete cascade,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  primary key (user_address, venture_id)
);

-- Create Comments Table
create table if not exists public.comments (
  id uuid default gen_random_uuid() primary key,
  user_address text not null,
  venture_id uuid not null references public.ventures(id) on delete cascade,
  content text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS
alter table public.likes enable row level security;
alter table public.comments enable row level security;

-- Policies for Likes
create policy "Anyone can read likes"
  on public.likes for select
  using ( true );

create policy "Authenticated users can toggle likes"
  on public.likes for all
  using ( true )
  with check ( true ); 

-- Policies for Comments
create policy "Anyone can read comments"
  on public.comments for select
  using ( true );

create policy "Authenticated users can post comments"
  on public.comments for insert
  with check ( true ); 
