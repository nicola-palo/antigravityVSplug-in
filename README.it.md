# Antigravity Panel (Unofficial)

> [!IMPORTANT]
> Questa è un'estensione **non ufficiale** sviluppata autonomamente. Non è affiliata, sponsorizzata o approvata da Google o dal team di Antigravity. Richiede che l'applicazione ufficiale Antigravity sia installata sul tuo computer.

L'**Agent Manager di Antigravity dentro VS Code e VSCodium**.

Questa estensione non re-implementa Antigravity: si collega all'applicazione
Antigravity già installata sul tuo computer e ne incorpora la **vera
interfaccia** (servita dal language server locale dell'app) in un pannello di
VS Code. Quindi:

- **Stessa estetica** — è letteralmente la UI di Antigravity, non una copia.
- **Selettore di modello e thinking** — quelli nativi dell'app (Gemini 3 Pro
  High/Low, Claude, ecc.), perfettamente funzionanti.
- **Stesso account e stesse conversazioni** dell'app Antigravity.
- **Cartella del progetto** — il pulsante *Apri progetto* invia la cartella
  aperta in VS Code direttamente ad Antigravity.

## Come funziona

L'app Antigravity avvia un language server locale (`language_server.exe`) che
serve l'interfaccia dell'Agent Manager in HTTPS su una porta locale casuale,
con un certificato self-signed di cui solo l'app Electron si fida. L'estensione:

1. trova il processo del language server di Antigravity e la sua porta HTTPS;
2. avvia un piccolo proxy locale che termina il TLS (accettando il certificato
   self-signed in Node) e riserve la UI in HTTP semplice su `127.0.0.1`;
3. inietta nella pagina i "bridge nativi" che la UI si aspetta dal preload di
   Electron (`nativeStorage`, `electronNative`, `dialog`, …): lo storage viene
   persistito dall'estensione, *apri cartella* usa il file picker di VS Code e
   i link esterni si aprono nel browser;
4. incorpora la UI in una webview (sidebar o scheda editor).

Se Antigravity non è in esecuzione, il pannello offre un pulsante **Avvia
Antigravity** che apre l'app con la cartella del progetto corrente e si
connette appena il server è pronto.

## Utilizzo

- Clicca l'icona **Antigravity** nella Activity Bar (barra laterale).
- Oppure: `Ctrl+Shift+P` → **Antigravity: Apri Agent Manager in una scheda**
  (consigliato: più spazio per la chat).
- **Antigravity: Apri la cartella del progetto in Antigravity** apre il
  progetto corrente nell'app.
- La voce **🚀 Antigravity** nella status bar mostra lo stato della
  connessione (✓ connesso / ○ non in esecuzione).

## Impostazioni

| Impostazione | Descrizione |
|---|---|
| `antigravityPanel.executablePath` | Percorso di `Antigravity.exe` (vuoto = rilevamento automatico in `%LOCALAPPDATA%\Programs\Antigravity`) |
| `antigravityPanel.port` | Porta del server (0 = rilevamento automatico) |
| `antigravityPanel.autoLaunch` | Avvia automaticamente l'app se non è in esecuzione |

## Installazione

```
code --install-extension antigravity-panel-0.1.0.vsix
codium --install-extension antigravity-panel-0.1.0.vsix
```

Oppure da VS Code/VSCodium: **Estensioni → menu "…" → Installa da VSIX…**

## Requisiti

- Applicazione [Antigravity](https://antigravity.google) installata.
- Windows (rilevamento automatico); macOS/Linux supportati impostando
  `antigravityPanel.executablePath`.

## Note

- L'estensione comunica esclusivamente con il server locale di Antigravity su
  `127.0.0.1`; nessun dato viene inviato altrove.
- Non è affiliata a Google.

## Licenza e Dichiarazione di Limitazione di Responsabilità

Questo progetto è distribuito sotto la [Licenza MIT](./LICENSE).

> [!WARNING]
> IL SOFTWARE VIENE FORNITO "COSÌ COM'È", SENZA GARANZIE DI ALCUN TIPO, ESPLICITE O IMPLICITE, INCLUSE, A TITOLO ESEMPLIFICATIVO, LE GARANZIE DI COMMERCIABILITÀ, IDONEITÀ PER UNO SCOPO PARTICOLARE E NON VIOLAZIONE. IN NESSUN CASO GLI AUTORI O I TITOLARI DEI DIRITTI D'AUTORE SARANNO RESPONSABILI PER QUALSIASI RECLAMO, DANNO O ALTRA RESPONSABILITÀ, SIA IN UN'AZIONE CONTRATTUALE, TORTO O ALTRO, DERIVANTE DA, O IN CONNESSIONE CON IL SOFTWARE O L'USO O ALTRI RAPPORTI CON IL SOFTWARE.

