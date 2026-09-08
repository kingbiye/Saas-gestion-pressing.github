# Pressing SaaS MVP

Monorepo TypeScript pour la gestion multi-tenant d'un pressing : authentification,
catalogue, depots, bilan mensuel et essai de 10 jours.

## Demarrage local

```bash
npm ci
copy .env.example .env
npm run db:generate
npm run db:push
npm run verify
npm run dev:api
```

L'API ecoute sur `http://localhost:4000` et le frontend sur `http://localhost:3000`.

## Qualite et CI

`npm run verify` regenere Prisma, verifie TypeScript et execute les builds de
production. Le workflow `.github/workflows/ci.yml` lance cette verification avec
`npm ci` sur chaque push et pull request vers `main`. Une publication doit etre
bloquee si la CI echoue.

## API

- `POST /auth/register`, `POST /auth/login`
- `POST /admin/login`
- `GET|POST /catalog`
- `GET|POST /deposits`
- `GET|POST /expenses`
- `GET /reports/monthly`
- `GET /billing/status`
- `GET /health`

Les routes metier exigent `Authorization: Bearer <token>` et renvoient
`402 TRIAL_EXPIRED` apres la periode configuree.

## Deploiement

Le frontend est exporte en fichiers statiques (`apps/web/out`) pour Cloudflare Pages.

Configuration Cloudflare Pages :

1. Connecter le depot GitHub a Cloudflare Pages.
2. Laisser le repertoire racine du projet vide (le monorepo utilise le `package-lock.json` racine).
3. Commande de build : `npm run build --workspace apps/web`.
4. Repertoire de sortie : `apps/web/out`.
5. Definir la variable d'environnement `NEXT_PUBLIC_API_URL` avec l'URL HTTPS
   publique de l'API, par exemple `https://api.example.com`.
6. Utiliser Node.js 20 ou superieur dans les parametres de build.

La variable `NEXT_PUBLIC_API_URL` est integree au build frontend : apres toute
modification, declencher un nouveau deploiement. Ne jamais mettre de secret
dans les variables `NEXT_PUBLIC_*`. Le fichier `apps/web/public/_headers`
ajoute les en-tetes de securite pris en charge par Cloudflare Pages.

L'API utilise Node.js et Prisma avec PostgreSQL. Le fichier `render.yaml`
decrit un deploiement Render avec un health-check sur `/health`. Configurez
toutes les variables secretes dans Render, jamais dans GitHub.

Deploiement de l'API sur Render :

1. Creer un nouveau **Blueprint** dans Render et selectionner le depot GitHub.
2. Render detecte `render.yaml` et cree le service `pressing-api`.
3. Renseigner `DATABASE_URL`, `DIRECT_URL`, `AUTH_SECRET`,
   `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD` et `WEB_ORIGIN` dans
   l'onglet **Environment**. `WEB_ORIGIN` doit etre l'URL HTTPS exacte du
   frontend Cloudflare Pages, sans slash final.
4. Generer `AUTH_SECRET` avec une valeur aleatoire longue et ne jamais reutiliser
   le mot de passe Supabase ou le mot de passe administrateur ailleurs.
5. Apres le premier deploiement, verifier `https://<service>.onrender.com/health`.
6. Reporter cette URL publique dans `NEXT_PUBLIC_API_URL` sur Cloudflare Pages,
   puis redeployer le frontend.

Le service utilise `PORT=10000`, la valeur recommandee par Render. Le build
execute `prisma generate` puis compile l'API ; les migrations de schema restent
gerees explicitement avec `npm run db:push` depuis un environnement de confiance.

Variables API de production :

- `DATABASE_URL`
- `DIRECT_URL`
- `AUTH_SECRET`
- `WEB_ORIGIN`
- `PLATFORM_ADMIN_EMAIL`
- `PLATFORM_ADMIN_PASSWORD`
- `TRIAL_DAYS`
- `PORT`

## Hygiene de production

- Ne jamais versionner `.env` ou les mots de passe.
- Utiliser `npm ci`, jamais `npm install`, dans CI et les builds de production.
- Ne pas reutiliser un dossier `.next` ou `dist` local : chaque plateforme genere un build propre.
- Executer `/health` apres chaque deploiement.
- Utiliser les redeploiements/rollbacks du fournisseur si un health-check echoue.
