-- Keep profile images private; the app signs avatar URLs for the owning account.
update storage.buckets
   set public = false
 where id = 'profile-avatars';
