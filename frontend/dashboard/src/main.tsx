import React, { Suspense, lazy } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// /app/* is the dashboard; everything else is the landing page.
const DashboardApp = lazy(() => import('./dashboard/DashboardApp.tsx'))
const path = window.location.pathname
const isDashboard = path === '/app' || path.startsWith('/app/')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isDashboard ? (
      <Suspense fallback={null}>
        <DashboardApp />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
)
