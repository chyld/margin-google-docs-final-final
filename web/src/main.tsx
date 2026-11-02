import { Component, StrictMode } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Root } from './components/Root.tsx'
// IBM Plex Sans: the app's UI font and the page's default font, bundled so it works offline. The
// range-aware files carry unicode-range, so browsers fetch only the subsets a page uses.
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans/700.css'
import '@fontsource/ibm-plex-sans/400-italic.css'
import '@fontsource/ibm-plex-sans/700-italic.css'
import './styles/app.css'
import './styles/editor.css'

// Shows a message instead of a blank page if rendering throws. Unsaved edits stay in local drafts.
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash" role="alert">
        <div>
          <h1>Something went wrong</h1>
          <p>{this.state.error.message}</p>
          <button type="button" className="button" onClick={() => window.location.assign('/')}>
            Reload Margin
          </button>
        </div>
      </div>
    )
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>,
)
