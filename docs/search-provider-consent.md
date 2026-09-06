# Search provider network consent

Injected search providers must declare `networkAccess` with two explicit booleans:

- `modelDownloads`: preparation or execution may fetch model files.
- `inference`: execution may send query text or selected media to a remote service.

The declaration describes capability. It does not grant permission. The application supplies a separate `SearchProviderConsent`. Each permission defaults to denied and only literal `true` grants it. Download consent never authorizes remote inference.

```typescript
const provider = new MySearchProvider({
  networkAccess: { modelDownloads: false, inference: true },
});
engine.temporalSearch.providers.register(provider, { inference: true });
```

The example assumes the application's configuration or user interaction has authorized remote inference. The engine does not display consent UI or infer authorization from a model manifest, provider name, or the fact that a provider was passed to it.

A local injected provider declares `{ modelDownloads: false, inference: false }` and needs no grant. The built-in temporal CLIP and CLAP providers declare local inference and model downloads according to their constructor's `allowModelDownload` option. Constructor options are copied and frozen. Explicit online preparation outside an Engine remains controlled by that constructor option. When registering a download-enabled built-in with an Engine, also pass `{ modelDownloads: true }`. For normal offline use, omit `allowModelDownload` and register without consent.

## Registration and revocation

Temporal registration validates declarations and grants before accepting a provider. Missing or malformed declarations produce `INVALID_INPUT`; denied network permissions produce `OFFLINE`. A failed replacement leaves the existing registration intact.

Authorization is checked before every `prepare` and embedding invocation, including after an awaited preparation step. Grants and declarations are snapshotted. Changing the declaration requires registration again; mutating a previously supplied consent object does not change an existing grant. Re-register with the desired grant, or use:

```typescript
engine.temporalSearch.providers.unregister(provider.manifestId);
```

Removal or successful replacement revokes future calls through the old registration, including the embedding stage of a query currently awaiting preparation. It cannot recall content already delivered to a running provider. Registrations and grants belong to one Engine instance and are not persisted in semantic data, history, or action logs. Reopening an Engine requires registration again.

## Compatibility similarity API

`EngineConfig.similarity.provider`, `.audio.provider`, and `.text.provider` use the same declarations and dispatch checks. Set `providerConsent` next to each injected provider:

```typescript
const engine = createEngine({
  rootDir,
  similarity: {
    provider: visualProvider,
    providerConsent: { inference: true },
    text: {
      provider: textProvider,
      providerConsent: { inference: true },
    },
  },
});
```

These configurations are checked when the provider is invoked, returning the normal `Result` error from preparation, indexing, or query operations. Each modality owns its grant; audio and text do not inherit the visual provider's consent. Recreate the Engine to change a compatibility provider's grant. Built-in compatibility providers retain their existing `allowModelDownload` configuration and local inference behavior; `providerConsent` applies only to injected implementations.

The new properties are optional in TypeScript so existing integrations still compile on this patch version. **Undeclared injected providers fail at runtime.** Update them to declare their capabilities explicitly. This is an intentional fail-closed migration, not an inference that old providers are local.

## Input and trust boundary

Temporal text dispatch supplies only the query string and operation options, not the Engine, catalog, book metadata, or other artifacts. Compatibility dispatch supplies the selected materialized media path or normalized/chunked text. Direct application indexing and reference preparation still choose the media paths and ranges supplied to built-ins.

A declaration is a contract with trusted injected JavaScript, not a network sandbox. Providers can lie about capabilities, access their own ambient credentials, or inspect files accessible to the host process. Applications must trust and audit injected implementations. Consent gates prevent the engine from dispatching to undeclared, unauthorized, changed, or revoked providers; they do not intercept arbitrary socket or filesystem calls made by malicious code. Complete cross-book input scoping and whole-application network auditing are tracked separately.

`tests/search-provider-access.test.ts` exercises actual Engine dispatch against an HTTP receiver, including rejected grants with zero requests, query-only transmission, frozen providers, Engine isolation, revocation/replacement during preparation, capability mutation, built-in declarations, and compatibility image/video/audio/text denial and separate grants.
