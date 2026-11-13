import type { SigningAlgo } from "./nearai.ts";

/**
 * The model, signing scheme and signer that 01-SHARED-INTERFACE.md §6.3 pins (version 1.2 onwards): the values the
 * live contract holds in `get_constants().model` and checks every proposal against. The signer is the model's
 * ed25519 public key as 64 hex characters.
 */
export const PINNED_01: { readonly model: string; readonly algo: SigningAlgo; readonly signer: string } = {
  model: "z-ai/glm-5.3-flash",
  algo: "ed25519",
  signer: "5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff",
};

/**
 * The ed25519 signing keys of the four signed models, as recorded on 2026-11-11 (intern/fixtures/ai/README.md,
 * finding 3). Only used to name the signer of a signature that does not verify with the pin: ed25519 has no key
 * recovery, so a key outside this list cannot be named.
 */
export const RECORDED_ED25519_SIGNERS: Readonly<Record<string, string>> = {
  "Qwen/Qwen3.8-27B": "89154a43a47684742c3d1753252bb6f49f61da9d8c84fc9b1def2df130cb2d93",
  "z-ai/glm-5.3-flash": "5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff",
  "Qwen/Qwen3.6-35B-A3B-FP8": "89fb781a9530473a6d3bddd6bb0a0536c8d155058798edae88b19153bd8f4350",
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": "236f5a6b91dd47dc3b7b36e43d4eb531a042ffb8f8fbf3a1555b78cef4fdda4c",
};
