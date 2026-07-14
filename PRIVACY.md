# Privacy policy

Last updated: July 12, 2026

Handwriting Natively works locally inside Obsidian. It does not create an account, send telemetry, use analytics, load remote code, or transmit PDF contents, handwriting, settings, filenames, or usage data to the developer or any hosted service.

## Information we collect

Handwriting Natively and its developer collect no information from your device. The plugin processes the following information locally only: PDF paths and contents, handwriting points, annotation metadata, tool preferences, save status, recovery records, and optional backups. None is sent to the developer.

## How we use your information

Local information is used only to render annotations, save editable sidecars, recover interrupted edits, and export annotated copies. It is not used for profiling, advertising, analytics, or training.

## Data stored on your device

The plugin may store:

- editable annotation sidecars;
- autosave and crash-recovery files;
- plugin settings and tool preferences;
- annotated PDF copies you explicitly export.

Default sidecars and recovery data live under `.obsidian/plugins/handwriting-natively/`. Sidecar locations are configurable. Exported PDFs use the location you choose or the source PDF folder.

## Original PDFs

Original PDFs remain unchanged. `Export PDF` creates a separate annotated file.

## Retention and deletion

Data remains on your device until you delete it. Removing annotations in the plugin updates the sidecar but may not immediately remove backups, recovery files, synced versions, or operating-system file history.

To delete plugin data:

1. close PDF annotation views;
2. delete the relevant sidecar or the plugin annotation folder;
3. delete optional backup and exported PDF files;
4. clear versions retained by vault sync, cloud storage, or device backups when applicable.

Uninstalling the plugin may leave local sidecars and backups so handwriting is not silently destroyed. Delete those folders manually if you want complete removal.

## Sharing and recipients

Handwriting Natively does not sell or share your information. No developer, advertiser, analytics provider, or other recipient receives it from the plugin. Obsidian Sync, third-party sync tools, operating-system backups, and cloud folders may copy files according to their own policies. Handwriting Natively does not control those services.

## Security

Sidecar and backup files receive the same filesystem access protection as the vault. Anyone or any plugin with vault/device access may be able to read them. Keep sensitive vaults encrypted and restrict plugin access.

## Changes

Material privacy changes will update this document and its date. A future network feature must be opt-in and documented before release.

## Contact support

Contact support by opening an issue in the source repository or issue tracker from which you obtained Handwriting Natively. Public releases must publish that concrete repository URL before distribution. Security reports should follow `SECURITY.md` when published.
