import axios from 'axios'

// Separate storage key from the main app's token - the two are different
// sessions even when both apps run in the same browser.
const TOKEN_KEY = 'ackintel_admin_token'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}
export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token)
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
})

api.interceptors.request.use((config) => {
  const token = getToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const fallback = !err.response
      ? 'Could not connect to the server. Check your internet connection and try again.'
      : 'Something went wrong. Please try again.'
    const message = err.response?.data?.error || fallback
    err.userMessage = message

    // Session expired/invalid/no longer admin - drop the stale token and
    // bounce to admin login, skipping the auth endpoints themselves (a wrong
    // password on the admin login form is not a "session expired" event).
    const isAuthRoute = err.config?.url?.startsWith('/auth/')
    if (err.response?.status === 401 && !isAuthRoute) {
      clearToken()
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login'
      }
    }

    return Promise.reject(err)
  }
)

export default api
