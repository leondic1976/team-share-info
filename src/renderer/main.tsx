import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/query-client'
import { App } from './App'
import { SeatPicker } from './features/seat/SeatPicker'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        {/* shared PC: the sign-in window runs before anybody's data is open, so nothing of App (settings, connection) may load */}
        {window.location.hash.startsWith('#/popup/seat') ? <SeatPicker /> : <App />}
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>
)
