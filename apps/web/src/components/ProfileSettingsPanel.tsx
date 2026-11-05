import { useRef, useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext'
import { supabaseClient } from '../lib/supabase'
import { useProfileAvatarUrl } from '../lib/useProfileAvatarUrl'

function getDisplayName(session: ReturnType<typeof useAuth>['session']) {
  const metadata = session?.user.user_metadata
  const savedName = metadata?.display_name ?? metadata?.full_name ?? metadata?.name
  return typeof savedName === 'string' && savedName.trim()
    ? savedName.trim()
    : session?.user.email?.split('@')[0] ?? ''
}

async function optimizeAvatar(file: File) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d')
  if (!context) {
    bitmap.close()
    throw new Error('Não foi possível preparar a imagem.')
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.84))
  if (!blob) throw new Error('Não foi possível preparar a imagem.')
  return blob
}

export function ProfileSettingsPanel() {
  const { session } = useAuth()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(() => getDisplayName(session))
  const [avatarPath, setAvatarPath] = useState(() => {
    const path = session?.user.user_metadata?.avatar_path
    return typeof path === 'string' ? path : ''
  })
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileMessage, setProfileMessage] = useState<string | null>(null)
  const [avatarBroken, setAvatarBroken] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null)
  const [resetSending, setResetSending] = useState(false)

  const avatarUrl = useProfileAvatarUrl(avatarPath)
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toLocaleUpperCase('pt-BR') || 'S'

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || !session || profileSaving) return
    const cleanName = name.trim()
    if (cleanName.length < 2 || cleanName.length > 100) {
      setProfileError('Informe um nome entre 2 e 100 caracteres.')
      return
    }
    setProfileSaving(true)
    setProfileError(null)
    setProfileMessage(null)
    let uploadedPath: string | null = null
    try {
      if (avatarFile) {
        const image = await optimizeAvatar(avatarFile)
        uploadedPath = `${session.user.id}/${crypto.randomUUID()}.webp`
        const { error: uploadError } = await supabaseClient.storage.from('profile-avatars').upload(uploadedPath, image, {
          cacheControl: '31536000',
          contentType: 'image/webp',
          upsert: false,
        })
        if (uploadError) throw uploadError
      }

      const oldPath = avatarPath
      const nextPath = uploadedPath ?? avatarPath
      const { error: updateError } = await supabaseClient.auth.updateUser({
        data: { ...session.user.user_metadata, display_name: cleanName, avatar_path: nextPath || null },
      })
      if (updateError) {
        if (uploadedPath) await supabaseClient.storage.from('profile-avatars').remove([uploadedPath])
        throw updateError
      }
      setName(cleanName)
      setAvatarPath(nextPath)
      setAvatarFile(null)
      setAvatarBroken(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
      if (uploadedPath && oldPath && oldPath !== uploadedPath) {
        void supabaseClient.storage.from('profile-avatars').remove([oldPath]).catch(() => undefined)
      }
      setProfileMessage('Perfil atualizado.')
    } catch {
      setProfileError(avatarFile
        ? 'Não foi possível salvar o perfil ou a foto. Tente novamente com outra imagem.'
        : 'Não foi possível salvar o perfil. Tente novamente.')
    } finally {
      setProfileSaving(false)
    }
  }

  async function removeAvatar() {
    if (!supabaseClient || !session || !avatarPath || profileSaving) return
    setProfileSaving(true)
    setProfileError(null)
    setProfileMessage(null)
    const previousPath = avatarPath
    try {
      const { error } = await supabaseClient.auth.updateUser({
        data: { ...session.user.user_metadata, display_name: name.trim(), avatar_path: null },
      })
      if (error) {
        setProfileError('Não foi possível remover a foto. Tente novamente.')
        return
      }
      setAvatarPath('')
      setAvatarBroken(false)
      void supabaseClient.storage.from('profile-avatars').remove([previousPath]).catch(() => undefined)
      setProfileMessage('Foto removida.')
    } catch {
      setProfileError('Não foi possível remover a foto. Tente novamente.')
    } finally {
      setProfileSaving(false)
    }
  }

  async function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || passwordSaving) return
    setPasswordError(null)
    setPasswordMessage(null)
    if (newPassword.length < 8) {
      setPasswordError('A nova senha precisa ter pelo menos 8 caracteres.')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('A confirmação não corresponde à nova senha.')
      return
    }
    setPasswordSaving(true)
    try {
      const { error } = await supabaseClient.auth.updateUser({ password: newPassword, current_password: currentPassword })
      if (error) {
        setPasswordError('Não foi possível alterar a senha. Confira a senha atual e tente novamente.')
        return
      }
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPasswordMessage('Senha alterada.')
    } catch {
      setPasswordError('Não foi possível alterar a senha. Confira a senha atual e tente novamente.')
    } finally {
      setPasswordSaving(false)
    }
  }

  async function sendPasswordReset() {
    if (!supabaseClient || !session?.user.email || resetSending) return
    setResetSending(true)
    setPasswordError(null)
    setPasswordMessage(null)
    try {
      const redirectTo = new URL('/redefinir-senha', window.location.origin).toString()
      const { error } = await supabaseClient.auth.resetPasswordForEmail(session.user.email, { redirectTo })
      if (error) {
        setPasswordError('Não foi possível enviar o link de recuperação agora.')
        return
      }
      setPasswordMessage(`Enviamos um link de recuperação para ${session.user.email}.`)
    } catch {
      setPasswordError('Não foi possível enviar o link de recuperação agora.')
    } finally {
      setResetSending(false)
    }
  }

  return (
    <>
      <section className="surface-panel settings-panel" aria-labelledby="profile-title">
        <div className="section-heading">
          <div><p className="eyebrow">MEU PERFIL</p><h2 id="profile-title">Nome e foto</h2></div>
        </div>
        <form className="profile-settings-form" onSubmit={(event) => void saveProfile(event)}>
          <div className="profile-settings-identity">
            <span className="profile-settings-avatar" aria-hidden="true">
              {avatarUrl && !avatarBroken ? <img alt="" onError={() => setAvatarBroken(true)} src={avatarUrl} /> : initials}
            </span>
            <div>
              <strong>{name || 'Seu perfil'}</strong>
              <small>{session?.user.email}</small>
              <label className="button button-secondary profile-photo-button">
                Escolher foto
                <input
                  accept="image/jpeg,image/png,image/webp"
                  id="profile-photo"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null
                    setAvatarFile(file && file.size > 10 * 1024 * 1024 ? null : file)
                    setProfileError(file && file.size > 10 * 1024 * 1024 ? 'Escolha uma imagem de até 10 MB.' : null)
                    setProfileMessage(null)
                  }}
                  ref={fileInputRef}
                  type="file"
                />
              </label>
              {avatarFile && <small className="profile-photo-selected">{avatarFile.name}</small>}
              <small className="profile-photo-privacy">A foto fica privada e só aparece na sua conta.</small>
              {avatarPath && <button className="text-button profile-photo-remove" disabled={profileSaving} onClick={() => void removeAvatar()} type="button">Remover foto</button>}
            </div>
          </div>
          <label className="record-field">
            <span className="field-label">Nome do perfil</span>
            <input autoComplete="name" className="text-input" maxLength={100} onChange={(event) => setName(event.target.value)} required value={name} />
          </label>
          {profileError && <p className="form-message form-message-error" role="alert">{profileError}</p>}
          {profileMessage && <p className="form-message form-message-success" role="status">{profileMessage}</p>}
          <button className="button button-primary" disabled={profileSaving} type="submit">{profileSaving ? 'Salvando…' : 'Salvar perfil'}</button>
        </form>
      </section>

      <section className="surface-panel settings-panel" aria-labelledby="security-title">
        <div className="section-heading">
          <div><p className="eyebrow">SEGURANÇA</p><h2 id="security-title">Senha e recuperação</h2></div>
        </div>
        <form className="profile-password-form" onSubmit={(event) => void updatePassword(event)}>
          <label className="record-field"><span className="field-label">Senha atual</span><input autoComplete="current-password" className="text-input" onChange={(event) => setCurrentPassword(event.target.value)} required type="password" value={currentPassword} /></label>
          <label className="record-field"><span className="field-label">Nova senha</span><input autoComplete="new-password" className="text-input" minLength={8} onChange={(event) => setNewPassword(event.target.value)} required type="password" value={newPassword} /></label>
          <label className="record-field"><span className="field-label">Confirmar nova senha</span><input autoComplete="new-password" className="text-input" minLength={8} onChange={(event) => setConfirmPassword(event.target.value)} required type="password" value={confirmPassword} /></label>
          {passwordError && <p className="form-message form-message-error" role="alert">{passwordError}</p>}
          {passwordMessage && <p className="form-message form-message-success" role="status">{passwordMessage}</p>}
          <div className="profile-password-actions">
            <button className="button button-primary" disabled={passwordSaving} type="submit">{passwordSaving ? 'Atualizando…' : 'Trocar senha'}</button>
            <button className="button button-secondary" disabled={resetSending} onClick={() => void sendPasswordReset()} type="button">{resetSending ? 'Enviando link…' : 'Enviar link para redefinir'}</button>
          </div>
        </form>
      </section>
    </>
  )
}
