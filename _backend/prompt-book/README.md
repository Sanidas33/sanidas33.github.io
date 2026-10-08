# Free-book lead capture — Google Apps Script backend

Powers two gated downloads on drinksbyneat.com. GitHub Pages is static, so this small Apps Script web app,
running under **sani@drinksbyneat.com** (project **DBN Prompt Book Leads**), does the server work:

| Page | Book | `book` field sent | Sheet tab | PDF Script Property |
|---|---|---|---|---|
| `/prompt-book/` | The Bartender's AI Prompt Book | *(none — v1 default)* | `Leads` | `PDF_FILE_ID` |
| `/bcb/` | Running a Spirits Brand with AI (BCB Berlin 2026) | `bcb` | `BCB Leads` | `BCB_PDF_FILE_ID` |

For each submission it (v3):

* saves the lead to the private Google Sheet (**Drinks by Neat — Prompt Book Leads**), in that book's tab,
  with a personal download token (`download_token`, `download_token_expires`: 30 days, 20 downloads)
* **always** emails a "Download your copy" link (`https://drinksbyneat.com/<bcb|prompt-book>/download/?t=…`)
  from sani@drinksbyneat.com (reply-to the same address). The PDF is attached too when Drive allows; if the PDF
  can't be read, or sending with the attachment fails, the same email goes out without it (and never says "attached")
* sends a short alert to sani@drinksbyneat.com (name, email, book, what failed) if the PDF couldn't be read or the
  email failed, so nobody is missed
* returns the same token for the instant download on the page
* the PDFs sit **unshared** in Drive, so there's no public URL to pass around

No API keys, no DNS changes, no servers. The only credential is the one-time Google authorization.

## What changed in v3 (October 2026): the email link always goes out

Why: a `/bcb/` sign-up saved the lead, but the PDF couldn't be read (`BCB_PDF_FILE_ID` missing), and in v2 the email
depended on attaching the PDF, so no email went out at all.

* Two new columns, **appended at the end** of both tabs: `download_token`, `download_token_expires`. Existing columns
  never move. `setup()` adds them, and so does the first submission if `setup()` wasn't re-run.
* Every sign-up gets an email with a **Download your copy** link to `/bcb/download/` or `/prompt-book/download/`.
  The link works for 30 days and 20 downloads; downloads are counted in `downloads` / `last_download_at`.
* Email order: PDF attached + link (`email_status` = `sent`) -> link only (`sent_link_only`) -> `failed` /
  `failed_quota` only if Gmail itself refuses (quota or error). Wording never says "attached" unless it is.
