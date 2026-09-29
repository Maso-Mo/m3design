import { AboutSection } from '../components/sections/AboutSection'
import { ContactSection } from '../components/sections/ContactSection'
import { GuaranteeSection } from '../components/sections/GuaranteeSection'
import { HeroSection } from '../components/sections/HeroSection'
import { ProcessSection } from '../components/sections/ProcessSection'
import { ProjectsSection } from '../components/sections/ProjectsSection'
import { ServicesSection } from '../components/sections/ServicesSection'
import { useScrollReveal } from '../hooks/useScrollReveal'

/**
 * Page d'accueil : succession des sept sections de la page unique.
 *
 * Chaque section porte elle-même son ancre, son rythme vertical et son
 * en-tête ; cette page ne fait que les ordonner. La section en cours de
 * construction reste directement après le Hero pour faciliter sa validation.
 */
export function HomePage() {
  useScrollReveal()

  return (
    <>
      <HeroSection />
      <AboutSection />
      <ServicesSection />
      <ProjectsSection />
      <ProcessSection />
      <GuaranteeSection />
      <ContactSection />
    </>
  )
}
