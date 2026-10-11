import type { NetworkPolicy, SandboxBuilder } from 'microsandbox'

export type SandboxVolumeMount = {
  name: string
  mountPath: string
  createIfMissing?: boolean
  readonly?: boolean
}

export type NetworkConfig =
  | 'none'                  // no network — throws if packages or secrets present
  | 'public'                // public internet only — no LAN, host, or cloud metadata
  | { allow: string[] }     // allowlist: 'api.example.com', '*.example.com', '10.0.0.0/8';
                            // merged with hosts from secrets + pypi from packages
  | NetworkPolicy           // microsandbox policy, passed through unchanged
  | boolean                 // shorthand: true = 'public', false = 'none'

export type SandboxSecret = {
  env: string     // env var name inside the sandbox
  value: string   // the secret value (from vault, process.env, etc.)
  host: string    // only exposed to connections to this host; auto-added to network allowlist
}

export type SandboxConfig = {
  image: string
  interpreter: string
  cpus?: number
  memory?: number
  network?: NetworkConfig
  timeoutSecs?: number
  /** Max bytes of stdout and of stderr returned to the model; the middle is dropped. Default: 32768. */
  maxOutputBytes?: number
  env?: Record<string, string>
  secrets?: SandboxSecret[]
  packages?: string[]
  volumes?: SandboxVolumeMount[]
  persist?: boolean
  configure?: (b: SandboxBuilder) => SandboxBuilder
}

export type FileChangeKind = 'created' | 'modified'

export type FileOutPayload = {
  /** Path relative to /workspace, e.g. 'reports/q1/summary.md'. */
  file_name: string
  /** Whether the file was added this run or changed since the run started. */
  change: FileChangeKind
  version: number
  /** Size in bytes. */
  size: number
  /** Host path of the file. Only valid until the onFileOutput callback returns. */
  path: string
  /** File contents; omitted for files of 2 GiB or more (read them from `path`). */
  buffer?: Uint8Array
}

export type WorkspaceInput =
  | File
  | { name: string; data: Buffer | Uint8Array }

export type WorkspaceContextOptions = {
  inputFiles?: WorkspaceInput[]
  onFileOutput?: (payload: FileOutPayload) => void | Promise<void>
  /** Called with sandbox workspace paths after each run (for UI file trees). */
  onWorkspaceSnapshot?: (paths: string[]) => void | Promise<void>
  /** Stable sandbox name for persist: true configs across multiple run() calls. */
  sandboxName?: string
  /** Skip writing inputFiles (use on follow-up turns when the sandbox already has them). */
  skipInputSeed?: boolean
  /**
   * Host directory that holds persistent session workspaces (one folder per sandboxName)
   * and, when set, temp workspaces for other runs. Default: ~/.mst/workspaces.
   * Use the same value for every turn of a session and for listSessions()/endSession().
   */
  workspaceRoot?: string
}
