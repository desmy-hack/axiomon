# Axiomon (AXN)

Cryptomonnaie pédagogique de type ERC-20, déployée sur le testnet Sepolia, avec une application web complète : comptes utilisateurs, wallet généré pour chaque compte, envoi de AXN, historique des transactions, administration.

## Ce que fait l'application

- **Contrat** (`contracts/Axiomon.sol`) : offre plafonnée à 21 000 000 AXN, **limite par transfert** (10 000 AXN par défaut, modifiable par le propriétaire), `mint` réservé au propriétaire, `burn` ouvert à chaque détenteur.
- **Backend** (`src/`) : API Express, base SQLite, mots de passe hachés (bcrypt), sessions par jeton JWT.
- **Wallets** : à l'inscription, le serveur génère une adresse Ethereum pour l'utilisateur. La clé privée est chiffrée (AES-256-GCM) avec `MASTER_KEY` avant d'être stockée. C'est un portefeuille *custodial* : le serveur signe les transactions pour l'utilisateur.
- **Frais de réseau** : le compte propriétaire envoie automatiquement un peu d'ETH de test à un utilisateur qui n'en a plus, pour que personne n'ait à passer par un faucet.
- **Interface** (`public/`) : connexion et inscription, solde, adresse, envoi, distribution quotidienne de AXN de test, historique avec liens vers Etherscan, section administrateur.

## Installation

Prérequis : Node.js 20 ou plus récent.

```bash
npm install
cp .env.example .env     # puis remplis .env
```

Pour générer les deux secrets (`JWT_SECRET` et `MASTER_KEY`, deux valeurs différentes) :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Essai en local (sans ETH de test)

1. Dans un terminal : `npm run chain`. Une blockchain locale démarre et affiche des comptes avec leurs clés privées.
2. Dans `.env` : `RPC_URL=http://127.0.0.1:8545`, et `OWNER_PRIVATE_KEY` = une des clés affichées (comptes de test publics, valables uniquement en local).
3. Dans un second terminal : `npm run compile`, puis `npm run deploy`, puis `npm start`.
4. Ouvre http://localhost:3000. Crée d'abord le compte `admin` (nom défini par `ADMIN_USERNAME`) : c'est lui qui aura la section Administration.
5. Pour un test automatique de l'API : `npm run smoke`.

## Déploiement sur Sepolia

1. **Compte propriétaire** : génère une clé *neuve*, sans aucun lien avec un compte réel.
   ```bash
   node -e "const {Wallet}=require('ethers');const w=Wallet.createRandom();console.log(w.address);console.log(w.privateKey)"
   ```
   Mets la clé privée dans `OWNER_PRIVATE_KEY`.
2. **ETH de test** : demande de l'ETH Sepolia pour l'adresse du propriétaire sur un faucet Sepolia (plusieurs existent, vérifie lesquels fonctionnent en ce moment). Il en faut assez pour le déploiement et pour approvisionner les utilisateurs en frais.
3. **RPC** : crée un accès Sepolia chez un fournisseur (Alchemy, Infura ou autre) et mets son URL dans `RPC_URL`.
4. **Déploie** : `npm run compile` puis `npm run deploy`. L'adresse du contrat s'affiche et s'écrit dans `build/deployment.json`. Tu peux la retrouver sur https://sepolia.etherscan.io.
5. Lance `npm start` et ouvre http://localhost:3000.

## Hébergement

Le backend sert aussi l'interface : un seul service à héberger (Node.js).

1. Compile (`npm run compile`) et publie le projet sur GitHub. `.env` et `data/` sont ignorés par Git : ne les ajoute jamais. `build/Axiomon.json` doit en revanche être publié.
2. Sur l'hébergeur (par exemple Render, Railway ou Fly.io), crée un service web Node.js relié au dépôt. Commande d'installation `npm install`, commande de démarrage `npm start`.
3. Renseigne les variables d'environnement de `.env.example` dans l'interface de l'hébergeur, avec `CONTRACT_ADDRESS` = l'adresse déployée.
4. **Crée le compte administrateur tout de suite** après la mise en ligne : le premier compte inscrit avec le nom `ADMIN_USERNAME` devient administrateur.
5. **Persistance** : la base SQLite est un fichier. Sur un hébergement dont le disque est éphémère, les comptes et wallets disparaissent à chaque redéploiement. Utilise un volume ou disque persistant (vérifie les conditions de ton hébergeur) et mets `DB_PATH` sur ce volume.

## Structure

```
contracts/Axiomon.sol   contrat ERC-20
scripts/compile.js      compilation (solc-js, EVM « paris »)
scripts/deploy.js       déploiement
scripts/smoke-test.js   test de bout en bout de l'API
src/                    backend (config, db, crypto, chain, server)
public/                 interface web
```

## Limites connues

- **Wallet custodial** : le serveur détient les clés. Quiconque obtient la base *et* `MASTER_KEY` contrôle tous les wallets. Acceptable sur un testnet, pas avec de vrais fonds.
- **Historique** : il contient les transactions faites *via l'application*. Un transfert envoyé depuis un autre outil (MetaMask, Remix) vers l'adresse d'un utilisateur change son solde mais n'apparaît pas dans l'historique.
- Limiteur de requêtes en mémoire, pas de vérification d'e-mail, pas de récupération de mot de passe.
- Les jetons de session sont gardés dans le navigateur (`localStorage`).
- La limite par transfert s'applique à tous les comptes, propriétaire compris.

## Dépannage

- `invalid opcode` au déploiement : la version d'EVM du compilateur ne correspond pas au réseau. Le script `compile.js` compile pour « paris », compatible avec Sepolia et les chaînes locales récentes.
- `insufficient funds` : le compte propriétaire n'a plus d'ETH. Recharge-le depuis un faucet.
- Erreur à l'installation de `better-sqlite3` : vérifie la version de Node (20 ou 22 recommandées) et relance `npm install`.
- Page blanche ou « Le serveur ne répond pas » : regarde la console du terminal où tourne `npm start`, en particulier l'avertissement « aucun contrat à cette adresse ».

## Fonctionnalités ajoutées (version PostgreSQL)

| Fonctionnalité | Où la voir |
|---|---|
| Verrouillage après 5 échecs de connexion (15 min) | Connexion ; variables `MAX_FAILED_LOGINS`, `LOCK_MINUTES` |
| Gel et dégel d'un compte | Administration → tableau des utilisateurs |
| Limite journalière par adresse (24 h glissantes) | Carte du solde « Reste aujourd'hui » ; modifiable dans Administration ; variable `DAILY_LIMIT` |
| Journal d'audit des actions admin | Administration → « Journal d'audit » |
| Export CSV de l'historique | Portefeuille → « Exporter en CSV » |
| Note (mémo) sur un transfert | Formulaire d'envoi, visible dans l'historique et le CSV |
| Recherche dans l'historique | Portefeuille → champ de recherche |
| Estimation des frais avant envoi | Fenêtre de confirmation de l'envoi |
| Page « À propos du token » | Menu « Le token » |
| Vérification Etherscan | `npm run compile` puis `npm run verify-info` |

**Migration de la base** : au démarrage, le serveur ajoute lui-même les colonnes et tables nécessaires (`frozen`, `failed_logins`, `locked_until`, `note`, `audit`, `settings`). Le même SQL est dans `migrations/001_fonctionnalites.sql` si tu préfères l'exécuter à la main dans le SQL Editor de Supabase.

**Tests** : avec la chaîne locale, le contrat déployé et le serveur lancés, `npm run smoke` puis `npm run test:features`.
