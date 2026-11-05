import { useEffect, useState } from 'react'
import { supabaseClient } from './supabase'

export function useProfileAvatarUrl(path: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setUrl(null)
    if (!path || !supabaseClient) return () => { active = false }

    void supabaseClient.storage.from('profile-avatars').createSignedUrl(path, 60 * 60 * 24)
      .then(({ data, error }) => {
        if (active) setUrl(error ? null : data.signedUrl)
      })
      .catch(() => {
        if (active) setUrl(null)
      })
    return () => { active = false }
  }, [path])

  return url
}
