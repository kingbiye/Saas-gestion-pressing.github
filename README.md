# Pressing SaaS

Application de gestion multi-tenant pour pressing, avec inscription, catalogue,
dépôts, dépenses, rapports mensuels et administration de la plateforme.

## Architecture

- `apps/web` : interface Next.js et routes API exécutées dans le runtime Node.js
  de Vercel. Le navigateur appelle l'API sur la même origine via `/api`.
- `apps/api` : logique métier HTTP utilisée par les routes Next.js et le serveur
  local de développement.
- `prisma` : schéma de données PostgreSQL.
- Supabase héberge PostgreSQL ; Vercel héberge l'application web et son API.
- `/` : connexion et espace des professionnels du pressing.
- `/admin` : connexion et tableau de bord de l'administration plateforme.

## Développement local

Prérequis : Node.js 20+ et une base PostgreSQL Supabase.

```bash
npm ci
copy .env.example .env
npm run db:generate
npm run db:push
npm run dev
```

L'application est disponible sur `http://localhost:3000`. Pour démarrer
uniquement l'API autonome, utilisez `npm run dev:api` ; celle-ci écoute sur
`http://localhost:4000`.

## Vérification

```bash
npm run verify
```

Cette commande génère le client Prisma, vérifie les types et compile les
workspaces. La CI GitHub exécute aussi cette vérification.

## API

- `POST /api/auth/register`, `POST /api/auth/login`
- `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`
- `POST /api/admin/login`
- `GET|POST /api/catalog`, `PATCH|DELETE /api/catalog/:id`
- `GET|POST /api/deposits`, `PATCH /api/deposits/:id`
- `GET|POST /api/expenses`
- `GET /api/reports/monthly`
- `GET|PATCH /api/settings/shop` (logo PNG, JPEG ou WebP, 1 Mo maximum)
- `GET /api/billing/status`
- `GET /api/health`

Les routes métier nécessitent un jeton Bearer. Les données sont isolées par
tenant. Les comptes suspendus ou dont l'essai est terminé ne peuvent plus
utiliser les routes métier.

## Déploiement Vercel et Supabase

1. Créer un projet PostgreSQL dans Supabase.
2. Dans les paramètres Supabase, récupérer l'URL du pooler de connexion pour
   `DATABASE_URL` (transaction pooler, port `6543`, avec
   `pgbouncer=true&connection_limit=1`) et l'URL PostgreSQL directe pour
   `DIRECT_URL` (port `5432`).
3. Importer le dépôt dans Vercel, sélectionner **Next.js** et définir
   `apps/web` comme **Root Directory**. Garder l'installation npm à la racine
   du monorepo pour que les dépendances partagées et le lockfile soient utilisés.
   La configuration Next.js autorise l'import du code partagé de `apps/api`.
4. Laisser la commande de build par défaut (`npm run build`). Le script
   `prebuild` génère le client Prisma avant la compilation Next.js.

5. Ajouter les variables d'environnement Vercel pour chaque environnement
   utilisé (`Production`, et éventuellement `Preview` et `Development`) :
   `DATABASE_URL`, `DIRECT_URL`, `AUTH_SECRET`, `PLATFORM_ADMIN_EMAIL`,
   `PLATFORM_ADMIN_PASSWORD` et `TRIAL_DAYS`.
6. Générer une valeur longue et aléatoire pour `AUTH_SECRET`. Les secrets
   Supabase et administrateur doivent rester dans les variables Vercel, jamais
   dans une variable `NEXT_PUBLIC_*` ni dans Git.
7. Appliquer le schéma à la base depuis un environnement de confiance. Le champ
   de logo de boutique est ajouté de façon nullable ; cette commande ne supprime
   pas les données existantes :

   ```bash
   npm run db:push
   ```

8. Après le déploiement, vérifier `https://<projet>.vercel.app/api/health`.

Le front et l'API sont servis sur la même origine Vercel : aucune URL d'API
publique distincte ni configuration CORS de production n'est nécessaire.

## Variables d'environnement

- `DATABASE_URL` : connexion Supabase via le pooler transactionnel.
- `DIRECT_URL` : connexion PostgreSQL directe Supabase utilisée par Prisma.
- `AUTH_SECRET` : secret de signature des jetons, obligatoire en production.
- `PLATFORM_ADMIN_EMAIL` et `PLATFORM_ADMIN_PASSWORD` : identifiants de
  l'administration de la plateforme.
- `TRIAL_DAYS` : durée de l'essai en jours (10 par défaut).
- `WEB_ORIGIN` et `PORT` : utilisés par le serveur API autonome local.

Ne jamais versionner `.env` ou d'autres secrets. Utiliser `npm ci` pour une
installation reproductible.
