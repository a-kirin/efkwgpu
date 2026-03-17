import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import './lib/firebase'

createRoot(document.getElementById('root')!).render(<App />)
