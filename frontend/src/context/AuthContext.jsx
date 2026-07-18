import { createContext, useContext, useEffect, useState } from 'react'
import api, { getToken, setToken, clearToken } from '../utils/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const token = getToken()
    if (!token) {
      setLoading(false)
      return
    }
    api.get('/auth/me')
      .then((res) => { if (!cancelled) setUser(res.data.user) })
      .catch(() => { if (!cancelled) clearToken() })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  async function login(email, password) {
    const res = await api.post('/auth/login', { email, password })
    setToken(res.data.token)
    setUser(res.data.user)
    return res.data.user
  }

  async function signup(username, email, password) {
    const res = await api.post('/auth/signup', { username, email, password })
    return res.data.message
  }

  function logout() {
    clearToken()
    setUser(null)
  }

  async function updateProfile(fields) {
    const res = await api.patch('/auth/me', fields)
    setUser(res.data.user)
    return res.data.user
  }

  async function changePassword(currentPassword, newPassword, confirmNewPassword) {
    const res = await api.post('/auth/change-password', { currentPassword, newPassword, confirmNewPassword })
    setToken(res.data.token)
    setUser(res.data.user)
    return res.data.user
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout, updateProfile, changePassword }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