* Alert to sani@drinksbyneat.com when the PDF can't be read or the email fails (never stops the sign-up).
* `selfTest()` (editor): checks the sheet, columns, both PDFs and the mail quota. Read-only, sends nothing.
* `setup()` no longer stops when a PDF is missing. It finishes everything else and logs exactly what to do.
* `resendBookEmail('name@example.com', 'bcb')` (editor, on purpose only): fresh link + email to one person.
* Download pages (`/bcb/download/`, `/prompt-book/download/`): noindex, not in the sitemap or `llms.txt`. They read
  `?t=`, take it out of the address bar before analytics loads, fetch the PDF in chunks, start the download, and show
  "Download again". **Both pages call the BCB deployment URL** (`AKfycbylcd…/exec`), because that deployment runs v3
  and the token row knows its own book (the page's `book` is only a hint for which tab to search first).
  Plausible event on those pages: `Book Link Download` (property `book`), optional goal.
* `prompt-book.js`: if the instant download fails it now says the link is in their inbox (v3 backend), or, when the
  email didn't go out, "We saved your details. If no email arrives in a few minutes, email sani@drinksbyneat.com."
* v2 short tokens and v1 requests (no `book`) still work. v2 is in git history for rollback.

## Updating to v3 (keeps both /exec URLs)

1. Open the **DBN Prompt Book Leads** project at <https://script.google.com> as sani@drinksbyneat.com.
   Select all of `Code.gs`, paste the v3 file, **Save**.
2. Run **setup** (function dropdown > setup > Run). Approve permissions if asked. Read the log: if it says
   "SETUP NEEDS ONE MORE STEP", follow it (usually: add Script Property `BCB_PDF_FILE_ID` = the PDF's Drive file ID).
3. Run **selfTest**. Every line should start with `OK`. It sends no email.
4. **Deploy > Manage deployments** > select the **BCB** web app deployment (the `AKfycbylcd…` one) > pencil (Edit) >
   Version: **New version** > Deploy. The URL stays the same, so the site needs no edit.
5. Recommended, so bartender sign-ups also get the link: in the same dialog, select the **bartender** deployment
   (`AKfycbwaob…`) > pencil > Version: pick the **same new version number** > Deploy. Its URL stays the same too.
   Until you do, `/prompt-book/` keeps running v1 (PDF attached, no link), which still works.
6. Health check (no side effects): open the `/exec` URL -> `{"ok":true,"service":"prompt-book"}`.

**Rollback:** Manage deployments > pencil > Version: the previous version > Deploy.

## What changed in v2 (October 2026, for /bcb/)

* `book: "bcb"` in the POST body -> `BCB Leads` tab (own headers, incl. `brand`), own roles list, own PDF, own email.
  A POST **without** `book` behaves exactly like v1 (bartender, `Leads` tab, same email word for word).
* BCB email: subject "Your copy: Running a Spirits Brand with AI". The "book a 15-minute call" sentence is only
  included when the marketing opt-in is ticked; otherwise it ends "If you have questions, just reply."
* `?action=pdf&t=…&part=N` returns the PDF in 192 KB chunks (`parts`, `bytes` in the reply). Without `part`
  you get the whole file, as in v1. The page JS asks for chunks, because a 1 MB+ base64 reply through
  Google's echo redirect is what failed in the browser test.
* `?action=export&key=…&book=bcb` exports the BCB tab (no `book` = bartender tab, as before).
* `deleteLeadsByEmail(email)` and the POST `delete` action now erase that email from **both** tabs.
* The `BCB Leads` tab is created by `setup()`, or on the first BCB submission if `setup()` wasn't re-run.
* v1 is in git history (commit before this PR) and in the workspace as `Code.v1.gs`, for rollback.

## Deploying v2 (history: how the BCB deployment was created)

Same Apps Script project, **new deployment** -> new `/exec` URL for `/bcb/`. The existing bartender
deployment stays pinned to its current version, so `/prompt-book/` keeps running v1 until you decide otherwise.
Script Properties (`SHEET_ID`, `PDF_FILE_ID`, `EXPORT_KEY`) are per project, so both deployments share the
same Sheet and key.

1. Signed in as **sani@drinksbyneat.com**, upload `spirits-ai-prompt-book-bcb-berlin-2026.pdf` to My Drive.
   **Don't share it.** Name it **Running a Spirits Brand with AI - Drinks by Neat.pdf** (setup finds it by
   "Spirits Brand"), *or* copy its file ID from the Drive URL and add Script Property `BCB_PDF_FILE_ID` yourself
   (Project Settings > Script Properties). The ID route is the most reliable.
2. Open the **DBN Prompt Book Leads** project at <https://script.google.com>. Replace all of `Code.gs` with the v2 file.
   `appsscript.json` is unchanged. Save.
3. Pick **setup** in the function dropdown and click **Run**. It adds the `BCB Leads` tab with headers, records
   `BCB_PDF_FILE_ID`, and logs both PDFs' names and sizes. It never touches existing `Leads` rows.
   If Google asks for permissions again, approve them (same scopes as before).
4. **Deploy > New deployment** (not "Manage deployments"). Type **Web app**, Execute as **Me**,
   Who has access **Anyone**, description "v2 BCB". Click **Deploy** and copy the new Web app URL.
5. Paste that URL into `bcb/index.html`: `data-endpoint="https://script.google.com/macros/s/…/exec"`.
   Until it's set, the `/bcb/` form shows a friendly "email sani@drinksbyneat.com" message and stores nothing.
6. Optional health check (no side effects): open `<new exec URL>` in a browser -> `{"ok":true,"service":"prompt-book"}`.
7. In Plausible: Site settings > Goals > Add goal > Custom event `BCB Book Download` (property `src`).
8. Later, if you want the bartender page on v2 too (chunked downloads): Deploy > Manage deployments > pencil on the
   **old** deployment > Version: the new version > Deploy. Its URL stays the same; `/prompt-book/` needs no edit.

**Rollback:** `/bcb/` -> archive the new deployment (Manage deployments). The bartender deployment was never changed.

## Day to day

* **See leads:** open the Sheet. Bartenders are in `Leads`, BCB sign-ups in `BCB Leads`. One row per submission,
  with `src`, both consents, and their timestamps.
* **Export CSV:** File > Download > CSV in the Sheet, or `<exec URL>?action=export&key=<EXPORT_KEY>` (bartender)
  / `…&book=bcb` (BCB). The key is in Project Settings > Script Properties.
* **Delete someone (GDPR):** delete their row(s), or run `deleteLeadsByEmail('name@example.com')` in the editor
  (clears both tabs).
* **`email_status`**: `sent` = PDF attached + link; `sent_link_only` = link only (check selfTest: usually the PDF);
  `failed` / `failed_quota` = no email went out (you also get an alert). Run `resendBookEmail(email, book)` once fixed,
  or send the PDF by hand.
* **Code changes:** Deploy > Manage deployments > pencil > Version: New version > Deploy. The URL stays the same.

## Limits

* MailApp quota: Google Workspace allows 1,500 recipients a day (consumer Gmail allows 100). The script checks first.
* Spam protection: an off-screen honeypot field and a minimum fill time of 2.5 seconds.
  Anything that trips them gets a fake success and nothing is stored. Each email address is limited to 3
  submissions every 10 minutes per book.
* Cells starting with `= + - @` are prefixed with `'` so nobody can inject a formula into the Sheet.

## Local testing (no Google, no email)

`backend/mock/` in the workspace (`/workspace/prompt-book-work/backend/mock/`) holds a Node mock of the Apps Script services.
`node test.js` runs the v2 unit tests (v1 behaviour + BCB); `node test.v3.js <Code.gs>` runs the v3 tests (link email, fallbacks, alerts, tokens, upgrade). `node server.js <site dir>` serves the site on :8787 with
any form whose `data-endpoint` is empty wired to the mock; "sent" emails land in `mock-outbox/` as .html/.txt.
