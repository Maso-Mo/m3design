import { Layout } from './components/layout/Layout'
import { HomePage } from './pages/HomePage'

/**
 * Racine de l'application.
 *
 * Le site public tient sur une seule page (`/`), dont la navigation se fait par
 * ancres : il n'y a donc pas de routeur à installer pour l'instant. Les
 * dossiers `pages/` et `routes/` restent en place pour la suite (confirmation
 * d'envoi, administration), qui demandera de vraies URL.
 */
function App() {
  return (
    <Layout>
      <HomePage />
    </Layout>
  )
}

export default App
