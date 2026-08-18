import React, { Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import './styles/global.css'
import { ThemeProvider } from './ThemeProvider.tsx'
import { initI18n } from './i18n'
import App from './App.tsx'

// Boot i18n (from persisted language) before first render.
void initI18n().then(() => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <Suspense fallback={null}>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </Suspense>
    </React.StrictMode>,
  )
})