/**
 * Read an indexer knob from the environment. Hosted envio-cloud only accepts
 * ENVIO_-prefixed keys, so `ENVIO_<name>` wins; the bare `<name>` (upstream's
 * spelling) still works for local runs.
 */
export function env(name: string): string | undefined {
  return process.env[`ENVIO_${name}`] ?? process.env[name];
}
