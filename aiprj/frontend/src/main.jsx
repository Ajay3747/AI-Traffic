import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import AmbulancePage from './AmbulancePage.jsx'

// No router dependency needed for a single extra page: pick the component
// by path once at load time. The existing dashboard at "/" is untouched.
const isAmbulanceRoute = ['/ambulance', '/driver'].includes(window.location.pathname)
const RootComponent = isAmbulanceRoute ? AmbulancePage : App

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RootComponent />
  </StrictMode>,
)
