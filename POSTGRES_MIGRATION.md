# Migration Axiomon vers Supabase PostgreSQL

## 1. Préparer l'environnement

1. Copie `.env.example` vers `.env`.
2. Dans Supabase, ouvre **Project Settings → Database → Connection string** et copie l'URI PostgreSQL. Remplace les valeurs d'exemple de `DATABASE_URL`; encode les caractères spéciaux du mot de passe URL si nécessaire.
3. Renseigne aussi les variables existantes d'Ethereum (`RPC_URL`, `OWNER_PRIVATE_KEY`, `CONTRACT_ADDRESS`) et les secrets `MASTER_KEY`, `JWT_SECRET` utilisés par l'application.
4. Ne publie jamais `.env` et ne mets jamais la clé privée du propriétaire dans Git.

## 2. Installer les dépendances

```bash
npm install
```

Le client PostgreSQL `pg` est utilisé par le serveur. `better-sqlite3` est conservé uniquement pour lire la base SQLite lors de l'import initial.

## 3. Vérifier le schéma Supabase

Le projet doit avoir les tables `public.users` et `public.transactions` avec les colonnes suivantes :

- `users`: `id`, `username`, `email`, `password_hash`, `address`, `key_enc`, `key_iv`, `key_tag`, `role`, `last_faucet_at`, `created_at`.
- `transactions`: `id`, `tx_hash`, `kind`, `from_address`, `to_address`, `amount`, `status`, `block_number`, `created_at`.

Les horodatages `created_at` et `last_faucet_at` restent en millisecondes Unix (`BIGINT`) pour préserver la compatibilité avec le code historique.

## 4. Importer les comptes et l'historique

Avant d'importer, assure-toi que les tables Supabase sont vides. Le script s'arrête si elles contiennent déjà des lignes.

```bash
npm run migrate:sqlite
```

Par défaut, le script lit `data/axiomon.db`. Il vérifie l'intégrité SQLite, copie les identifiants existants, les hashes de mots de passe et les clés privées déjà chiffrées, puis synchronise les séquences PostgreSQL. Il n'efface ni ne modifie la base SQLite source.

Si la base source se trouve ailleurs, définis `SQLITE_IMPORT_PATH` dans l'environnement avant de lancer la commande.

Après l'import, vérifie dans Supabase :

```sql
SELECT
  (SELECT COUNT(*) FROM public.users) AS users,
  (SELECT COUNT(*) FROM public.transactions) AS transactions;
```

Pour la base fournie avec l'archive, les valeurs attendues sont 3 utilisateurs et 4 transactions.

## 5. Démarrer

```bash
npm start
```

La connexion à PostgreSQL est asynchrone. Le backend ne doit pas démarrer sans `DATABASE_URL` valide. Vérifie les routes d'inscription, de connexion, de solde et d'historique avant tout déploiement public.

## Notes

- Le script d'import n'importe que les tables SQLite `users` et `transactions`; il ne migre pas les données de l'ancienne structure blockchain `axiomon_*` qui avait été supprimée du projet Supabase.
- La base SQLite originale doit être conservée comme sauvegarde jusqu'à ce que les tests de connexion et de migration soient terminés.
- Le projet utilise toujours un contrat Ethereum externe. Héberger PostgreSQL sur Supabase ne déploie pas le contrat et n'héberge pas à lui seul le serveur Express.
