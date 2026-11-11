-- Qualify the outer Storage object path. An unqualified `name` inside the
-- products EXISTS subquery resolves to products.name and rejects valid uploads.
drop policy if exists product_photos_select_current_owner_image on storage.objects;
drop policy if exists product_photos_insert_for_product_owners on storage.objects;
drop policy if exists product_photos_delete_for_product_owners on storage.objects;

create policy product_photos_select_current_owner_image
  on storage.objects for select to authenticated
  using (
    bucket_id = 'product-photos'
    and exists (
      select 1
      from public.products as product
      where product.id::text = (storage.foldername(objects.name))[2]
        and product.business_id::text = (storage.foldername(objects.name))[1]
        and product.image_path = objects.name
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
      where product.id::text = (storage.foldername(objects.name))[2]
        and product.business_id::text = (storage.foldername(objects.name))[1]
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
      where product.id::text = (storage.foldername(objects.name))[2]
        and product.business_id::text = (storage.foldername(objects.name))[1]
        and (select private.is_business_owner(product.business_id))
    )
  );
