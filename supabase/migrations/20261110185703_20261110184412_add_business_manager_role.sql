-- A business can have one formal owner and multiple management members.
-- Keep this enum change in its own migration so later migrations can safely
-- reference the new value after this migration commits.
alter type public.business_member_role
  add value if not exists 'manager';
