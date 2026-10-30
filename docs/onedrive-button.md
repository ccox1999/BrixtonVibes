# Save to OneDrive — no new signup, payment card, server, or laptop

The app now uses the iPhone's own file-sharing screen. Your existing OneDrive
app or OneDrive Files provider authenticates and sends the file to Microsoft's
cloud. The public website has no access to your OneDrive account and receives
no Microsoft credentials. Other visitors can only use their own phone's save
destinations.

## Use it

1. Finish recording and label the trip, or skip. The complete recording saves
   on the phone first.
2. Tap **Save to OneDrive** directly below the recording controls.
3. In the system sheet, choose **OneDrive**, select the destination folder,
   and confirm the save. If OneDrive appears through **Save to Files** instead,
   choose its location there. This sends the prepared recording file directly;
   there is no preliminary download, desktop transfer, or manual file conversion.

The OneDrive app must already be installed and signed in with the intended
existing account. If OneDrive is missing from Files, enable it once in
**Files → Browse → More → Edit → OneDrive**. Apple's [cloud-provider guide](https://support.apple.com/en-us/102238)
describes that operating-system setting. Neither installing OneDrive nor using
the existing account is an Azure signup.

Saving is available after Finish, including after Skip and after reopening the
app. Older locally saved trips can be selected under Recordings & settings.
An unfinished recovery draft remains clearly marked and can be kept explicitly.

## What this does and does not guarantee

The file contains the original raw samples and compatible version-3 metadata,
with a deterministic `victoria-recording-ID.json` name. Preparing it happens
before the tap, so iOS's required user gesture is retained when opening the
system sheet. No sensor-recording interaction is introduced.

This is **button-driven saving, not silent automatic uploading**. A browser
cannot force a share destination or skip Apple's confirmation. It also cannot
see whether the chosen target finished a cloud transfer. The app therefore says
**Handed to the system**, never falsely **Uploaded to OneDrive**. OneDrive shows
its own upload status. Cancelling, being offline, or provider failure leaves the
local recording available for retry. A browser without native file sharing
shows the limitation rather than quietly downloading a file or sharing a URL.
These restrictions follow the [Web Share standard](https://www.w3.org/TR/web-share/).

The phone can send to OneDrive while the laptop is off. There is no extra
hosting account, free trial, freemium service, or billing setup. This works on
the existing public GitHub Pages site. Only the storage limits of the OneDrive
account you already use apply.

## Why the automatic Azure route was dropped

The account signed into Microsoft successfully but has no directory for app
registration. Microsoft's current [Entra ID Free requirements](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/microsoft-entra-id-free)
require a payment card for identity verification, even though the directory is
called free. That violates the user's explicit no-card condition. No Azure
subscription, billing account, Microsoft client secret, Cloudflare Worker,
database, or laptop relay was created. The earlier optional backend code remains
in the repository but the app now runs its journal in `nativeOnly` mode and
does not call a backend or authentication endpoint.

## Verification

Seven focused native-save tests cover a synchronous tap handoff, complete file
bytes, cancellation/retry, errors, unsupported browsers, recording restrictions,
MIME compatibility and overlapping sheets. An additional journal test confirms
native-only mode makes zero backend/auth requests. The complete app is exercised
in Edge with a mocked OS target, real file bytes, real clicks and IndexedDB.

The actual OneDrive share target and physical iPhone upload still require an
iPhone test. Desktop browser automation cannot establish those outcomes.
