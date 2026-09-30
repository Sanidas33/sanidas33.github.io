# Prompt Book lead capture — Google Apps Script backend

Powers the form at `/prompt-book/`. GitHub Pages is static, so this small Apps Script web app,
running under **sani@drinksbyneat.com**, does the server work:

* saves each lead to a private Google Sheet (**Drinks by Neat — Prompt Book Leads**, tab `Leads`)
* emails the PDF as an attachment from sani@drinksbyneat.com (reply-to the same address)
* returns a 30-minute, 5-use download token; the page trades it for the PDF
* the PDF sits **unshared** in Drive, so there's no public URL to pass around

No API keys, no DNS changes, no servers. The only credential is the one-time Google authorization.

## One-time setup (about 10 minutes)

1. Sign in to Google as **sani@drinksbyneat.com**. The email goes out from whichever account deploys the script.
2. Upload the PDF (`The Bartender's AI Prompt Book — Drinks by Neat.pdf`) to My Drive. **Don't share it.**
   `setup()` finds it by name ("Prompt Book"). You can also set `PDF_FILE_ID` yourself in Script Properties.
3. Open <https://script.new> and name the project "Prompt Book leads".
   * Replace the contents of `Code.gs` with [`Code.gs`](Code.gs).
   * Go to Project Settings, tick "Show appsscript.json manifest file in editor", then replace `appsscript.json` with [`appsscript.json`](appsscript.json).
4. In the editor, pick **setup**, click **Run**, and approve the Google permissions (Sheets, read-only Drive, send mail as you).
   Google will warn that the app is unverified. That's expected for your own script: click Advanced, then Go to Prompt Book leads.
   The execution log prints the new Sheet's URL.
5. Click **Deploy**, then **New deployment**. Choose type **Web app**, set Execute as: **Me**, Who has access: **Anyone**, then click **Deploy**.
   Copy the Web app URL (`https://script.google.com/macros/s/…/exec`).
6. Paste that URL into `prompt-book/index.html` on the form: `data-endpoint="https://script.google.com/macros/s/…/exec"`.
   Until it's set, the form shows a friendly "email sani@drinksbyneat.com" message and stores nothing.
7. In Plausible, go to Site settings, then Goals, then Add goal. Pick Custom event and name it `Prompt Book Download`.
   Optionally add the custom property `src` so you can split results by source (for example `berlin-seminar`).

## Day to day

* **See leads:** open the Sheet in Google Drive. There's one row per submission, with `src`, both consents, and their timestamps.
* **Export CSV:** in the Sheet, go to File, then Download, then CSV. You can also open `<exec URL>?action=export&key=<EXPORT_KEY>`
  (the key is in Project Settings, under Script Properties).
* **Delete someone (GDPR):** delete their row. You can also run `deleteLeadsByEmail('name@example.com')` in the editor.
* **`email_status` isn't `sent`** (Gmail quota or a hiccup): the visitor still got the instant download. Send them the PDF by hand.
* **Code changes:** go to Deploy, then Manage deployments, click the pencil icon, choose Version: New version, then Deploy. The URL stays the same.

## Limits

* MailApp quota: Google Workspace allows 1,500 recipients a day (consumer Gmail allows 100). The script checks the quota before sending.
* Spam protection: an off-screen honeypot field and a minimum fill time of 2.5 seconds.
  Anything that trips them gets a fake success and nothing is stored. Each email address is limited to 3 submissions every 10 minutes.
* Cells starting with `= + - @` are prefixed with `'` so nobody can inject a formula into the Sheet.

## Local testing

`/workspace/prompt-book-work/backend/mock/` holds a Node mock of the Apps Script services.
`node test.js` runs the unit tests. `node server.js` serves the site on :8787 with the form wired to the mock.
