-- Older Evolution syncs stored an authoritative group subject in contact_name.
-- Move those legacy labels into the dedicated group field; never infer a group
-- title from an individual message sender.
update public.whatsapp_conversations
   set group_subject = nullif(btrim(contact_name), ''),
       contact_name = null
 where remote_jid ~* '@g[.]us$'
   and group_subject is null
   and nullif(btrim(contact_name), '') is not null
   and lower(btrim(contact_name)) not in (
     'grupo sem nome', 'grupo sem identificação', 'grupo sem identificacao',
     'contato sem nome', 'contato sem identificação',
     'contato sem identificacao'
   )
   and btrim(contact_name) !~* '(@g[.]us|@lid|@s[.]whatsapp[.]net|@c[.]us)$'
   and btrim(contact_name) !~ '^[+]?[0-9][0-9[:space:]().-]{7,}$';
