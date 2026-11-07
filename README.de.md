# Computer Use im Codex-Stil

**Die präziseste Art, Windows aus DeepSeek Harness heraus zu steuern — und die günstigste pro Aufgabe.**

Beschreiben Sie das Ziel. Ihr Agent liest exakte Steuerelement-Identitäten, handelt über die Steuerelemente selbst, verifiziert das Ergebnis — und erledigt eine bekannte Sequenz in einem einzigen Modell-Roundtrip statt in zehn.

[English](README.md) | [中文](README.zh.md) | [Français](README.fr.md) | **Deutsch** | [Español](README.es.md) | [Português](README.pt.md) | [العربية](README.ar.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) · [Installation](#install-and-update-in-dsh-market) · [Änderungsprotokoll](CHANGELOG.md) · [Neuerungen 2.0.0](docs/RELEASE-2.0.0.md)

![Windows-Desktop-Steuerung im Codex-Stil: beobachten, handeln, verifizieren](docs/images/01-codex-style.png)

## Warum es die präzise Wahl ist

- **Identität statt Raten.** UI Automation legt den echten Steuerelementbaum mit exakten `AutomationId`s offen, und Aktionen können ein Steuerelement über seine eigenen UI-Automation-Muster ansteuern, statt Koordinaten anzuklicken.
- **Markierungen werden geprüft, nicht blind vertraut.** Standardmäßig wird eine nummerierte Markierung vor dem Absenden von Eingaben gegen die Fensteridentität und abgetastete Pixel validiert, sodass eine veraltete Markierung abgelehnt statt an der falschen Stelle angeklickt wird. Wenn ein animierter Nachbar die Pixelsignatur immer wieder ungültig macht, bindet `uiaOnly` die Identität an das Fensterhandle und die Geometrie, während die Verdeckungsprüfung zum Zeitpunkt des Absendens weiterhin gilt.
- **Abfragen bleiben begrenzt.** UIA-Abfragen verwenden standardmäßig Tiefe 6, 120 Knoten und ein weiches Zeitbudget von 1200 ms; eine Abfrage, die tiefer als 6 geht oder mehr als 300 Knoten umfasst, erfordert einen gemessenen `anchor`, damit eine Abfrage nicht unbemerkt die falsche Region durchsucht.
- **Wenn die App es verbirgt, lesen Sie es.** `computer_ocr` liefert Zeilen und Boxen pro Wort in absoluten Bildschirmpixeln, sodass sich auch Anwendungen ohne UIA anhand ihres Namens auffinden lassen.

## Warum es weniger kostet

- **Eine Modellrunde für eine bekannte Sequenz.** Ein `computer_batch`-Aufruf führt eine Aktionsliste seriell aus, stoppt beim ersten Fehler und kostet einen Modell-Roundtrip statt einen pro Aktion.
- **Nur das Delta kommt zurück.** Übergeben Sie die vorherige Beobachtungs-ID als `since` und erhalten Sie Ergänzungen, Änderungen, Löschungen und die Reihenfolge — nicht wieder den ganzen Baum.
- **Standardmäßig kompakte Quittungen in 2.0.0.** Der Text nach einer Aktion erweitert die Aktionsquittung normalerweise um höchstens 6 KiB; `feedback: full` steht weiterhin zur Verfügung, wenn Details wichtiger sind.
- **Belege bleiben außerhalb des Gesprächs.** Vollständige Belege zu einzelnen Punkten können in einem begrenzten lokalen Cache aufbewahrt werden (4 MiB Arbeitsspeicher, 32 MiB Festplatte, 64 Einträge, 24 Stunden Ablaufzeit) und bei Bedarf abgerufen werden.
- **Lokale Arbeit bleibt lokal.** UI Automation, Bildschirm-OCR und Pixelprüfungen laufen im vorkompilierten nativen Worker — keine zusätzlichen Vision-Kosten pro Schritt.

## Entwickelt für einen Desktop, den Sie weiterhin nutzen

- **Es wartet auf Sie.** Eine 1-sekündige Ankündigung vor der Eingabe (0,1 Sekunden innerhalb eines gleitenden 3-Minuten-Fensters) gibt den Desktop sofort zurück; wenn Sie fertig sind, beobachtet der Agent erneut und setzt die ursprüngliche Aufgabe fort.
- **Die Bremse erreicht das Modell.** `Ctrl+Esc` pausiert, `Ctrl+Alt+R` setzt fort, `Ctrl+Alt+Q` beendet, und ein Stopp wird in die laufende Sitzung eingespeist. Genehmigungen bleiben standardmäßig aktiv und Passwortfelder werden standardmäßig abgelehnt.
- **Es meldet, was es nicht kann.** Der sichere Windows-Desktop (UAC-Aufforderung oder Sperrbildschirm) wird erkannt, gemeldet und anschließend fortgesetzt — statt blind erneut zu versuchen.

![Übergabe an den Menschen: vorbereiten, übernehmen, fortsetzen](docs/images/02-handoff.png)

![Token-Effizienz: fokussierte Beobachtungen, gebündelte Aktionen und Rücklesen der Ergebnisse](docs/images/03-token-efficiency.png)

Die Abbildungen oben zeigen das in 1.3.0 eingeführte Interaktionsmodell; der Drachenzeiger, begrenzte Abfragen und kompakte Quittungen aus 2.0.0 werden oben beschrieben. Der tatsächliche Token-Verbrauch hängt von Aufgabe, Modell und Beobachtungsstrategie ab. Genehmigungen bleiben standardmäßig aktiviert; ausdrückliche Pause, Abbruch und Beenden bleiben maßgeblich.

**Bereit zur Installation.** 19 Desktop-Tools, native Hilfsprogramme inklusive. Kein SDK und keine Kompilierung bei der Installation. Erfordert Windows, Node.js ≥ 22 und das mit Windows gelieferte .NET Framework 4.x. Ein unabhängiges Community-Plugin; Codex beschreibt den Interaktionsstil.

## Neu in 2.0.0

- **Standardmäßig kompakte Quittungen** — der Text nach einer Aktion erweitert die Aktionsquittung normalerweise um höchstens 6 KiB; `feedback: full` und `feedback: none` sind ausdrückliche Alternativen.
- **Begrenzte, verankerte UIA-Abfragen** — standardmäßig Tiefe 6, 120 Knoten und ein weiches Zeitbudget von 1200 ms; Abfragen, die tiefer als 6 gehen oder mehr als 300 Knoten umfassen, benötigen einen gemessenen `anchor`.
- **Belege auf Abruf** — 4 MiB Arbeitsspeicher + 32 MiB Festplatte, 64 Einträge, 24 Stunden Ablaufzeit; bei einem Festplattenfehler wird auf den begrenzten Arbeitsspeicher zurückgegriffen.
- **Adaptive Vorbereitungsankündigung** — anfangs 1 Sekunde, 0,1 Sekunden innerhalb eines gleitenden 3-Minuten-Fensters; der geneigte Drachenzeiger markiert den Klickpunkt des Agenten.
- **Gehärteter Eingabepfad** — abgesicherte Tastenkombinationen für die Fensterverwaltung, Gegendruck und Erholung des Workers, Prüfungen auf veraltete Ziele und Aufräumen bei Abbruch.

<details>
<summary>Aktuelle Version und Kompatibilität</summary>

**2.0.0** ist das neue Major-Release und wird zunächst über npm `next` verteilt, solange das 24-Stunden-Release-Gate läuft. Siehe [Änderungen und Migration in 2.0.0](docs/RELEASE-2.0.0.md). Prüfen Sie die Registry-Tags für die aktuell stabile Verfügbarkeit.

Version 1.3.1 liest Text anhand des Namens vom Bildschirm, erkennt den sicheren Windows-Desktop und setzt von selbst fort. Jede Farbe bleibt auf derselben, aus der DPI abgeleiteten Randschiene mit einem sichtbaren Mindestmaß an Atembewegung. Version 1.3.0 gibt die Desktopsteuerung frei, wenn die Arbeit endet, während der Chat weiterläuft.

Frühere Korrekturen: [1.2.3 Genehmigungszuordnung](docs/RELEASE-1.2.3.md) · [1.2.1 native Aufmerksamkeitskorrektur](docs/RELEASE-1.2.1.md) · [Standalone-Host-Patch](docs/RELEASE-1.2.2.md).

</details>

## Was es leistet

Version 2.0.0 verwendet außerdem während der KI-Bedienung und des Szenen-Halts einen kompakten blauen Drachenzeiger. Seine geneigte Spitze markiert den Klickpunkt, mit kleinen Text- und Größenänderungssymbolen im Drachen. Ein atmender Drachen bedeutet, dass Seite und Zeigerposition unverändert bleiben sollen; der freie Modus stellt den normalen Cursor der Anwendung wieder her. Das Windows-Cursorthema des Benutzers bleibt erhalten.

Version 2.0.0 begrenzt die UIA-Durchquerung und verwendet standardmäßig kompakten Text nach Aktionen. Die bestehende Bildrückmeldung bleibt verfügbar; `feedback: compact|full|none` steuert den Detailgrad, und mit `verificationRegion: "x,y,w,h"` benennt ein Klick den erwarteten Wirkungsbereich unabhängig vom Eingabepunkt. Kompakter Text erweitert die ursprüngliche Aktionsquittung normalerweise um höchstens 6 KiB. Vollständige Belege zu einzelnen Punkten können in einem begrenzten, mit Ablaufzeit versehenen lokalen Cache aufbewahrt und bei Bedarf abgerufen werden. Bei einem Festplattenfehler wird auf begrenzten Arbeitsspeicher zurückgegriffen; wenn kein abrufbarer Snapshot aufbewahrt werden kann, werden die aktuellen Belege vollständig inline zurückgegeben — außerhalb dieses kompakten Budgets, ohne eine weitere Beobachtung oder Eingabe.

Gefilterte UIA-Abfragen erfordern `hwnd`. Standardwerte sind Tiefe 6, 120 Knoten und ein weiches Zeitbudget von 1200 ms. Eine Abfrage, die tiefer als 6 geht oder mehr als 300 Knoten umfasst, erfordert einen gemessenen `anchor:"x,y"` in diesem Fenster; eine exakte `id` umgeht diese Regel nicht. Ein Provider-Aufruf kann das weiche Zeitbudget überschreiten, und Teilergebnisse können Abwesenheit oder Eindeutigkeit nicht belegen. Prüfen Sie nach einer Tastenkombination zur Fensterverwaltung `computer_state {windows:true}`, aktivieren Sie das gewünschte Fenster erfolgreich und beobachten Sie es, bevor Sie weitere Tastatureingaben machen.

- **Beobachten** — Fensterliste, Screenshots (Region / JPEG / PNG / herunterskaliert), eine Set-of-Marks-Karte der anklickbaren Elemente und der UI-Automation-Baum mit exakten `AutomationId`s.
- **Handeln** — klicken, bewegen, ziehen, scrollen, einen Textbereich auswählen, tippen, Tasten drücken und Steuerelemente über ihre eigenen UI-Automation-Muster statt über blinde Koordinaten ansteuern.
- **Bündeln** — ein `computer_batch`-Aufruf führt eine Aktionsliste seriell aus und stoppt beim ersten Fehler, sodass eine bekannte Sequenz einen Modell-Roundtrip statt zehn kostet.
- **Fragen** — `computer_ask` stellt eine Frage auf derselben Chat-Karte, die DSH für `ask_user_question` verwendet, ohne Countdown.
- **Eine menschliche Bremse, die das Modell erreicht** — ein Stopp wird in die laufende Sitzung eingespeist, sodass der Agent erfährt, dass er unterbrochen wurde, statt es erst im nächsten Turn zu entdecken.

Die Tools beobachten den Desktop, statt Benutzerdokumente zu durchkämmen. Das Plugin verwaltet native Hilfsprogramme in `%LOCALAPPDATA%\dsh-computer-use\worker\` sowie Audit-Protokolle, Screenshots und einen eigenen begrenzten `observation-cache` unter `$DSH_HOME/data/computer-use/`. `computer_ctrl {action:"clear_cache"}` leert den Beobachtungs-Cache dieses Agenten; es löscht keine Screenshots, Anhänge oder Benutzerdokumente.

<a id="install-and-update-in-dsh-market"></a>

## Installation und Updates in dsh-market

Suchen Sie im Markt nach **computer-use** oder **Codex-style**. Achten Sie auf das Repository **ltmroberthk915/dsh-computer-use** und das npm-Paket **dsh-codex-style-computer-use** (Betreuer: **ltmroberthk**), und klicken Sie dann auf **Installieren**. Nutzen Sie **Aktualisieren** bzw. **Alle aktualisieren** für Updates im stabilen Kanal. Beide nativen Hilfsprogramme sind enthalten; weder PowerShell 7 noch Build-Berechtigungen sind erforderlich.

Alternativ geben Sie **`dsh-codex-style-computer-use`** in **Einstellungen → Plugins → Plugin hinzufügen** für den aktuellen stabilen Kanal ein oder **`dsh-codex-style-computer-use@2.0.0`** für die hier beschriebene Version. Geben Sie die npm-Paketspezifikation direkt ein. Ihr Host kann für frische Versionen eine Wartezeit anwenden; folgen Sie seinen Hinweisen. Ein neu hinzugefügtes Bundle kann auf unterstützten Hosts live geladen werden; prüfen Sie, ob seine Tools und sein Skill erscheinen. Starten Sie aus dem Tray neu, wenn Sie eine geladene Version ersetzen, wenn der Client veraltet bleibt oder wenn DSH **restart-required** meldet.

### Releases, die weniger als 24 Stunden alt sind

Die standardmäßige, nicht strikte Konfiguration von pnpm 11.7.0 vermerkt automatisch eine Ausnahme für eine einzelne Version und installiert. Eine erfolgreiche Installation auf einem Rechner belegt nicht, dass ein anderer Rechner frische Versionen zulässt.

Mit `minimumReleaseAgeStrict: true` (oder einer Host-Richtlinie, die strikte Prüfungen des Release-Alters aktiviert) und ohne anwendbare Ausnahme wird eine Version unterhalb des konfigurierten Alters abgelehnt, bevor Plugin-Code ausgeführt wird. Der bloße Name, eine exakte Fixierung auf `@1.2.0` und die npm-Tarball-URL schlugen unter dieser Richtlinie alle nachweislich mit `ERR_PNPM_NO_MATURE_MATCHING_VERSION` fehl. Das explizite Setzen von `minimumReleaseAge: 1440` aktiviert in pnpm 11.7.0 ebenfalls striktes Verhalten, sofern `minimumReleaseAgeStrict` nicht separat auf false gesetzt wird. Ein Neustart von DSH, die Installation von PowerShell oder das Wiederholen desselben Befehls beheben eine Ablehnung durch die strikte Richtlinie nicht. Die offizielle Desktop-Bridge akzeptiert keine zusätzlichen pnpm-Flags.

Wenn eine strikte Richtlinie die Installation blockiert, warten Sie, bis die Version das konfigurierte Alter erreicht, um ohne Änderung der Richtlinie zu installieren. Version 1.2.0 wurde am `2026-10-03T03:50:11.586Z` veröffentlicht; sie erfüllt die 24-Stunden-Grenze ab **2026-10-04 03:50:12 UTC** (11:50:12 in China). Eine längere benutzerdefinierte Grenze oder ein verzögerter Registry-Spiegel können die Verfügbarkeit weiter hinauszögern. Benutzer der standardmäßigen, nicht strikten Konfiguration müssen für dieses Paket weder warten noch die Konfiguration bearbeiten.

Wenn Sie sich ausdrücklich dafür entscheiden, früher zu installieren, übernehmen Sie diese Ausnahme für eine einzelne Version in die bestehende `pnpm-workspace.yaml` des Zielprofils und wiederholen Sie dann die Installation aus dem Markt. Behalten Sie andere Einträge bei; deaktivieren Sie nicht die globale Altersrichtlinie:

```yaml
minimumReleaseAgeExclude:
  - dsh-codex-style-computer-use@1.2.0
```

Der standardmäßige Desktop-Pfad ist `%USERPROFILE%\.dsh\profiles\desktop\pnpm-workspace.yaml`; verwenden Sie das tatsächliche Verzeichnis, wenn `DSH_HOME` angepasst ist. Entfernen Sie diese eine Ausnahme bei Bedarf, sobald die Version das erforderliche Alter erreicht hat.

Die früheren Korrekturen an der Dokumentation und an der Publisher-Prüfung änderten die 1.2.0-Laufzeit nicht und erforderten keine Neuinstallation. Die native Aufmerksamkeitskorrektur in **1.2.1** erfordert jedoch ein Update. Das erneute Hinzufügen derselben Quelle kann bei einigen Installationswegen einen Host-Fehler `ambiguous-install` erzeugen; eine Neuinstallation von 1.2.0 wendet die Korrektur aus 1.2.1 nicht an.

**Migration einer älteren Git-/Tarball-Installation aus diesem Repository:** Entfernen Sie den alten Eintrag **dsh-computer-use** im Markt und installieren Sie dann **dsh-codex-style-computer-use**. Der npm-Name ohne Scope `dsh-computer-use` gehört zu einem anderen Repository; installieren Sie ihn nicht als Upgrade dieses Plugins. Eine Git-Installation kann ihre Abhängigkeitsidentität nicht allein durch das Abrufen eines neuen Commits wechseln. Nach dieser einmaligen UI-Migration verwenden Sie die normalen Markt-Updates. Bestehende Toolnamen `computer_*` und der Einstellungs-Namespace `computer-use` bleiben erhalten.

**Behalten Sie auch Ihre gespeicherte Konfiguration bei:** Legen Sie eine Sicherung der `cordis.patch.yml` des Profils an und ändern Sie dann in einem Override mit `id: computer-use` nur `name: dsh-computer-use` in `name: dsh-codex-style-computer-use`. Behalten Sie sämtliche Felder `config` und `disabled` bei. Allein die Beibehaltung des Einstellungs-Namespace reicht nicht: Eine Namensabweichung führt dazu, dass DSH selbst `read-only`, `dryRun` und Overrides im deaktivierten Zustand überspringt. Ersetzen Sie nicht global andere Plugins oder einen gemeinsamen Home-Patch. `scripts/migrate-profile.mjs` im Repository zeigt standardmäßig eine Vorschau an; `--apply` erstellt eine Sicherung und ersetzt die Datei atomar und lehnt gleichzeitige Änderungen ab.

Alternativ können Sie das [Migrationsprogramm für die Konfiguration](https://github.com/ltmroberthk915/dsh-computer-use/releases/download/v1.2.0/computer-use-profile-migration.zip) herunterladen, es entpacken und auf `migrate-profile.cmd` doppelklicken. Es ermittelt die installierte offizielle Desktop-App und verwendet Windows PowerShell 5.1 sowie das mit DSH gelieferte Node, um das Standard-Desktopprofil zu reparieren. Es stoppt, wenn das neue Bundle fehlt oder das alte Bundle noch ausgewählt ist. Es ändert nicht die Release-Altersrichtlinie. Für ein anderes Profil führen Sie `migrate-profile.ps1 -ProfileDirectory <absolute-directory>` aus, um eine Vorschau zu erhalten, und fügen dann `-Apply` hinzu, wenn Sie bereit sind.

Das GitHub-Release enthält außerdem `dsh-computer-use.tgz` für die Offline- und manuelle Installation; die Installation über die Registry ist der Standard für Markt-Updates.

CLI-Benutzer (Web-Profil):

```sh
dsh plugin --profile web add dsh-codex-style-computer-use
```

Desktop-Diagnosen müssen die **in der offiziellen Desktop-App enthaltene CLI** verwenden:

```powershell
$CuDshInstall = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'
& "$CuDshInstall\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop why dsh-codex-style-computer-use
```

Legen Sie bei einer benutzerdefinierten Installation `$CuDshInstall` auf das Verzeichnis im Ziel der Desktop-Verknüpfung fest. Ein älteres globales npm-`dsh` kann das Desktop-Profil ablehnen. Fügen Sie `resources/runtime/bin` nicht zum globalen PATH hinzu und installieren Sie für diese Aufgabe kein separates pnpm. Bevorzugen Sie die Plugin-UI für die Installation.

## Der mitgelieferte Skill

Die Steuerungstools bleiben gesperrt, bis die Sitzung eine Quittungsformulierung erzeugt, die nur in `skills/computer-use/SKILL.md` enthalten ist. Das ist Absicht — es ist die stärkste ehrliche Variante von „Lesen Sie die Anleitung, bevor Sie steuern“, denn keine Toolschicht kann sehen, ob ein Modell ein Dokument gelesen hat.

Das Plugin registriert den mitgelieferten Skill über `ctx.skills.register()`, wenn verfügbar. Ist dieser Dienst nicht vorhanden, gibt `computer_use_activate` dasselbe Handbuch, seinen absoluten Quellpfad und die bereichsbezogene Tool-Liste zurück. Die Quittung und alle bestehenden Genehmigungs- und Bremsprüfungen gelten weiterhin.

## Geteilte Eingabe in 1.2.0-rc.2

Diese Vorabversion führt die sofortige Übernahme durch den Menschen ein, das automatische Warten nach 2 Sekunden fortgesetzter Eingabe und die Fortsetzung nach 3 Sekunden Ruhe. Das Warten erfolgt lokal ohne Modell-Polling. Unterbrochene Schreibvorgänge erfordern ein frisches Rücklesen und werden nie blind wiederholt. Eine Host-Stornierung gibt akzeptierte, von der Automatisierung übernommene Eingaben frei, ohne eine neue dauerhafte Pause zu erzeugen. Die bestehende Behandlung von DSH Pet/Hauptfenster und des ursprünglichen Topmost-Status bleibt erhalten.

Die konfigurierten Routen GLM 5.3 Max, GLM 5.3 Flash und DeepSeek Flash bestanden einen kontrollierten Test des Fortsetzungsprotokolls. Native Eingabe und physische Hotkeys wurden getrennt verifiziert; dies ist kein allgemeiner Desktop- oder Vision-Benchmark. Zum Umfang siehe [Release-Verifikation](docs/RELEASE-1.2.0-rc.2.md).

## Bedarfsgesteuerte Steuerung in 1.1

- **Tools pro Agent:** Inaktive Agenten sehen `computer_use_activate`, `computer_ctrl` und `computer_ask`. Ein erfolgreiches Laden des computer-use-Skills, eine Quittung oder eine Aktivierung macht die 19 Desktop-Tools samt Aktivierungseintrag für diesen Agenten verfügbar. Andere Agenten und untergeordnete Agenten aktivieren unabhängig. Native Aufrufe und Node `run_code` werden unterstützt. Eine Aktivierung startet weder die Steuerung noch löst sie eine menschliche Bremse.
- **Beobachtete UIA-Ziele:** Eine bereichsbezogene Name-/ID-Abfrage gibt ein opakes Ziel-Handle zurück. Verwenden Sie es für Musteraktionen; das optionale `rebind:true` erlaubt eine Wiederherstellung über eindeutige Identität oder Semantik nach einem Austausch im selben Fenster. Bei geändertem Kontext, Mehrdeutigkeit oder unvollständigen Scans wird abgelehnt. Breite Abfragen überspringen Wiederherstellungs-Handles, sofern nicht `targets:true` gesetzt ist; das Erzeugen von Witnesses für eine große Liste verursacht zusätzliche native Arbeit.
- **Inkrementelle Beobachtungen:** Übergeben Sie die vorherige Beobachtungs-ID als `since` mit derselben Abfrage. Deltas bewahren Ergänzungen, Änderungen, Löschungen und die Reihenfolge. Snapshots sind pro Agent isoliert, mit höchstens 64 indizierten Beobachtungen und 4 MiB aufbewahrtem JSON pro Speicher. `snapshot` ruft ein aufbewahrtes historisches Ergebnis ab; `offset` und `limit` blättern durch dessen Arrays. Fehlende Basisbeobachtungen, geänderter Umfang, unvollständige Belege oder ein größeres Delta fallen auf die vollständige Ausgabe zurück.

Siehe [das detaillierte Protokoll](skills/computer-use/references/progressive-control.md) für Cache-Limits und die Grenzen der Wiederherstellung. UIA-Snapshots bewahren vom Provider zurückgegebene Felder innerhalb der bestehenden Provider-Grenzen; der historische Abruf ist keine frische Verifikation des Ergebnisses.

## Tools

| Gruppe | Tools |
|---|---|
| Aktivieren | `computer_use_activate` |
| Beobachten | `computer_state` `computer_shot` `computer_ocr` `computer_marks` `computer_uia` |
| Handeln | `computer_click` `computer_move` `computer_drag` `computer_scroll` `computer_select` `computer_key` `computer_type` `computer_uia_act` `computer_window` `computer_clip` |
| Ablauf | `computer_wait` `computer_batch` |
| Meta | `computer_ask` `computer_ctrl` |

`computer_marks` gibt nummerierte Markierungen für die auf dem Bildschirm gefundenen Elemente zurück; `computer_marks {shot:true}` speichert zusätzlich ein annotiertes Bild. `computer_shot` gibt einen einfachen Screenshot und, auf bildfähigen Routen, einen nativen Bildanhang zurück. Eine Markierung ist eine Snapshot-ID: Sie wird vor dem Absenden von Eingaben gegen die Fensteridentität und abgetastete Pixel validiert, sodass eine veraltete Markierung abgelehnt statt an der falschen Stelle angeklickt wird.

## Genehmigungsmodi

Wenn ein Host eine automatische Ablehnung bei deaktivierter Nachfrage als „der Benutzer hat das Tool abgelehnt“ meldet, siehe [DSH-Patch zur Genehmigungszuordnung und Regressionstest](docs/APPROVAL-ATTRIBUTION.md).

`automationMode` wird in den Einstellungen des Plugins festgelegt und ist standardmäßig `standard`:

| Modus | Beobachtung | Betätigung |
|---|---|---|
| `read-only` | erlaubt | verweigert |
| `standard` | erlaubt | jede Aktion fragt über die Genehmigungskarte des Hosts nach |
| `autonomous` | erlaubt | erlaubt, Vorgänge mit hohem Risiko fragen weiterhin nach |
| `unrestricted` | erlaubt | erlaubt (Worker-Failsafe und Ratenbegrenzung gelten weiterhin) |

Vorgänge mit hohem Risiko (ein Fenster schließen, `alt+f4`, `win+r` und Ähnliches) fragen in jedem Modus nach. Passwortfelder werden über `IsPassword` von UI Automation erkannt und standardmäßig abgelehnt.

## Sicherheitsmodell

- **Geteilte Eingabe** — gewöhnliche Benutzeraktivität ist erlaubt, während der Agent denkt, beobachtet oder sich vorbereitet. Während der tatsächlichen Betätigung weichen Tippen, Scrollen und Schaltflächen sofort; Zeigerbewegungen haben eine Verschiebungstoleranz von 16 Pixeln. Fortgesetzte Eingabe oder eine 2 Sekunden lang gehaltene Taste/Schaltfläche führt in das automatische Warten. Nach dem Loslassen und 3 Sekunden Ruhe muss der Agent das aktuelle Ziel prüfen und die ursprüngliche Aufgabe fortsetzen, ohne teilweise erfolgte Schreibvorgänge blind zu wiederholen. Ein sanfter hellgelber Randverlauf zeigt die menschliche Kontrolle an.
- **Manuelle Pause** — nur das physische `Ctrl+Esc` löst eine dauerhafte Eingabebremse aus; `Ctrl+Alt+R` setzt fort. Gewöhnliches Esc, Tippen, Scrollen, Zeigerdistanz/-frequenz und die Bildschirmecke erzeugen diese Pause nicht. Ausdrückliche Frage- und Diagnose-Haltezustände bleiben getrennt.
- **Beenden** — `Ctrl+Alt+Q` beendet die Sitzung: Das Overlay verschwindet, seine Listener werden abgebaut, und weitere Betätigungen werden abgelehnt, bis ein späterer Turn ein neues öffnet.
- **Die Bremse ist eine Tatsache über den Rechner, nicht über einen Prozess** — der aktivierte Zustand wird persistiert, und jeder Worker übernimmt ihn, auch ein später aus einer Shell gestarteter.
- **Audit** — jede Betätigung wird mit bereinigten Argumenten an `$DSH_HOME/data/computer-use/audit.jsonl` angehängt.
- **Kill-Switch für das Plugin selbst** — `DSH_COMPUTER_USE_KILL=1` lässt das Plugin den Start verweigern; `dryRun: true` simuliert Betätigungen und protokolliert sie nur.

## Konfiguration

| Schlüssel | Standard | Bedeutung |
|---|---:|---|
| `automationMode` | `standard` | Genehmigungsmodus (oben) |
| `progressiveTools` | `true` | Aktivierung pro Agent; `false` stellt die 19 Desktop-Tools global bereit |
| `actionFeedback` | `true` | nach direkten Aktionen und Batches automatisch beobachten |
| `actionFeedbackDetail` | `compact` | `compact`, `full` oder `none`; das `feedback` eines Aufrufs überschreibt diesen Standard; nicht zwischengespeicherte Belege fallen auf die vollständige Inline-Ausgabe zurück |
| `dryRun` | `false` | Betätigungen simulieren, nur protokollieren |
| `maxActionsPerMinute` | `60` | Ratenbegrenzung für Betätigungen auf Kernebene |
| `annotateMarks` | `true` | Set-of-Marks-Rahmen auf Screenshots zeichnen |
| `workerExe` | `""` | expliziter Worker-Pfad; leer = automatische Ermittlung oder Kompilieren |
| `snapshotDir` | `""` | Screenshot-Verzeichnis; leer = `$DSH_HOME/data/computer-use/shots` |

## MCP-Server

`mcp/` ist ein abhängigkeitsfreier MCP-stdio-Server über demselben Kern, für Clients, die MCP statt Cordis sprechen:

```sh
# published package (2.0.1 and later) — no checkout needed
npx -y dsh-codex-style-computer-use

# from a checkout
node mcp/src/index.js
```

Der eingebettete Server meldet die Version dieses Root-Pakets. Er startet nur mit Beobachtung. Der startende Host kann `DSH_CU_ALLOW_INPUT=1` setzen, wenn er die Autorisierung für Desktop-Aktionen besitzt; MCP-Toolaufrufe können Eingaben nicht aktivieren. Das Kompatibilitätstool `cu_approve` meldet nur diese Regel und erteilt nie eine Zustimmung. Die `automationMode`-Richtlinie von DSH gehört zum Cordis-Adapter und ist kein MCP-Genehmigungsdienst. `DSH_CU_DRY_RUN=1` simuliert Eingaben, die der Host bereits aktiviert hat.

Beide Adapter verwenden dieselbe Grammatik für Tastenbefehle, dieselben Regeln für Batch-Fehler und Fortsetzung und dieselbe Zuordnung von Bildkoordinaten. MCP gibt strukturierte Aufnahme-Metadaten und ein aktuelles PNG/JPEG-Bild zurück, ohne Bildbytes in JSON-Text zu serialisieren. `cu_hold` / `cu_free` reservieren oder geben die Szene zwischen Aktionen frei; `cu_release` beendet den Desktop-Zyklus. `cu_drag` akzeptiert `expectCursor`- und `hwnd`-Prüfungen. MCP bietet eine kleinere Tool-Oberfläche; die DSH-spezifische Integration von Menschenfragen und Host-Lebenszyklus wird vom Cordis-Adapter bereitgestellt.

## Entwicklung

Release-Prüfungen des Publishers verwenden standardmäßig die offizielle Registry von npm. Wenn dieser Ursprung in Ihrem Netzwerk nicht erreichbar ist, wählt `CU_REGISTRY` einen expliziten Spiegel für den schreibgeschützten Befehl `check`; das JSON-Ergebnis enthält `registry` und `authoritative`. Beispiel in PowerShell (ändert nur die aktuelle Shell):

```powershell
$env:CU_REGISTRY = 'https://registry.npmmirror.com'
node scripts/release-channel.mjs check 1.2.0
Remove-Item Env:CU_REGISTRY
```

Exit-Code `0` bedeutet, dass die Version die 24-Stunden-Publisher-Prüfung bestanden hat, `2` bedeutet, dass sie noch abkühlt, und `1` bedeutet, dass die Prüfung fehlgeschlagen ist. Ein Netzwerkfehler belegt nicht, dass ein Paket unveröffentlicht ist, und Spiegel können hinterherhinken. `promote` prüft immer erneut und schreibt `https://registry.npmjs.org`, wobei `CU_REGISTRY` ignoriert wird; es benötigt Zugriff auf diesen Ursprung und nutzt bei Bedarf die Proxy-Konfiguration von npm. Dieses Publisher-Tool ist nicht Teil der Endbenutzerinstallation. Siehe [das Release-Verfahren](docs/RELEASE-1.2.0.md).

Das Repository enthält die Guard-Suite, die die oben genannten Invarianten schützt — die Lebensdauer des Zyklus, das Frage-/Bremsprotokoll, die Klassifizierung der Vorgänge, das Skill-Gate und die Verdrahtung des mitgelieferten Skills:

```sh
pwsh -NoProfile -ExecutionPolicy Bypass -File build/run-guards.ps1   # all guards
node build/verify-tools-schema.mjs                                   # tool-schema load guard
```

Die Tooldefinitionen werden durch die echte `@deepseek-ai/dsh-tools`-DSL kompiliert, sodass ein Schemafehler hier fehlschlägt, statt beim Neustart den Plugin-Baum des Hosts lahmzulegen. Einige Guards kompilieren den nativen Worker und laufen nur unter Windows.

## Lizenz

MIT — siehe [LICENSE](LICENSE).
