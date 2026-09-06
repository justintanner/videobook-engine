import type { SearchProviderConsent, SearchProviderNetworkAccess } from "./engine-types.js";
import { EngineFault } from "./store.js";

interface NetworkProvider {
  readonly networkAccess?: SearchProviderNetworkAccess;
}

export function guardSearchProvider<T extends NetworkProvider>(
  source: T,
  consent: SearchProviderConsent = {},
  isActive: () => boolean = () => true,
): { provider: T; validate: () => void; matches: (candidate: T, grant: SearchProviderConsent) => boolean } {
  const downloads = source.networkAccess?.modelDownloads;
  const inference = source.networkAccess?.inference;
  const allowDownloads = consent.modelDownloads === true;
  const allowInference = consent.inference === true;
  const validate = () => {
    if (typeof downloads !== "boolean" || typeof inference !== "boolean") {
      throw new EngineFault({ code: "INVALID_INPUT", message: "Search provider must declare networkAccess.modelDownloads and networkAccess.inference as booleans" });
    }
    if (!isActive()) {
      throw new EngineFault({ code: "OFFLINE", message: "Search provider registration has been revoked" });
    }
    if (source.networkAccess?.modelDownloads !== downloads || source.networkAccess?.inference !== inference) {
      throw new EngineFault({ code: "INVALID_INPUT", message: "Search provider network declaration changed; register it again with application consent" });
    }
    if ((downloads && !allowDownloads) || (inference && !allowInference)) {
      throw new EngineFault({ code: "OFFLINE", message: "Search provider network access requires application consent" });
    }
  };
  const provider = Object.create(source) as T;
  for (const method of ["prepare", "embedText", "embedImage", "embedVideo", "embedAudio"] as const) {
    const operation: unknown = Reflect.get(source, method);
    if (typeof operation !== "function") continue;
    Object.defineProperty(provider, method, {
      value: async (...args: unknown[]) => {
        validate();
        return Reflect.apply(operation, source, args) as unknown;
      },
    });
  }
  return {
    provider, validate,
    matches: (candidate, grant) => candidate === source
      && candidate.networkAccess?.modelDownloads === downloads
      && candidate.networkAccess?.inference === inference
      && (grant.modelDownloads === true) === allowDownloads
      && (grant.inference === true) === allowInference,
  };
}
