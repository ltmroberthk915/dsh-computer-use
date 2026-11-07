# Computer Use à la manière de Codex

**La façon la plus précise de piloter Windows depuis DeepSeek Harness — et la moins coûteuse par tâche.**

Décrivez l'objectif. Votre agent lit l'identité exacte des contrôles, agit par les contrôles eux-mêmes, vérifie le résultat — et exécute une séquence connue en un seul aller-retour de modèle au lieu de dix.

[English](README.md) | [中文](README.zh.md) | **Français** | [Deutsch](README.de.md) | [Español](README.es.md) | [Português](README.pt.md) | [العربية](README.ar.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) · [Installer](#install-and-update-in-dsh-market) · [Journal des modifications](CHANGELOG.md) · [Nouveautés 2.0.0](docs/RELEASE-2.0.0.md)

![Contrôle du bureau Windows à la manière de Codex : observer, agir, vérifier](docs/images/01-codex-style.png)

## Pourquoi c'est le plus précis

- **L'identité, pas les devinettes.** UI Automation expose l'arborescence réelle des contrôles avec des `AutomationId` exacts, et les actions peuvent piloter un contrôle via ses propres modèles UI Automation au lieu de cliquer sur des coordonnées.
- **Les repères sont vérifiés, jamais présumés.** Par défaut, un repère numéroté est validé par rapport à l'identité de la fenêtre et aux pixels échantillonnés avant l'envoi de toute entrée, si bien qu'un repère périmé est refusé plutôt que cliqué au mauvais endroit. Lorsqu'un voisin animé invalide sans cesse la signature de pixels, `uiaOnly` ancre l'identité sur le handle de fenêtre et la géométrie, tandis que la vérification d'occlusion au moment de l'envoi reste appliquée.
- **Les requêtes restent bornées.** Les requêtes UIA sont par défaut limitées à une profondeur de 6, 120 nœuds et un budget souple de 1200 ms ; une requête plus profonde que 6 ou portant sur plus de 300 nœuds exige un `anchor` mesuré, afin qu'aucune requête ne puisse balayer discrètement la mauvaise région.
- **Quand l'application le cache, lisez l'écran.** `computer_ocr` renvoie des lignes et des zones par mot en pixels d'écran absolus, ce qui permet de localiser par leur nom les applications dépourvues d'UIA.

## Pourquoi il coûte moins cher

- **Un seul aller-retour pour une séquence connue.** Un appel `computer_batch` exécute une liste d'actions en série, s'arrête à la première erreur et ne coûte qu'un aller-retour de modèle au lieu d'un par action.
- **Seul le delta est renvoyé.** Indiquez l'ID d'observation précédent comme `since` et recevez les ajouts, modifications, suppressions et l'ordre — et non l'arborescence entière à nouveau.
- **Des reçus compacts par défaut dans la 2.0.0.** Le texte post-action ajoute normalement au plus 6 KiB au reçu d'action ; `feedback: full` reste disponible lorsque le détail compte davantage.
- **Les preuves restent hors de la conversation.** Les preuves ponctuelles complètes peuvent résider dans un cache local borné (4 MiB de mémoire, 32 MiB de disque, 64 enregistrements, expiration après 24 heures) et être récupérées à la demande.
- **Le travail local reste local.** UI Automation, l'OCR d'écran et les vérifications de pixels s'exécutent dans le worker natif précompilé — aucune facture de vision supplémentaire par étape.

## Conçu pour un bureau que vous utilisez toujours

- **Il vous attend.** Un préavis de 1 seconde avant toute entrée (0,1 seconde dans une fenêtre glissante de 3 minutes) rend immédiatement la main sur le bureau ; une fois que vous avez terminé, l'agent observe à nouveau et poursuit la tâche d'origine.
- **Le frein atteint le modèle.** `Ctrl+Esc` met en pause, `Ctrl+Alt+R` reprend, `Ctrl+Alt+Q` quitte, et un arrêt est poussé dans la session en cours. Les approbations restent activées par défaut et les champs de mot de passe sont refusés par défaut.
- **Il signale ce qu'il ne peut pas faire.** Le bureau sécurisé de Windows (invite UAC ou écran de verrouillage) est détecté et signalé, puis l'exécution reprend — sans nouvelle tentative à l'aveugle.

![Passation à l'humain : préparer, prendre la main, continuer](docs/images/02-handoff.png)

![Efficacité des tokens : observations ciblées, actions groupées et relecture des résultats](docs/images/03-token-efficiency.png)

Les illustrations ci-dessus présentent le modèle d'interaction introduit dans la 1.3.0 ; le pointeur en forme de cerf-volant, les requêtes bornées et les reçus compacts de la 2.0.0 sont décrits plus haut. L'usage réel des tokens dépend de la tâche, du modèle et de la stratégie d'observation. Les approbations restent activées par défaut ; la pause, l'annulation et la sortie explicites font toujours autorité.

**Prêt à installer.** 19 outils de bureau, avec les composants natifs inclus. Aucun SDK ni compilation lors de l'installation. Nécessite Windows, Node.js ≥ 22 et le .NET Framework 4.x inclus avec Windows. Un plugin communautaire indépendant ; Codex décrit le style d'interaction.

## Nouveautés de la 2.0.0

- **Des reçus compacts par défaut** — le texte post-action ajoute normalement au plus 6 KiB au reçu d'action ; `feedback: full` et `feedback: none` sont des alternatives explicites.
- **Des requêtes UIA bornées et ancrées** — profondeur 6, 120 nœuds et budget souple de 1200 ms par défaut ; les requêtes plus profondes que 6 ou portant sur plus de 300 nœuds nécessitent un `anchor` mesuré.
- **Des preuves à la demande** — 4 MiB de mémoire + 32 MiB de disque, 64 enregistrements, expiration après 24 heures ; une défaillance de disque se replie sur la mémoire bornée.
- **Préavis de préparation adaptatif** — 1 seconde au départ, 0,1 seconde dans une fenêtre glissante de 3 minutes ; le cerf-volant incliné marque le point de clic de l'agent.
- **Chemin d'entrée renforcé** — raccourcis de gestion des fenêtres protégés, contre-pression et récupération du worker, contrôles de cibles périmées et nettoyage des annulations.

<details>
<summary>Version actuelle et compatibilité</summary>

**2.0.0** est la nouvelle version majeure, d'abord distribuée sur npm `next` pendant que s'exécute le contrôle de publication de 24 heures. Voir [changements et migration de la 2.0.0](docs/RELEASE-2.0.0.md). Consultez les tags du registre pour la disponibilité stable actuelle.

La version 1.3.1 lit le texte à l'écran pour retrouver les éléments par leur nom, détecte le bureau sécurisé de Windows et reprend d'elle-même, et maintient chaque couleur sur le même rail de bord dérivé du DPI avec un plancher de respiration visible. La version 1.3.0 libère le contrôle du bureau lorsque le travail se termine tandis que la conversation continue.

Correctifs antérieurs : [attribution des approbations 1.2.3](docs/RELEASE-1.2.3.md) · [attention native 1.2.1](docs/RELEASE-1.2.1.md) · [correctif d'hôte autonome](docs/RELEASE-1.2.2.md).

</details>

## Ce qu'il fait

La version 2.0.0 utilise également un pointeur compact bleu en forme de cerf-volant pendant le fonctionnement de l'IA et le maintien de scène. Sa pointe inclinée marque le point de clic, avec de petits symboles de texte et de redimensionnement à l'intérieur du cerf-volant. Un cerf-volant qui respire signifie que la page et la position du pointeur doivent rester en place ; le mode libre restaure le curseur normal de l'application. Le thème de curseur Windows de l'utilisateur est préservé.

La version 2.0.0 borne le parcours UIA et opte par défaut pour un texte post-action compact. Le retour d'image existant reste disponible ; `feedback: compact|full|none` contrôle le niveau de détail, et le paramètre de clic `verificationRegion: "x,y,w,h"` désigne la zone d'effet attendue indépendamment du point d'entrée. Le texte compact ajoute normalement au plus 6 KiB au reçu d'action d'origine. Les preuves ponctuelles complètes peuvent être conservées dans un cache local borné et à expiration, puis récupérées à la demande. Une défaillance de disque se replie sur la mémoire bornée ; si aucun instantané récupérable ne peut être conservé, les preuves courantes sont renvoyées intégralement dans la réponse, hors de ce budget compact, sans nouvelle observation ni nouvelle entrée.

Les requêtes UIA filtrées exigent `hwnd`. Les valeurs par défaut sont une profondeur de 6, 120 nœuds et un budget souple de 1200 ms. Une requête plus profonde que 6 ou portant sur plus de 300 nœuds exige un `anchor:"x,y"` mesuré dans cette fenêtre ; un `id` exact ne contourne pas cette règle. Un appel au fournisseur peut dépasser le budget souple, et des résultats partiels ne peuvent établir ni l'absence ni l'unicité. Après un raccourci de gestion des fenêtres, inspectez `computer_state {windows:true}`, activez la fenêtre visée avec succès, puis observez-la avant toute nouvelle entrée au clavier.

- **Observer** — liste des fenêtres, captures d'écran (région / JPEG / PNG / réduites), une carte Set-of-Marks des
  éléments cliquables et l'arborescence UI Automation avec des `AutomationId` exacts.
- **Agir** — cliquer, déplacer, glisser, faire défiler, sélectionner une plage de texte, taper, appuyer sur des touches et piloter des contrôles
  via leurs propres modèles UI Automation au lieu de coordonnées à l'aveugle.
- **Traiter par lots** — un appel `computer_batch` exécute une liste d'actions en série et s'arrête à la première
  erreur ; une séquence connue ne coûte donc qu'un aller-retour de modèle au lieu de dix.
- **Demander** — `computer_ask` pose une question sur la même carte de conversation que DSH utilise pour `ask_user_question`,
  sans compte à rebours.
- **Un frein humain qui atteint le modèle** — un arrêt est poussé dans la session en cours, si bien que l'agent
  apprend qu'il a été interrompu au lieu de le découvrir au tour suivant.

Les outils observent le bureau plutôt que de parcourir les documents de l'utilisateur. Le plugin gère les composants natifs dans
`%LOCALAPPDATA%\dsh-computer-use\worker\`, ainsi que les journaux d'audit, les captures d'écran et son propre cache borné
`observation-cache` sous `$DSH_HOME/data/computer-use/`. `computer_ctrl {action:"clear_cache"}` vide
le cache d'observation de cet Agent ; il ne supprime ni les captures d'écran, ni les pièces jointes, ni les documents de l'utilisateur.

<a id="install-and-update-in-dsh-market"></a>

## Installer et mettre à jour dans dsh-market

Recherchez **computer-use** ou **Codex-style** dans le market. Repérez le dépôt **ltmroberthk915/dsh-computer-use** et le paquet npm **dsh-codex-style-computer-use** (mainteneur : **ltmroberthk**), puis cliquez sur **Installer**. Utilisez **Mettre à jour** ou **Tout mettre à jour** pour les mises à jour du canal stable. Les deux composants natifs sont inclus ; ni PowerShell 7 ni une autorisation de compilation ne sont nécessaires.

Sinon, saisissez **`dsh-codex-style-computer-use`** dans **Paramètres → Plugins → Ajouter un plugin** pour le canal stable actuel, ou **`dsh-codex-style-computer-use@2.0.0`** pour la version décrite ici. Saisissez directement la spécification du paquet npm. Votre hôte peut appliquer une période d'attente aux nouvelles versions ; suivez son indication. Un bundle nouvellement ajouté peut se charger à chaud sur les hôtes compatibles ; vérifiez que ses outils et sa compétence apparaissent. Redémarrez depuis la zone de notification lors du remplacement d'une version chargée, lorsque le client reste obsolète ou lorsque DSH signale **restart-required**.

### Versions publiées depuis moins de 24 heures

La configuration pnpm 11.7.0 non stricte par défaut enregistre automatiquement une exception de version unique et procède à l'installation. La réussite d'une installation sur une machine ne prouve pas qu'une autre machine autorise les versions récentes.

Avec `minimumReleaseAgeStrict: true` (ou une politique d'hôte qui active des contrôles stricts de l'âge de publication), et sans exception applicable, une version qui n'a pas encore atteint l'âge configuré est rejetée avant l'exécution du code du plugin. Nous avons vérifié que le nom seul, un épinglage exact `@1.2.0` et l'URL du tarball npm échouent tous avec `ERR_PNPM_NO_MATURE_MATCHING_VERSION` sous cette politique. Définir explicitement `minimumReleaseAge: 1440` active aussi le comportement strict dans pnpm 11.7.0, sauf si `minimumReleaseAgeStrict` est défini séparément à false. Redémarrer DSH, installer PowerShell ou réessayer la même commande ne corrige pas un refus dû à une politique stricte. Le pont de bureau officiel n'accepte pas d'options pnpm supplémentaires.

Si une politique stricte bloque l'installation, attendez que la version atteigne l'âge configuré pour l'installer sans changer de politique. La version 1.2.0 a été publiée le `2026-10-03T03:50:11.586Z` ; elle satisfait au seuil de 24 heures après **2026-10-04 03:50:12 UTC** (11:50:12 en Chine). Un seuil personnalisé plus long ou un miroir de registre en retard peut retarder encore la disponibilité. Les utilisateurs du mode non strict par défaut n'ont pas besoin d'attendre ni de modifier la configuration pour ce paquet.

Si vous choisissez explicitement d'installer plus tôt, fusionnez cette exception de version unique dans le fichier `pnpm-workspace.yaml` existant du profil cible, puis relancez l'installation depuis le market. Préservez les autres entrées ; ne désactivez pas la politique d'âge globale :

```yaml
minimumReleaseAgeExclude:
  - dsh-codex-style-computer-use@1.2.0
```

Le chemin par défaut du profil desktop est `%USERPROFILE%\.dsh\profiles\desktop\pnpm-workspace.yaml` ; utilisez le répertoire réel si `DSH_HOME` est personnalisé. Supprimez cette exception après la maturation de la version si vous le souhaitez.

Les corrections antérieures de la documentation et du contrôle de l'éditeur n'ont pas modifié le runtime de la 1.2.0 et n'ont nécessité aucune réinstallation. Le correctif d'attention native de la **1.2.1** nécessite bien une mise à jour. Réajouter la même source peut produire une erreur d'hôte `ambiguous-install` sur certains chemins d'installation ; réinstaller la 1.2.0 n'appliquera pas le correctif de la 1.2.1.

**Migration d'une ancienne installation Git/tarball de ce dépôt :** supprimez l'ancienne entrée **dsh-computer-use** dans le market, puis installez **dsh-codex-style-computer-use**. Le nom npm non scoped `dsh-computer-use` appartient à un autre dépôt ; ne l'installez pas comme mise à jour de ce plugin. Une installation Git ne peut pas changer d'identité de dépendance en récupérant simplement un nouveau commit. Après cette migration d'interface ponctuelle, utilisez les mises à jour normales du market. Les noms d'outils `computer_*` existants et l'espace de noms de paramètres `computer-use` sont conservés.

**Préservez aussi votre configuration enregistrée :** sauvegardez le fichier `cordis.patch.yml` du profil, puis remplacez uniquement `name: dsh-computer-use` par `name: dsh-codex-style-computer-use` sur une surcharge ayant `id: computer-use`. Conservez l'intégralité de ses champs `config` et `disabled`. Conserver le seul espace de noms de paramètres ne suffit pas : une inadéquation de nom amène DSH à ignorer même les surcharges `read-only`, `dryRun` et celles à l'état désactivé. Ne remplacez pas globalement d'autres plugins ni un patch partagé du home. Le script `scripts/migrate-profile.mjs` du dépôt affiche un aperçu par défaut ; `--apply` crée une sauvegarde et remplace le fichier de manière atomique, en refusant les modifications concurrentes.

Sinon, téléchargez l'[utilitaire de migration de configuration](https://github.com/ltmroberthk915/dsh-computer-use/releases/download/v1.2.0/computer-use-profile-migration.zip), extrayez-le et double-cliquez sur `migrate-profile.cmd`. Il localise l'application Desktop officielle installée et utilise Windows PowerShell 5.1 ainsi que le Node fourni avec DSH pour réparer le profil desktop par défaut. Il s'arrête si le nouveau bundle est absent ou si l'ancien bundle est toujours sélectionné. Il ne modifie pas la politique d'âge de publication. Pour un autre profil, exécutez `migrate-profile.ps1 -ProfileDirectory <absolute-directory>` pour un aperçu, puis ajoutez `-Apply` lorsque vous êtes prêt.

La GitHub Release inclut aussi `dsh-computer-use.tgz` pour une installation hors ligne/manuelle ; l'installation via le registre est la méthode par défaut pour les mises à jour du market.

Utilisateurs de la CLI (profil web) :

```sh
dsh plugin --profile web add dsh-codex-style-computer-use
```

Les diagnostics du profil desktop doivent utiliser la **CLI fournie avec l'application Desktop officielle** :

```powershell
$CuDshInstall = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'
& "$CuDshInstall\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop why dsh-codex-style-computer-use
```

Pour une installation personnalisée, définissez `$CuDshInstall` sur le répertoire indiqué dans la cible du raccourci Desktop. Un `dsh` npm global plus ancien peut rejeter le profil desktop. N'ajoutez pas `resources/runtime/bin` au PATH global et n'installez pas un pnpm séparé pour cette tâche. Privilégiez l'interface du plugin pour l'installation.

## La compétence intégrée

Les outils de pilotage restent verrouillés tant que la session n'a pas produit une phrase de reçu qui n'existe qu'à l'intérieur de
`skills/computer-use/SKILL.md`. C'est délibéré — c'est la version honnête la plus forte de « lisez le manuel avant de piloter », car aucune couche d'outils ne peut voir si un modèle a lu un document.

Le plugin enregistre la compétence intégrée via `ctx.skills.register()` lorsque ce service est disponible. Si ce service est absent, `computer_use_activate` renvoie le même manuel, son chemin source absolu et la liste d'outils limitée au périmètre. Le reçu et tous les contrôles d'approbation et de frein existants s'appliquent toujours.

## Entrée partagée dans la 1.2.0-rc.2

Cette préversion introduit la prise de main immédiate par l'humain, l'attente automatique après 2 secondes d'entrée continue et la reprise après 3 secondes de calme. L'attente se produit localement, sans interrogation répétée du modèle. Les écritures interrompues exigent une nouvelle relecture et ne sont jamais rejouées à l'aveugle. L'annulation par l'hôte libère l'entrée acceptée et détenue par l'automatisation sans créer de nouvelle pause persistante. La gestion existante de DSH Pet et de la fenêtre principale, ainsi que celle du maintien au premier plan d'origine, est conservée.

Les routes configurées GLM 5.3 Max, GLM 5.3 Flash et DeepSeek Flash ont réussi un test contrôlé du protocole de reprise. L'entrée native et les raccourcis physiques ont été vérifiés séparément ; il ne s'agit pas d'un benchmark général du bureau ou de la vision. Voir [la vérification de publication](docs/RELEASE-1.2.0-rc.2.md) pour le périmètre.

## Contrôles à la demande dans la 1.1

- **Outils par Agent :** les Agents inactifs voient `computer_use_activate`, `computer_ctrl` et `computer_ask`. Un chargement réussi de la compétence computer-use, un reçu ou une activation expose les 19 outils de bureau ainsi que l'entrée d'activation à cet Agent. Les autres Agents et les agents enfants s'activent indépendamment. Les appels natifs et `run_code` de Node sont pris en charge. L'activation ne démarre pas le contrôle et ne libère pas un frein humain.
- **Cibles UIA observées :** une requête de nom ou d'identifiant limitée à un périmètre renvoie un handle de cible opaque. Utilisez-le pour les actions par modèle ; l'option `rebind:true` permet une récupération par identité unique ou par sémantique après remplacement dans la même fenêtre. Un contexte modifié, une ambiguïté ou un balayage incomplet entraîne un refus. Les requêtes larges ignorent les handles de récupération sauf si `targets:true` ; créer des témoins pour une longue liste coûte un travail natif supplémentaire.
- **Observations incrémentales :** indiquez l'ID d'observation précédent comme `since` avec la même requête. Les deltas préservent les ajouts, modifications, suppressions et l'ordre. Les instantanés sont isolés par Agent, avec au plus 64 observations indexées et 4 MiB de JSON conservé par stockage. `snapshot` récupère un résultat historique conservé ; `offset` et `limit` paginent ses tableaux. Une base manquante, un périmètre modifié, des preuves incomplètes ou un delta plus volumineux se replient sur la sortie complète.

Voir [le protocole détaillé](skills/computer-use/references/progressive-control.md) pour les limites de cache et les frontières de récupération. Les instantanés UIA préservent les champs renvoyés par le fournisseur dans les limites existantes du fournisseur ; la récupération historique ne constitue pas une vérification fraîche du résultat.

## Outils

| Groupe | Outils |
|---|---|
| Activer | `computer_use_activate` |
| Observer | `computer_state` `computer_shot` `computer_ocr` `computer_marks` `computer_uia` |
| Agir | `computer_click` `computer_move` `computer_drag` `computer_scroll` `computer_select` `computer_key` `computer_type` `computer_uia_act` `computer_window` `computer_clip` |
| Flux | `computer_wait` `computer_batch` |
| Méta | `computer_ask` `computer_ctrl` |

`computer_marks` renvoie des repères numérotés pour les éléments qu'il a trouvés à l'écran ; `computer_marks {shot:true}` enregistre aussi une image annotée. `computer_shot` renvoie une capture d'écran simple et, sur les routes compatibles avec les images, une pièce jointe d'image native. Un repère est un ID d'instantané : il est validé par rapport à l'identité de la fenêtre et aux pixels échantillonnés avant l'envoi de toute entrée, si bien qu'un repère périmé est refusé plutôt que cliqué au mauvais endroit.

## Modes d'approbation

Pour un hôte qui signale un refus automatique (invites désactivées) comme « l'utilisateur a rejeté l'outil », voir le [patch d'attribution des approbations DSH et son test de non-régression](docs/APPROVAL-ATTRIBUTION.md).

`automationMode` se définit dans les paramètres du plugin et vaut `standard` par défaut :

| Mode | Observation | Actionnement |
|---|---|---|
| `read-only` | autorisée | refusé |
| `standard` | autorisée | chaque action demande confirmation via la carte d'approbation de l'hôte |
| `autonomous` | autorisée | autorisé, les opérations à haut risque demandent toujours confirmation |
| `unrestricted` | autorisée | autorisé (le dispositif de sécurité du worker et la limite de débit s'appliquent toujours) |

Les opérations à haut risque (fermer une fenêtre, `alt+f4`, `win+r` et similaires) demandent confirmation dans tous les modes. Les champs de mot de passe sont détectés via `IsPassword` d'UI Automation et refusés par défaut.

## Modèle de sécurité

- **Entrée partagée** — l'activité ordinaire de l'utilisateur est autorisée pendant que l'agent réfléchit, observe ou se prépare. Pendant l'actionnement proprement dit, la saisie, le défilement et les boutons cèdent immédiatement ; le déplacement du pointeur dispose d'une tolérance de 16 pixels. Une entrée continue, ou une touche ou un bouton maintenu pendant 2 secondes, déclenche une attente automatique. Après le relâchement et 3 secondes de calme, l'agent doit inspecter la cible actuelle et poursuivre la tâche d'origine, sans rejouer à l'aveugle des écritures partielles. Un dégradé doux jaune pâle sur le bord indique que l'humain a la main.
- **Pause manuelle** — seul le raccourci physique `Ctrl+Esc` déclenche un frein d'entrée persistant ; `Ctrl+Alt+R` reprend. La touche Échap ordinaire, la saisie, le défilement, la distance ou la fréquence du pointeur et le coin de l'écran ne créent pas cette pause. Les maintiens explicites de question ou de diagnostic restent distincts.
- **Sortie** — `Ctrl+Alt+Q` met fin à la session : la surcouche disparaît, ses écouteurs sont démontés et tout actionnement ultérieur est refusé jusqu'à ce qu'un tour ultérieur en ouvre une nouvelle.
- **Le frein est un fait de la machine, pas d'un seul processus** — l'état activé est persisté et chaque worker l'adopte, y compris un worker démarré plus tard depuis un shell.
- **Audit** — chaque actionnement est ajouté à `$DSH_HOME/data/computer-use/audit.jsonl` avec assainissement des arguments.
- **Interrupteur d'arrêt du plugin lui-même** — `DSH_COMPUTER_USE_KILL=1` empêche le plugin de démarrer ; `dryRun: true` simule les actionnements et se contente de les journaliser.

## Configuration

| Clé | Défaut | Signification |
|---|---:|---|
| `automationMode` | `standard` | mode d'approbation (ci-dessus) |
| `progressiveTools` | `true` | activation par Agent ; `false` expose les 19 outils de bureau globalement |
| `actionFeedback` | `true` | observer automatiquement après les actions directes et les lots |
| `actionFeedbackDetail` | `compact` | `compact`, `full` ou `none` ; le `feedback` d'un appel remplace ce défaut ; les preuves non mises en cache se replient sur une sortie complète directement dans la réponse |
| `dryRun` | `false` | simuler les actionnements, journalisation uniquement |
| `maxActionsPerMinute` | `60` | limite de débit d'actionnement au niveau du cœur |
| `annotateMarks` | `true` | dessiner les cadres Set-of-Marks sur les captures d'écran |
| `workerExe` | `""` | chemin explicite du worker ; vide = découverte automatique ou compilation |
| `snapshotDir` | `""` | répertoire des captures d'écran ; vide = `$DSH_HOME/data/computer-use/shots` |

## Serveur MCP

`mcp/` est un serveur MCP stdio sans dépendances reposant sur le même cœur, destiné aux clients qui parlent MCP plutôt que Cordis :

```sh
# published package (2.0.1 and later) — no checkout needed
npx -y dsh-codex-style-computer-use

# from a checkout
node mcp/src/index.js
```

Le serveur embarqué indique la version de ce paquet racine. Il démarre en observation seule. L'hôte de lancement peut définir `DSH_CU_ALLOW_INPUT=1` lorsqu'il détient l'autorisation des actions sur le bureau ; les appels d'outils MCP ne peuvent pas activer l'entrée. L'outil de compatibilité `cu_approve` se contente de signaler cette règle et n'accorde jamais de consentement. La politique `automationMode` de DSH appartient à l'adaptateur Cordis et n'est pas un service d'approbation MCP. `DSH_CU_DRY_RUN=1` simule une entrée que l'hôte a déjà activée.

Les deux adaptateurs utilisent la même grammaire des commandes clavier, les mêmes règles d'échec et de reprise des lots, et la même correspondance des coordonnées d'image. MCP renvoie des métadonnées de capture structurées et une seule image PNG/JPEG la plus récente, sans sérialiser les octets d'image dans du texte JSON. `cu_hold` / `cu_free` réservent ou libèrent la scène entre les actions ; `cu_release` met fin au cycle de bureau. `cu_drag` accepte les contrôles `expectCursor` et `hwnd`. MCP expose une surface d'outils plus réduite ; l'intégration des questions humaines et du cycle de vie de l'hôte, propre à DSH, est assurée par l'adaptateur Cordis.

## Développement

Les contrôles de publication de l'éditeur utilisent par défaut le registre officiel de npm. Si cette origine est inaccessible sur votre réseau, `CU_REGISTRY` sélectionne un miroir explicite pour la commande `check` en lecture seule ; le résultat JSON inclut `registry` et `authoritative`. Exemple en PowerShell (cela ne modifie que le shell courant) :

```powershell
$env:CU_REGISTRY = 'https://registry.npmmirror.com'
node scripts/release-channel.mjs check 1.2.0
Remove-Item Env:CU_REGISTRY
```

Le code de sortie `0` signifie que la version a passé le contrôle de publication de 24 heures, `2` qu'elle est encore en refroidissement et `1` que le contrôle a échoué. Une défaillance réseau ne prouve pas qu'un paquet n'est pas publié, et les miroirs peuvent être en retard. `promote` revérifie toujours et écrit `https://registry.npmjs.org`, en ignorant `CU_REGISTRY` ; il nécessite l'accès à cette origine, en utilisant la configuration proxy de npm si nécessaire. Cet outil d'éditeur ne fait pas partie de l'installation destinée aux utilisateurs finaux. Voir [la procédure de publication](docs/RELEASE-1.2.0.md).

Le dépôt fournit la suite de garde-fous qui protège les invariants ci-dessus — la durée de vie du cycle, le protocole question/frein, la classification des opérations, le verrou de compétence et le câblage de la compétence intégrée :

```sh
pwsh -NoProfile -ExecutionPolicy Bypass -File build/run-guards.ps1   # all guards
node build/verify-tools-schema.mjs                                   # tool-schema load guard
```

Les définitions d'outils sont compilées via le véritable DSL `@deepseek-ai/dsh-tools`, de sorte qu'une erreur de schéma échoue ici au lieu de faire tomber l'arborescence de plugins de l'hôte au redémarrage. Certains garde-fous compilent le worker natif et sont réservés à Windows.

## Licence

MIT — voir [LICENSE](LICENSE).
