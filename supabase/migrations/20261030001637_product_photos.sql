-- Keep product photos private and scoped to an owner's own catalog records.

alter table public.products
  add column image_path text
    check (image_path is null or char_length(btrim(image_path)) between 1 and 512),
  add column pending_image_cleanup_path text
    check (pending_image_cleanup_path is null or char_length(btrim(pending_image_cleanup_path)) between 1 and 512);

grant update (image_path, pending_image_cleanup_path) on table public.products to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-photos',
  'product-photos',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
);

create policy product_photos_select_current_owner_image
  on storage.objects for select to authenticated
  using (
    bucket_id = 'product-photos'
    and exists (
      select 1
      from public.products as product
      where product.id::text = (storage.foldername(name))[2]
        and product.business_id::text = (storage.foldername(name))[1]
        and product.image_path = name
        and (select private.is_business_owner(product.business_id))
    )
  );

create policy product_photos_insert_for_product_owners
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'product-photos'
    and exists (
      select 1
      from public.products as product
      where product.id::text = (storage.foldername(name))[2]
        and product.business_id::text = (storage.foldername(name))[1]
        and (select private.is_business_owner(product.business_id))
    )
  );

create policy product_photos_delete_for_product_owners
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'product-photos'
    and exists (
      select 1
      from public.products as product
      where product.id::text = (storage.foldername(name))[2]
        and product.business_id::text = (storage.foldername(name))[1]
        and (select private.is_business_owner(product.business_id))
    )
  );
