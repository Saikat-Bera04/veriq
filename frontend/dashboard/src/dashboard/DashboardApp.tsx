import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'framer-motion'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import '../styles/veriq-tokens.css'
import 'veriq-client/styles.css'
import { Shell } from './components/Shell'
import { OverviewPage } from './pages/Overview'
import { FeedPage } from './pages/Feed'
import { ProvidersPage } from './pages/Providers'
import { LightClientPage } from './pages/LightClient'
import { AttackLabPage } from './pages/AttackLab'
import { PolicyPage } from './pages/Policy'
import { DevelopersPage } from './pages/Developers'
import { DelegationGuardPage } from './pages/DelegationGuard'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 1000 },
  },
})

export default function DashboardApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <BrowserRouter>
          <Routes>
            <Route path="/app" element={<Shell />}>
              <Route index element={<OverviewPage />} />
              <Route path="feed" element={<FeedPage />} />
              <Route path="delegation-guard" element={<DelegationGuardPage />} />
              <Route path="providers" element={<ProvidersPage />} />
              <Route path="light-client" element={<LightClientPage />} />
              <Route path="attack-lab" element={<AttackLabPage />} />
              <Route path="policy" element={<PolicyPage />} />
              <Route path="developers" element={<DevelopersPage />} />
              <Route path="*" element={<Navigate to="/app" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </MotionConfig>
    </QueryClientProvider>
  )
}
