import { createClient } from '@supabase/supabase-js'
import { getSupabaseConfigurationError } from './supabaseConfig'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? ''
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? ''

export const supabaseConfigurationError =
  import.meta.env.VITE_SUPABASE_CONFIG_ERROR?.trim() ||
  getSupabaseConfigurationError(supabaseUrl, publishableKey)
export const isSupabaseConfigured = supabaseConfigurationError === null

export const supabaseClient = isSupabaseConfigured
  ? createClient(supabaseUrl, publishableKey)
  : null
