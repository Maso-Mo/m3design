import { defineConfig } from 'vitest/config'

/**
 * Configuration des tests du Worker et des modules frontend purs.
 *
 * Les tests du Worker sont des tests d'INTÉGRATION : ils s'exécutent contre une
 * vraie base D1 locale (SQLite géré par workerd, via `wrangler`), créée dans un
 * dossier temporaire et initialisée par la même commande de migration que celle
 * utilisée en développement et en production. Les tests frontend couvrent les
 * fonctions pures de validation et le client HTTP, sans environnement DOM ajouté.
 *
 * Aucun accès réseau n'est nécessaire, aucun déploiement n'est réalisé, et aucun
 * secret réel n'est lu : seules des valeurs de test sont utilisées.
 */
export default defineConfig({
  test: {
    include: ['worker/tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Le démarrage de workerd et l'application des migrations prennent quelques
    // secondes : les délais par défaut seraient trop courts.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Une seule base temporaire vit à la fois : l'exécution séquentielle évite les
    // conflits de ressources et rend les échecs reproductibles.
    fileParallelism: false,
    env: {
      // Évite toute remontée de télémétrie pendant les tests.
      WRANGLER_SEND_METRICS: 'false',
    },
  },
})
